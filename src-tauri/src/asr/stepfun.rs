//! StepFun (阶跃星辰) StepAudio ASR (`stepaudio-2.5-asr`).
//!
//! `POST {endpoint}/audio/transcriptions`, an OpenAI-shaped multipart form with
//! `model`, `response_format=json`, the WAV `file`, and optional `hotwords`
//! (a JSON array string). The service accepts files up to 100 MB and audio up
//! to 30 minutes; recordings are still split near quiet points so a single
//! request stays inside the client timeout.
//!
//! Step Plan subscription keys cannot call this endpoint — they are limited to
//! the SSE API under `https://api.stepfun.com/step_plan/v1`.
//!
//! Docs: https://platform.stepfun.com/docs/zh/api-reference/audio/transcriptions

use super::{
    dedup_terms, encode_wav, parse_transcription_response, split_for_upload, transcriptions_url,
    AsrError, Recognized,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub const PROVIDER_ID: &str = "stepfun";
pub const DEFAULT_ENDPOINT: &str = "https://api.stepfun.com/v1";
pub const DEFAULT_MODEL: &str = "stepaudio-2.5-asr";
/// The file limit is 100 MB and the model takes up to 30 minutes, so the cut is
/// about request latency: 180 s of 16 kHz / 16-bit mono WAV is ~5.8 MB.
pub const MAX_CHUNK_SECS: f32 = 180.0;
/// The docs do not state a limit; stay with the cap used for the other vendors.
pub const MAX_HOTWORDS: usize = 100;

/// Set when the service rejected hotwords once; later requests omit them
/// instead of failing again.
static HOTWORDS_REJECTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone)]
pub struct StepFunAsrRequest {
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
    pub hotwords: Vec<String>,
}

/// Dictionary terms as hotwords: trimmed, de-duplicated, at most 100.
pub fn hotwords_from_terms<'a>(terms: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    dedup_terms(terms, MAX_HOTWORDS)
}

/// Text form fields for one request. `response_format` is required by the API.
/// Hotwords go in a single field holding a JSON array string.
pub fn form_text_fields(req: &StepFunAsrRequest, include_hotwords: bool) -> Vec<(String, String)> {
    let mut fields = vec![
        ("model".to_string(), req.model.clone()),
        ("response_format".to_string(), "json".to_string()),
    ];
    if include_hotwords && !req.hotwords.is_empty() {
        let words: Vec<&str> = req
            .hotwords
            .iter()
            .take(MAX_HOTWORDS)
            .map(String::as_str)
            .collect();
        if let Ok(json) = serde_json::to_string(&words) {
            fields.push(("hotwords".to_string(), json));
        }
    }
    fields
}

async fn send_chunk(
    client: &reqwest::Client,
    req: &StepFunAsrRequest,
    wav: Vec<u8>,
    include_hotwords: bool,
) -> Result<Recognized, AsrError> {
    let mut form = reqwest::multipart::Form::new();
    for (key, value) in form_text_fields(req, include_hotwords) {
        form = form.text(key, value);
    }
    let file = reqwest::multipart::Part::bytes(wav)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| AsrError::Encode(e.to_string()))?;
    form = form.part("file", file);

    let response = client
        .post(transcriptions_url(&req.endpoint))
        .bearer_auth(&req.api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            AsrError::Network(if e.is_timeout() {
                "timed out".into()
            } else {
                e.without_url().to_string()
            })
        })?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|e| AsrError::Network(e.without_url().to_string()))?;
    parse_transcription_response(status, &body)
}

async fn transcribe_chunk(
    client: &reqwest::Client,
    req: &StepFunAsrRequest,
    samples: &[f32],
) -> Result<Recognized, AsrError> {
    let wav = encode_wav(samples)?;
    let with_hotwords = !req.hotwords.is_empty() && !HOTWORDS_REJECTED.load(Ordering::Relaxed);
    match send_chunk(client, req, wav.clone(), with_hotwords).await {
        Err(AsrError::Http { status: 400, .. }) if with_hotwords => {
            log::warn!("StepAudio ASR rejected the request with hotwords; retrying without them");
            HOTWORDS_REJECTED.store(true, Ordering::Relaxed);
            send_chunk(client, req, wav, false).await
        }
        other => other,
    }
}

