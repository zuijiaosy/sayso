//! Commands for Voiceless dictate / translate sessions.

use crate::actions::{paste_and_finish, run_text_model, show_translation_failure};
use crate::settings::{
    get_settings, write_settings, AsrProviderKind, DashScopeAsrSettings, DictationPostMode,
    DictionaryEntry,
};
use crate::tray::{set_tray_state, TrayIconState};
use crate::utils;
use crate::voice::{
    find_translate_target, translate_targets, FailedTranslation, PromptKind, SessionMode,
    SessionModeEvent, TranslateTarget, VoiceSessionState,
};
use crate::TranscriptionCoordinator;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_specta::Event as _;

/// Overlay confirm button: stop recording and process what was said.
#[tauri::command]
#[specta::specta]
pub fn stop_active_recording(app: AppHandle) {
    if let Some(coordinator) = app.try_state::<TranscriptionCoordinator>() {
        coordinator.stop_active();
    }
}

#[tauri::command]
#[specta::specta]
pub fn list_translate_targets() -> Vec<TranslateTarget> {
    translate_targets()
}

/// Current session mode, target language and any pending translation failure.
#[derive(Serialize, Type)]
pub struct VoiceSessionSnapshot {
    pub mode: SessionMode,
    pub target_language: String,
    pub failure: Option<FailedTranslation>,
}

#[tauri::command]
#[specta::specta]
pub fn get_voice_session(app: AppHandle) -> VoiceSessionSnapshot {
    let state = app.state::<VoiceSessionState>();
    let (mode, target_language) = state.snapshot();
    VoiceSessionSnapshot {
        mode,
        target_language,
        failure: state.failed(),
    }
}

/// Choose the translation target from the overlay picker (or settings). It
/// applies to the session being recorded and becomes the default.
#[tauri::command]
#[specta::specta]
pub fn set_session_translate_target(
    app: AppHandle,
    code: String,
) -> Result<SessionModeEvent, String> {
    let target =
        find_translate_target(&code).ok_or_else(|| format!("Unsupported language: {code}"))?;
    let mut settings = get_settings(&app);
    settings.translate_target_language = target.code.clone();
    write_settings(&app, settings);
    let event = app
        .state::<VoiceSessionState>()
        .set_target_language(target.code);
    let _ = event.clone().emit(&app);
    Ok(event)
}

/// Retry the last failed translation and paste the result into the focused
/// app (the overlay never takes focus, so it is still the original target).
#[tauri::command]
#[specta::specta]
pub async fn retry_failed_translation(app: AppHandle) -> Result<(), String> {
    let state = app.state::<VoiceSessionState>();
    let Some(failure) = state.failed() else {
        return Err("Nothing to retry".to_string());
    };
    state.clear_failed(None);

    let settings = get_settings(&app);
    let target = find_translate_target(&failure.target_language)
        .ok_or_else(|| format!("Unsupported language: {}", failure.target_language))?;
    utils::show_processing_overlay(&app);
    set_tray_state(&app, TrayIconState::Transcribing);

    let system_prompt = crate::voice::build_system_prompt(
        &PromptKind::Translate(&target),
        &settings.dictionary,
        &failure.source_text,
    )
    .expect("translation always has a prompt");

    match run_text_model(&settings, &system_prompt, &failure.source_text).await {
        Ok(translated) => {
            paste_and_finish(&app, translated, None);
            Ok(())
        }
        Err(err) => {
            log::warn!("Translation retry failed: {err:?}");
            let reason = err.reason_code();
            show_translation_failure(
                &app,
                FailedTranslation {
                    reason: reason.to_string(),
                    ..failure
                },
            );
            Ok(())
        }
    }
}

/// Copy the untranslated source text so the user can handle it manually.
#[tauri::command]
#[specta::specta]
pub fn copy_failed_translation_source(app: AppHandle) -> Result<(), String> {
    let state = app.state::<VoiceSessionState>();
    let failure = state
        .failed()
        .ok_or_else(|| "Nothing to copy".to_string())?;
    app.clipboard()
        .write_text(failure.source_text)
        .map_err(|e| format!("Failed to copy: {e}"))?;
    state.clear_failed(None);
    utils::hide_recording_overlay(&app);
    Ok(())
}

/// The overlay's language list opened or closed.
#[tauri::command]
#[specta::specta]
pub fn set_overlay_picker_open(app: AppHandle, open: bool) {
    utils::set_overlay_picker_open(&app, open);
}

#[tauri::command]
#[specta::specta]
pub fn dismiss_translation_failure(app: AppHandle) {
    app.state::<VoiceSessionState>().clear_failed(None);
    utils::hide_recording_overlay(&app);
    set_tray_state(&app, TrayIconState::Idle);
}

