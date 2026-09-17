//! Which engines produced a transcript, and what they reported spending.
//!
//! Recorded with every history entry so the History page can show whether a
//! sentence went through a local model or a cloud vendor, and how many tokens
//! each vendor billed for it. Vendor consoles often lag, so this is the
//! user's only real-time view.

use serde::{Deserialize, Serialize};
use specta::Type;

/// `AsrTrace::provider` value for on-device recognition.
pub const LOCAL_ASR_PROVIDER: &str = "local";

/// Tokens a vendor reported for one request (or the sum over its chunks).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TokenUsage {
    pub input: i64,
    pub output: i64,
}

impl TokenUsage {
    /// Sum of the parts that reported usage; `None` when none of them did.
    pub fn sum(parts: impl IntoIterator<Item = Option<TokenUsage>>) -> Option<TokenUsage> {
        parts.into_iter().flatten().fold(None, |acc, usage| {
            let acc = acc.unwrap_or_default();
            Some(TokenUsage {
                input: acc.input + usage.input,
                output: acc.output + usage.output,
            })
        })
    }

    /// Build from a vendor's optional counters; `None` when both are absent.
    pub fn from_parts(input: Option<i64>, output: Option<i64>) -> Option<TokenUsage> {
        match (input, output) {
            (None, None) => None,
            (input, output) => Some(TokenUsage {
                input: input.unwrap_or(0),
                output: output.unwrap_or(0),
            }),
        }
    }
}

/// The speech recognizer that produced the raw transcript.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct AsrTrace {
    /// `"local"` or a cloud vendor id (`dashscope`, `glm`, `stepfun`).
    pub provider: String,
    /// Local model id or cloud model name.
    pub model: Option<String>,
    pub usage: Option<TokenUsage>,
    /// Wall-clock recognition time.
    pub ms: Option<i64>,
}

/// The text model that polished or translated the transcript. Only present
/// when its output is what got inserted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct LlmTrace {
    /// A post-processing provider id (`deepseek`, `openai`, `custom`, …).
    pub provider: String,
    pub model: Option<String>,
    pub usage: Option<TokenUsage>,
    pub ms: Option<i64>,
}

/// Milliseconds since `start`, as stored in the history table.
pub fn elapsed_ms(start: std::time::Instant) -> i64 {
    i64::try_from(start.elapsed().as_millis()).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sum_skips_missing_parts() {
        let a = Some(TokenUsage {
            input: 3,
            output: 4,
        });
        let b = Some(TokenUsage {
            input: 10,
            output: 1,
        });
        assert_eq!(
            TokenUsage::sum([a, None, b]),
            Some(TokenUsage {
                input: 13,
                output: 5
            })
        );
        assert_eq!(TokenUsage::sum([None, None]), None);
        assert_eq!(TokenUsage::sum([]), None);
    }

    #[test]
    fn from_parts_needs_at_least_one_counter() {
        assert_eq!(TokenUsage::from_parts(None, None), None);
        assert_eq!(
            TokenUsage::from_parts(Some(7), None),
            Some(TokenUsage {
                input: 7,
                output: 0
            })
        );
    }
}