pub async fn transcribe(req: &StepFunAsrRequest, samples: &[f32]) -> Result<Recognized, AsrError> {
    if req.api_key.trim().is_empty() {
        return Err(AsrError::NotConfigured("missing API key".into()));
    }
    if req.endpoint.trim().is_empty() || req.model.trim().is_empty() {
        return Err(AsrError::NotConfigured("missing endpoint or model".into()));
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(90))
        .user_agent("Sayso/0.1")
        .build()
        .map_err(|e| AsrError::Network(e.to_string()))?;

    let chunks = split_for_upload(samples, MAX_CHUNK_SECS, 10.0);
    let results = futures_util::future::join_all(
        chunks
            .into_iter()
            .map(|chunk| transcribe_chunk(&client, req, chunk)),
    )
    .await;
    let parts = results.into_iter().collect::<Result<Vec<_>, _>>()?;
    Ok(Recognized::join(parts))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> StepFunAsrRequest {
        StepFunAsrRequest {
            endpoint: DEFAULT_ENDPOINT.into(),
            api_key: "key".into(),
            model: DEFAULT_MODEL.into(),
            hotwords: vec!["Codex".into(), "new-api".into()],
        }
    }

    #[test]
    fn url_is_built_once() {
        let url = transcriptions_url("https://api.stepfun.com/v1/");
        assert_eq!(url, "https://api.stepfun.com/v1/audio/transcriptions");
        assert_eq!(transcriptions_url(&url), url);
    }

    #[test]
    fn form_always_carries_model_and_response_format() {
        let fields = form_text_fields(&request(), false);
        assert_eq!(fields.len(), 2);
        assert_eq!(fields[0], ("model".into(), "stepaudio-2.5-asr".into()));
        assert_eq!(fields[1], ("response_format".into(), "json".into()));
    }

    #[test]
    fn hotwords_are_one_json_array_field() {
        let fields = form_text_fields(&request(), true);
        assert_eq!(fields.len(), 3);
        assert_eq!(
            fields[2],
            ("hotwords".into(), r#"["Codex","new-api"]"#.into())
        );
        let mut empty = request();
        empty.hotwords.clear();
        assert_eq!(form_text_fields(&empty, true).len(), 2);
    }

    #[test]
    fn hotwords_are_deduplicated_and_capped() {
        let terms: Vec<String> = (0..150).map(|i| format!("t{i}")).collect();
        let mut input: Vec<&str> = vec!["t0", " ", "t0"];
        input.extend(terms.iter().map(String::as_str));
        let words = hotwords_from_terms(input);
        assert_eq!(words.len(), MAX_HOTWORDS);
        assert_eq!(words[0], "t0");
        assert_eq!(words[1], "t1");
    }

    #[test]
    fn parses_success_and_errors() {
        let ok = r#"{"text":" 你好，世界。 "}"#;
        assert_eq!(
            parse_transcription_response(200, ok).unwrap().text,
            "你好，世界。"
        );
        assert!(matches!(
            parse_transcription_response(401, r#"{"error":{"message":"invalid api key"}}"#),
            Err(AsrError::Http { status: 401, .. })
        ));
    }

    #[test]
    fn long_audio_splits_under_the_request_budget() {
        let samples = vec![0.1f32; 16_000 * 400];
        let chunks = split_for_upload(&samples, MAX_CHUNK_SECS, 10.0);
        assert_eq!(chunks.len(), 3);
        assert!(chunks.iter().all(|c| c.len() <= 16_000 * 185));
    }

    /// `VOICELESS_LIVE_TESTS=1 cargo test --lib live_stepfun -- --ignored`
    #[test]
    #[ignore]
    fn live_stepfun_invalid_key_is_rejected() {
        if std::env::var("VOICELESS_LIVE_TESTS").ok().as_deref() != Some("1") {
            return;
        }
        let mut req = request();
        req.api_key = "sayso-invalid-key".into();
        let result = tauri::async_runtime::block_on(transcribe(&req, &vec![0.0; 16_000]));
        match result {
            Err(AsrError::Http { status, .. }) => {
                assert!(status == 401 || status == 403, "status {status}")
            }
            other => panic!("expected an auth error, got {other:?}"),
        }
    }
}
