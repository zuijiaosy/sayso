//! Commands for Voiceless dictate / translate sessions.

use crate::actions::{paste_and_finish, run_text_model, show_translation_failure};
use crate::settings::{get_settings, write_settings, DictationPostMode, DictionaryEntry};
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
