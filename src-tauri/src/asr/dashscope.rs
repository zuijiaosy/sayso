//! Alibaba Cloud Model Studio (Bailian / DashScope) Qwen-ASR, synchronous API.
//!
//! `POST {endpoint}/api/v1/services/aigc/multimodal-generation/generation`
//! with the recording as a base64 WAV data URL. The system message carries
//! recognition context (dictionary terms). Docs:
//! https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference

use super::{encode_wav, split_for_upload, usage_from_value, AsrError, Recognized};
use base64::Engine as _;
use serde_json::{json, Value};
use std::time::Duration;

pub const PROVIDER_ID: &str = "dashscope";
pub const DEFAULT_ENDPOINT: &str = "https://dashscope.aliyuncs.com";
pub const DEFAULT_MODEL: &str = "qwen3-asr-flash";
const GENERATION_PATH: &str = "/api/v1/services/aigc/multimodal-generation/generation";
/// The service limits the base64 payload to 10 MB. 180 s of 16 kHz / 16-bit
/// mono WAV is ~5.8 MB raw, ~7.7 MB base64, which leaves headroom.
pub const MAX_CHUNK_SECS: f32 = 180.0;
pub const MAX_BASE64_BYTES: usize = 10 * 1024 * 1024;
/// Upper bound on context text sent with each request.
pub const CONTEXT_BUDGET_CHARS: usize = 600;

#[derive(Debug, Clone)]
pub struct DashScopeAsrRequest {
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
    /// `None` lets the model detect the language.
    pub language: Option<String>,
    pub context: Option<String>,
}

pub fn generation_url(endpoint: &str) -> String {
    let base = endpoint.trim().trim_end_matches('/');
    if base.ends_with(GENERATION_PATH) {
        base.to_string()
    } else {
        format!("{base}{GENERATION_PATH}")
    }
}

/// Recognition context from dictionary terms, bounded by `CONTEXT_BUDGET_CHARS`.
pub fn context_from_terms<'a>(terms: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let prefix = "以下是可能出现的专有名词，识别时请优先使用这些写法：";
    let mut out = String::from(prefix);
    let mut count = 0;
    for term in terms.into_iter().map(str::trim).filter(|t| !t.is_empty()) {
        let sep = if count == 0 { "" } else { "、" };
        if out.chars().count() + sep.chars().count() + term.chars().count() > CONTEXT_BUDGET_CHARS {
            break;
        }
        out.push_str(sep);
        out.push_str(term);
        count += 1;
    }
    (count > 0).then_some(out)
}

pub fn build_request_body(req: &DashScopeAsrRequest, wav_base64: &str) -> Value {
    let mut messages = Vec::new();
    if let Some(context) = req.context.as_deref().filter(|c| !c.trim().is_empty()) {
        messages.push(json!({ "role": "system", "content": [{ "text": context }] }));
    }
    messages.push(json!({
        "role": "user",
        "content": [{ "audio": format!("data:audio/wav;base64,{wav_base64}") }]
    }));

    let mut asr_options = json!({ "enable_itn": true });
    if let Some(language) = req
        .language
        .as_deref()
        .filter(|l| !l.is_empty() && *l != "auto")
    {
        asr_options["language"] = json!(language);
    }

    json!({
        "model": req.model,
        "input": { "messages": messages },
        "parameters": { "asr_options": asr_options }
    })
}

/// Extract recognized text, or a structured error, from a response body.
pub fn parse_response(status: u16, body: &str) -> Result<Recognized, AsrError> {
    let value: Value = serde_json::from_str(body).map_err(|_| {
        if (200..300).contains(&status) {
            AsrError::InvalidResponse("response is not JSON".into())
        } else {
            AsrError::Http {
                status,
                code: None,
                message: body.chars().take(200).collect(),
            }
        }
    })?;

    let error_code = value
        .get("code")
        .or_else(|| value.pointer("/output/code"))
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
        .map(str::to_string);
    if !(200..300).contains(&status) || error_code.is_some() {
        let message = value
            .get("message")
            .or_else(|| value.pointer("/output/message"))
            .and_then(Value::as_str)
            .unwrap_or("request failed")
            .to_string();
        return Err(AsrError::Http {
            status,
            code: error_code,
            message,
        });
    }

    let content = value
        .pointer("/output/choices/0/message/content")
        .ok_or_else(|| {
            AsrError::InvalidResponse("missing output.choices[0].message.content".into())
        })?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => return Err(AsrError::InvalidResponse("unexpected content type".into())),
    };
    Ok(Recognized {
        text: text.trim().to_string(),
        usage: usage_from_value(&value),
    })
}

async fn transcribe_chunk(
    client: &reqwest::Client,
    req: &DashScopeAsrRequest,
    samples: &[f32],
) -> Result<Recognized, AsrError> {
    let wav = encode_wav(samples)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(wav);
    if b64.len() > MAX_BASE64_BYTES {
        return Err(AsrError::Encode(format!(
            "audio chunk is {} bytes after base64, above the 10 MB limit",
            b64.len()
        )));
    }
    let body = build_request_body(req, &b64);
    let response = client
        .post(generation_url(&req.endpoint))
        .bearer_auth(&req.api_key)
        .json(&body)
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
    let text = response
        .text()
        .await
        .map_err(|e| AsrError::Network(e.without_url().to_string()))?;
    parse_response(status, &text)
}

