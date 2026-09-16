# Voiceless

**English** | [简体中文](README.zh.md)

Local-first voice input for macOS. Hold Fn and talk, clean text lands at your cursor. Hold Fn + Left Shift and talk in Chinese, English comes out.

Forked from [Handy](https://github.com/cjpais/Handy) (MIT). Recording, global hotkeys, the non-activating overlay, reliable paste and model management come from there. Translation mode, text-model cleanup, the dictionary and cloud recognition are new.

> 0.1 dev build. Only tested on macOS (Apple Silicon).
>
> CI builds a Windows x64 installer, but nobody has gone through it feature by feature. Fn dictation, chord-cancel, the copy-instead-of-paste guard and reliable paste are macOS-only. On Windows bind `Ctrl+Space` or similar under Shortcuts.

## Features

| Feature     | Notes                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dictation   | `Fn`. Tap to start, tap to stop. Or hold to talk, release to finish.                                                                                                                 |
| Translation | `Fn + Left Shift`. Target language switches from the overlay. Hold Fn then add Left Shift to turn a running dictation into a translation.                                            |
| Overlay     | Black pill at the bottom of the screen: ✕ cancel, live waveform, ✓ done. Never takes focus from the field you are typing into.                                                       |
| Recognition | Local Qwen3-ASR 0.6B (offline, 30 languages, auto language detect). SenseVoice still available. Cloud: StepFun `stepaudio-2.5-asr`, Alibaba `qwen3-asr-flash`, Zhipu `glm-asr-2512`. |
| Text model  | DeepSeek `deepseek-flash` (thinking off), Alibaba Cloud, or any OpenAI-compatible endpoint.                                                                                          |
| Cleanup     | Off / fix only / polish (default).                                                                                                                                                   |
| Dictionary  | Preferred spellings, common misrecognitions, fixed translations, notes. Import and export as text.                                                                                   |

## Where your data goes

| Setup                       | Audio       | Text                                     |
| --------------------------- | ----------- | ---------------------------------------- |
| Local, cleanup off          | stays local | stays local                              |
| Local + DeepSeek or similar | stays local | transcript + matching dictionary entries |
| Cloud recognition           | uploaded    | depends on your text-model setting       |

- No silent cloud fallback. If local recognition fails, it fails.
- A failed translation never inserts the original. You get Retry and Copy original.
- A failed cleanup inserts the raw transcript, dictionary replacements included.
- API keys sit in plain text in `~/Library/Application Support/com.voiceless.desktop/settings_store.json`. Keychain is on the list.

## Install

1. Build or download `Voiceless.app`, drop it in Applications.
2. GitHub Actions builds are not notarized. Check the download came from this repo, then clear quarantine:

   ```bash
   xattr -cr /Applications/Voiceless.app
   ```

3. Grant **Microphone**, **Accessibility** and **Input Monitoring** when asked.
4. System Settings → Keyboard → "Press 🌐 key to" → **Do Nothing**. Otherwise Fn also cycles input sources.
5. Pick recognition: download Qwen3-ASR 0.6B (~811 MB), import an existing sherpa-onnx SenseVoice int8 folder, or go cloud.
6. For cleanup or translation, add an API key under Models → Text model and hit Test.

**Known limitations**

- Fn only exists on Apple keyboards. Third-party keyboard: use "Add another" under Shortcuts.
- Build without a stable signing identity and you re-grant Accessibility and Input Monitoring after every install.
- Password fields and other secure-input contexts block simulated paste. Nothing to do about it.
- Zhipu never documented how multiple GLM-ASR hotwords are encoded. We send them the way the official SDK does, and retry without hotwords on rejection.
- StepFun Step Plan keys cannot call `/v1/audio/transcriptions`. Use a pay-as-you-go key. Chinese and English only.
- Downloads try Hugging Face, then hf-mirror.com, then the catalog mirrors. If you reach Hugging Face through a proxy, hf-mirror will not help: it bounces non-mainland clients back to the origin.

## Development

Rust, Bun, Xcode Command Line Tools, CMake.

```bash
bun install
CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri dev      # dev run; permissions attach to the terminal
CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri build --bundles app,dmg
cd src-tauri && cargo test --lib                          # Rust tests
bun run lint && bunx tsc --noEmit                         # frontend checks
```

Grant permissions to the packaged `.app`, not the dev build. Dev mode runs a bare binary that never shows up in the permission lists.

**Signing.** macOS keeps Accessibility and Input Monitoring across reinstalls only if the signing identity is stable. Ad-hoc (`-`) invalidates them every build. `tauri.conf.json` stays ad-hoc so CI and anyone without a certificate can still build. Locally:

```bash
bun run build:signed                        # picks an identity from the keychain
bun run build:signed -- --bundles app,dmg
APPLE_SIGNING_IDENTITY="<sha-1>" bun run build:signed
```

Prefers `Developer ID Application`, falls back to `Apple Development`. The identity goes in through `--config`, so no personal certificate lands in the repo. Switching from ad-hoc costs one last re-grant.

```bash
security find-identity -v -p codesigning
# Tauri's dmg step wants Finder control. hdiutil does the job too:
cd src-tauri/target/release/bundle && mkdir dmg-stage && ditto macos/Voiceless.app dmg-stage/Voiceless.app \
  && ln -s /Applications dmg-stage/Applications \
  && hdiutil create -volname Voiceless -srcfolder dmg-stage -ov -format UDZO dmg/Voiceless_0.1.0_aarch64.dmg \
  && rm -rf dmg-stage
```

Live tests hit the real endpoints with an invalid key:

```bash
cd src-tauri && VOICELESS_LIVE_TESTS=1 cargo test --lib live_ -- --ignored
```

Code map:

| Path                                         | What                                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src-tauri/src/voice.rs`                     | Modes, prompts, dictionary replacement, output validation                                                                                                          |
| `src-tauri/src/actions.rs`                   | Recognize → clean up or translate → paste                                                                                                                          |
| `src-tauri/src/transcription_coordinator.rs` | Hotkey state machine, including the Fn → Fn+Shift upgrade                                                                                                          |
| `src-tauri/src/asr/`                         | Cloud adapters. Alibaba Qwen-ASR (≤10 MB, 3-min chunks), Zhipu GLM-ASR (≤30 s, 28-s chunks in parallel), StepFun StepAudio ASR (≤100 MB, 3-min chunks in parallel) |
| `src-tauri/src/catalog/`                     | Bundled model catalog, resolver for the default local model                                                                                                        |
| `src/voiceless/`                             | Settings UI and onboarding                                                                                                                                         |
| `src/overlay/`                               | Recording overlay                                                                                                                                                  |

Background reading: `docs/typeless-local-plan.md`, `docs/BASELINE.md`. Handy's original README is kept at `docs/UPSTREAM_HANDY_README.md`.

## License

MIT, see `LICENSE`. Third-party components and model weights: `THIRD_PARTY.md`.
