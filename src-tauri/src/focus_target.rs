//! Where recognized text is allowed to go.
//!
//! The app that was frontmost when recording started is the target. If the
//! user has switched to another app by the time the text is ready, pasting
//! would put it somewhere they did not intend, so the text is copied instead.
//! Multi-line text is also only copied when the target is a terminal, where a
//! newline can run a command.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontApp {
    pub pid: i32,
    pub bundle_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InsertDecision {
    Paste,
    /// Leave the text on the clipboard and tell the user why.
    CopyOnly(CopyReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyReason {
    TargetChanged,
    TerminalMultiline,
}

const TERMINAL_BUNDLE_IDS: &[&str] = &[
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "dev.warp.Warp-Stable",
    "dev.warp.Warp",
    "com.mitchellh.ghostty",
    "net.kovidgoyal.kitty",
    "org.alacritty",
    "io.alacritty",
    "co.zeit.hyper",
    "com.github.wez.wezterm",
    "com.raphaelamorim.rio",
];

pub fn is_terminal(bundle_id: Option<&str>) -> bool {
    bundle_id.is_some_and(|id| {
        TERMINAL_BUNDLE_IDS
            .iter()
            .any(|t| t.eq_ignore_ascii_case(id))
    })
}

/// Decide whether `text` may be pasted into `current`, given the `target`
/// captured at recording start. Unknown apps (lookup failed) do not block.
pub fn decide_insert(
    target: Option<&FrontApp>,
    current: Option<&FrontApp>,
    text: &str,
) -> InsertDecision {
    if let (Some(target), Some(current)) = (target, current) {
        if target.pid != current.pid {
            return InsertDecision::CopyOnly(CopyReason::TargetChanged);
        }
    }
    let multiline = text.trim_end().contains('\n');
    if multiline && is_terminal(current.and_then(|c| c.bundle_id.as_deref())) {
        return InsertDecision::CopyOnly(CopyReason::TerminalMultiline);
    }
    InsertDecision::Paste
}

/// The frontmost application, if it can be determined.
#[cfg(target_os = "macos")]
pub fn frontmost_app() -> Option<FrontApp> {
    use objc2_app_kit::NSWorkspace;
    let workspace = NSWorkspace::sharedWorkspace();
    let app = workspace.frontmostApplication()?;
    Some(FrontApp {
        pid: app.processIdentifier(),
        bundle_id: app.bundleIdentifier().map(|s| s.to_string()),
    })
}

#[cfg(not(target_os = "macos"))]
pub fn frontmost_app() -> Option<FrontApp> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(pid: i32, bundle: &str) -> FrontApp {
        FrontApp {
            pid,
            bundle_id: Some(bundle.to_string()),
        }
    }

    #[test]
    fn same_app_pastes() {
        let a = app(10, "com.apple.TextEdit");
        assert_eq!(
            decide_insert(Some(&a), Some(&a), "hi\nthere"),
            InsertDecision::Paste
        );
    }

    #[test]
    fn switched_app_copies_instead() {
        let a = app(10, "com.apple.TextEdit");
        let b = app(11, "com.tencent.xinWeChat");
        assert_eq!(
            decide_insert(Some(&a), Some(&b), "hello"),
            InsertDecision::CopyOnly(CopyReason::TargetChanged)
        );
    }

    #[test]
    fn terminal_multiline_copies_but_single_line_pastes() {
        let term = app(20, "com.googlecode.iterm2");
        assert_eq!(
            decide_insert(Some(&term), Some(&term), "ls\nrm -rf build"),
            InsertDecision::CopyOnly(CopyReason::TerminalMultiline)
        );
        assert_eq!(
            decide_insert(Some(&term), Some(&term), "git status\n"),
            InsertDecision::Paste
        );
        assert_eq!(
            decide_insert(Some(&term), Some(&term), "git status"),
            InsertDecision::Paste
        );
    }

    #[test]
    fn unknown_apps_do_not_block() {
        assert_eq!(decide_insert(None, None, "a\nb"), InsertDecision::Paste);
        let a = app(10, "com.apple.TextEdit");
        assert_eq!(decide_insert(Some(&a), None, "x"), InsertDecision::Paste);
    }
}