/// Recognize a whole recording, splitting it when it exceeds the upload limit.
pub async fn transcribe(
    req: &DashScopeAsrRequest,
    samples: &[f32],
) -> Result<Recognized, AsrError> {
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

    let mut parts = Vec::new();
    for chunk in split_for_upload(samples, MAX_CHUNK_SECS, 10.0) {
        parts.push(transcribe_chunk(&client, req, chunk).await?);
    }
    Ok(Recognized::join(parts))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> DashScopeAsrRequest {
        DashScopeAsrRequest {
            endpoint: "https://dashscope.aliyuncs.com/".into(),
            api_key: "sk-test".into(),
            model: DEFAULT_MODEL.into(),
            language: Some("zh".into()),
            context: Some("以下是可能出现的专有名词：Codex".into()),
        }
    }

    #[test]
    fn url_is_built_once() {
        let url = generation_url("https://dashscope.aliyuncs.com/");
        assert_eq!(
            url,
            "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
        );
        assert_eq!(generation_url(&url), url);
        assert_eq!(
            generation_url("https://ws-1.cn-beijing.maas.aliyuncs.com"),
            "https://ws-1.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
        );
    }

    #[test]
    fn body_matches_documented_shape() {
        let body = build_request_body(&request(), "QUJD");
        assert_eq!(body["model"], "qwen3-asr-flash");
        assert_eq!(body["input"]["messages"][0]["role"], "system");
        assert_eq!(
            body["input"]["messages"][0]["content"][0]["text"],
            "以下是可能出现的专有名词：Codex"
        );
        assert_eq!(body["input"]["messages"][1]["role"], "user");
        assert_eq!(
            body["input"]["messages"][1]["content"][0]["audio"],
            "data:audio/wav;base64,QUJD"
        );
        assert_eq!(body["parameters"]["asr_options"]["language"], "zh");
        assert_eq!(body["parameters"]["asr_options"]["enable_itn"], true);
    }

    #[test]
    fn auto_language_and_empty_context_are_omitted() {
        let mut req = request();
        req.language = Some("auto".into());
        req.context = None;
        let body = build_request_body(&req, "QUJD");
        assert_eq!(body["input"]["messages"].as_array().unwrap().len(), 1);
        assert!(body["parameters"]["asr_options"].get("language").is_none());
    }

    #[test]
    fn parses_text_from_success_response() {
        let body = r#"{"output":{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":[{"text":"欢迎使用阿里云。"}],"annotations":[{"language":"zh","type":"audio_info"}]}}]},"request_id":"x"}"#;
        let parsed = parse_response(200, body).unwrap();
        assert_eq!(parsed.text, "欢迎使用阿里云。");
        assert_eq!(parsed.usage, None);
        let empty = r#"{"output":{"choices":[{"message":{"content":[]}}]}}"#;
        assert_eq!(parse_response(200, empty).unwrap().text, "");
    }

    #[test]
    fn parses_usage_from_success_response() {
        let body = r#"{"output":{"choices":[{"message":{"content":[{"text":"你好"}]}}]},"usage":{"input_tokens_details":{"text_tokens":0},"output_tokens":3,"input_tokens":52,"output_tokens_details":{"text_tokens":3},"seconds":2},"request_id":"x"}"#;
        assert_eq!(
            parse_response(200, body).unwrap().usage,
            Some(crate::trace::TokenUsage {
                input: 52,
                output: 3
            })
        );
    }

    #[test]
    fn surfaces_service_errors() {
        let body =
            r#"{"code":"InvalidApiKey","message":"Invalid API-key provided.","request_id":"x"}"#;
        assert_eq!(
            parse_response(401, body),
            Err(AsrError::Http {
                status: 401,
                code: Some("InvalidApiKey".into()),
                message: "Invalid API-key provided.".into()
            })
        );
        assert!(matches!(
            parse_response(502, "<html>bad gateway</html>"),
            Err(AsrError::Http { status: 502, .. })
        ));
        assert!(matches!(
            parse_response(200, "{}"),
            Err(AsrError::InvalidResponse(_))
        ));
    }

    #[test]
    fn context_respects_budget() {
        let terms: Vec<String> = (0..500).map(|i| format!("术语{i}")).collect();
        let ctx = context_from_terms(terms.iter().map(String::as_str)).unwrap();
        assert!(ctx.chars().count() <= CONTEXT_BUDGET_CHARS);
        assert!(ctx.contains("术语0、术语1"));
        assert!(context_from_terms(["", "  "]).is_none());
    }

    /// Live check of the endpoint and error parsing with a deliberately
    /// invalid key and one second of silence. Run with
    /// `VOICELESS_LIVE_TESTS=1 cargo test --lib live_invalid_key -- --ignored`.
    #[test]
    #[ignore]
    fn live_invalid_key_is_rejected_by_service() {
        if std::env::var("VOICELESS_LIVE_TESTS").ok().as_deref() != Some("1") {
            return;
        }
        let mut req = request();
        req.api_key = "sk-sayso-invalid-key".into();
        let result = tauri::async_runtime::block_on(transcribe(&req, &vec![0.0; 16_000]));
        match result {
            Err(AsrError::Http { status, code, .. }) => {
                assert!(status == 401 || status == 403, "status {status}");
                assert!(code.is_some(), "service error code should be parsed");
            }
            other => panic!("expected an auth error, got {other:?}"),
        }
    }

    #[test]
    fn missing_key_is_not_configured() {
        let mut req = request();
        req.api_key = " ".into();
        let result = tauri::async_runtime::block_on(transcribe(&req, &[0.0; 160]));
        assert!(matches!(result, Err(AsrError::NotConfigured(_))));
    }
}
