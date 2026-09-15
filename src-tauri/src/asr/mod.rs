//! Cloud speech recognition providers (Voiceless).
//!
//! Local recognition stays in `managers::transcription`; this module adds
//! providers that upload the recorded audio after the user stops speaking.

pub mod dashscope;
pub mod glm;

use std::io::Cursor;

pub const SAMPLE_RATE: u32 = 16_000;

/// Why a cloud recognition request did not produce text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AsrError {
    NotConfigured(String),
    Http {
        status: u16,
        code: Option<String>,
        message: String,
    },
    Network(String),
    InvalidResponse(String),
    Encode(String),
}

impl std::fmt::Display for AsrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AsrError::NotConfigured(why) => write!(f, "Cloud ASR is not configured: {why}"),
            AsrError::Http {
                status,
                code,
                message,
            } => match code {
                Some(code) => write!(f, "Cloud ASR failed ({status} {code}): {message}"),
                None => write!(f, "Cloud ASR failed ({status}): {message}"),
            },
            AsrError::Network(e) => write!(f, "Cloud ASR request failed: {e}"),
            AsrError::InvalidResponse(e) => {
                write!(f, "Cloud ASR returned an invalid response: {e}")
            }
            AsrError::Encode(e) => write!(f, "Could not encode audio: {e}"),
        }
    }
}

impl std::error::Error for AsrError {}

/// Build a DashScope request from settings. The ASR key falls back to the
/// DashScope text-model key so one Model Studio key can serve both.
pub fn dashscope_request(
    settings: &crate::settings::AppSettings,
) -> dashscope::DashScopeAsrRequest {
    let cfg = &settings.dashscope_asr;
    let api_key = settings
        .asr_api_keys
        .get(dashscope::PROVIDER_ID)
        .filter(|k| !k.trim().is_empty())
        .or_else(|| {
            settings
                .post_process_api_keys
                .get(crate::settings::DASHSCOPE_PROVIDER_ID)
        })
        .cloned()
        .unwrap_or_default();
    let context = if cfg.send_dictionary {
        dashscope::context_from_terms(settings.dictionary.iter().map(|e| e.term.as_str()))
    } else {
        None
    };
    dashscope::DashScopeAsrRequest {
        endpoint: cfg.endpoint.clone(),
        api_key,
        model: cfg.model.clone(),
        language: Some(cfg.language.clone()),
        context,
    }
}

pub fn glm_request(settings: &crate::settings::AppSettings) -> glm::GlmAsrRequest {
    let cfg = &settings.glm_asr;
    glm::GlmAsrRequest {
        endpoint: cfg.endpoint.clone(),
        api_key: settings
            .asr_api_keys
            .get(glm::PROVIDER_ID)
            .cloned()
            .unwrap_or_default(),
        model: cfg.model.clone(),
        hotwords: if cfg.send_dictionary {
            glm::hotwords_from_terms(settings.dictionary.iter().map(|e| e.term.as_str()))
        } else {
            Vec::new()
        },
    }
}

/// Recognize with the cloud vendor selected in settings.
pub async fn transcribe_cloud(
    settings: &crate::settings::AppSettings,
    samples: &[f32],
) -> Result<String, AsrError> {
    match settings.cloud_asr_provider {
        crate::settings::CloudAsrProvider::Dashscope => {
            dashscope::transcribe(&dashscope_request(settings), samples).await
        }
        crate::settings::CloudAsrProvider::Glm => {
            glm::transcribe(&glm_request(settings), samples).await
        }
    }
}

/// Encode 16 kHz mono float samples as a 16-bit PCM WAV file in memory.
pub fn encode_wav(samples: &[f32]) -> Result<Vec<u8>, AsrError> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = Cursor::new(Vec::with_capacity(44 + samples.len() * 2));
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec)
            .map_err(|e| AsrError::Encode(e.to_string()))?;
        for &s in samples {
            let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
            writer
                .write_sample(v)
                .map_err(|e| AsrError::Encode(e.to_string()))?;
        }
        writer
            .finalize()
            .map_err(|e| AsrError::Encode(e.to_string()))?;
    }
    Ok(cursor.into_inner())
}

