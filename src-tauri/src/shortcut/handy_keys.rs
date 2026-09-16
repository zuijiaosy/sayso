//! Handy-keys based keyboard shortcut implementation
//!
//! This module provides an alternative to Tauri's global-shortcut plugin
//! using the handy-keys library for more control over keyboard events.
//!
//! ## Architecture
//!
//! The implementation uses a dedicated manager thread that owns the `HotkeyManager`:
//!
//! ```text
//! ┌─────────────────┐     commands      ┌──────────────────────┐
//! │   Main Thread   │ ───────────────▶ │   Manager Thread     │
//! │                 │   (via channel)   │                      │
//! │ - register()    │                   │ - owns HotkeyManager │
//! │ - unregister()  │                   │ - polls for events   │
//! └─────────────────┘                   │ - dispatches actions │
//!                                       └──────────────────────┘
//! ```
//!
//! This design ensures thread-safety since `HotkeyManager` is only accessed
//! from a single thread. Commands (register/unregister) are sent via an mpsc
//! channel and responses are synchronously awaited.
//!
//! ## Modifier-only shortcuts on macOS
//!
//! `HotkeyManager::new_with_blocking` deletes every matching event so it never
//! reaches other applications. That is required for shortcuts with a regular
//! key (Option+Space would otherwise type a space), but for modifier-only
//! shortcuts such as Fn it swallows the modifier press itself: every other app
//! then sees Fn released without ever seeing it pressed, and stops working
//! with Fn. On macOS modifier-only shortcuts are therefore matched by
//! [`ModifierOnlyMatcher`] against a listen-only [`KeyboardListener`], which
//! passes every event through untouched. The matcher also reports a regular
//! key pressed while such a shortcut is held (Fn + F), so the dictation that
//! the Fn press started can be discarded.
//!
//! ## Recording Mode
//!
//! For UI key capture, a separate `KeyboardListener` is created on-demand and
//! polled from a dedicated recording thread. Events are emitted to the frontend
//! via Tauri's event system.

use handy_keys::{Hotkey, HotkeyId, HotkeyManager, HotkeyState, Key, KeyEvent, KeyboardListener};
use log::{debug, error, info};
use serde::Serialize;
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use tauri::{AppHandle, Emitter, Manager};

use crate::settings::{self, get_settings, ShortcutBinding};

use super::handler::{handle_key_combination, handle_shortcut_event};

/// Commands that can be sent to the hotkey manager thread
enum ManagerCommand {
    Register {
        binding_id: String,
        hotkey_string: String,
        response: Sender<Result<(), String>>,
    },
    Unregister {
        binding_id: String,
        response: Sender<Result<(), String>>,
    },
    Shutdown,
}

/// Output of [`ModifierOnlyMatcher::process`].
#[derive(Debug, Clone, PartialEq, Eq)]
enum MatcherSignal {
    /// A modifier-only shortcut was pressed or released.
    Shortcut {
        binding_id: String,
        hotkey_string: String,
        is_pressed: bool,
    },
    /// A regular key went down while a modifier-only shortcut was held.
    KeyCombination,
}

/// Matches modifier-only shortcuts (e.g. `fn`, `fn+shift_left`) against raw
/// key events from a listen-only listener, with the same press/release rules
/// as `handy_keys::HotkeyManager`.
#[derive(Default)]
struct ModifierOnlyMatcher {
    /// binding_id -> (hotkey, hotkey string)
    hotkeys: HashMap<String, (Hotkey, String)>,
    /// Bindings whose shortcut is currently held.
    pressed: HashSet<String>,
}

impl ModifierOnlyMatcher {
    fn register(
        &mut self,
        binding_id: &str,
        hotkey: Hotkey,
        hotkey_string: &str,
    ) -> Result<(), String> {
        if self
            .hotkeys
            .values()
            .any(|(existing, _)| *existing == hotkey)
        {
            return Err(format!(
                "Failed to register hotkey: already registered: {}",
                hotkey_string
            ));
        }
        self.pressed.remove(binding_id);
        self.hotkeys
            .insert(binding_id.to_string(), (hotkey, hotkey_string.to_string()));
        Ok(())
    }

