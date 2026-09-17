use crate::trace::{AsrTrace, LlmTrace, TokenUsage};
use crate::voice::SessionMode;
use anyhow::{anyhow, Result};
use chrono::{DateTime, Local, Utc};
use log::{debug, error, info};
use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};
use rusqlite_migration::{Migrations, M};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_specta::Event;

/// Database migrations for transcription history.
/// Each migration is applied in order. The library tracks which migrations
/// have been applied using SQLite's user_version pragma.
///
/// Note: For users upgrading from tauri-plugin-sql, migrate_from_tauri_plugin_sql()
/// converts the old _sqlx_migrations table tracking to the user_version pragma,
/// ensuring migrations don't re-run on existing databases.
static MIGRATIONS: &[M] = &[
    M::up(
        "CREATE TABLE IF NOT EXISTS transcription_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_name TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            saved BOOLEAN NOT NULL DEFAULT 0,
            title TEXT NOT NULL,
            transcription_text TEXT NOT NULL
        );",
    ),
    M::up("ALTER TABLE transcription_history ADD COLUMN post_processed_text TEXT;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN post_process_prompt TEXT;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN post_process_requested BOOLEAN NOT NULL DEFAULT 0;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN mode TEXT NOT NULL DEFAULT 'dictate';"),
    M::up("ALTER TABLE transcription_history ADD COLUMN audio_ms INTEGER NOT NULL DEFAULT 0;"),
    M::up(
        "CREATE TABLE IF NOT EXISTS usage_daily (
            day TEXT NOT NULL,
            mode TEXT NOT NULL,
            sessions INTEGER NOT NULL DEFAULT 0,
            chars INTEGER NOT NULL DEFAULT 0,
            audio_ms INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (day, mode)
        );",
    ),
    // Which recognizer / text model produced each entry, and what they billed.
    M::up(
        "ALTER TABLE transcription_history ADD COLUMN asr_provider TEXT;
        ALTER TABLE transcription_history ADD COLUMN asr_model TEXT;
        ALTER TABLE transcription_history ADD COLUMN asr_input_tokens INTEGER;
        ALTER TABLE transcription_history ADD COLUMN asr_output_tokens INTEGER;
        ALTER TABLE transcription_history ADD COLUMN asr_ms INTEGER;
        ALTER TABLE transcription_history ADD COLUMN llm_provider TEXT;
        ALTER TABLE transcription_history ADD COLUMN llm_model TEXT;
        ALTER TABLE transcription_history ADD COLUMN llm_input_tokens INTEGER;
        ALTER TABLE transcription_history ADD COLUMN llm_output_tokens INTEGER;
        ALTER TABLE transcription_history ADD COLUMN llm_ms INTEGER;",
    ),
];

/// Every column of `transcription_history`, in the order `map_history_entry`
/// reads them. Kept in one place so a new column only has to be added once.
const ENTRY_COLUMNS: &str = "id, file_name, timestamp, saved, title, transcription_text, \
     post_processed_text, post_process_prompt, post_process_requested, mode, audio_ms, \
     asr_provider, asr_model, asr_input_tokens, asr_output_tokens, asr_ms, \
     llm_provider, llm_model, llm_input_tokens, llm_output_tokens, llm_ms";

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct PaginatedHistory {
    pub entries: Vec<HistoryEntry>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(tag = "action")]
pub enum HistoryUpdatePayload {
    #[serde(rename = "added")]
    Added { entry: HistoryEntry },
    #[serde(rename = "updated")]
    Updated { entry: HistoryEntry },
    #[serde(rename = "deleted")]
    Deleted { id: i64 },
    #[serde(rename = "toggled")]
    Toggled { id: i64 },
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct HistoryEntry {
    pub id: i64,
    /// Empty once the recording has been cleaned up. The text is kept forever;
    /// only the WAV is pruned, so an entry with no file name cannot be retried.
    pub file_name: String,
    pub timestamp: i64,
    pub saved: bool,
    pub title: String,
    pub transcription_text: String,
    pub post_processed_text: Option<String>,
    pub post_process_prompt: Option<String>,
    pub post_process_requested: bool,
    pub mode: SessionMode,
    pub audio_ms: i64,
    /// Recognizer that produced `transcription_text`. `None` for entries
    /// saved before this was recorded.
    pub asr: Option<AsrTrace>,
    /// Text model that produced `post_processed_text`, when one did.
    pub llm: Option<LlmTrace>,
}

/// Everything needed to insert a history entry; the id, timestamp and title
/// are assigned on save.
#[derive(Clone, Debug)]
pub struct NewHistoryEntry {
    pub file_name: String,
    pub transcription_text: String,
    pub post_process_requested: bool,
    pub post_processed_text: Option<String>,
    pub post_process_prompt: Option<String>,
    pub mode: SessionMode,
    pub audio_ms: i64,
    pub asr: Option<AsrTrace>,
    pub llm: Option<LlmTrace>,
}

/// One route's columns (`asr_*` or `llm_*`), flattened for SQL parameters.
struct TraceColumns<'a> {
    provider: Option<&'a str>,
    model: Option<&'a str>,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    ms: Option<i64>,
}