#[tauri::command]
#[specta::specta]
pub fn update_dictation_post_mode(app: AppHandle, mode: DictationPostMode) {
    let mut settings = get_settings(&app);
    settings.dictation_post_mode = mode;
    write_settings(&app, settings);
}

/// Replace the whole dictionary. Entries are trimmed, blank terms dropped, and
/// aliases de-duplicated.
#[tauri::command]
#[specta::specta]
pub fn update_dictionary(app: AppHandle, entries: Vec<DictionaryEntry>) -> Vec<DictionaryEntry> {
    let cleaned = normalize_dictionary(entries);
    let mut settings = get_settings(&app);
    settings.dictionary = cleaned.clone();
    write_settings(&app, settings);
    cleaned
}

#[tauri::command]
#[specta::specta]
pub fn update_asr_provider(app: AppHandle, provider: AsrProviderKind) {
    let mut settings = get_settings(&app);
    settings.asr_provider = provider;
    write_settings(&app, settings);
}

#[tauri::command]
#[specta::specta]
pub fn update_dashscope_asr_settings(
    app: AppHandle,
    config: DashScopeAsrSettings,
) -> Result<DashScopeAsrSettings, String> {
    let endpoint = config.endpoint.trim().trim_end_matches('/').to_string();
    if !(endpoint.starts_with("https://") || endpoint.starts_with("http://")) {
        return Err("Endpoint must start with https://".to_string());
    }
    let model = config.model.trim().to_string();
    if model.is_empty() {
        return Err("Model cannot be empty".to_string());
    }
    let language = match config.language.trim() {
        "" => "auto".to_string(),
        other => other.to_string(),
    };
    let cleaned = DashScopeAsrSettings {
        endpoint,
        model,
        language,
        send_dictionary: config.send_dictionary,
    };
    let mut settings = get_settings(&app);
    settings.dashscope_asr = cleaned.clone();
    write_settings(&app, settings);
    Ok(cleaned)
}

#[tauri::command]
#[specta::specta]
pub fn set_asr_api_key(app: AppHandle, provider: String, api_key: String) -> Result<(), String> {
    if provider != crate::asr::dashscope::PROVIDER_ID {
        return Err(format!("Unknown ASR provider: {provider}"));
    }
    let mut settings = get_settings(&app);
    settings
        .asr_api_keys
        .insert(provider, api_key.trim().to_string());
    write_settings(&app, settings);
    Ok(())
}

/// Check the DashScope key and endpoint with one second of silence.
/// Returns the latency in milliseconds.
#[tauri::command]
#[specta::specta]
pub async fn test_dashscope_asr(app: AppHandle) -> Result<u32, String> {
    let settings = get_settings(&app);
    let request = crate::asr::dashscope_request(&settings);
    let started = std::time::Instant::now();
    let silence = vec![0.0f32; crate::asr::SAMPLE_RATE as usize];
    crate::asr::dashscope::transcribe(&request, &silence)
        .await
        .map_err(|e| e.to_string())?;
    Ok(started.elapsed().as_millis().min(u32::MAX as u128) as u32)
}

/// Parse dictionary text. One entry per line, `#` starts a comment:
/// `term | alias, alias | translation | note`, or `wrong → right` / `wrong -> right`,
/// or just `term`.
pub fn parse_dictionary_text(text: &str) -> Vec<DictionaryEntry> {
    let mut entries = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.contains('|') {
            let mut fields = line.split('|').map(str::trim);
            let term = fields.next().unwrap_or_default().to_string();
            let aliases = fields
                .next()
                .unwrap_or_default()
                .split([',', '，', '、'])
                .map(|a| a.trim().to_string())
                .filter(|a| !a.is_empty())
                .collect();
            let translation = fields.next().map(str::to_string);
            let note = fields.next().map(str::to_string);
            entries.push(DictionaryEntry {
                term,
                aliases,
                translation,
                note,
            });
            continue;
        }
        let arrow = ["→", "->", "=>"]
            .iter()
            .find_map(|sep| line.split_once(sep));
        if let Some((wrong, right)) = arrow {
            entries.push(DictionaryEntry {
                term: right.trim().to_string(),
                aliases: vec![wrong.trim().to_string()],
                translation: None,
                note: None,
            });
            continue;
        }
        entries.push(DictionaryEntry {
            term: line.to_string(),
            ..Default::default()
        });
    }
    normalize_dictionary(entries)
}