    /// Returns whether the binding was registered here.
    fn unregister(&mut self, binding_id: &str) -> bool {
        self.pressed.remove(binding_id);
        self.hotkeys.remove(binding_id).is_some()
    }

    fn process(&mut self, event: &KeyEvent) -> Vec<MatcherSignal> {
        let mut signals = Vec::new();

        if event.is_key_down {
            if let Some(key) = event.key {
                // Mouse buttons are reported with modifiers held; clicking while
                // dictating is not a key combination.
                if !self.pressed.is_empty() && !is_mouse_key(key) {
                    signals.push(MatcherSignal::KeyCombination);
                }
                return signals;
            }
            for (binding_id, (hotkey, hotkey_string)) in &self.hotkeys {
                if hotkey.modifiers.matches(event.modifiers) && !self.pressed.contains(binding_id) {
                    self.pressed.insert(binding_id.clone());
                    signals.push(MatcherSignal::Shortcut {
                        binding_id: binding_id.clone(),
                        hotkey_string: hotkey_string.clone(),
                        is_pressed: true,
                    });
                }
            }
        } else if event.key.is_none() {
            // A modifier went up: release every held shortcut whose modifiers
            // no longer match.
            for (binding_id, (hotkey, hotkey_string)) in &self.hotkeys {
                if self.pressed.contains(binding_id) && !hotkey.modifiers.matches(event.modifiers) {
                    self.pressed.remove(binding_id);
                    signals.push(MatcherSignal::Shortcut {
                        binding_id: binding_id.clone(),
                        hotkey_string: hotkey_string.clone(),
                        is_pressed: false,
                    });
                }
            }
        }

        signals
    }
}

fn is_mouse_key(key: Key) -> bool {
    matches!(
        key,
        Key::MouseLeft | Key::MouseRight | Key::MouseMiddle | Key::MouseX1 | Key::MouseX2
    )
}

/// A listen-only keyboard listener for modifier-only shortcuts, on macOS only.
/// Elsewhere (and if it cannot be created) every shortcut uses the blocking
/// manager as before.
fn create_passthrough_listener() -> Option<KeyboardListener> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    match KeyboardListener::new() {
        Ok(listener) => Some(listener),
        Err(e) => {
            error!(
                "Failed to create listen-only keyboard listener; modifier-only shortcuts will block: {}",
                e
            );
            None
        }
    }
}

/// State for the handy-keys shortcut manager
pub struct HandyKeysState {
    /// Channel to send commands to the manager thread (wrapped in Mutex for Sync)
    command_sender: Mutex<Sender<ManagerCommand>>,
    /// Handle to the manager thread (wrapped in Mutex for Sync, allows proper join on drop)
    thread_handle: Mutex<Option<JoinHandle<()>>>,
    /// Recording listener for UI key capture (only active during recording)
    recording_listener: Mutex<Option<KeyboardListener>>,
    /// Flag indicating if we're in recording mode
    is_recording: AtomicBool,
    /// The binding ID being recorded (if any)
    recording_binding_id: Mutex<Option<String>>,
    /// Flag to stop recording loop
    recording_running: Arc<AtomicBool>,
}

/// Key event sent to frontend during recording mode
#[derive(Debug, Clone, Serialize, Type)]
pub struct FrontendKeyEvent {
    /// Currently pressed modifier keys
    pub modifiers: Vec<String>,
    /// The key that was pressed (if any)
    pub key: Option<String>,
    /// Whether this is a key down event
    pub is_key_down: bool,
    /// The full hotkey string (e.g., "option+space")
    pub hotkey_string: String,
}

impl HandyKeysState {
    /// Create a new HandyKeysState
    pub fn new(app: AppHandle) -> Result<Self, String> {
        let (cmd_tx, cmd_rx) = mpsc::channel::<ManagerCommand>();

        // Start the manager thread
        let app_clone = app.clone();
        let thread_handle = thread::spawn(move || {
            Self::manager_thread(cmd_rx, app_clone);
        });

        Ok(Self {
            command_sender: Mutex::new(cmd_tx),
            thread_handle: Mutex::new(Some(thread_handle)),
            recording_listener: Mutex::new(None),
            is_recording: AtomicBool::new(false),
            recording_binding_id: Mutex::new(None),
            recording_running: Arc::new(AtomicBool::new(false)),
        })
    }