impl<'a> TraceColumns<'a> {
    fn new(
        provider: Option<&'a str>,
        model: Option<&'a str>,
        usage: Option<TokenUsage>,
        ms: Option<i64>,
    ) -> Self {
        Self {
            provider,
            model,
            input_tokens: usage.map(|u| u.input),
            output_tokens: usage.map(|u| u.output),
            ms,
        }
    }

    fn asr(trace: Option<&'a AsrTrace>) -> Self {
        match trace {
            Some(t) => Self::new(Some(&t.provider), t.model.as_deref(), t.usage, t.ms),
            None => Self::new(None, None, None, None),
        }
    }

    fn llm(trace: Option<&'a LlmTrace>) -> Self {
        match trace {
            Some(t) => Self::new(Some(&t.provider), t.model.as_deref(), t.usage, t.ms),
            None => Self::new(None, None, None, None),
        }
    }
}

/// Read one route's columns; `None` when the provider column is empty.
#[allow(clippy::type_complexity)]
fn read_trace_columns(
    row: &rusqlite::Row<'_>,
    prefix: &str,
) -> rusqlite::Result<Option<(String, Option<String>, Option<TokenUsage>, Option<i64>)>> {
    let provider: Option<String> = row.get(format!("{prefix}_provider").as_str())?;
    let Some(provider) = provider.filter(|p| !p.is_empty()) else {
        return Ok(None);
    };
    let model: Option<String> = row.get(format!("{prefix}_model").as_str())?;
    let input: Option<i64> = row.get(format!("{prefix}_input_tokens").as_str())?;
    let output: Option<i64> = row.get(format!("{prefix}_output_tokens").as_str())?;
    let ms: Option<i64> = row.get(format!("{prefix}_ms").as_str())?;
    Ok(Some((
        provider,
        model,
        TokenUsage::from_parts(input, output),
        ms,
    )))
}

/// One day's totals for a single mode, as stored in `usage_daily`. Weekly and
/// all-time figures are derived from these rows by the frontend.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct UsageDay {
    /// Local calendar day, `YYYY-MM-DD`.
    pub day: String,
    pub mode: SessionMode,
    pub sessions: i64,
    pub chars: i64,
    pub audio_ms: i64,
}

fn mode_to_str(mode: SessionMode) -> &'static str {
    match mode {
        SessionMode::Dictate => "dictate",
        SessionMode::Translate => "translate",
    }
}

fn mode_from_str(value: &str) -> SessionMode {
    match value {
        "translate" => SessionMode::Translate,
        _ => SessionMode::Dictate,
    }
}