pub fn format_dictionary_text(entries: &[DictionaryEntry]) -> String {
    let mut out = String::from("# Voiceless dictionary: term | aliases | translation | note\n");
    for e in entries {
        let fields = [
            e.term.clone(),
            e.aliases.join(", "),
            e.translation.clone().unwrap_or_default(),
            e.note.clone().unwrap_or_default(),
        ];
        let mut line = fields.join(" | ");
        while line.ends_with(" | ") {
            line.truncate(line.len() - 3);
        }
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// Merge imported text into the dictionary (or replace it) and save.
#[tauri::command]
#[specta::specta]
pub fn import_dictionary_text(app: AppHandle, text: String, replace: bool) -> Vec<DictionaryEntry> {
    let imported = parse_dictionary_text(&text);
    let mut settings = get_settings(&app);
    let combined = if replace {
        imported
    } else {
        let mut all = settings.dictionary.clone();
        all.extend(imported);
        all
    };
    let cleaned = normalize_dictionary(combined);
    settings.dictionary = cleaned.clone();
    write_settings(&app, settings);
    cleaned
}

#[tauri::command]
#[specta::specta]
pub fn export_dictionary_text(app: AppHandle) -> String {
    format_dictionary_text(&get_settings(&app).dictionary)
}

fn trimmed_opt(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

pub fn normalize_dictionary(entries: Vec<DictionaryEntry>) -> Vec<DictionaryEntry> {
    let mut out: Vec<DictionaryEntry> = Vec::new();
    for entry in entries {
        let term = entry.term.trim().to_string();
        if term.is_empty() {
            continue;
        }
        let mut aliases: Vec<String> = Vec::new();
        for alias in entry.aliases {
            let alias = alias.trim().to_string();
            if !alias.is_empty() && alias != term && !aliases.contains(&alias) {
                aliases.push(alias);
            }
        }
        let normalized = DictionaryEntry {
            term,
            aliases,
            translation: trimmed_opt(entry.translation),
            note: trimmed_opt(entry.note),
        };
        // A repeated term merges into the first occurrence.
        if let Some(existing) = out.iter_mut().find(|e| e.term == normalized.term) {
            for alias in normalized.aliases {
                if !existing.aliases.contains(&alias) {
                    existing.aliases.push(alias);
                }
            }
            if existing.translation.is_none() {
                existing.translation = normalized.translation;
            }
            if existing.note.is_none() {
                existing.note = normalized.note;
            }
        } else {
            out.push(normalized);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_line_formats() {
        let text = "# comment\nCodex | 扣戴克斯, code x | Codex | OpenAI 编程工具\n\n地表水 | | surface water\nnew api → new-api\n瑞迪斯 -> Redis\nClaude Code\n";
        let entries = parse_dictionary_text(text);
        assert_eq!(entries.len(), 5);
        assert_eq!(entries[0].term, "Codex");
        assert_eq!(entries[0].aliases, vec!["扣戴克斯", "code x"]);
        assert_eq!(entries[0].note.as_deref(), Some("OpenAI 编程工具"));
        assert_eq!(entries[1].term, "地表水");
        assert!(entries[1].aliases.is_empty());
        assert_eq!(entries[1].translation.as_deref(), Some("surface water"));
        assert_eq!(entries[2].term, "new-api");
        assert_eq!(entries[2].aliases, vec!["new api"]);
        assert_eq!(entries[3].term, "Redis");
        assert_eq!(entries[4].term, "Claude Code");
    }

    #[test]
    fn export_round_trips() {
        let entries = parse_dictionary_text(
            "Codex | 扣戴克斯 | Codex | tool\n地表水 | | surface water\nPlain\n",
        );
        let text = format_dictionary_text(&entries);
        assert!(text.contains("Plain\n"), "{text}");
        assert!(text.contains("地表水 |  | surface water\n"), "{text}");
        assert_eq!(parse_dictionary_text(&text), entries);
    }

    #[test]
    fn normalizes_and_merges_entries() {
        let entries = vec![
            DictionaryEntry {
                term: " Codex ".into(),
                aliases: vec!["扣戴克斯".into(), " ".into(), "Codex".into()],
                translation: Some("  ".into()),
                note: None,
            },
            DictionaryEntry {
                term: "".into(),
                aliases: vec!["x".into()],
                translation: None,
                note: None,
            },
            DictionaryEntry {
                term: "Codex".into(),
                aliases: vec!["扣戴克斯".into(), "code x".into()],
                translation: Some("Codex".into()),
                note: Some("OpenAI 编程工具".into()),
            },
        ];
        let out = normalize_dictionary(entries);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].term, "Codex");
        assert_eq!(out[0].aliases, vec!["扣戴克斯", "code x"]);
        assert_eq!(out[0].translation.as_deref(), Some("Codex"));
        assert_eq!(out[0].note.as_deref(), Some("OpenAI 编程工具"));
    }
}
