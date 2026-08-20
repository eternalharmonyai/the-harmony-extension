## v0.4.11 更新内容

*v0.4.11 是一个重要版本 —— 自 v0.4.1 以来共 44+ 次提交，涵盖可逆效果账本、Exoskeleton v2.0、全新的字节跳动系提供商、Gemini 原生流式输出、DeepSeek 上下文缓存，以及长时间对话的可靠性修复。*

### 🛡️ 可逆效果账本
所有变更操作 —— 文件写入、终端命令、后台进程和密钥更改 —— 现在都会在本地账本中记录一条可逆效果。Harmony 可以回滚文件变更、停止已启动的进程，并从中断的操作中恢复。操作前快照已去重、限制大小，并共享同一套代码路径。

### 🦾 Exoskeleton v2.0
六个新的子系统模块（第 0–5 阶段）构成 Exoskeleton v2.0 骨架，并以四个原生工具的形式暴露 —— `harmony_spine`、`harmony_oracle`、`harmony_guard` 和 `harmony_dispatch` —— 让编排层一次性完成规划、验证和调度。

### 🌏 BytePlus / Doubao / StepFun —— 正确的模型 ID
BytePlus（国际版）模型 ID 已修正为真实的 ModelArk `seed-*` ID（Seed 2.0 Pro / Lite / Mini / Code）。为 Doubao、BytePlus 编程版计划和 StepFun 提供了专门的 **设置 API 密钥** 命令。侧边栏主模型选择现在能正确路由到聊天。

### 🔍 模型发现持久化
**Harmony: Discover Models (live)**（发现模型）现在会把提供商的精确模型列表写入本地文件，并支持复制 / 打开操作。

### 🧠 Gemini 原生流式输出 + 推理捕获
原生 `generateContent` 流式输出，保留 `thought_signature` 并支持 `thinkingConfig`。新增 **Gemini 3.7 Flash** 和 **GLM 5.3**。

### 🇨🇳 Qwen 3.8 Max + Qwen 视觉刷新
阿里巴巴 / Qwen 重载级 → **Qwen 3.8 Max**（旗舰，文本 + 视觉）；轻量级 → **Qwen 3.7 Flash**。Qwen 视觉从 `qwen-vl-max` 升级到 **`qwen3.8-max`**（以 `qwen3.7-plus` 作为更便宜的选择）。

### ⚡ 性能：DeepSeek 缓存 + 并行只读批处理
稳定的前缀缓存排序（system 优先、确定性工具）以及 DeepSeek 的中段历史截断。独立的只读工具调用并行批处理（`harmony.parallelToolBatching` 逃生开关）。

### 🤖 原生模型选择器中的 DeepSeek
Harmony 将 **DeepSeek V4 Flash** 和 **DeepSeek V4 Pro** 注册为原生 VS Code 语言模型，因此安装此扩展的任何人都会在 Copilot Chat 的模型选择器中看到它们 —— 每位用户提供自己的 DeepSeek API 密钥。**注意：** 这些选择器条目是纯 DeepSeek 聊天补全；完整的 `harmony_*` 工具循环通过侧边栏 / 直接提供商路由的 `@harmony` 运行，而非原生选择器。

### 🩺 Harmony: LM Check
从命令面板运行 **Harmony: LM Check（DeepSeek 注册表诊断）**，查询与 Copilot Chat 选择器读取的同一份模型注册表。

### 🩹 聊天可靠性修复
- Hub 提示等待有界（30 秒）—— 本地 hub 变慢不再卡住一次对话
- 流式响应在闲置 120 秒后干净地中止
- 续传请求每次重试使用新的 AbortController（工具调用后的 "fetch failed" 修复）
- 工具路由守卫现在接受实质性的散文式回答，而不会让一次正常的对话硬失败

### 🛡️ Triple-Check 注册表同步
Triple-Check 审计现在会对照模型注册表验证每个提供商的层级默认值。

### 🔧 修复
- Qwen 视觉现在遵循高级模型确认门（此前缺失，与 Gemini 不同）
- 侧边栏主模型选择现在驱动聊天路由
- 修复了侧边栏下拉框与聊天标签可能显示不同 DeepSeek 模型的失步问题（单一权威数据源）
- Consult-model 分派覆盖 Doubao / BytePlus / StepFun / Zhipu 编程版
- 只读门控不再对长消息误触发
- Creative Tools 完全本地化（英文 + 中文）
- 可配置的快照大小上限（`harmony.snapshotMaxBytes`）
- 编排模式提示文本已修正