    /// The main manager thread - owns the HotkeyManager and processes commands
    fn manager_thread(cmd_rx: Receiver<ManagerCommand>, app: AppHandle) {
        info!("handy-keys manager thread started");

        // Create the HotkeyManager in this thread
        let manager = match HotkeyManager::new_with_blocking() {
            Ok(m) => m,
            Err(e) => {
                error!("Failed to create HotkeyManager: {}", e);
                return;
            }
        };

        // Maps binding IDs to HotkeyIds and hotkey strings
        let mut binding_to_hotkey: HashMap<String, HotkeyId> = HashMap::new();
        let mut hotkey_to_binding: HashMap<HotkeyId, (String, String)> = HashMap::new(); // (binding_id, hotkey_string)

        let passthrough_listener = create_passthrough_listener();
        let mut matcher = ModifierOnlyMatcher::default();

        loop {
            // Modifier-only shortcuts, observed without blocking any event
            if let Some(listener) = &passthrough_listener {
                while let Some(key_event) = listener.try_recv() {
                    for signal in matcher.process(&key_event) {
                        match signal {
                            MatcherSignal::Shortcut {
                                binding_id,
                                hotkey_string,
                                is_pressed,
                            } => {
                                debug!(
                                    "handy-keys passthrough event: binding={}, hotkey={}, pressed={}",
                                    binding_id, hotkey_string, is_pressed
                                );
                                handle_shortcut_event(
                                    &app,
                                    &binding_id,
                                    &hotkey_string,
                                    is_pressed,
                                );
                            }
                            MatcherSignal::KeyCombination => handle_key_combination(&app),
                        }
                    }
                }
            }

            // Check for hotkey events (non-blocking)
            while let Some(event) = manager.try_recv() {
                if let Some((binding_id, hotkey_string)) = hotkey_to_binding.get(&event.id) {
                    debug!(
                        "handy-keys event: binding={}, hotkey={}, state={:?}",
                        binding_id, hotkey_string, event.state
                    );
                    let is_pressed = event.state == HotkeyState::Pressed;
                    handle_shortcut_event(&app, binding_id, hotkey_string, is_pressed);
                }
            }

            // Check for commands (non-blocking with timeout)
            match cmd_rx.recv_timeout(std::time::Duration::from_millis(10)) {
                Ok(cmd) => match cmd {
                    ManagerCommand::Register {
                        binding_id,
                        hotkey_string,
                        response,
                    } => {
                        let result = Self::do_register(
                            &manager,
                            passthrough_listener.is_some().then_some(&mut matcher),
                            &mut binding_to_hotkey,
                            &mut hotkey_to_binding,
                            &binding_id,
                            &hotkey_string,
                        );
                        let _ = response.send(result);
                    }
                    ManagerCommand::Unregister {
                        binding_id,
                        response,
                    } => {
                        let result = Self::do_unregister(
                            &manager,
                            &mut matcher,
                            &mut binding_to_hotkey,
                            &mut hotkey_to_binding,
                            &binding_id,
                        );
                        let _ = response.send(result);
                    }
                    ManagerCommand::Shutdown => {
                        info!("handy-keys manager thread shutting down");
                        break;
                    }
                },
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    // No command, continue
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    info!("Command channel disconnected, shutting down");
                    break;
                }
            }
        }

