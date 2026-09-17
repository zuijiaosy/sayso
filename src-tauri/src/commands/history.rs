use crate::actions::process_transcription_output;
use crate::managers::{
    history::{HistoryManager, PaginatedHistory, UsageDay},
    transcription::TranscriptionManager,
};
use crate::trace::{elapsed_ms, AsrTrace, LOCAL_ASR_PROVIDER};
use crate::voice::SessionMode;
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
#[specta::specta]
pub async fn get_history_entries(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    cursor: Option<i64>,
    limit: Option<usize>,
    mode: Option<SessionMode>,
    query: Option<String>,
) -> Result<PaginatedHistory, String> {
    history_manager
        .get_history_entries(cursor, limit, mode, query)
        .await
        .map_err(|e| e.to_string())
}

/// Per-day usage totals backing the Usage page.
#[tauri::command]
#[specta::specta]
pub async fn get_usage_days(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    mode: Option<SessionMode>,
) -> Result<Vec<UsageDay>, String> {
    history_manager
        .get_usage_days(mode)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn toggle_history_entry_saved(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
) -> Result<(), String> {
    history_manager
        .toggle_saved_status(id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn get_audio_file_path(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    file_name: String,
) -> Result<String, String> {
    let path = history_manager.get_audio_file_path(&file_name);
    path.to_str()
        .ok_or_else(|| "Invalid file path".to_string())
        .map(|s| s.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_history_entry(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
) -> Result<(), String> {
    history_manager
        .delete_entry(id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn retry_history_entry_transcription(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    transcription_manager: State<'_, Arc<TranscriptionManager>>,
    id: i64,
) -> Result<(), String> {
    let entry = history_manager
        .get_entry_by_id(id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("History entry {} not found", id))?;

    // Cleanup prunes recordings but keeps the text, so an entry can outlive its
    // audio. Those cannot be transcribed again.
    if entry.file_name.is_empty() {
        return Err("Recording has been cleaned up".to_string());
    }

    let audio_path = history_manager.get_audio_file_path(&entry.file_name);
    let samples = crate::audio_toolkit::read_wav_samples(&audio_path)
        .map_err(|e| format!("Failed to load audio: {}", e))?;

    if samples.is_empty() {
        return Err("Recording has no audio samples".to_string());
    }

    // Recognize with the same engine a new recording would use, so the
    // recorded route matches what actually ran.
    let settings = crate::settings::get_settings(&app);
    let started = std::time::Instant::now();
    let (transcription, mut asr) =
        if settings.asr_provider == crate::settings::AsrProviderKind::Cloud {
            let cloud = crate::asr::transcribe_cloud(&settings, &samples)
                .await
                .map_err(|e| e.to_string())?;
            let trace = AsrTrace {
                provider: cloud.provider.to_string(),
                model: Some(cloud.model).filter(|m| !m.trim().is_empty()),
                usage: cloud.usage,
                ms: None,
            };
            (cloud.text, trace)
        } else {
            transcription_manager.initiate_model_load();
            let tm = Arc::clone(&transcription_manager);
            let text = tauri::async_runtime::spawn_blocking(move || tm.transcribe(samples))
                .await
                .map_err(|e| format!("Transcription task panicked: {}", e))?
                .map_err(|e| e.to_string())?;
            let trace = AsrTrace {
                provider: LOCAL_ASR_PROVIDER.to_string(),
                model: transcription_manager
                    .get_current_model()
                    .or_else(|| Some(settings.selected_model.clone()))
                    .filter(|m| !m.is_empty()),
                usage: None,
                ms: None,
            };
            (text, trace)
        };
    asr.ms = Some(elapsed_ms(started));

    if transcription.is_empty() {
        return Err("Recording contains no speech".to_string());
    }

    // History does not record the session mode; a retry re-runs dictation.
    let _ = entry.post_process_requested;
    let (post_processed_text, post_process_prompt, llm) = match process_transcription_output(
        &app,
        &transcription,
        crate::voice::SessionMode::Dictate,
        &settings.translate_target_language,
    )
    .await
    {
        Ok(processed) => (
            processed.post_processed_text,
            processed.post_process_prompt,
            processed.llm,
        ),
        Err(_) => (None, None, None),
    };
    history_manager
        .update_transcription(
            id,
            transcription,
            post_processed_text,
            post_process_prompt,
            Some(asr),
            llm,
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn update_history_limit(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    limit: usize,
) -> Result<(), String> {
    let mut settings = crate::settings::get_settings(&app);
    settings.history_limit = limit;
    crate::settings::write_settings(&app, settings);

    history_manager
        .cleanup_old_entries()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn update_recording_retention_period(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    period: String,
) -> Result<(), String> {
    use crate::settings::RecordingRetentionPeriod;

    let retention_period = match period.as_str() {
        "never" => RecordingRetentionPeriod::Never,
        "preserve_limit" => RecordingRetentionPeriod::PreserveLimit,
        "days3" => RecordingRetentionPeriod::Days3,
        "weeks2" => RecordingRetentionPeriod::Weeks2,
        "months3" => RecordingRetentionPeriod::Months3,
        _ => return Err(format!("Invalid retention period: {}", period)),
    };

    let mut settings = crate::settings::get_settings(&app);
    settings.recording_retention_period = retention_period;
    crate::settings::write_settings(&app, settings);

    history_manager
        .cleanup_old_entries()
        .map_err(|e| e.to_string())?;

    Ok(())
}
