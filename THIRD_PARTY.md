# Third-party notices

Voiceless is distributed under the MIT License (see `LICENSE`). It includes or
downloads components under their own terms. This list covers the main ones;
`src-tauri/Cargo.lock` and `bun.lock` are the complete dependency record.

## Application code

| Component                                                               | License              | Notes                                              |
| ----------------------------------------------------------------------- | -------------------- | -------------------------------------------------- |
| [Handy](https://github.com/cjpais/Handy)                                | MIT, © 2025 CJ Pais | Base of this project, forked at `ba10ce19`         |
| [Tauri](https://tauri.app)                                              | MIT / Apache-2.0     | Desktop runtime                                    |
| [transcribe-rs](https://crates.io/crates/transcribe-rs), transcribe-cpp | MIT                  | Local inference (ONNX Runtime, whisper.cpp / ggml) |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime)                | MIT                  | Linked statically                                  |
| [handy-keys](https://crates.io/crates/handy-keys)                       | MIT                  | Global key listener (Fn, side-specific modifiers)  |
| [tauri-nspanel](https://github.com/ahkohd/tauri-nspanel)                | MIT / Apache-2.0     | Non-activating overlay panel                       |

## Models (downloaded on demand, not bundled)

| Model                                                           | Weights license                                                                                           | Source                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| SenseVoice Small int8 (`sense-voice-int8`)                      | FunASR Model Open Source License Agreement — https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE | Converted by sherpa-onnx; mirrored at blob.handy.computer |
| Silero VAD v4                                                   | MIT                                                                                                       | Bundled resource                                          |
| Other catalog models (Whisper, Qwen3-ASR, Fun-ASR, Parakeet, …) | See each model card                                                                                       | Hugging Face                                              |

The SenseVoice code is MIT, but its weights are under the FunASR model
license; check that license before redistributing the weights.

## Cloud services (optional)

DeepSeek, Alibaba Cloud Model Studio (DashScope) and other OpenAI-compatible
providers are used only when you configure them, under their own terms of
service.