        info!("handy-keys manager thread stopped");
    }

    /// Register a hotkey
    fn do_register(
        manager: &HotkeyManager,
        passthrough: Option<&mut ModifierOnlyMatcher>,
        binding_to_hotkey: &mut HashMap<String, HotkeyId>,
        hotkey_to_binding: &mut HashMap<HotkeyId, (String, String)>,
        binding_id: &str,
        hotkey_string: &str,
    ) -> Result<(), String> {
        let hotkey: Hotkey = hotkey_string
            .parse()
            .map_err(|e| format!("Failed to parse hotkey '{}': {}", hotkey_string, e))?;

        if hotkey.key.is_none() {
            if let Some(matcher) = passthrough {
                matcher.register(binding_id, hotkey, hotkey_string)?;
                debug!(
                    "Registered listen-only handy-keys shortcut: {} -> {:?}",
                    binding_id, hotkey
                );
                return Ok(());
            }
        }

        let id = manager
            .register(hotkey)
            .map_err(|e| format!("Failed to register hotkey: {}", e))?;

        binding_to_hotkey.insert(binding_id.to_string(), id);
        hotkey_to_binding.insert(id, (binding_id.to_string(), hotkey_string.to_string()));

        debug!(
            "Registered handy-keys shortcut: {} -> {:?}",
            binding_id, hotkey
        );
        Ok(())
    }

    /// Unregister a hotkey
    fn do_unregister(
        manager: &HotkeyManager,
        matcher: &mut ModifierOnlyMatcher,
        binding_to_hotkey: &mut HashMap<String, HotkeyId>,
        hotkey_to_binding: &mut HashMap<HotkeyId, (String, String)>,
        binding_id: &str,
    ) -> Result<(), String> {
        if matcher.unregister(binding_id) {
            debug!(
                "Unregistered listen-only handy-keys shortcut: {}",
                binding_id
            );
            return Ok(());
        }
        if let Some(id) = binding_to_hotkey.remove(binding_id) {
            manager
                .unregister(id)
                .map_err(|e| format!("Failed to unregister hotkey: {}", e))?;
            hotkey_to_binding.remove(&id);
            debug!("Unregistered handy-keys shortcut: {}", binding_id);
        }
        Ok(())
    }

    /// Register a shortcut binding
    pub fn register(&self, binding: &ShortcutBinding) -> Result<(), String> {
        // An unset optional shortcut ("add another") has nothing to register.
        if binding.current_binding.trim().is_empty() {
            return Ok(());
        }
        let (tx, rx) = mpsc::channel();
        self.command_sender
            .lock()
            .map_err(|_| "Failed to lock command_sender")?
            .send(ManagerCommand::Register {
                binding_id: binding.id.clone(),
                hotkey_string: binding.current_binding.clone(),
                response: tx,
            })
            .map_err(|_| "Failed to send register command")?;

        rx.recv()
            .map_err(|_| "Failed to receive register response")?
    }

    /// Unregister a shortcut binding
    pub fn unregister(&self, binding: &ShortcutBinding) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        self.command_sender
            .lock()
            .map_err(|_| "Failed to lock command_sender")?
            .send(ManagerCommand::Unregister {
                binding_id: binding.id.clone(),
                response: tx,
            })
            .map_err(|_| "Failed to send unregister command")?;

        rx.recv()
            .map_err(|_| "Failed to receive unregister response")?
    }

    /// Start recording mode for a specific binding
    pub fn start_recording(&self, app: &AppHandle, binding_id: String) -> Result<(), String> {
        if self.is_recording.load(Ordering::SeqCst) {
            return Err("Already recording".into());
        }

        // Create a new keyboard listener for recording
        let listener = KeyboardListener::new()
            .map_err(|e| format!("Failed to create keyboard listener: {}", e))?;

        {
            let mut recording = self
                .recording_listener
                .lock()
                .map_err(|_| "Failed to lock recording_listener")?;
            *recording = Some(listener);
        }
        {
            let mut binding = self
                .recording_binding_id
                .lock()
                .map_err(|_| "Failed to lock recording_binding_id")?;
            *binding = Some(binding_id);
        }

        self.is_recording.store(true, Ordering::SeqCst);
        self.recording_running.store(true, Ordering::SeqCst);

        // Start a thread to emit key events to the frontend
        let app_clone = app.clone();
        let recording_running = Arc::clone(&self.recording_running);
        thread::spawn(move || {
            Self::recording_loop(app_clone, recording_running);
        });

        debug!("Started handy-keys recording mode");
        Ok(())
    }

    /// Recording loop - emits key events to frontend during recording
    fn recording_loop(app: AppHandle, running: Arc<AtomicBool>) {
        while running.load(Ordering::SeqCst) {
            let event = {
                let state = match app.try_state::<HandyKeysState>() {
                    Some(s) => s,
                    None => break,
                };
                let listener = state.recording_listener.lock().ok();
                listener.as_ref().and_then(|l| l.as_ref()?.try_recv())
            };

            if let Some(key_event) = event {
                // Convert to frontend-friendly format
                let frontend_event = FrontendKeyEvent {
                    modifiers: modifiers_to_strings(key_event.modifiers),
                    key: key_event.key.map(|k| k.to_string().to_lowercase()),
                    is_key_down: key_event.is_key_down,
                    hotkey_string: key_event
                        .as_hotkey()
                        .map(|h| h.to_handy_string())
                        .unwrap_or_default(),
                };

                // Emit to frontend
                if let Err(e) = app.emit("handy-keys-event", &frontend_event) {
                    error!("Failed to emit key event: {}", e);
                }
            } else {
                thread::sleep(std::time::Duration::from_millis(10));
            }
        }

        debug!("Recording loop ended");
    }

    /// Stop recording mode
    pub fn stop_recording(&self) -> Result<(), String> {
        self.is_recording.store(false, Ordering::SeqCst);
        self.recording_running.store(false, Ordering::SeqCst);

        {
            let mut recording = self
                .recording_listener
                .lock()
                .map_err(|_| "Failed to lock recording_listener")?;
            *recording = None;
        }
        {
            let mut binding = self
                .recording_binding_id
                .lock()
                .map_err(|_| "Failed to lock recording_binding_id")?;
            *binding = None;
        }

        debug!("Stopped handy-keys recording mode");
        Ok(())
    }
}

