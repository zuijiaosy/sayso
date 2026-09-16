# Baseline (P0)

Voiceless is derived from [Handy](https://github.com/cjpais/Handy) (MIT).

| Item                   | Value                                                                  |
| ---------------------- | ---------------------------------------------------------------------- |
| Upstream remote        | `upstream` → https://github.com/cjpais/Handy.git                       |
| Pinned upstream commit | `ba10ce1943ef34e93c09494027fc0b9ced2e8a44` (v0.9.6, 2026-09-15)        |
| Machine                | Apple M4, 32 GB, macOS 26.6.2, arm64                                   |
| Toolchain              | rustc 1.97.0, bun 1.3.14, node 24.18, cmake 4.4.3 (Homebrew), Xcode 26 |

## Build commands

```bash
bun install
# VAD model is tracked in git at src-tauri/resources/models/silero_vad_v4.onnx
cd src-tauri && CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo build   # ~2m first build on M4
cd .. && bun run build                                          # frontend, ~2s
bun run tauri dev                                               # full app
```

`cmake` is required (whisper.cpp inside `transcribe-cpp`). ONNX Runtime is linked
statically; `otool -L target/debug/handy` shows only system frameworks.

## Headless ASR check (unmodified upstream)

Model `sense-voice-int8` from `https://blob.handy.computer/sense-voice-int8.tar.gz`
(sha256 `171d611f…e8a4`, matches the registry). Its `model.int8.onnx` is byte-identical
to sherpa-onnx's `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` release,
so an existing local copy can be imported instead of downloaded.

```bash
./target/debug/handy --transcribe-file zh.wav --model sense-voice-int8 --json
```

| Sample | Audio  | Transcribe (debug build) | Result                                                                            |
| ------ | ------ | ------------------------ | --------------------------------------------------------------------------------- |
| zh.wav | 5.59 s | 473 ms (11.8x RT)        | 开放时间早上9点至下午5点。                                                        |
| en.wav | 7.15 s | 593 ms (12.1x RT)        | The tribal chieftain called for the boy and presented him with 50 pieces of code. |

Model load: ~0.4–0.5 s.

## Known blockers / notes

- Homebrew auto-update against the TUNA mirror hung; use `HOMEBREW_NO_AUTO_UPDATE=1`.
- Interactive checks (Fn key, overlay focus, paste into other apps) need a human at the
  keyboard and macOS TCC grants (Microphone, Accessibility, Input Monitoring). They are
  listed in the manual test matrix, not marked as passed here.
- System setting `AppleFnUsageType` is `1` (Fn switches input source) on this machine;
  it must be set to "Do Nothing" for a bare Fn shortcut to be usable.