---

## What's New in v0.4.11

*v0.4.11 is a major release — 44+ commits since v0.4.1 spanning a reversible Effect Ledger, Exoskeleton v2.0, new ByteDance-family providers, Gemini native streaming, DeepSeek context caching, and long-running chat-reliability fixes.*

### 🛡️ Reversible Effect Ledger
All mutating operations — file writes, terminal commands, background processes, and secret changes — now record a reversible effect in a local ledger. Harmony can roll back file mutations, stop spawned processes, and recover from interrupted operations. Pre-action snapshots are deduplicated, size-capped, and share a single code path.

### 🦾 Exoskeleton v2.0
Six new subsystem modules (Phase 0–5) form the Exoskeleton v2.0 skeleton, exposed as four native tools — `harmony_spine`, `harmony_oracle`, `harmony_guard`, and `harmony_dispatch` — giving the orchestration layer planning, verification, and dispatch in one pass.

### 🌏 BytePlus / Doubao / StepFun — correct model IDs
BytePlus (international) model IDs corrected to the real ModelArk `seed-*` IDs (Seed 2.0 Pro / Lite / Mini / Code). Dedicated **Set API Key** commands for Doubao, BytePlus Coding Plan, and StepFun. Sidebar primary-model selection now routes correctly to chat.

### 🔍 Model discovery persistence
**Harmony: Discover Models (live)** now writes the provider's exact model list to a local file with copy/open actions.

### 🧠 Gemini native streaming + reasoning capture
Native `generateContent` streaming with `thought_signature` preservation and `thinkingConfig` support. Added **Gemini 3.7 Flash** and **GLM 5.3**.

### 🇨🇳 Qwen 3.8 Max + Qwen vision refresh
Alibaba/Qwen heavy tier → **Qwen 3.8 Max** (flagship, text + vision); light tier → **Qwen 3.7 Flash**. Qwen vision upgraded from `qwen-vl-max` to **`qwen3.8-max`** (with `qwen3.7-plus` as a cheaper option).

### ⚡ Performance: DeepSeek caching + parallel read-only batching
Stable prefix-cache ordering (system-first, deterministic tools) and mid-history truncation for DeepSeek. Independent read-only tool calls batch in parallel (`harmony.parallelToolBatching` escape hatch).

### 🤖 DeepSeek in the native model picker
Harmony registers **DeepSeek V4 Flash** and **DeepSeek V4 Pro** as native VS Code language models, so they appear in Copilot Chat's model picker for anyone who installs the extension — each user supplies their own DeepSeek API key. **Note:** these picker entries are plain DeepSeek chat completions; the full `harmony_*` tool loop runs through `@harmony` via the sidebar / direct-provider route, not the native picker.

### 🩺 Harmony: LM Check
Run **Harmony: LM Check (DeepSeek Registry Diagnostic)** from the Command Palette to query the same model registry Copilot Chat's picker reads.

### 🩹 Chat reliability fixes
- Hub prompt awaits bounded (30s) — a slow local hub no longer stalls a turn
- Streaming responses abort cleanly after 120s of idleness
- Continuation fetches use a fresh AbortController per retry (post-tool "fetch failed" fix)
- Tool-routing guard now accepts substantive prose answers instead of hard-failing a good turn

### 🛡️ Triple-Check registry sync
The Triple-Check audit now verifies every provider's tier defaults against its model registry.

### 🔧 Fixes
- Qwen vision now respects the premium-model confirmation gate (was missing, unlike Gemini)
- Sidebar primary-model selection now drives the chat route
- Fixed a desync where the sidebar dropdown and the chat label could show different DeepSeek models (single canonical source of truth)
- Consult-model dispatch cases for Doubao/BytePlus/StepFun/Zhipu Coding
- Read-only gating no longer misfires on long messages
- Creative Tools fully localized (EN + ZH)
- Configurable snapshot size limit (`harmony.snapshotMaxBytes`)
- Orchestration mode prompt text corrected
