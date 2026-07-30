# Harmony Extension v0.4.2

---

### 🌏 Chinese AI Provider Support

Harmony now connects directly to two major Chinese AI platforms through your own API keys:

- **ByteDance / Doubao (字节跳动豆包)** — Volcano Engine Ark API with four models: Seed-Evolving (always latest), Seed-2.1-pro (flagship), Seed-2.1-turbo (cost-efficient), and Seed-Code (coding-specialized, ~256K context)
- **StepFun / 阶跃星辰** — 198B MoE architecture with step-3.7-flash, supporting 256K context, native multimodal, tool calling, and reasoning effort control
- **Doubao Rewards (豆包协作激励计划)** — Dedicated provider for Volcano Engine's Collaboration Rewards Program, using authorized access point IDs (ep-xxx)

### 🌐 Endpoint Region Switcher

Chinese providers often offer separate domestic and international API endpoints. The sidebar now includes a region switcher:

- **StepFun** — toggle between international (`api.stepfun.ai`) and mainland China (`api.stepfun.com`)
- **ByteDance** — defaults to Beijing (`ark.cn-beijing.volces.com`) with custom endpoint override for regional Volcano Engine deployments

### 🧠 Reasoning & Thinking

Reasoning content (thinking) is now properly captured for all new providers that support it. Thinking appears in a collapsible block instead of leaking into the response text.

### 🔧 Provider Routing

Direct provider routing is now wired for ByteDance and StepFun, with proper base URL resolution, API key handling, and OpenAI-compatible request/response streaming.

---

### Provider Lineup

| Provider | Models | Region Options |
|:---|:---|:---|
| ByteDance / Doubao | Seed-Evolving, Seed-2.1-pro, Seed-2.1-turbo, Seed-Code | Beijing / Custom |
| Doubao Rewards | Authorized access point (ep-xxx) | Beijing / Custom |
| StepFun / 阶跃星辰 | step-3.7-flash | International / Mainland / Custom |

Activate models in the Volcano Engine Ark console or StepFun console before use. Use **Harmony: Discover Models (live)** to verify exact model IDs available to your account.

---

# Harmony Extension v0.4.2

---

### 🌏 中国 AI 服务商支持

Harmony 现可通过您自己的 API 密钥直接连接两大中国 AI 平台：

- **字节跳动豆包（ByteDance / Doubao）** —— 火山引擎方舟 API，提供四款模型：Seed-Evolving（持续更新）、Seed-2.1-pro（旗舰稳定版）、Seed-2.1-turbo（快速高性价比）、Seed-Code（编程专精，支持约 256K 上下文）
- **阶跃星辰（StepFun）** —— 198B MoE 架构，step-3.7-flash 模型，支持 256K 上下文、原生多模态、工具调用及推理强度控制
- **豆包协作激励计划（Doubao Rewards）** —— 火山引擎协作激励计划专用服务商，使用授权接入点 ID（ep-xxx）

### 🌐 端点区域切换

中国服务商通常提供独立的国内和国际 API 端点。侧边栏现已包含区域切换器：

- **阶跃星辰** —— 在国际端点（`api.stepfun.ai`）和中国大陆端点（`api.stepfun.com`）之间切换
- **字节跳动** —— 默认北京端点（`ark.cn-beijing.volces.com`），支持自定义区域端点覆盖

### 🧠 推理与思考

所有支持推理的新服务商现已正确捕获推理内容（思考过程）。思考内容显示在可折叠的区块中，不再泄露到正文中。

### 🔧 服务商路由

字节跳动和阶跃星辰现已接入直连服务商路由，包括正确的基址解析、API 密钥处理及 OpenAI 兼容的请求/响应流式传输。

---

### 服务商一览

| 服务商 | 模型 | 区域选项 |
|:---|:---|:---|
| 字节跳动 / 豆包 | Seed-Evolving、Seed-2.1-pro、Seed-2.1-turbo、Seed-Code | 北京 / 自定义 |
| 豆包协作激励计划 | 授权接入点（ep-xxx） | 北京 / 自定义 |
| 阶跃星辰 | step-3.7-flash | 国际 / 大陆 / 自定义 |

使用前请在火山引擎方舟控制台或阶跃星辰控制台激活模型。使用 **Harmony: Discover Models (live)** 验证您账户下可用的具体模型 ID。
