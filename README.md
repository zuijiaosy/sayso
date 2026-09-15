# Voiceless

本地优先的 macOS 语音输入工具，交互参考 Typeless：**按 Fn 说话，整理好的文字出现在光标处；按 Fn + 左 Shift 说中文，插入地道的译文。**

Voiceless 派生自开源项目 [Handy](https://github.com/cjpais/Handy)（MIT），复用了它的录音、全局热键、非激活悬浮窗、可靠粘贴和本地模型管理，在此基础上增加了翻译模式、文本模型整理、自定义词典和阿里云百炼云端识别。

> 状态：0.1 开发版，只在 macOS（Apple Silicon）上验证过。

## 功能

| 功能 | 说明 |
|---|---|
| 口述 | 默认 `Fn`。短按开始、再按结束；也可以按住说话、松开结束 |
| 翻译 | 默认 `Fn + 左 Shift`。悬浮条上可切换目标语言；先按住 Fn 再按左 Shift，会把正在进行的口述转为翻译 |
| 悬浮条 | 屏幕底部黑色胶囊：✕ 取消、实时波形、✓ 完成；不抢走当前输入框的焦点 |
| 语音识别 | 默认本地 SenseVoice（离线，中/英/日/韩/粤）；可选阿里云百炼 `qwen3-asr-flash` |
| 文本模型 | 预设 DeepSeek `deepseek-flash`（已关闭思考模式）、阿里云百炼，以及任意 OpenAI 兼容接口 |
| 口述整理 | 关闭 / 仅纠错 / 整理（默认） |
| 词典 | 标准写法、常见误识别（字面替换）、固定译法、备注；支持文本导入导出 |

## 数据去向

| 配置 | 音频 | 文字 |
|---|---|---|
| 本地识别，整理关闭 | 不出本机 | 不出本机 |
| 本地识别 + DeepSeek 等文本模型 | 不出本机 | 识别结果和相关词条发往所选服务 |
| 百炼云端识别 | 上传到阿里云 | 取决于文本模型设置 |

- **不会静默切换到云端。** 本地识别失败时不会自动改用云端。
- **翻译失败时不会插入原文。** 悬浮条会给出「重试」和「复制原文」。
- **整理失败时插入识别原文。** 口述整理出错或超时，直接插入识别出的文字（已应用词典替换）。
- **API Key 保存在本机设置文件中。** 当前版本以明文保存在 `~/Library/Application Support/com.voiceless.desktop/settings_store.json`，计划后续迁移到钥匙串。

## 安装与首次使用

1. 构建或下载 `Voiceless.app`，放进「应用程序」文件夹。
2. 打开后按引导授予 **麦克风**、**辅助功能**、**输入监控**。
3. 系统设置 → 键盘 →「按下 🌐 键时」改为 **不执行任何操作**，否则按 Fn 会同时切换输入法。
4. 选择语音识别：下载 SenseVoice（约 152 MB）、导入已有的 sherpa-onnx SenseVoice int8 文件夹，或使用百炼。
5. 如需整理或翻译，在「模型 → 文本模型」填写 DeepSeek 或其他服务的 API Key，点「测试」。

**已知限制**

- Fn 键只在 Apple 键盘上有效，第三方键盘请在「快捷键」里「添加另一个」。
- 自签名构建每次重新安装后，macOS 可能需要重新授予辅助功能和输入监控权限。
- 密码框等「安全输入」场景下，系统会阻止模拟粘贴。

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

可选的联网测试，使用无效 Key 验证服务端点：

```bash
cd src-tauri && VOICELESS_LIVE_TESTS=1 cargo test --lib live_ -- --ignored
```

主要代码位置：

| 路径 | 内容 |
|---|---|
| `src-tauri/src/voice.rs` | 模式、提示词、词典替换、模型输出校验 |
| `src-tauri/src/actions.rs` | 录音结束后的识别 → 整理/翻译 → 粘贴流水线 |
| `src-tauri/src/transcription_coordinator.rs` | 热键状态机（含 Fn → Fn+Shift 升级） |
| `src-tauri/src/asr/` | 百炼 Qwen-ASR 适配器 |
| `src/voiceless/` | 设置界面与首次引导 |
| `src/overlay/` | 录音悬浮条 |

更多背景见 `docs/typeless-local-plan.md` 和 `docs/BASELINE.md`；上游 Handy 的原始说明保存在 `docs/UPSTREAM_HANDY_README.md`。

## 许可

应用代码使用 MIT 许可，见 `LICENSE`。第三方组件和模型权重的许可见 `THIRD_PARTY.md`。