impl Drop for HandyKeysState {
    fn drop(&mut self) {
        // Signal recording to stop
        self.recording_running.store(false, Ordering::SeqCst);
        self.is_recording.store(false, Ordering::SeqCst);

        // Send shutdown command
        if let Ok(sender) = self.command_sender.lock() {
            let _ = sender.send(ManagerCommand::Shutdown);
        }

        // Wait for the manager thread to finish
        if let Ok(mut handle) = self.thread_handle.lock() {
            if let Some(h) = handle.take() {
                let _ = h.join();
            }
        }
    }
}

/// Convert handy-keys Modifiers to a list of strings
fn modifiers_to_strings(modifiers: handy_keys::Modifiers) -> Vec<String> {
    let mut result = Vec::new();

    if modifiers.contains(handy_keys::Modifiers::CTRL) {
        result.push("ctrl".to_string());
    }
    if modifiers.contains(handy_keys::Modifiers::OPT) {
        #[cfg(target_os = "macos")]
        result.push("option".to_string());
        #[cfg(not(target_os = "macos"))]
        result.push("alt".to_string());
    }
    if modifiers.contains(handy_keys::Modifiers::SHIFT) {
        result.push("shift".to_string());
    }
    if modifiers.contains(handy_keys::Modifiers::CMD) {
        #[cfg(target_os = "macos")]
        result.push("command".to_string());
        #[cfg(not(target_os = "macos"))]
        result.push("super".to_string());
    }
    if modifiers.contains(handy_keys::Modifiers::FN) {
        result.push("fn".to_string());
    }

    result
}

/// Validate a shortcut string for the HandyKeys implementation.
/// HandyKeys is more permissive: allows modifier-only combos and the fn key.
pub fn validate_shortcut(raw: &str) -> Result<(), String> {
    if raw.trim().is_empty() {
        return Err("Shortcut cannot be empty".into());
    }
    // HandyKeys accepts modifier-only, key-only, and modifier+key combos
    // Just verify the string is parseable
    raw.parse::<Hotkey>()
        .map(|_| ())
        .map_err(|e| format!("Invalid shortcut for HandyKeys: {}", e))
}

/// Initialize handy-keys shortcuts
pub fn init_shortcuts(app: &AppHandle) -> Result<(), String> {
    let state = HandyKeysState::new(app.clone())?;

    let default_bindings = settings::get_default_settings().bindings;
    let user_settings = settings::load_or_create_app_settings(app);

    // Register all bindings except cancel (which is dynamic)
    for (id, default_binding) in default_bindings {
        if id == "cancel" {
            continue;
        }
        // Skip post-processing shortcut when the feature is disabled
        if id == "transcribe_with_post_process" && !user_settings.post_process_enabled {
            continue;
        }

        let binding = user_settings
            .bindings
            .get(&id)
            .cloned()
            .unwrap_or(default_binding);

        if let Err(e) = state.register(&binding) {
            error!(
                "Failed to register handy-keys shortcut {} during init: {}",
                id, e
            );
        }
    }

    app.manage(state);
    info!("handy-keys shortcuts initialized");
    Ok(())
}