/// Neutralise LIKE wildcards so a search for "100%" matches literally. Used
/// with `ESCAPE '\'` on the SQL side.
fn escape_like(needle: &str) -> String {
    needle
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

pub struct HistoryManager {
    app_handle: AppHandle,
    recordings_dir: PathBuf,
    db_path: PathBuf,
}

impl HistoryManager {
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        // Create recordings directory in app data dir
        let app_data_dir = crate::portable::app_data_dir(app_handle)?;
        let recordings_dir = app_data_dir.join("recordings");
        let db_path = app_data_dir.join("history.db");

        // Ensure recordings directory exists
        if !recordings_dir.exists() {
            fs::create_dir_all(&recordings_dir)?;
            debug!("Created recordings directory: {:?}", recordings_dir);
        }

        let manager = Self {
            app_handle: app_handle.clone(),
            recordings_dir,
            db_path,
        };

        // Initialize database and run migrations synchronously
        manager.init_database()?;

        Ok(manager)
    }

    fn init_database(&self) -> Result<()> {
        info!("Initializing database at {:?}", self.db_path);

        let mut conn = Connection::open(&self.db_path)?;

        // Handle migration from tauri-plugin-sql to rusqlite_migration
        // tauri-plugin-sql used _sqlx_migrations table, rusqlite_migration uses user_version pragma
        self.migrate_from_tauri_plugin_sql(&conn)?;

        // Create migrations object and run to latest version
        let migrations = Migrations::new(MIGRATIONS.to_vec());

        // Validate migrations in debug builds
        #[cfg(debug_assertions)]
        migrations.validate().expect("Invalid migrations");

        // Get current version before migration
        let version_before: i32 =
            conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        debug!("Database version before migration: {}", version_before);

        // Apply any pending migrations
        migrations.to_latest(&mut conn)?;

        // Get version after migration
        let version_after: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

        if version_after > version_before {
            info!(
                "Database migrated from version {} to {}",
                version_before, version_after
            );
        } else {
            debug!("Database already at latest version {}", version_after);
        }

        Ok(())
    }

    /// Migrate from tauri-plugin-sql's migration tracking to rusqlite_migration's.
    /// tauri-plugin-sql used a _sqlx_migrations table, while rusqlite_migration uses
    /// SQLite's user_version pragma. This function checks if the old system was in use
    /// and sets the user_version accordingly so migrations don't re-run.
    fn migrate_from_tauri_plugin_sql(&self, conn: &Connection) -> Result<()> {
        // Check if the old _sqlx_migrations table exists
        let has_sqlx_migrations: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !has_sqlx_migrations {
            return Ok(());
        }

        // Check current user_version
        let current_version: i32 =
            conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

        if current_version > 0 {
            // Already migrated to rusqlite_migration system
            return Ok(());
        }

        // Get the highest version from the old migrations table
        let old_version: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations WHERE success = 1",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        if old_version > 0 {
            info!(
                "Migrating from tauri-plugin-sql (version {}) to rusqlite_migration",
                old_version
            );

            // Set user_version to match the old migration state
            conn.pragma_update(None, "user_version", old_version)?;

            // Optionally drop the old migrations table (keeping it doesn't hurt)
            // conn.execute("DROP TABLE IF EXISTS _sqlx_migrations", [])?;

            info!(
                "Migration tracking converted: user_version set to {}",
                old_version
            );
        }

        Ok(())
    }

    fn get_connection(&self) -> Result<Connection> {
        Ok(Connection::open(&self.db_path)?)
    }

    fn map_history_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryEntry> {
        Ok(HistoryEntry {
            id: row.get("id")?,
            file_name: row.get("file_name")?,
            timestamp: row.get("timestamp")?,
            saved: row.get("saved")?,
            title: row.get("title")?,
            transcription_text: row.get("transcription_text")?,
            post_processed_text: row.get("post_processed_text")?,
            post_process_prompt: row.get("post_process_prompt")?,
            post_process_requested: row.get("post_process_requested")?,
            mode: mode_from_str(&row.get::<_, String>("mode")?),
            audio_ms: row.get("audio_ms")?,
            asr: read_trace_columns(row, "asr")?.map(|(provider, model, usage, ms)| AsrTrace {
                provider,
                model,
                usage,
                ms,
            }),
            llm: read_trace_columns(row, "llm")?.map(|(provider, model, usage, ms)| LlmTrace {
                provider,
                model,
                usage,
                ms,
            }),
        })
    }

    fn map_usage_day(row: &rusqlite::Row<'_>) -> rusqlite::Result<UsageDay> {
        Ok(UsageDay {
            day: row.get("day")?,
            mode: mode_from_str(&row.get::<_, String>("mode")?),
            sessions: row.get("sessions")?,
            chars: row.get("chars")?,
            audio_ms: row.get("audio_ms")?,
        })
    }

    pub fn recordings_dir(&self) -> &std::path::Path {
        &self.recordings_dir
    }

    /// Roll a new entry into `usage_daily`. Entries saved with no text are
    /// failures kept for retry, so they must not count towards usage.
    fn record_usage_with_conn(conn: &Connection, entry: &HistoryEntry) -> Result<()> {
        let text = entry
            .post_processed_text
            .as_deref()
            .unwrap_or(&entry.transcription_text);
        if text.trim().is_empty() {
            return Ok(());
        }

        // Bucket by local calendar day: the Usage page's streaks and "this
        // week" are what the user experienced in their own timezone.
        let day = DateTime::from_timestamp(entry.timestamp, 0)
            .map(|dt| dt.with_timezone(&Local))
            .unwrap_or_else(Local::now)
            .format("%Y-%m-%d")
            .to_string();

        conn.execute(
            "INSERT INTO usage_daily (day, mode, sessions, chars, audio_ms)
             VALUES (?1, ?2, 1, ?3, ?4)
             ON CONFLICT(day, mode) DO UPDATE SET
                 sessions = sessions + 1,
                 chars = chars + excluded.chars,
                 audio_ms = audio_ms + excluded.audio_ms",
            params![
                day,
                mode_to_str(entry.mode),
                text.chars().count() as i64,
                entry.audio_ms,
            ],
        )?;

        Ok(())
    }

    /// Per-day usage totals, oldest first. Weekly/all-time figures and streaks
    /// are derived from these rows by the Usage page.
    pub fn get_usage_days(&self, mode: Option<SessionMode>) -> Result<Vec<UsageDay>> {
        let conn = self.get_connection()?;
        Self::get_usage_days_with_conn(&conn, mode)
    }

    fn get_usage_days_with_conn(
        conn: &Connection,
        mode: Option<SessionMode>,
    ) -> Result<Vec<UsageDay>> {
        let mut sql = String::from("SELECT day, mode, sessions, chars, audio_ms FROM usage_daily");
        let mut args: Vec<Value> = Vec::new();

        if let Some(mode) = mode {
            sql.push_str(" WHERE mode = ?");
            args.push(Value::Text(mode_to_str(mode).to_string()));
        }
        sql.push_str(" ORDER BY day");

        let mut stmt = conn.prepare(&sql)?;
        let days = stmt
            .query_map(params_from_iter(args.iter()), Self::map_usage_day)?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(days)
    }

    /// Save a new history entry to the database.
    /// The WAV file should already have been written to the recordings directory.
    pub fn save_entry(&self, new: NewHistoryEntry) -> Result<HistoryEntry> {
        let timestamp = Utc::now().timestamp();
        let title = self.format_timestamp_title(timestamp);

        let conn = self.get_connection()?;
        let entry = Self::insert_entry_with_conn(&conn, new, timestamp, title)?;

        Self::record_usage_with_conn(&conn, &entry)?;

        debug!("Saved history entry with id {}", entry.id);

        self.cleanup_old_entries()?;

        // Emit typed event for real-time frontend updates
        if let Err(e) = (HistoryUpdatePayload::Added {
            entry: entry.clone(),
        })
        .emit(&self.app_handle)
        {
            error!("Failed to emit history-updated event: {}", e);
        }

        Ok(entry)
    }

    fn insert_entry_with_conn(
        conn: &Connection,
        new: NewHistoryEntry,
        timestamp: i64,
        title: String,
    ) -> Result<HistoryEntry> {
        let asr = TraceColumns::asr(new.asr.as_ref());
        let llm = TraceColumns::llm(new.llm.as_ref());
        conn.execute(
            "INSERT INTO transcription_history (
                file_name,
                timestamp,
                saved,
                title,
                transcription_text,
                post_processed_text,
                post_process_prompt,
                post_process_requested,
                mode,
                audio_ms,
                asr_provider,
                asr_model,
                asr_input_tokens,
                asr_output_tokens,
                asr_ms,
                llm_provider,
                llm_model,
                llm_input_tokens,
                llm_output_tokens,
                llm_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                      ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
            params![
                &new.file_name,
                timestamp,
                false,
                &title,
                &new.transcription_text,
                &new.post_processed_text,
                &new.post_process_prompt,
                new.post_process_requested,
                mode_to_str(new.mode),
                new.audio_ms,
                asr.provider,
                asr.model,
                asr.input_tokens,
                asr.output_tokens,
                asr.ms,
                llm.provider,
                llm.model,
                llm.input_tokens,
                llm.output_tokens,
                llm.ms,
            ],
        )?;

        Ok(HistoryEntry {
            id: conn.last_insert_rowid(),
            file_name: new.file_name,
            timestamp,
            saved: false,
            title,
            transcription_text: new.transcription_text,
            post_processed_text: new.post_processed_text,
            post_process_prompt: new.post_process_prompt,
            post_process_requested: new.post_process_requested,
            mode: new.mode,
            audio_ms: new.audio_ms,
            asr: new.asr,
            llm: new.llm,
        })
    }

    /// Update an existing history entry with new transcription results (used by
    /// retry). The route columns are overwritten too, so a retry that skips the
    /// text model clears the old one.
    pub fn update_transcription(
        &self,
        id: i64,
        transcription_text: String,
        post_processed_text: Option<String>,
        post_process_prompt: Option<String>,
        asr: Option<AsrTrace>,
        llm: Option<LlmTrace>,
    ) -> Result<HistoryEntry> {
        let conn = self.get_connection()?;
        let entry = Self::update_transcription_with_conn(
            &conn,
            id,
            transcription_text,
            post_processed_text,
            post_process_prompt,
            asr.as_ref(),
            llm.as_ref(),
        )?;

        debug!("Updated transcription for history entry {}", id);

        if let Err(e) = (HistoryUpdatePayload::Updated {
            entry: entry.clone(),
        })
        .emit(&self.app_handle)
        {
            error!("Failed to emit history-updated event: {}", e);
        }

        Ok(entry)
    }

    fn update_transcription_with_conn(
        conn: &Connection,
        id: i64,
        transcription_text: String,
        post_processed_text: Option<String>,
        post_process_prompt: Option<String>,
        asr: Option<&AsrTrace>,
        llm: Option<&LlmTrace>,
    ) -> Result<HistoryEntry> {
        let asr = TraceColumns::asr(asr);
        let llm = TraceColumns::llm(llm);
        let updated = conn.execute(
            "UPDATE transcription_history
             SET transcription_text = ?1,
                 post_processed_text = ?2,
                 post_process_prompt = ?3,
                 asr_provider = ?4,
                 asr_model = ?5,
                 asr_input_tokens = ?6,
                 asr_output_tokens = ?7,
                 asr_ms = ?8,
                 llm_provider = ?9,
                 llm_model = ?10,
                 llm_input_tokens = ?11,
                 llm_output_tokens = ?12,
                 llm_ms = ?13
             WHERE id = ?14",
            params![
                transcription_text,
                post_processed_text,
                post_process_prompt,
                asr.provider,
                asr.model,
                asr.input_tokens,
                asr.output_tokens,
                asr.ms,
                llm.provider,
                llm.model,
                llm.input_tokens,
                llm.output_tokens,
                llm.ms,
                id
            ],
        )?;

        if updated == 0 {
            return Err(anyhow!("History entry {} not found", id));
        }

        Ok(conn.query_row(
            &format!("SELECT {ENTRY_COLUMNS} FROM transcription_history WHERE id = ?1"),
            params![id],
            Self::map_history_entry,
        )?)
    }

    /// Prune old *recordings*. Transcribed text is kept forever — the History
    /// and Usage pages read it — so cleanup only deletes WAV files and clears
    /// the entry's `file_name` to mark the recording as gone.
    pub fn cleanup_old_entries(&self) -> Result<()> {
        let retention_period = crate::settings::get_recording_retention_period(&self.app_handle);
        let conn = self.get_connection()?;

        match retention_period {
            crate::settings::RecordingRetentionPeriod::Never => {
                // Don't delete anything
                Ok(())
            }
            crate::settings::RecordingRetentionPeriod::PreserveLimit => {
                // Use the old count-based logic with history_limit
                let limit = crate::settings::get_history_limit(&self.app_handle);
                Self::cleanup_by_count_with_conn(&conn, &self.recordings_dir, limit)
            }
            _ => {
                // Use time-based logic
                Self::cleanup_by_time_with_conn(&conn, &self.recordings_dir, retention_period)
            }
        }
    }

    fn delete_audio_files(
        conn: &Connection,
        recordings_dir: &Path,
        entries: &[(i64, String)],
    ) -> Result<usize> {
        if entries.is_empty() {
            return Ok(0);
        }

        let mut deleted_count = 0;

        for (id, file_name) in entries {
            let file_path = recordings_dir.join(file_name);
            if file_path.exists() {
                if let Err(e) = fs::remove_file(&file_path) {
                    error!("Failed to delete WAV file {}: {}", file_name, e);
                    // Keep the file name so a later pass retries the delete.
                    continue;
                }
                debug!("Deleted old WAV file: {}", file_name);
            }

            // An empty file name is how the rest of the app tells "the text is
            // here but the recording is gone" (retry is refused for these).
            conn.execute(
                "UPDATE transcription_history SET file_name = '' WHERE id = ?1",
                params![id],
            )?;
            deleted_count += 1;
        }

        Ok(deleted_count)
    }

    fn cleanup_by_count_with_conn(
        conn: &Connection,
        recordings_dir: &Path,
        limit: usize,
    ) -> Result<()> {
        // Entries that still have a recording, newest first.
        let mut stmt = conn.prepare(
            "SELECT id, file_name FROM transcription_history
             WHERE saved = 0 AND file_name != ''
             ORDER BY timestamp DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>("id")?, row.get::<_, String>("file_name")?))
        })?;

        let mut entries: Vec<(i64, String)> = Vec::new();
        for row in rows {
            entries.push(row?);
        }

        if entries.len() > limit {
            let entries_to_delete = &entries[limit..];
            let deleted_count = Self::delete_audio_files(conn, recordings_dir, entries_to_delete)?;

            if deleted_count > 0 {
                debug!("Cleaned up {} old recordings by count", deleted_count);
            }
        }

        Ok(())
    }

    fn cleanup_by_time_with_conn(
        conn: &Connection,
        recordings_dir: &Path,
        retention_period: crate::settings::RecordingRetentionPeriod,
    ) -> Result<()> {
        // Calculate cutoff timestamp (current time minus retention period)
        let now = Utc::now().timestamp();
        let cutoff_timestamp = match retention_period {
            crate::settings::RecordingRetentionPeriod::Days3 => now - (3 * 24 * 60 * 60), // 3 days in seconds
            crate::settings::RecordingRetentionPeriod::Weeks2 => now - (2 * 7 * 24 * 60 * 60), // 2 weeks in seconds
            crate::settings::RecordingRetentionPeriod::Months3 => now - (3 * 30 * 24 * 60 * 60), // 3 months in seconds (approximate)
            _ => unreachable!("Should not reach here"),
        };

        // Recordings older than the cutoff that have not been kept explicitly.
        let mut stmt = conn.prepare(
            "SELECT id, file_name FROM transcription_history
             WHERE saved = 0 AND file_name != '' AND timestamp < ?1",
        )?;

        let rows = stmt.query_map(params![cutoff_timestamp], |row| {
            Ok((row.get::<_, i64>("id")?, row.get::<_, String>("file_name")?))
        })?;

        let mut entries_to_delete: Vec<(i64, String)> = Vec::new();
        for row in rows {
            entries_to_delete.push(row?);
        }

        let deleted_count = Self::delete_audio_files(conn, recordings_dir, &entries_to_delete)?;

        if deleted_count > 0 {
            debug!(
                "Cleaned up {} old recordings based on retention period",
                deleted_count
            );
        }

        Ok(())
    }

    pub async fn get_history_entries(
        &self,
        cursor: Option<i64>,
        limit: Option<usize>,
        mode: Option<SessionMode>,
        query: Option<String>,
    ) -> Result<PaginatedHistory> {
        let conn = self.get_connection()?;
        Self::query_entries_with_conn(&conn, cursor, limit, mode, query)
    }

    fn query_entries_with_conn(
        conn: &Connection,
        cursor: Option<i64>,
        limit: Option<usize>,
        mode: Option<SessionMode>,
        query: Option<String>,
    ) -> Result<PaginatedHistory> {
        let limit = limit.map(|l| l.min(100));

        let mut sql = format!("SELECT {ENTRY_COLUMNS} FROM transcription_history");
        let mut clauses: Vec<&str> = Vec::new();
        let mut args: Vec<Value> = Vec::new();

        if let Some(cursor_id) = cursor {
            clauses.push("id < ?");
            args.push(Value::Integer(cursor_id));
        }
        if let Some(mode) = mode {
            clauses.push("mode = ?");
            args.push(Value::Text(mode_to_str(mode).to_string()));
        }
        if let Some(needle) = query.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
            clauses.push(
                "(transcription_text LIKE ? ESCAPE '\\' \
                  OR post_processed_text LIKE ? ESCAPE '\\')",
            );
            let pattern = format!("%{}%", escape_like(needle));
            args.push(Value::Text(pattern.clone()));
            args.push(Value::Text(pattern));
        }

        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }
        sql.push_str(" ORDER BY id DESC");
        if let Some(lim) = limit {
            // Fetch one extra row to tell whether another page exists.
            sql.push_str(" LIMIT ?");
            args.push(Value::Integer(lim as i64 + 1));
        }

        let mut stmt = conn.prepare(&sql)?;
        let mut entries = stmt
            .query_map(params_from_iter(args.iter()), Self::map_history_entry)?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        let has_more = limit.is_some_and(|lim| entries.len() > lim);
        if has_more {
            entries.pop();
        }

        Ok(PaginatedHistory { entries, has_more })
    }

    #[cfg(test)]
    fn get_latest_entry_with_conn(conn: &Connection) -> Result<Option<HistoryEntry>> {
        let mut stmt = conn.prepare(&format!(
            "SELECT {ENTRY_COLUMNS}
             FROM transcription_history
             ORDER BY timestamp DESC
             LIMIT 1",
        ))?;

        let entry = stmt.query_row([], Self::map_history_entry).optional()?;
        Ok(entry)
    }

    /// Get the latest entry with non-empty transcription text.
    pub fn get_latest_completed_entry(&self) -> Result<Option<HistoryEntry>> {
        let conn = self.get_connection()?;
        Self::get_latest_completed_entry_with_conn(&conn)
    }

    fn get_latest_completed_entry_with_conn(conn: &Connection) -> Result<Option<HistoryEntry>> {
        let mut stmt = conn.prepare(&format!(
            "SELECT {ENTRY_COLUMNS}
             FROM transcription_history
             WHERE transcription_text != ''
             ORDER BY timestamp DESC
             LIMIT 1",
        ))?;

        let entry = stmt.query_row([], Self::map_history_entry).optional()?;
        Ok(entry)
    }

    pub async fn toggle_saved_status(&self, id: i64) -> Result<()> {
        let conn = self.get_connection()?;

        // Get current saved status
        let current_saved: bool = conn.query_row(
            "SELECT saved FROM transcription_history WHERE id = ?1",
            params![id],
            |row| row.get("saved"),
        )?;

        let new_saved = !current_saved;

        conn.execute(
            "UPDATE transcription_history SET saved = ?1 WHERE id = ?2",
            params![new_saved, id],
        )?;

        debug!("Toggled saved status for entry {}: {}", id, new_saved);

        // Emit history updated event
        if let Err(e) = (HistoryUpdatePayload::Toggled { id }).emit(&self.app_handle) {
            error!("Failed to emit history-updated event: {}", e);
        }

        Ok(())
    }

    pub fn get_audio_file_path(&self, file_name: &str) -> PathBuf {
        self.recordings_dir.join(file_name)
    }

    pub async fn get_entry_by_id(&self, id: i64) -> Result<Option<HistoryEntry>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {ENTRY_COLUMNS} FROM transcription_history WHERE id = ?1",
        ))?;

        let entry = stmt.query_row([id], Self::map_history_entry).optional()?;

        Ok(entry)
    }

    pub async fn delete_entry(&self, id: i64) -> Result<()> {
        let conn = self.get_connection()?;

        // Get the entry to find the file name
        if let Some(entry) = self.get_entry_by_id(id).await? {
            // Delete the audio file first
            let file_path = self.get_audio_file_path(&entry.file_name);
            if file_path.exists() {
                if let Err(e) = fs::remove_file(&file_path) {
                    error!("Failed to delete audio file {}: {}", entry.file_name, e);
                    // Continue with database deletion even if file deletion fails
                }
            }
        }

        // Delete from database
        conn.execute(
            "DELETE FROM transcription_history WHERE id = ?1",
            params![id],
        )?;

        debug!("Deleted history entry with id: {}", id);

        // Emit history updated event
        if let Err(e) = (HistoryUpdatePayload::Deleted { id }).emit(&self.app_handle) {
            error!("Failed to emit history-updated event: {}", e);
        }

        Ok(())
    }

    fn format_timestamp_title(&self, timestamp: i64) -> String {
        if let Some(utc_datetime) = DateTime::from_timestamp(timestamp, 0) {
            // Convert UTC to local timezone
            let local_datetime = utc_datetime.with_timezone(&Local);
            local_datetime.format("%B %e, %Y - %l:%M%p").to_string()
        } else {
            format!("Recording {}", timestamp)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{params, Connection};

    fn setup_conn() -> Connection {
        // Build the schema from the real migrations so the tests catch any
        // drift between them, `ENTRY_COLUMNS` and the INSERT/UPDATE lists.
        let mut conn = Connection::open_in_memory().expect("open in-memory db");
        Migrations::new(MIGRATIONS.to_vec())
            .to_latest(&mut conn)
            .expect("apply migrations");
        conn
    }

    fn insert_entry(conn: &Connection, timestamp: i64, text: &str, post_processed: Option<&str>) {
        conn.execute(
            "INSERT INTO transcription_history (
                file_name,
                timestamp,
                saved,
                title,
                transcription_text,
                post_processed_text,
                post_process_prompt,
                post_process_requested,
                mode,
                audio_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                format!("sayso-{}.wav", timestamp),
                timestamp,
                false,
                format!("Recording {}", timestamp),
                text,
                post_processed,
                Option::<String>::None,
                false,
                "dictate",
                1000,
            ],
        )
        .expect("insert history entry");
    }

    fn entry_for_usage(
        timestamp: i64,
        text: &str,
        post_processed: Option<&str>,
        mode: SessionMode,
        audio_ms: i64,
    ) -> HistoryEntry {
        HistoryEntry {
            id: 0,
            file_name: String::new(),
            timestamp,
            saved: false,
            title: String::new(),
            transcription_text: text.to_string(),
            post_processed_text: post_processed.map(str::to_string),
            post_process_prompt: None,
            post_process_requested: false,
            mode,
            audio_ms,
            asr: None,
            llm: None,
        }
    }

    fn new_entry(text: &str) -> NewHistoryEntry {
        NewHistoryEntry {
            file_name: "sayso-1.wav".into(),
            transcription_text: text.into(),
            post_process_requested: true,
            post_processed_text: Some(format!("{text}!")),
            post_process_prompt: Some("prompt".into()),
            mode: SessionMode::Dictate,
            audio_ms: 1200,
            asr: Some(AsrTrace {
                provider: "dashscope".into(),
                model: Some("qwen3-asr-flash".into()),
                usage: Some(TokenUsage {
                    input: 52,
                    output: 3,
                }),
                ms: Some(640),
            }),
            llm: Some(LlmTrace {
                provider: "deepseek".into(),
                model: Some("deepseek-chat".into()),
                usage: Some(TokenUsage {
                    input: 300,
                    output: 12,
                }),
                ms: Some(900),
            }),
        }
    }

    #[test]
    fn route_trace_round_trips_through_the_table() {
        let conn = setup_conn();
        let new = new_entry("hello");
        let saved =
            HistoryManager::insert_entry_with_conn(&conn, new.clone(), 100, "t".into()).unwrap();
        let read = HistoryManager::get_latest_entry_with_conn(&conn)
            .unwrap()
            .expect("entry exists");
        assert_eq!(read.asr, new.asr);
        assert_eq!(read.llm, new.llm);
        assert_eq!(read.asr, saved.asr);
        assert_eq!(read.post_processed_text.as_deref(), Some("hello!"));
    }

    #[test]
    fn legacy_rows_have_no_route() {
        let conn = setup_conn();
        insert_entry(&conn, 100, "old", None);
        let read = HistoryManager::get_latest_entry_with_conn(&conn)
            .unwrap()
            .expect("entry exists");
        assert_eq!(read.asr, None);
        assert_eq!(read.llm, None);
    }

    #[test]
    fn route_without_usage_keeps_usage_empty() {
        let conn = setup_conn();
        let mut new = new_entry("x");
        new.asr = Some(AsrTrace {
            provider: "local".into(),
            model: None,
            usage: None,
            ms: None,
        });
        new.llm = None;
        HistoryManager::insert_entry_with_conn(&conn, new, 100, "t".into()).unwrap();
        let read = HistoryManager::get_latest_entry_with_conn(&conn)
            .unwrap()
            .unwrap();
        let asr = read.asr.expect("asr trace");
        assert_eq!(asr.provider, "local");
        assert_eq!(asr.usage, None);
        assert_eq!(read.llm, None);
    }

    #[test]
    fn retry_overwrites_the_route() {
        let conn = setup_conn();
        let saved =
            HistoryManager::insert_entry_with_conn(&conn, new_entry("a"), 100, "t".into()).unwrap();
        let local = AsrTrace {
            provider: "local".into(),
            model: Some("sense-voice".into()),
            usage: None,
            ms: Some(80),
        };
        let updated = HistoryManager::update_transcription_with_conn(
            &conn,
            saved.id,
            "b".into(),
            None,
            None,
            Some(&local),
            None,
        )
        .unwrap();
        assert_eq!(updated.transcription_text, "b");
        assert_eq!(updated.asr, Some(local));
        assert_eq!(updated.llm, None, "the old text model is cleared");
        assert!(HistoryManager::update_transcription_with_conn(
            &conn,
            saved.id + 1,
            "c".into(),
            None,
            None,
            None,
            None
        )
        .is_err());
    }

    #[test]
    fn get_latest_entry_returns_none_when_empty() {
        let conn = setup_conn();
        let entry = HistoryManager::get_latest_entry_with_conn(&conn).expect("fetch latest entry");
        assert!(entry.is_none());
    }

    #[test]
    fn get_latest_entry_returns_newest_entry() {
        let conn = setup_conn();
        insert_entry(&conn, 100, "first", None);
        insert_entry(&conn, 200, "second", Some("processed"));

        let entry = HistoryManager::get_latest_entry_with_conn(&conn)
            .expect("fetch latest entry")
            .expect("entry exists");

        assert_eq!(entry.timestamp, 200);
        assert_eq!(entry.transcription_text, "second");
        assert_eq!(entry.post_processed_text.as_deref(), Some("processed"));
    }

    #[test]
    fn get_latest_completed_entry_skips_empty_entries() {
        let conn = setup_conn();
        insert_entry(&conn, 100, "completed", None);
        insert_entry(&conn, 200, "", None);

        let entry = HistoryManager::get_latest_completed_entry_with_conn(&conn)
            .expect("fetch latest completed entry")
            .expect("completed entry exists");

        assert_eq!(entry.timestamp, 100);
        assert_eq!(entry.transcription_text, "completed");
    }

    #[test]
    fn cleanup_by_count_prunes_recordings_but_keeps_text() {
        let conn = setup_conn();
        let dir = tempfile::tempdir().expect("temp recordings dir");

        for timestamp in [100, 200, 300] {
            insert_entry(&conn, timestamp, "kept text", None);
            fs::write(dir.path().join(format!("sayso-{timestamp}.wav")), b"wav")
                .expect("write fake recording");
        }

        HistoryManager::cleanup_by_count_with_conn(&conn, dir.path(), 1).expect("cleanup by count");

        // The newest recording survives; the older two lose only their audio.
        assert!(dir.path().join("sayso-300.wav").exists());
        assert!(!dir.path().join("sayso-200.wav").exists());
        assert!(!dir.path().join("sayso-100.wav").exists());

        let page = HistoryManager::query_entries_with_conn(&conn, None, None, None, None)
            .expect("query entries");
        assert_eq!(page.entries.len(), 3, "text is never deleted by cleanup");
        let by_timestamp = |ts: i64| {
            page.entries
                .iter()
                .find(|e| e.timestamp == ts)
                .expect("entry exists")
        };
        assert_eq!(by_timestamp(300).file_name, "sayso-300.wav");
        assert_eq!(by_timestamp(200).file_name, "");
        assert_eq!(by_timestamp(100).transcription_text, "kept text");
    }

    #[test]
    fn query_entries_filters_by_mode_and_text() {
        let conn = setup_conn();
        insert_entry(&conn, 100, "hello world", None);
        insert_entry(&conn, 200, "raw text", Some("polished hello"));
        conn.execute(
            "UPDATE transcription_history SET mode = 'translate' WHERE timestamp = 200",
            [],
        )
        .expect("mark entry as translate");

        let all = HistoryManager::query_entries_with_conn(&conn, None, Some(10), None, None)
            .expect("query all");
        assert_eq!(all.entries.len(), 2);
        assert!(!all.has_more);

        let translate = HistoryManager::query_entries_with_conn(
            &conn,
            None,
            Some(10),
            Some(SessionMode::Translate),
            None,
        )
        .expect("query translate");
        assert_eq!(translate.entries.len(), 1);
        assert_eq!(translate.entries[0].timestamp, 200);

        // Matches the post-processed text as well as the raw transcription.
        let search = HistoryManager::query_entries_with_conn(
            &conn,
            None,
            Some(10),
            None,
            Some("hello".to_string()),
        )
        .expect("query search");
        assert_eq!(search.entries.len(), 2);

        let none = HistoryManager::query_entries_with_conn(
            &conn,
            None,
            Some(10),
            None,
            Some("%".to_string()),
        )
        .expect("query wildcard search");
        assert!(
            none.entries.is_empty(),
            "LIKE wildcards in the query are escaped"
        );
    }

    #[test]
    fn query_entries_paginates_by_cursor() {
        let conn = setup_conn();
        for timestamp in [100, 200, 300] {
            insert_entry(&conn, timestamp, "text", None);
        }

        let first = HistoryManager::query_entries_with_conn(&conn, None, Some(2), None, None)
            .expect("first page");
        assert_eq!(first.entries.len(), 2);
        assert!(first.has_more);

        let cursor = first.entries.last().expect("last entry").id;
        let second =
            HistoryManager::query_entries_with_conn(&conn, Some(cursor), Some(2), None, None)
                .expect("second page");
        assert_eq!(second.entries.len(), 1);
        assert!(!second.has_more);
    }

    #[test]
    fn record_usage_accumulates_per_day_and_mode() {
        let conn = setup_conn();
        // 2024-01-02 12:00 UTC — far enough from midnight that any local
        // timezone keeps both entries on the same calendar day.
        let noon = 1_704_196_800;

        HistoryManager::record_usage_with_conn(
            &conn,
            &entry_for_usage(noon, "12345", None, SessionMode::Dictate, 2_000),
        )
        .expect("record dictate usage");
        HistoryManager::record_usage_with_conn(
            &conn,
            // The pasted (post-processed) text is what the user got.
            &entry_for_usage(noon, "raw", Some("1234567890"), SessionMode::Dictate, 3_000),
        )
        .expect("record second dictate usage");
        HistoryManager::record_usage_with_conn(
            &conn,
            &entry_for_usage(noon, "hi", None, SessionMode::Translate, 1_000),
        )
        .expect("record translate usage");

        let days = HistoryManager::get_usage_days_with_conn(&conn, None).expect("usage days");
        assert_eq!(days.len(), 2, "one row per day and mode");

        let dictate = days
            .iter()
            .find(|d| d.mode == SessionMode::Dictate)
            .expect("dictate row");
        assert_eq!(dictate.sessions, 2);
        assert_eq!(dictate.chars, 15);
        assert_eq!(dictate.audio_ms, 5_000);

        let only_translate =
            HistoryManager::get_usage_days_with_conn(&conn, Some(SessionMode::Translate))
                .expect("translate usage days");
        assert_eq!(only_translate.len(), 1);
        assert_eq!(only_translate[0].sessions, 1);
        assert_eq!(only_translate[0].chars, 2);
    }

    #[test]
    fn record_usage_ignores_failed_transcriptions() {
        let conn = setup_conn();
        HistoryManager::record_usage_with_conn(
            &conn,
            &entry_for_usage(1_704_196_800, "   ", None, SessionMode::Dictate, 4_000),
        )
        .expect("record empty usage");

        let days = HistoryManager::get_usage_days_with_conn(&conn, None).expect("usage days");
        assert!(days.is_empty());
    }
}
