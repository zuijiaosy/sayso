//! Zhipu GLM-ASR (`glm-asr-2512`) on the BigModel open platform.
//!
//! `POST {endpoint}/audio/transcriptions`, multipart form with `model`,
//! `stream=false`, the WAV `file`, and optional `hotwords`. The service
//! accepts at most 30 s of audio per request, so recordings are split near
//! quiet points and the chunks are recognized in parallel.
//! Docs: https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-asr-2512

use super::{
    dedup_terms, encode_wav, parse_transcription_response, split_for_upload, transcriptions_url,
    AsrError, Recognized,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub const PROVIDER_ID: &str = "glm";
pub const DEFAULT_ENDPOINT: &str = "https://open.bigmodel.cn/api/paas/v4";
pub const DEFAULT_MODEL: &str = "glm-asr-2512";
/// Service limit is 30 s; stay below it so a cut never exceeds the limit.
pub const MAX_CHUNK_SECS: f32 = 28.0;
pub const MAX_HOTWORDS: usize = 100;

/// Set when the service rejected hotwords once; later requests omit them
/// instead of failing again.
static HOTWORDS_REJECTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone)]
pub struct GlmAsrRequest {
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
    pub hotwords: Vec<String>,
}

/// Dictionary terms as hotwords: trimmed, de-duplicated, at most 100.
pub fn hotwords_from_terms<'a>(terms: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    dedup_terms(terms, MAX_HOTWORDS)
}

/// Text form fields for one request. Hotwords use the same encoding as the
/// official SDK (`hotwords[]`, one field per word).
pub fn form_text_fields(req: &GlmAsrRequest, include_hotwords: bool) -> Vec<(String, String)> {
    let mut fields = vec![
        ("model".to_string(), req.model.clone()),
        ("stream".to_string(), "false".to_string()),
    ];
    if include_hotwords {
        for word in req.hotwords.iter().take(MAX_HOTWORDS) {
            fields.push(("hotwords[]".to_string(), word.clone()));
        }
    }
    fields
}

pub fn parse_response(status: u16, body: &str) -> Result<Recognized, AsrError> {
    parse_transcription_response(status, body)
}

async fn send_chunk(
    client: &reqwest::Client,
    req: &GlmAsrRequest,
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
    parse_response(status, &body)
}

async fn transcribe_chunk(
    client: &reqwest::Client,
    req: &GlmAsrRequest,
    samples: &[f32],
) -> Result<Recognized, AsrError> {
    let wav = encode_wav(samples)?;
    let with_hotwords = !req.hotwords.is_empty() && !HOTWORDS_REJECTED.load(Ordering::Relaxed);
    match send_chunk(client, req, wav.clone(), with_hotwords).await {
        Err(AsrError::Http { status: 400, .. }) if with_hotwords => {
            log::warn!("GLM-ASR rejected the request with hotwords; retrying without them");
            HOTWORDS_REJECTED.store(true, Ordering::Relaxed);
            send_chunk(client, req, wav, false).await
        }
        other => other,
    }
}

pub async fn transcribe(req: &GlmAsrRequest, samples: &[f32]) -> Result<Recognized, AsrError> {
    if req.api_key.trim().is_empty() {
        return Err(AsrError::NotConfigured("missing API key".into()));
    }
    if req.endpoint.trim().is_empty() || req.model.trim().is_empty() {
        return Err(AsrError::NotConfigured("missing endpoint or model".into()));
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .user_agent("Sayso/0.1")
        .build()
        .map_err(|e| AsrError::Network(e.to_string()))?;

    let chunks = split_for_upload(samples, MAX_CHUNK_SECS, 6.0);
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

    fn request() -> GlmAsrRequest {
        GlmAsrRequest {
            endpoint: DEFAULT_ENDPOINT.into(),
            api_key: "key".into(),
            model: DEFAULT_MODEL.into(),
            hotwords: vec!["Codex".into(), "new-api".into()],
        }
    }

    #[test]
    fn url_is_built_once() {
        let url = transcriptions_url("https://open.bigmodel.cn/api/paas/v4/");
        assert_eq!(
            url,
            "https://open.bigmodel.cn/api/paas/v4/audio/transcriptions"
        );
        assert_eq!(transcriptions_url(&url), url);
    }

    #[test]
    fn form_fields_follow_sdk_encoding() {
        let fields = form_text_fields(&request(), true);
        assert_eq!(fields[0], ("model".into(), "glm-asr-2512".into()));
        assert_eq!(fields[1], ("stream".into(), "false".into()));
        assert_eq!(fields[2], ("hotwords[]".into(), "Codex".into()));
        assert_eq!(fields[3], ("hotwords[]".into(), "new-api".into()));
        assert_eq!(form_text_fields(&request(), false).len(), 2);
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
        let ok = r#"{"id":"x","created":1,"request_id":"r","model":"glm-asr-2512","text":" 你好，世界。 "}"#;
        assert_eq!(parse_response(200, ok).unwrap().text, "你好，世界。");
        let err = r#"{"error":{"code":"1002","message":"Authorization Token非法"}}"#;
        assert_eq!(
            parse_response(401, err),
            Err(AsrError::Http {
                status: 401,
                code: Some("1002".into()),
                message: "Authorization Token非法".into()
            })
        );
        assert!(matches!(
            parse_response(200, "{}"),
            Err(AsrError::InvalidResponse(_))
        ));
        assert!(matches!(
            parse_response(502, "bad gateway"),
            Err(AsrError::Http { status: 502, .. })
        ));
    }

    #[test]
    fn long_audio_splits_under_the_30_second_limit() {
        let samples = vec![0.1f32; 16_000 * 70];
        let chunks = split_for_upload(&samples, MAX_CHUNK_SECS, 6.0);
        assert_eq!(chunks.len(), 3);
        assert!(chunks.iter().all(|c| c.len() <= 16_000 * 30));
    }

    /// `VOICELESS_LIVE_TESTS=1 cargo test --lib live_glm -- --ignored`
    #[test]
    #[ignore]
    fn live_glm_invalid_key_is_rejected() {
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
