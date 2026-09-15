//! macOS system-setting checks that affect Voiceless shortcuts.

use serde::Serialize;
use specta::Type;

/// What macOS does when the Fn/Globe key is pressed on its own
/// (`com.apple.HIToolbox AppleFnUsageType`). Anything other than "do nothing"
/// makes a bare Fn shortcut also switch input source, show emoji, or start
/// system dictation.
#[derive(Serialize, Type, Debug, Clone, PartialEq, Eq)]
pub struct FnKeyUsage {
    /// Raw value, `None` when the key is unset or unreadable.
    pub value: Option<i32>,
    /// `do_nothing` | `change_input_source` | `emoji` | `dictation` | `unknown`
    pub action: String,
    /// True when a bare Fn shortcut will not collide with a system action.
    pub compatible: bool,
}

pub fn classify_fn_usage(value: Option<i32>) -> FnKeyUsage {
    let action = match value {
        Some(0) => "do_nothing",
        Some(1) => "change_input_source",
        Some(2) => "emoji",
        Some(3) => "dictation",
        _ => "unknown",
    };
    FnKeyUsage {
        value,
        action: action.to_string(),
        compatible: value == Some(0),
    }
}

/// Read `AppleFnUsageType` without modifying it. Voiceless never writes this
/// preference; the UI only links the user to Keyboard settings.
#[tauri::command]
#[specta::specta]
pub fn get_fn_key_usage() -> FnKeyUsage {
    #[cfg(target_os = "macos")]
    {
        let value = std::process::Command::new("/usr/bin/defaults")
            .args(["read", "com.apple.HIToolbox", "AppleFnUsageType"])
            .output()
            .ok()
            .filter(|out| out.status.success())
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .and_then(|s| s.trim().parse::<i32>().ok());
        classify_fn_usage(value)
    }
    #[cfg(not(target_os = "macos"))]
    {
        FnKeyUsage {
            value: None,
            action: "unknown".to_string(),
            compatible: true,
        }
    }
}

/// Open a System Settings pane relevant to Voiceless.
/// `pane`: `keyboard` | `accessibility` | `input_monitoring` | `microphone`.
#[tauri::command]
#[specta::specta]
pub fn open_system_settings_pane(pane: String) -> Result<(), String> {
    let url = match pane.as_str() {
        "keyboard" => "x-apple.systempreferences:com.apple.Keyboard-Settings.extension",
        "accessibility" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
        "input_monitoring" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
        }
        "microphone" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        }
        other => return Err(format!("Unknown settings pane: {other}")),
    };
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg(url)
            .status()
            .map_err(|e| format!("Failed to open System Settings: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        Err("System Settings panes are only available on macOS".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_do_nothing_is_compatible() {
        assert!(classify_fn_usage(Some(0)).compatible);
        for v in [Some(1), Some(2), Some(3), None] {
            assert!(!classify_fn_usage(v).compatible, "{v:?}");
        }
        assert_eq!(classify_fn_usage(Some(1)).action, "change_input_source");
        assert_eq!(classify_fn_usage(None).action, "unknown");
    }
}
