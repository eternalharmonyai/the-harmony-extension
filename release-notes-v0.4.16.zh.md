## v0.4.16 更新内容

*v0.4.16 新增 Gemini 4 Argon 前沿模型，提升长对话的稳定性，并如实说明 Harmony 的网络行为与能力。*

### 🚀 Gemini 4 Argon

`gemini-4-argon` 作为前沿（旗舰）选项加入 Gemini 模型选择器，并映射到 premium 层级。它走原生路径，与其他 2.5+ Gemini 模型采用相同的思考配置规则；使用前会触发 premium 费用确认。

### 💸 费用由您自行核实

模型描述不再显示固定的每令牌价格。服务商费率会变动，且常常无预警变动，因此 premium 模型的费用确认改为提示您查阅服务商的当前定价，而不再引述可能已经过期的数字。

### 🧠 长对话稳定性

- **单轮内上下文压缩**——当一轮对话超出模型的上下文保护阈值时，会就地收缩最早的工具输出。消息不会被删除，工具调用配对保持完整。
- **记忆健康提示**现在分类准确：真正的失败会警告，良性状态保持安静，不再虚报问题。
- **网络检查**——报告导致调用卡顿的本机重定向与过期端口转发规则。

### 🧰 原生 DeepSeek 选择器工具调用与编程模型选择

- **原生模型选择器支持工具调用**——为 Harmony 注册的 DeepSeek 模型（`deepseek-flash`、`deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp`）映射并转发 `options.tools`，在 `deepseekToolBridge.ts` 中重新组装流式 `delta.tool_calls` 片段（包括服务端省略 `index` 的情形），并向 Agent 模式回传 `LanguageModelToolCallPart`。
- **Agents 与 Swarm 选择器支持 DeepSeek Coding / Flash (V4.1)**——`deepseek-flash`（V4.1）现可在协作 **Agents** 模型选择器、**Swarm** 默认设置与 **DeepSwarm** 侧边栏下拉菜单中直接选择，并作为 DeepSeek 在 `coding`、`light` 与 `mid` 层级的默认模型。
- **耳语顺序与如实重试报告**——会话中途耳语排在工具结果之后以保持 `tool_calls` 配对合法；无工具回退重试如实报告服务端状态与原因，并在用量账本中记录降级重试。
- **IT/网络、WordPress/主机与云连接器工具及无头宿主适配层**——新增 `harmony_dns_ssl_probe`、`harmony_net_path_audit`、`harmony_wp_site_diagnostic`、`harmony_wp_rest_client` 与 `harmony_cloud_connector`（支持 Supabase、Cloudflare、Netlify、Firebase 与 Google Cloud API 启用状态检查），并加入 `vscodeHostShim.ts`，使全部 196 个注册工具也可在 VS Code 扩展宿主之外以无头模式执行。

### 🖼️ OCR

原生 OCR 辅助脚本现已随扩展发布，中英文文档均如实说明要求：要么安装原生层（Windows 的 `winocr`、macOS 的 `pyobjc`），要么自行提供 Tesseract 语言数据。

### 🌍 文档

中英文 README 现在都明确说明哪些功能完全在本机运行、哪些需要联网——并附上"无需 API 密钥即会联网"的功能表。

### 🔧 底层改进

- 服务商与 Hub 连接设置改为机器级，项目设置无法重定向它们。
- 仓库检查、迁移测试与步骤捕获测试现已纳入打包流水线。

---

## What's New in v0.4.16

*v0.4.16 adds the Gemini 4 Argon frontier model, makes long turns more stable, and states Harmony's network behaviour and capabilities plainly.*

### 🚀 Gemini 4 Argon

`gemini-4-argon` joins the Gemini picker as the frontier option and maps to the premium tier. It routes natively with the same thinking-configuration rules as the other 2.5+ Gemini models, and the premium cost confirmation applies before it is used.

### 💸 Costs you can verify yourself

Model descriptions no longer print fixed per-token prices. Provider rates change, often without notice, so the premium-model confirmation now points you to your provider's current pricing instead of quoting a number that may already be stale.

### 🧠 Long-turn stability

- **In-turn context compaction** — when a turn grows past the model's context guard, the oldest tool output is shrunk in place. Messages are never removed and tool-call pairing is preserved.
- **Memory-health notices** are now classified properly: real failures warn, while benign states stay quiet instead of raising a false alarm.
- **Network check** — reports local redirects and stale port-forward rules that make provider calls stall.

### 🧰 Native DeepSeek picker tool calling & Coding selector

- **Tool calling in the native model picker** — `options.tools` is mapped and forwarded for Harmony's registered DeepSeek models (`deepseek-flash`, `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp`), streamed `delta.tool_calls` fragments are reassembled in `deepseekToolBridge.ts` (including when a server omits `index`), and `LanguageModelToolCallPart` events are emitted back to Agent mode.
- **DeepSeek Coding / Flash (V4.1) in Agent & Swarm selectors** — `deepseek-flash` (V4.1) is now directly selectable in the collaborative **Agents** model selector, **Swarm** defaults, and the **DeepSwarm** sidebar selector, and serves as the default DeepSeek model across `coding`, `light`, and `mid` tiers.
- **Whisper ordering & retry honesty** — mid-session whispers are appended after tool results so `tool_calls` pairing stays valid, and tool-less fallback retries report the server's actual status/reason and record degraded retries in the usage ledger.
- **IT/Network, WordPress/Hosting & Cloud connector tools + headless host shim** — adds `harmony_dns_ssl_probe`, `harmony_net_path_audit`, `harmony_wp_site_diagnostic`, `harmony_wp_rest_client`, and `harmony_cloud_connector` (Supabase, Cloudflare, Netlify, Firebase, and Google Cloud API enablement checks), plus `vscodeHostShim.ts` so all 196 registered tools can also execute headlessly outside the VS Code extension host.

### 🖼️ OCR

The native OCR helper now ships with the extension, and the requirements are documented accurately in both languages: either a native layer (`winocr` on Windows, `pyobjc` on macOS) or Tesseract language data that you supply yourself.

### 🌍 Documentation

Both READMEs now state exactly what runs on your machine and what uses the network — including a table of the features that make outbound requests before you add any API key.

### 🔧 Under the hood

- Provider and Hub connection settings are machine-scoped, so a project's settings cannot redirect them.
- Repository checks, migration tests and step-capture tests now run as part of the package pipeline.