/// Register the cancel shortcut (called when recording starts)
pub fn register_cancel_shortcut(app: &AppHandle) {
    // Disabled on Linux due to instability
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        return;
    }

    #[cfg(not(target_os = "linux"))]
    {
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(cancel_binding) = get_settings(&app_clone).bindings.get("cancel").cloned() {
                if let Some(state) = app_clone.try_state::<HandyKeysState>() {
                    if let Err(e) = state.register(&cancel_binding) {
                        error!("Failed to register cancel shortcut: {}", e);
                    }
                }
            }
        });
    }
}

/// Unregister the cancel shortcut (called when recording stops)
pub fn unregister_cancel_shortcut(app: &AppHandle) {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        return;
    }

    #[cfg(not(target_os = "linux"))]
    {
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(cancel_binding) = get_settings(&app_clone).bindings.get("cancel").cloned() {
                if let Some(state) = app_clone.try_state::<HandyKeysState>() {
                    let _ = state.unregister(&cancel_binding);
                }
            }
        });
    }
}

/// Register a shortcut
pub fn register_shortcut(app: &AppHandle, binding: ShortcutBinding) -> Result<(), String> {
    let state = app
        .try_state::<HandyKeysState>()
        .ok_or("HandyKeysState not initialized")?;
    state.register(&binding)
}

/// Unregister a shortcut
pub fn unregister_shortcut(app: &AppHandle, binding: ShortcutBinding) -> Result<(), String> {
    let state = app
        .try_state::<HandyKeysState>()
        .ok_or("HandyKeysState not initialized")?;
    state.unregister(&binding)
}

/// Start key recording mode
#[tauri::command]
#[specta::specta]
pub fn start_handy_keys_recording(app: AppHandle, binding_id: String) -> Result<(), String> {
    let settings = get_settings(&app);
    if settings.keyboard_implementation != settings::KeyboardImplementation::HandyKeys {
        return Err("handy-keys is not the active keyboard implementation".into());
    }

    // While Secure Input is active the tap receives no KeyDown/KeyUp, so the
    // recorder would silently capture just the modifier and overwrite the
    // binding with it (issue #1578). Refuse instead; the frontend maps this
    // marker to a localized explanation, and the noted impact makes the
    // warning banner appear with the full story.
    if crate::secure_input::is_enabled_now() {
        crate::secure_input::note_recorder_blocked(&app);
        return Err("secure-input-active".into());
    }

    let state = app
        .try_state::<HandyKeysState>()
        .ok_or("HandyKeysState not initialized")?;

    // Suspend every registered shortcut so a combo that overlaps an existing
    // binding can't fire it (or have its keys swallowed) mid-capture.
    super::suspend_all_shortcuts(&app);

    let result = state.start_recording(&app, binding_id);
    if result.is_err() {
        super::resume_all_shortcuts(&app);
    }
    result
}

