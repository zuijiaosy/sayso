# Voiceless

[English](README.md) | **简体中文**

本地优先的 macOS 语音输入。按住 Fn 说话，整理好的文字落在光标处。按住 Fn + 左 Shift 说中文，出来的是英文。

从 [Handy](https://github.com/cjpais/Handy)（MIT）分叉。录音、全局热键、非激活悬浮窗、可靠粘贴和模型管理沿用上游，翻译模式、文本模型整理、词典和云端识别是新加的。

> 0.1 开发版，只在 macOS（Apple Silicon）上测过。
>
> CI 会产出 Windows x64 安装包，但没人逐项验过。Fn 口述、组合键取消、目标窗口变化时改用复制、可靠粘贴这几项仍是 macOS 独有。Windows 上请在「快捷键」里绑 `Ctrl+Space` 之类的组合。

## 功能

| 功能     | 说明                                                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 口述     | `Fn`。短按开始，再按结束；也可以按住说、松开结束。                                                                                                               |
| 翻译     | `Fn + 左 Shift`。悬浮条上切目标语言。先按住 Fn 再加左 Shift，能把正在进行的口述转成翻译。                                                                        |
| 悬浮条   | 屏幕底部的黑色胶囊：✕ 取消、实时波形、✓ 完成。不抢当前输入框的焦点。                                                                                             |
| 语音识别 | 本地 Qwen3-ASR 0.6B（离线，30 种语言，自动判断语种），SenseVoice 仍可选。云端：阶跃星辰 `stepaudio-2.5-asr`、阿里云百炼 `qwen3-asr-flash`、智谱 `glm-asr-2512`。 |
| 文本模型 | DeepSeek `deepseek-flash`（已关思考）、阿里云百炼，或任意 OpenAI 兼容接口。                                                                                      |
| 口述整理 | 关闭 / 仅纠错 / 整理（默认）。                                                                                                                                   |
| 词典     | 标准写法、常见误识别、固定译法、备注。支持文本导入导出。                                                                                                         |

## 数据去向

| 配置                     | 音频     | 文字                 |
| ------------------------ | -------- | -------------------- |
| 本地识别，整理关闭       | 不出本机 | 不出本机             |
| 本地识别 + DeepSeek 之类 | 不出本机 | 识别结果和命中的词条 |
| 云端识别                 | 上传     | 取决于文本模型设置   |

- 不会静默切到云端。本地识别失败就是失败。
- 翻译失败不会插入原文，悬浮条给「重试」和「复制原文」。
- 整理失败会插入识别原文，词典替换已经应用过。
- API Key 以明文存在 `~/Library/Application Support/com.voiceless.desktop/settings_store.json`，迁到钥匙串这件事在计划里。

## 安装

1. 构建或下载 `Voiceless.app`，丢进「应用程序」。
2. GitHub Actions 的构建没有公证。确认安装包来自本仓库后，去掉隔离属性：

   ```bash
   xattr -cr /Applications/Voiceless.app
   ```

3. 按提示授予 **麦克风**、**辅助功能**、**输入监控**。
4. 系统设置 → 键盘 →「按下 🌐 键时」改成 **不执行任何操作**，否则按 Fn 会顺带切输入法。
5. 选识别方式：下载 Qwen3-ASR 0.6B（约 811 MB）、导入已有的 sherpa-onnx SenseVoice int8 文件夹，或者走云端。
6. 要整理或翻译的话，在「模型 → 文本模型」填 API Key，点「测试」。

**已知限制**

- Fn 只在 Apple 键盘上有。第三方键盘请用「快捷键」里的「添加另一个」。
- 不用固定签名身份构建的话，每次重装都要重新授予辅助功能和输入监控。
- 密码框这类「安全输入」场景下，系统会拦掉模拟粘贴，没辙。
- 智谱没写明 GLM-ASR 的多热词怎么编码。我们按官方 SDK 的方式发，被拒就去掉热词重试。
- 阶跃星辰的 Step Plan 密钥调不了 `/v1/audio/transcriptions`，得用按量付费的密钥。该模型只支持中英文。
- 模型下载依次尝试 Hugging Face、hf-mirror.com、目录镜像。如果你是靠代理连的 Hugging Face，hf-mirror 帮不上忙：它会把非大陆来源的请求 308 跳回源站。

## 开发

需要 Rust、Bun、Xcode Command Line Tools、CMake。

```bash
bun install
CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri dev      # 开发运行，权限记在终端上
CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri build --bundles app,dmg
cd src-tauri && cargo test --lib                          # Rust 测试
bun run lint && bunx tsc --noEmit                         # 前端检查
```

授权要对打包后的 `.app` 做，别对开发版。开发模式跑的是裸二进制，系统设置的权限列表里根本看不到它。

**签名。** 只有签名身份固定，macOS 才会在重装后保留辅助功能和输入监控。自签名（`-`）每次构建都让授权失效。`tauri.conf.json` 保持自签名，好让 CI 和没有证书的人也能构建。本机构建用：

```bash
bun run build:signed                        # 自动从钥匙串挑身份
bun run build:signed -- --bundles app,dmg
APPLE_SIGNING_IDENTITY="<sha-1>" bun run build:signed
```

优先 `Developer ID Application`，没有就用 `Apple Development`。身份通过 `--config` 传入，个人证书不会进仓库。从自签名切过来时还要再授权一次，之后就不用了。

```bash
security find-identity -v -p codesigning
# Tauri 的 dmg 步骤要控制访达，用 hdiutil 也一样：
cd src-tauri/target/release/bundle && mkdir dmg-stage && ditto macos/Voiceless.app dmg-stage/Voiceless.app \
  && ln -s /Applications dmg-stage/Applications \
  && hdiutil create -volname Voiceless -srcfolder dmg-stage -ov -format UDZO dmg/Voiceless_0.1.0_aarch64.dmg \
  && rm -rf dmg-stage
```

联网测试用无效 Key 打真实端点：

```bash
cd src-tauri && VOICELESS_LIVE_TESTS=1 cargo test --lib live_ -- --ignored
```

代码位置：

| 路径                                         | 内容                                                                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src-tauri/src/voice.rs`                     | 模式、提示词、词典替换、输出校验                                                                                                                   |
| `src-tauri/src/actions.rs`                   | 识别 → 整理或翻译 → 粘贴                                                                                                                           |
| `src-tauri/src/transcription_coordinator.rs` | 热键状态机，含 Fn → Fn+Shift 升级                                                                                                                  |
| `src-tauri/src/asr/`                         | 云端适配器。百炼 Qwen-ASR（≤10 MB，按 3 分钟分段）、智谱 GLM-ASR（≤30 秒，按 28 秒并行分段）、阶跃星辰 StepAudio ASR（≤100 MB，按 3 分钟并行分段） |
| `src-tauri/src/catalog/`                     | 内置模型目录，以及默认本地模型的解析                                                                                                               |
| `src/voiceless/`                             | 设置界面与首次引导                                                                                                                                 |
| `src/overlay/`                               | 录音悬浮条                                                                                                                                         |

背景资料看 `docs/typeless-local-plan.md` 和 `docs/BASELINE.md`。上游 Handy 的原始 README 留在 `docs/UPSTREAM_HANDY_README.md`。

## 许可

MIT，见 `LICENSE`。第三方组件和模型权重的许可见 `THIRD_PARTY.md`。
