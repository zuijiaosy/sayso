# Voiceless

本地优先的 macOS 语音输入工具，交互参考 Typeless：**按 Fn 说话，整理好的文字出现在光标处；按 Fn + 左 Shift 说中文，插入地道的译文。**

Voiceless 派生自开源项目 [Handy](https://github.com/cjpais/Handy)（MIT），复用了它的录音、全局热键、非激活悬浮窗、可靠粘贴和本地模型管理，在此基础上增加了翻译模式、文本模型整理、自定义词典和阿里云百炼云端识别。

> 状态：0.1 开发版，只在 macOS（Apple Silicon）上验证过。

## 功能

| 功能     | 说明                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 口述     | 默认 `Fn`。短按开始、再按结束；也可以按住说话、松开结束                                                                               |
| 翻译     | 默认 `Fn + 左 Shift`。悬浮条上可切换目标语言；先按住 Fn 再按左 Shift，会把正在进行的口述转为翻译                                      |
| 悬浮条   | 屏幕底部黑色胶囊：✕ 取消、实时波形、✓ 完成；不抢走当前输入框的焦点                                                                    |
| 语音识别 | 默认本地 SenseVoice（离线，中/英/日/韩/粤）；云端可选阿里云百炼 `qwen3-asr-flash`、智谱 `glm-asr-2512` 或阶跃星辰 `stepaudio-2.5-asr` |
| 文本模型 | 预设 DeepSeek `deepseek-flash`（已关闭思考模式）、阿里云百炼，以及任意 OpenAI 兼容接口                                                |
| 口述整理 | 关闭 / 仅纠错 / 整理（默认）                                                                                                          |
| 词典     | 标准写法、常见误识别（字面替换）、固定译法、备注；支持文本导入导出                                                                    |

## 数据去向

| 配置                           | 音频             | 文字                           |
| ------------------------------ | ---------------- | ------------------------------ |
| 本地识别，整理关闭             | 不出本机         | 不出本机                       |
| 本地识别 + DeepSeek 等文本模型 | 不出本机         | 识别结果和相关词条发往所选服务 |
| 云端识别（百炼 / 智谱 / 阶跃） | 上传到所选服务商 | 取决于文本模型设置             |

- **不会静默切换到云端。** 本地识别失败时不会自动改用云端。
- **翻译失败时不会插入原文。** 悬浮条会给出「重试」和「复制原文」。
- **整理失败时插入识别原文。** 口述整理出错或超时，直接插入识别出的文字（已应用词典替换）。
- **API Key 保存在本机设置文件中。** 当前版本以明文保存在 `~/Library/Application Support/com.voiceless.desktop/settings_store.json`，计划后续迁移到钥匙串。

## 安装与首次使用

1. 构建或下载 `Voiceless.app`，放进「应用程序」文件夹。
2. 从 GitHub Actions 下载的 macOS 安装包没有 Apple 公证。确认安装包来自本仓库后，在终端执行以下命令移除隔离属性：

   ```bash
   xattr -cr /Applications/Voiceless.app
   ```

3. 打开后按引导授予 **麦克风**、**辅助功能**、**输入监控**。
4. 系统设置 → 键盘 →「按下 🌐 键时」改为 **不执行任何操作**，否则按 Fn 会同时切换输入法。
5. 选择语音识别：下载 SenseVoice（约 152 MB）、导入已有的 sherpa-onnx SenseVoice int8 文件夹，或使用云端识别（阿里云百炼 / 智谱 GLM / 阶跃星辰 StepAudio）。
6. 如需整理或翻译，在「模型 → 文本模型」填写 DeepSeek 或其他服务的 API Key，点「测试」。

**已知限制**

- Fn 键只在 Apple 键盘上有效，第三方键盘请在「快捷键」里「添加另一个」。
- 未使用固定签名身份构建时，每次重新安装后都要重新授予辅助功能和输入监控权限。
- 密码框等「安全输入」场景下，系统会阻止模拟粘贴。
- 智谱 GLM-ASR 的多个热词如何编码，官方文档没有写明。Voiceless 按官方 SDK 的方式发送，被服务端拒绝时会自动去掉热词重试。
- 阶跃星辰的 Step Plan 订阅密钥不能调用 `/v1/audio/transcriptions`，需要改用按量付费密钥。该模型仅支持中英文。

## 开发

需要 Rust、Bun、Xcode Command Line Tools、CMake。

```bash
bun install
CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri dev      # 开发运行（权限会记在终端上）
CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri build --bundles app,dmg   # 打包
cd src-tauri && cargo test --lib                          # Rust 单元测试
bun run lint && bunx tsc --noEmit                         # 前端检查
```

在系统设置里授权时，请使用打包后的 `.app`：开发模式下运行的是裸二进制，系统设置的权限列表里找不到它。

**签名与打包。** 用固定的签名身份构建，macOS 才会在重新安装后保留辅助功能和输入监控授权；自签名（`-`）每次构建都会让授权失效。

```bash
security find-identity -v -p codesigning        # 找到你的签名身份
APPLE_SIGNING_IDENTITY="<身份 SHA-1>" CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri build --bundles app
# Tauri 的 dmg 脚本需要控制访达；也可以直接用 hdiutil：
cd src-tauri/target/release/bundle && mkdir dmg-stage && ditto macos/Voiceless.app dmg-stage/Voiceless.app \
  && ln -s /Applications dmg-stage/Applications \
  && hdiutil create -volname Voiceless -srcfolder dmg-stage -ov -format UDZO dmg/Voiceless_0.1.0_aarch64.dmg \
  && rm -rf dmg-stage
```

可选的联网测试，使用无效 Key 验证服务端点：

```bash
cd src-tauri && VOICELESS_LIVE_TESTS=1 cargo test --lib live_ -- --ignored
```

主要代码位置：

| 路径                                         | 内容                                                                                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src-tauri/src/voice.rs`                     | 模式、提示词、词典替换、模型输出校验                                                                                                                                  |
| `src-tauri/src/actions.rs`                   | 录音结束后的识别 → 整理/翻译 → 粘贴流水线                                                                                                                             |
| `src-tauri/src/transcription_coordinator.rs` | 热键状态机（含 Fn → Fn+Shift 升级）                                                                                                                                   |
| `src-tauri/src/asr/`                         | 云端识别适配器：百炼 Qwen-ASR（单次 ≤10 MB，按 3 分钟分段）、智谱 GLM-ASR（单次 ≤30 秒，按 28 秒分段并行）、阶跃星辰 StepAudio ASR（单次 ≤100 MB，按 3 分钟分段并行） |
| `src/voiceless/`                             | 设置界面与首次引导                                                                                                                                                    |
| `src/overlay/`                               | 录音悬浮条                                                                                                                                                            |

更多背景见 `docs/typeless-local-plan.md` 和 `docs/BASELINE.md`；上游 Handy 的原始说明保存在 `docs/UPSTREAM_HANDY_README.md`。

## 许可

应用代码使用 MIT 许可，见 `LICENSE`。第三方组件和模型权重的许可见 `THIRD_PARTY.md`。