/// Stop key recording mode
#[tauri::command]
#[specta::specta]
pub fn stop_handy_keys_recording(app: AppHandle) -> Result<(), String> {
    let settings = get_settings(&app);
    if settings.keyboard_implementation != settings::KeyboardImplementation::HandyKeys {
        return Err("handy-keys is not the active keyboard implementation".into());
    }

    let state = app
        .try_state::<HandyKeysState>()
        .ok_or("HandyKeysState not initialized")?;

    // Restore shortcuts from settings regardless of how recording ended.
    // A commit has already registered the new binding via change_binding;
    // re-registering it here fails cleanly and is ignored.
    let result = state.stop_recording();
    super::resume_all_shortcuts(&app);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use handy_keys::Modifiers;

    fn modifier_event(modifiers: Modifiers, is_key_down: bool) -> KeyEvent {
        KeyEvent {
            modifiers,
            key: None,
            is_key_down,
            changed_modifier: None,
        }
    }

    fn key_event(modifiers: Modifiers, key: Key, is_key_down: bool) -> KeyEvent {
        KeyEvent {
            modifiers,
            key: Some(key),
            is_key_down,
            changed_modifier: None,
        }
    }

    fn matcher_with(bindings: &[(&str, &str)]) -> ModifierOnlyMatcher {
        let mut matcher = ModifierOnlyMatcher::default();
        for (binding_id, hotkey_string) in bindings {
            let hotkey: Hotkey = hotkey_string.parse().unwrap();
            matcher.register(binding_id, hotkey, hotkey_string).unwrap();
        }
        matcher
    }

    fn shortcut(binding_id: &str, is_pressed: bool) -> MatcherSignal {
        MatcherSignal::Shortcut {
            binding_id: binding_id.to_string(),
            hotkey_string: if binding_id == "transcribe" {
                "fn".to_string()
            } else {
                "fn+shift_left".to_string()
            },
            is_pressed,
        }
    }

    #[test]
    fn fn_press_and_release_fire_the_shortcut() {
        let mut matcher = matcher_with(&[("transcribe", "fn")]);
        assert_eq!(
            matcher.process(&modifier_event(Modifiers::FN, true)),
            vec![shortcut("transcribe", true)]
        );
        assert_eq!(
            matcher.process(&modifier_event(Modifiers::empty(), false)),
            vec![shortcut("transcribe", false)]
        );
    }

    #[test]
    fn regular_key_while_fn_held_is_a_key_combination() {
        let mut matcher = matcher_with(&[("transcribe", "fn")]);
        matcher.process(&modifier_event(Modifiers::FN, true));
        assert_eq!(
            matcher.process(&key_event(Modifiers::FN, Key::F, true)),
            vec![MatcherSignal::KeyCombination]
        );
        // The key-up of the combination is not reported again.
        assert!(matcher
            .process(&key_event(Modifiers::FN, Key::F, false))
            .is_empty());
    }

    #[test]
    fn keys_without_a_held_shortcut_are_ignored() {
        let mut matcher = matcher_with(&[("transcribe", "fn")]);
        assert!(matcher
            .process(&key_event(Modifiers::empty(), Key::F, true))
            .is_empty());
        matcher.process(&modifier_event(Modifiers::FN, true));
        matcher.process(&modifier_event(Modifiers::empty(), false));
        assert!(matcher
            .process(&key_event(Modifiers::empty(), Key::F, true))
            .is_empty());
    }

    #[test]
    fn mouse_click_while_fn_held_is_not_a_key_combination() {
        let mut matcher = matcher_with(&[("transcribe", "fn")]);
        matcher.process(&modifier_event(Modifiers::FN, true));
        assert!(matcher
            .process(&key_event(Modifiers::FN, Key::MouseLeft, true))
            .is_empty());
    }

    #[test]
    fn fn_then_left_shift_presses_translate_and_keeps_dictate_held() {
        let mut matcher = matcher_with(&[("transcribe", "fn"), ("translate", "fn+shift_left")]);
        assert_eq!(
            matcher.process(&modifier_event(Modifiers::FN, true)),
            vec![shortcut("transcribe", true)]
        );
        assert_eq!(
            matcher.process(&modifier_event(Modifiers::FN | Modifiers::SHIFT_LEFT, true)),
            vec![shortcut("translate", true)]
        );
        // Shift up releases translate only; Fn is still held.
        assert_eq!(
            matcher.process(&modifier_event(Modifiers::FN, false)),
            vec![shortcut("translate", false)]
        );
        assert_eq!(
            matcher.process(&modifier_event(Modifiers::empty(), false)),
            vec![shortcut("transcribe", false)]
        );
    }

    #[test]
    fn duplicate_hotkey_is_rejected_and_unregister_clears_held_state() {
        let mut matcher = matcher_with(&[("transcribe", "fn")]);
        let hotkey: Hotkey = "fn".parse().unwrap();
        assert!(matcher.register("transcribe", hotkey, "fn").is_err());

        matcher.process(&modifier_event(Modifiers::FN, true));
        assert!(matcher.unregister("transcribe"));
        assert!(!matcher.unregister("transcribe"));
        assert!(matcher
            .process(&key_event(Modifiers::FN, Key::F, true))
            .is_empty());
    }
}
