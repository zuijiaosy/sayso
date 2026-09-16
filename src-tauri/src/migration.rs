//! One-time migration of the app-data directory across bundle-identifier
//! renames.
//!
//! The app data dir is derived from the bundle identifier, so changing the
//! identifier points the app at an empty directory and the user appears to have
//! lost their settings, history and (multi-gigabyte) downloaded models.
//!
//! On startup, if the current data dir has no settings store but a directory
//! from a previous identifier does, the old one is adopted. macOS TCC grants are
//! keyed on the identifier and signature, so microphone/accessibility
//! permissions still have to be granted again; that is unavoidable here.
//!
//! # Why this runs before Tauri starts
//!
//! `tauri-plugin-store` caches a store in memory the first time it is opened and
//! never re-reads it from disk. If the store is opened while the new data dir is
//! still empty, the plugin caches an empty store; moving the real file in
//! afterwards has no effect, and the first settings write persists the cached
//! defaults over it — silently wiping API keys and the dictionary. So this runs
//! from `run()` before the Tauri builder exists, which is also why it resolves
//! the data directory itself instead of taking an `AppHandle`.

use std::path::{Path, PathBuf};

/// Must match `identifier` in `tauri.conf.json` (asserted by a test below).
const APP_IDENTIFIER: &str = "com.sayso.desktop";

/// Bundle identifiers this app shipped under before, newest first.
const LEGACY_IDENTIFIERS: [&str; 1] = ["com.voiceless.desktop"];

/// Name of the settings store, duplicated from `settings::SETTINGS_STORE_PATH`
/// because that module is not reachable this early without an `AppHandle`.
const SETTINGS_STORE: &str = "settings_store.json";

/// The platform data directory Tauri derives `app_data_dir()` from, i.e.
/// `dirs::data_dir()`. Kept dependency-free: this is the only place that needs
/// it, and it runs before any Tauri path resolver exists.
fn platform_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join("Library").join("Application Support"))
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(PathBuf::from)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .map(|home| home.join(".local").join("share"))
            })
    }
}

/// Adopt a previous identifier's data directory if the current one is unused.
///
/// Must run before anything opens the settings store. Never fatal: a failed
/// migration leaves the user with defaults rather than a crash, and the old
/// directory is only ever read, so a partial copy can be retried by deleting the
/// new dir.
pub fn migrate_legacy_data_dir() {
    // Portable installs keep their data next to the executable, where the
    // identifier plays no part.
    if crate::portable::is_portable() {
        return;
    }

    let Some(parent) = platform_data_dir() else {
        return;
    };
    let new_dir = parent.join(APP_IDENTIFIER);

    // The presence of a settings store is what marks a directory as "in use".
    if new_dir.join(SETTINGS_STORE).exists() {
        return;
    }

    for legacy in LEGACY_IDENTIFIERS {
        let old_dir = parent.join(legacy);
        if old_dir == new_dir || !old_dir.is_dir() || !old_dir.join(SETTINGS_STORE).exists() {
            continue;
        }

        // Logging is not initialized this early, so report on stderr the way
        // `portable::init` does.
        eprintln!(
            "[migration] adopting data dir {} -> {}",
            old_dir.display(),
            new_dir.display()
        );
        match adopt_dir(&old_dir, &new_dir) {
            Ok(Adopted::Renamed) => eprintln!("[migration] complete (moved)"),
            Ok(Adopted::Copied) => eprintln!(
                "[migration] complete (copied); the old directory can be deleted: {}",
                old_dir.display()
            ),
            Err(e) => eprintln!("[migration] failed, starting fresh: {e}"),
        }
        return;
    }
}

#[derive(Debug)]
enum Adopted {
    Renamed,
    Copied,
}

/// Move `old_dir` onto `new_dir`, falling back to a recursive copy.
///
/// The rename is preferred because the models directory routinely holds several
/// gigabytes and copying it would transiently double that. It only works when
/// `new_dir` does not exist yet and both sides are on one volume.
fn adopt_dir(old_dir: &Path, new_dir: &Path) -> std::io::Result<Adopted> {
    let new_is_empty = match std::fs::read_dir(new_dir) {
        Ok(mut entries) => entries.next().is_none(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(e) => return Err(e),
    };

    if new_is_empty {
        // rename() needs the destination to not exist (or to be an empty dir on
        // some platforms); remove the empty placeholder if one is there.
        let _ = std::fs::remove_dir(new_dir);
        if std::fs::rename(old_dir, new_dir).is_ok() {
            return Ok(Adopted::Renamed);
        }
    }

    copy_dir_recursive(old_dir, new_dir)?;
    Ok(Adopted::Copied)
}

fn copy_dir_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&src, &dest)?;
        } else if !dest.exists() {
            std::fs::copy(&src, &dest)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    /// The identifier is duplicated from tauri.conf.json (this module runs
    /// before any Tauri config is loaded); catch the two drifting apart.
    #[test]
    fn app_identifier_matches_tauri_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"].as_str(), Some(APP_IDENTIFIER));
    }

    #[test]
    fn adopts_by_rename_when_destination_is_absent() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old");
        let new = root.path().join("new");
        write(&old.join(SETTINGS_STORE), "{}");
        write(&old.join("models").join("a.bin"), "weights");

        let adopted = adopt_dir(&old, &new).unwrap();

        assert!(matches!(adopted, Adopted::Renamed));
        assert!(!old.exists(), "rename should not leave the old dir behind");
        assert_eq!(
            std::fs::read_to_string(new.join("models").join("a.bin")).unwrap(),
            "weights"
        );
    }

    #[test]
    fn falls_back_to_copy_when_destination_has_files() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old");
        let new = root.path().join("new");
        write(&old.join(SETTINGS_STORE), "{}");
        write(&old.join("history.db"), "sqlite");
        write(&new.join("logs").join("app.log"), "existing");

        let adopted = adopt_dir(&old, &new).unwrap();

        assert!(matches!(adopted, Adopted::Copied));
        assert!(old.exists(), "copy must leave the old dir intact");
        assert_eq!(
            std::fs::read_to_string(new.join("history.db")).unwrap(),
            "sqlite"
        );
        assert_eq!(
            std::fs::read_to_string(new.join("logs").join("app.log")).unwrap(),
            "existing",
            "pre-existing files in the destination win"
        );
    }

    #[test]
    fn copy_does_not_overwrite_existing_files() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old");
        let new = root.path().join("new");
        write(&old.join(SETTINGS_STORE), "old");
        write(&new.join(SETTINGS_STORE), "new");

        copy_dir_recursive(&old, &new).unwrap();

        assert_eq!(
            std::fs::read_to_string(new.join(SETTINGS_STORE)).unwrap(),
            "new"
        );
    }

    #[test]
    fn platform_data_dir_is_absolute() {
        let dir = platform_data_dir().expect("HOME/APPDATA should be set in tests");
        assert!(dir.is_absolute(), "got {dir:?}");
    }
}