/// Split `samples` into chunks of at most `max_secs`, cutting at the quietest
/// 100 ms window inside the last `search_secs` of each chunk so words are not
/// cut in half. Chunks cover the input exactly, in order.
pub fn split_for_upload(samples: &[f32], max_secs: f32, search_secs: f32) -> Vec<&[f32]> {
    let max_len = (max_secs * SAMPLE_RATE as f32) as usize;
    let search_len = ((search_secs * SAMPLE_RATE as f32) as usize).min(max_len / 2);
    let window = (SAMPLE_RATE / 10) as usize;
    if max_len == 0 || samples.len() <= max_len {
        return vec![samples];
    }

    let mut chunks = Vec::new();
    let mut start = 0usize;
    while samples.len() - start > max_len {
        let hard_end = start + max_len;
        let search_start = hard_end - search_len;
        let mut best_cut = hard_end;
        let mut best_energy = f32::MAX;
        let mut w = search_start;
        while w + window <= hard_end {
            let energy: f32 = samples[w..w + window].iter().map(|s| s * s).sum();
            if energy < best_energy {
                best_energy = energy;
                best_cut = w + window / 2;
            }
            w += window / 2;
        }
        chunks.push(&samples[start..best_cut]);
        start = best_cut;
    }
    chunks.push(&samples[start..]);
    chunks
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3000..=0x303F | 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF |
        0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF)
}

/// Join per-chunk transcripts: no space between CJK text, one space otherwise.
pub fn join_segments(parts: &[String]) -> String {
    let mut out = String::new();
    for part in parts.iter().map(|p| p.trim()).filter(|p| !p.is_empty()) {
        if let (Some(prev), Some(next)) = (out.chars().last(), part.chars().next()) {
            if !(is_cjk(prev) || is_cjk(next)) && !prev.is_whitespace() {
                out.push(' ');
            }
        }
        out.push_str(part);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_has_header_and_16_bit_samples() {
        let wav = encode_wav(&[0.0, 1.0, -1.0, 0.5]).unwrap();
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(wav.len(), 44 + 4 * 2);
        let reader = hound::WavReader::new(Cursor::new(wav)).unwrap();
        assert_eq!(reader.spec().sample_rate, 16_000);
        let samples: Vec<i16> = reader.into_samples::<i16>().map(Result::unwrap).collect();
        assert_eq!(samples, vec![0, i16::MAX, -i16::MAX, 16384]);
    }

    #[test]
    fn short_audio_is_one_chunk() {
        let samples = vec![0.1; 16_000 * 3];
        let chunks = split_for_upload(&samples, 180.0, 10.0);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].len(), samples.len());
    }

    #[test]
    fn long_audio_splits_at_quiet_point_and_covers_everything() {
        // 10 s of loud audio with a silent gap at 7.0–7.4 s; max chunk 8 s.
        let mut samples = vec![0.5f32; 16_000 * 10];
        for s in &mut samples[16_000 * 7..16_000 * 7 + 6_400] {
            *s = 0.0;
        }
        let chunks = split_for_upload(&samples, 8.0, 2.0);
        assert_eq!(chunks.len(), 2);
        let first = chunks[0].len();
        assert!(
            (16_000 * 7..=16_000 * 7 + 6_400).contains(&first),
            "cut at {first} should fall inside the silent gap"
        );
        assert_eq!(chunks.iter().map(|c| c.len()).sum::<usize>(), samples.len());
    }

    #[test]
    fn joins_cjk_without_spaces_and_latin_with_spaces() {
        let parts = vec![
            "你好".to_string(),
            "世界。".into(),
            "Hello".into(),
            " world ".into(),
            "".into(),
        ];
        assert_eq!(join_segments(&parts), "你好世界。Hello world");
    }
}
