# Sayso · 顺口说

**English** | [简体中文](README.zh.md)

_Your say-so, on screen._

Local-first voice input for macOS. Hold Fn and talk, clean text lands at your cursor. Hold Fn + Left Shift and talk in Chinese, English comes out.

Forked from [Handy](https://github.com/cjpais/Handy) (MIT). Recording, global hotkeys, the non-activating overlay, reliable paste and model management come from there. Translation mode, text-model cleanup, the dictionary and cloud recognition are new.

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
- API keys sit in plain text in `~/Library/Application Support/com.sayso.desktop/settings_store.json`. Keychain is on the list.

## Install

1. Build or download `Sayso.app`, drop it in Applications.
2. GitHub Actions builds are not notarized. Check the download came from this repo, then clear quarantine:

   ```bash
   xattr -cr /Applications/Sayso.app
   ```

3. Grant **Microphone**, **Accessibility** and **Input Monitoring** when asked.
4. System Settings → Keyboard → "Press 🌐 key to" → **Do Nothing**. Otherwise Fn also cycles input sources.
5. Pick recognition: download Qwen3-ASR 0.6B (~811 MB), import an existing sherpa-onnx SenseVoice int8 folder, or go cloud.
6. For cleanup or translation, add an API key under Models → Text model and hit Test.

### Upgrading from Voiceless

The app used to be called Voiceless and stored its data under `com.voiceless.desktop`. On first launch Sayso moves that folder (settings, history, recordings and downloaded models) to `com.sayso.desktop`; nothing is lost and nothing needs re-downloading. macOS ties permissions to the app identity, so **Microphone**, **Accessibility** and **Input Monitoring** have to be granted once more.

## License

MIT, see `LICENSE`. Third-party components and model weights: `THIRD_PARTY.md`.
