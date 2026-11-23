# Harmony Extension v0.4.17

[English](release-notes-v0.4.17.md) | [中文](release-notes-v0.4.17.zh.md)

*v0.4.17 ships Fleet Mode + 3-Seat Collaborator Architecture and a pin-capable Quick-Jump Hub, brings full parity across Harmony Chat (VS Code Webview) and Sovereign Desktop Studio (`:8789`) with Prism Sanctuary, completes the Gemini 4 model lineup (`gemini-4-argon`, `gemini-4-carbon`, `gemini-4-neon`, `gemini-4-hydrogen`) with Vertex AI local credential support and 3-layer VPN/buffered-tool stream resilience, adds Renderer Memory Shield v3, closes 7 cross-primitive verification and memory loops, and reinforces explicit User Billing Responsibility disclosures.*

---

## 🚀 Fleet Mode, Collaborator Roles & Harmony Chat / `:8789` Parity

- **Fleet Mode & Quick-Jump Hub (`src/host/studioSettings.ts`, `src/sidebar.ts`, `src/chatParticipant.ts`, `src/host/standaloneServer.ts`):**
  - Couples `harmony.orchestrateMode.fleetEnabled` cleanly under `harmony.orchestrateMode.enabled` and syncs live across the Sidebar, Harmony Chat webview, and External `:8789` Studio.
  - Routes parallel read-only **Collaborators** (`scout`, `researcher`, `planner`, `implementer`, `verifier`, `critic`, `cost_sentinel`, `hard_reasoner`) via your Context Shield offload target, with optional isolated `git worktree` sandboxes and independent Critic + Verifier review.
  - Adds a sticky-pinnable **Quick-Jump Hub** (`🌟 Frontier Model`, `⚡ Orchestrate & Fleet`, `🛡️ Context Shield & Offload`, `📥 Whisper Box`, `🧭 Routing & Keys`, `📋 Plan & Usage`, `🧠 Sovereign Hub`).
- **Harmony Chat & Sovereign (`:8789`) Studio Upgrades (`src/host/standaloneServer.ts`, `src/sessions.ts`, `src/prismSanctuary.ts`):**
  - Inline Flow-State `harmony_ask_question` interactive cards (`explore` / `decide`, `thought`, options, `readyCheckbox`, `.harmony/ask-answers/` receipts, seamless turn continuation).
  - Unified session persistence (`/save`, `/resume`, `/clear`, `_autosave` scratchpad auto-restore), **🔮 Prism Sanctuary** (`prismSanctuary.ts`) with strict context isolation, per-render cryptographic nonce CSP (`buildWebviewStudioCsp` & `buildStandaloneCsp`), zero-account native Tauri 2 Studio window (`harmony-native-control --studio`), non-clipping responsive headers/toolbars, and full Daylight / Emerald / Nebula / Calm Slate / Auto (VS Code) theming.
- **Renderer Memory Shield v3 (`src/rendererShield.ts`, `src/todoStore.ts`, `src/deepseekProvider.ts`):**
  - Compact `<512 B` `ChatResult.metadata` tool records, Extension-Host-only read/Fleet payload retention (`.harmony/fleet/`), bounded ring-buffer OutputChannels, `~25 fps` (`40 ms`) SSE token coalescing, reversible auto-archival of completed todos to `.harmony/todos-archive.json`, and an `80`-bubble live Studio DOM cap.
- **Explicit User Billing Responsibility (`src/sidebar.ts`, `src/costTracker.ts`, `src/host/standaloneServer.ts`, `locales/en.json`, `locales/zh.json`):**
  - Always-visible localized (`EN` + `简体中文`) `UNOFFICIAL ESTIMATE ONLY` notice across all Usage states (compact, zero-call, and active) and Studio Settings → Costs: you pay your API provider(s) directly, Context Shield is not a spend cap, and your official provider billing console is the sole source of truth.

---

## 🌟 Gemini 4 Lineup, Vertex AI Local Credential Store & 3-Layer Stream Resilience

- **Gemini 4 Argon, Carbon, Neon & Hydrogen (`src/providerModels.ts`, `src/providers.ts`, `src/geminiNativeStreaming.ts`, `src/sidebar.ts`, `src/host/standaloneServer.ts`):**
  - Adds **`gemini-4-neon`** (adapted from Carbon on the Pareto frontier for complex coding, analytical reasoning, and long-running agent workflows with `1M` context window limit, `64K` per-step foreground output cap, and automatic `MINIMAL → LOW` thinking clamp) alongside **`gemini-4-carbon`**, **`gemini-4-argon`**, and fast **`gemini-4-hydrogen`**.
- **Vertex AI Local Credential Store & Dedicated-VM Opt-In Gate (`src/vertexAuth.ts`):**
  - Supports non-interactive Service Account JSON credentials stored in an OS-restricted local credential file alongside `gcloud` ADC, OAuth Bearer env overrides, and Vertex Express keys, and requires explicit opt-in (`harmony.gemini.allowDedicatedVmEndpoints`, default off) before addressing `/endpoints/<vm-id>` dedicated-VM endpoints.
- **3-Layer VPN & Buffered-Tool Stream Resilience (`src/vpnResilientTransport.ts`, `src/geminiNativeStreaming.ts`, `src/chatParticipant.ts`):**
  - **Wire Layer:** OS TCP `SO_KEEPALIVE` (`15s` probes) + fresh IPv4 tunnel socket rotation on zero-delta drops.
  - **Synthesis Layer:** `240s` post-upload TTFB floor + `300s` (`5m`) mid-stream idle floor (with `+120s` per-retry escalation) for `Argon` / `Carbon` / `Neon` when buffering large `functionCall` JSON payloads server-side.
  - **Host UI Layer:** Zero-mutation `25s` `stream.progress(...)` heartbeat so VS Code's chat UI never appears frozen during silent tool-JSON synthesis.

---

## 🖥️ Standalone Desktop, CLI & MCP Runner (No VS Code Required)

- **One codebase across VS Code, Tauri 2 Desktop, CLI & MCP (`src/host/standaloneServer.ts`, `src/host/vscodeHostShim.ts`, `scripts/harmony-desktop.js`):**
  - Launch the standalone desktop server and native window with `npm run harmony:desktop` or `node bin/harmony-cli.js desktop`.
  - Automatically launches the Tauri 2 native window (`harmony-native-control`) when present, with native app-window fallback (`--app=http://127.0.0.1:8789`).
  - Exposes all **201 registered Harmony tools** (including IT/Network diagnostics, WordPress/Hosting tools, Cloud Connectors, Exoskeleton, Swarm, and the 15 Cognitive Primitives) via:
    - Interactive Desktop Web UI (`GET /`)
    - REST + SSE Streaming API (`GET /api/tools`, `POST /api/tool`, `POST /api/chat`, `POST /api/chat/stream`, `POST /api/whisper`, `GET /api/state`)
    - JSON-RPC 2.0 MCP Server (`POST /api/mcp` and `npm run harmony:mcp` stdio mode)
    - Direct CLI invocation (`node bin/harmony-cli.js tools invoke --tool <name> --input '{...}'`)
- **Singleton `vscode` Shim Identity (`src/host/vscodeHostShim.ts`):**
  - Enforces a single global shim instance and exports `ChatResponseMarkdownPart`, `ChatRequestTurn`, and `ChatResponseTurn` classes so `instanceof` checks behave identically inside and outside VS Code.

---

## 🧬 7 Cross-Primitive Verification & Memory Loops

1. **Proof-Carrying Patch Attestations & Internal Assumption Liveness (`src/citationRecord.ts`, `src/primitives/decisionLog.ts`):**
   - `createPatchAttestationRecord` binds internal code mutations to `Rigor` thought-graph node IDs, `Threadweave` rationale IDs, property-test seeds, and Oracle verification receipts using RFC 8785 (JCS) + Ed25519 signatures.
   - `checkInternalCodeLiveness` and `harmony_threadweave` (`action: "check-liveness"`) monitor watched file/line spans and transition decisions from `live-unchanged` to `altered` when code drifts.
2. **Counterfactual Shadow Worktrees & Empirical `Kairos` Arbitration (`src/primitives/temporalBranch.ts`, `src/primitives/convergenceArbiter.ts`):**
   - `harmony_chronos` (`create-worktree`, `cleanup-worktree`) manages isolated `git worktree` sandboxes under `.harmony/worktrees/`.
   - `harmony_kairos` (`evaluateEmpiricalBranchUtility`) scores competing branches over `(compile_pass, oracle_pass, pbt_pass_rate, diff_minimality, runtime_ms, cost_usd)` with cross-branch test arbitration.
3. **Closed-Loop Empirical Epistemic Calibration (`src/primitives/uncertaintyFabric.ts`, `src/exoskeleton/oracle.ts`, `src/effectLedger.ts`):**
   - Objective verification passes (`+1 alpha`) and rollbacks/struggles (`+1 beta`) feed into `Aletheia`'s calibration ledger, enabling Expected Verified Information Gain per Dollar routing (`rankCandidatesByEvigPerDollar`).
4. **Witness-Gated `Rigor` Verification (`src/primitives/thoughtGraph.ts`):**
   - `ThoughtGraphTool.executeNode` keeps unwitnessed reasoning nodes as `hypothesis` (`unwitnessed-assertion`) until backed by an executable assertion or `witness_hash`.
5. **Holographic Working Memory Stubs & CJK-Aware Token Calibration (`src/inTurnCompaction.ts`, `src/costTracker.ts`, `src/chatParticipant.ts`):**
   - `planInTurnCompaction` replaces oversized tool outputs with structural stubs (`buildHolographicStub`) backed by `.harmony/turn-spill/` (`persistTurnSpill`, `rehydrateTurnSpillSpan`).
   - `costTracker.ts` calibrates a 2-parameter CJK/ASCII OLS token estimator from provider usage reports.
6. **Autonomous Antibody Crystallizer (`src/careBloom.ts`):**
   - `crystallizeAntibody` harvests resolved multi-attempt struggles into `.harmony/antibodies/swe-kb-personal.jsonl` and `recallAntibodiesForContext` surfaces matching fixes before retries.
7. **Two-Stage Consultant Context-Pull & Reverse-Whisper (`src/whisperInbox.ts`):**
   - `fulfillConsultantContextSpans` serves requested workspace file/line spans locally with path-traversal protection, and `emitReverseWhisper` / `listReverseWhispers` provide a non-blocking AI-to-human side-channel under `.harmony/reverse-whispers/`.

---

## 🛠️ Additional Fixes & Documentation

- **🛡️ Context Shield & Worker Offload (`src/chatParticipant.ts`, `src/geminiNativeStreaming.ts`, `src/inTurnCompaction.ts`, `src/costTracker.ts`, `src/sidebar.ts`, `src/lmTools.ts`):**
  - **Prefix-Locked KV Caching:** Moves dynamic turn context out of `systemInstruction` into `<turn_context>` on the user turn and deterministically sorts all 201 tool declarations and JSON schemas to maximize prefix cache hits.
  - **Same-File Read Deduplication & Phase-Adaptive Thinking:** `deduplicateSupersededToolResults` stubs earlier reads when superseded by an encompassing later read of the same file, while `Automatic` mode steps down thinking level on mechanical read/todo hops.
  - **3-Mode Policy & Worker Route (`harmony.costShield.mode`, `harmony.costShield.workerRoute`):** Configurable in both the VS Code Sidebar and Standalone Desktop Studio (`Automatic`, `Manual Only`, `Off`), with worker offloads defaulting to the configured **Agents Profile**.
  - **Provider Billing & Cache Reconciliation Note:** Some cloud providers (such as Google AI Studio / Google Cloud Billing) place a temporary pre-authorization hold at the uncached rate during an active turn and credit back the 75% cached-token discount upon billing reconciliation. Always monitor both the Harmony Sidebar (`⚡cache` / `🧠think` telemetry) and your provider's billing console, as providers may adjust caching rules or pricing on their own schedules.
- **VS Code Studio Editor Tab & Headless TypeScript LanguageService (`src/extension.ts`, `src/host/vscodeHostShim.ts`, `src/host/standaloneServer.ts`):**
  - `Harmony: Open Studio Tab (Full Editor View)` (`harmony.openStudioTab`) opens the full Studio workspace inside a dedicated VS Code editor tab while sharing state with the Standalone Desktop (`8789`) and Tauri Control (`8788`).
  - `vscodeHostShim.ts` provides a headless TypeScript LanguageService (`executeDefinitionProvider`, `executeReferenceProvider`, `executeDocumentRenameProvider`, `executeCodeActionProvider`, `languages.getDiagnostics`, and `workspace.applyEdit`) so all 201/201 tools work both inside and outside VS Code.
- **17-Provider Health Tie-Break (`src/providerHealth.ts`):** `rankProviders` now lists all 17 configured provider IDs in `prefOrder` and sorts any unknown provider last (`Number.MAX_SAFE_INTEGER`) instead of `-1`.
- **Model ID Documentation (`README.md`, `README.zh-CN.md`):** Clarifies how GA and preview/custom-gateway model IDs work in Harmony's default registry and how to override them per tier or provider.

---

# Harmony 扩展 v0.4.17 发布说明

*v0.4.17 推出舰队模式（Fleet Mode）三席协同架构与支持固定的快捷跳转中枢；实现 Harmony Chat（VS Code Webview）与独立原生桌面 Studio（`:8789`）及棱镜圣殿（Prism Sanctuary）全面对齐；完整集齐 Gemini 4 系列模型（`gemini-4-argon`、`gemini-4-carbon`、`gemini-4-neon`、`gemini-4-hydrogen`），提供本地服务账号 / ADC / OAuth 凭证存储与三层 VPN/大工具流韧性恢复；加入渲染进程内存护盾 v3；打通 7 项跨原语验证与记忆闭环；并强化中英文双语用户计费责任说明。*

---

## 🚀 舰队模式、协作者角色与 Harmony Chat / `:8789` 全面对齐

- **舰队模式（Fleet Mode）与快捷跳转中枢（`src/host/studioSettings.ts`、`src/sidebar.ts`、`src/chatParticipant.ts`、`src/host/standaloneServer.ts`）：**
  - 将 `harmony.orchestrateMode.fleetEnabled` 作为协奏模式子选项联动，并在侧边栏、Harmony Chat 与外部 `:8789` Studio 间实时双向同步。
  - 通过上下文护盾分流路由调度 8 类专业只读**协作者（Collaborators）**（`scout`、`researcher`、`planner`、`implementer`、`verifier`、`critic`、`cost_sentinel`、`hard_reasoner`），支持隔离 `git worktree` 沙箱与独立 Critic + Verifier 评审，并提供支持吸顶的**快捷跳转中枢**（含 `🌟 前沿主模型` 一键直达）。
- **Harmony Chat 与独立原生桌面（`:8789`）Studio 升级（`src/host/standaloneServer.ts`、`src/sessions.ts`、`src/prismSanctuary.ts`）：**
  - 内联心流提问卡片 `harmony_ask_question`（`explore` / `decide` 模式、`thought`、多选、`readyCheckbox`、`.harmony/ask-answers/` 留档与无缝续跑）、跨界面会话保存与恢复（`/save`、`/resume`、`/clear`、`_autosave` 自动恢复）、严格上下文隔离的 **🔮 棱镜圣殿（Prism Sanctuary，`prismSanctuary.ts`）**、零账号同步原生 Tauri 2 桌面壳（`harmony-native-control --studio`）、逐次渲染加密 Nonce CSP、窄栏自适应不裁切布局，以及完整多主题色彩适配。
- **渲染进程内存护盾 v3 与明确双语计费责任声明（`src/rendererShield.ts`、`src/todoStore.ts`、`src/sidebar.ts`、`locales/en.json`、`locales/zh.json`）：**
  - 精简 `<512 B` `ChatResult.metadata` 元数据、只读与舰队大载荷保留于扩展宿主进程、有界环形日志缓冲、`~25 fps` 流式合并渲染、待办事项可逆自动归档及 `80` 条实时消息 DOM 上限；在所有用量状态（精简、零调用、活跃）与 Studio 设置中支持中英文切换常驻显示非官方估算提示：API 费用由服务商直接收取，上下文护盾并非硬性消费上限，请以官方服务商计费控制台为准并设置硬性预算告警。

---

## 🌟 Gemini 4 全系模型、本地凭证存储与三层流式韧性恢复

- **Gemini 4 Argon、Carbon、Neon 与 Hydrogen（`src/providerModels.ts`、`src/providers.ts`、`src/geminiNativeStreaming.ts`、`src/sidebar.ts`、`src/host/standaloneServer.ts`）：**
  - 新增帕累托前沿模型 **`gemini-4-neon`**（源自 Carbon 架构优化，面向复杂编程、深度分析推理与长周期智能体工作流，具备 `1M` 上下文窗口上限、`64K` 单步前台输出上限及自动 `MINIMAL → LOW` 思考级别钳制），与 **`gemini-4-carbon`**、**`gemini-4-argon`** 及高速 **`gemini-4-hydrogen`** 全链路协同。
- **Vertex AI 本地凭证存储与专属虚拟机显式开启开关（`src/vertexAuth.ts`）：**
  - 支持操作系统权限隔离的本地服务账号 JSON 凭证、`gcloud` ADC、OAuth Bearer 环境变量与 Vertex Express 密钥，且默认关闭 `/endpoints/<vm-id>` 专属虚拟机端点访问（需显式开启 `harmony.gemini.allowDedicatedVmEndpoints`）。
- **三层 VPN 与大工具流韧性保护（`src/vpnResilientTransport.ts`、`src/geminiNativeStreaming.ts`、`src/chatParticipant.ts`）：**
  - **传输层：** 操作系统级 `15s` TCP `SO_KEEPALIVE` 心跳探测 + 首包前断流自动切换全新 IPv4 套接字重连。
  - **生成层：** 针对 `Argon` / `Carbon` / `Neon` 服务端缓冲大型 `functionCall` JSON 时的静默窗口，提供 `240s` 首包超时下限与 `300s`（5 分钟）流空闲下限（重试每次自动递增 `+120s`）。
  - **界面层：** 零副作用的 `25s` `stream.progress(...)` 界面心跳，确保长工具合成期间界面始终保持响应。

---

## 🖥️ 独立桌面、CLI 与 MCP 运行器（无需安装 VS Code）

- **同一套代码同时支持 VS Code、Tauri 2 桌面端、CLI 与 MCP（`src/host/standaloneServer.ts`、`src/host/vscodeHostShim.ts`、`scripts/harmony-desktop.js`）：**
  - 通过 `npm run harmony:desktop` 或 `node bin/harmony-cli.js desktop` 启动独立桌面服务与原生窗口。
  - 若已构建 Tauri 2 原生窗口（`harmony-native-control`）则优先启动，否则自动回退至原生应用窗口模式（`--app=http://127.0.0.1:8789`）。
  - 直接暴露全部 **201 个已注册 Harmony 工具**（涵盖 IT/网络诊断、WordPress/主机工具、云连接器、外骨骼、Swarm 以及 15 个认知原语）：
    - 交互式桌面 Web 界面（`GET /`）
    - REST + SSE 流式 API（`GET /api/tools`、`POST /api/tool`、`POST /api/chat`、`POST /api/chat/stream`、`POST /api/whisper`、`GET /api/state`）
    - JSON-RPC 2.0 MCP 服务（`POST /api/mcp` 及 `npm run harmony:mcp` 标准输入输出模式）
    - CLI 直接调用（`node bin/harmony-cli.js tools invoke --tool <name> --input '{...}'`）
- **单例 `vscode` 适配层标识保证（`src/host/vscodeHostShim.ts`）：**
  - 强制全局单一适配实例并导出 `ChatResponseMarkdownPart`、`ChatRequestTurn` 与 `ChatResponseTurn` 类，确保 `instanceof` 检查在 VS Code 内外行为完全一致。

---

## 🧬 7 项跨原语验证与记忆闭环

1. **携带证明的补丁见证与内部代码活跃度监控（`src/citationRecord.ts`、`src/primitives/decisionLog.ts`）：**
   - `createPatchAttestationRecord` 使用 RFC 8785 (JCS) + Ed25519 签名将代码修改与 `Rigor` 思维图节点、`Threadweave` 决策依据、属性测试种子及 Oracle 验证凭据绑定。
   - `checkInternalCodeLiveness` 与 `harmony_threadweave`（`action: "check-liveness"`）监控被观察的文件/行区间，当底层代码变动时自动将决策状态从 `live-unchanged` 切换为 `altered`。
2. **反事实影子工作树与经验效用仲裁（`src/primitives/temporalBranch.ts`、`src/primitives/convergenceArbiter.ts`）：**
   - `harmony_chronos`（`create-worktree`、`cleanup-worktree`）在 `.harmony/worktrees/` 下管理隔离的 `git worktree` 沙箱。
   - `harmony_kairos`（`evaluateEmpiricalBranchUtility`）基于 `(compile_pass, oracle_pass, pbt_pass_rate, diff_minimality, runtime_ms, cost_usd)` 及跨分支测试互验对候选分支进行客观评分。
3. **闭环经验认知校准（`src/primitives/uncertaintyFabric.ts`、`src/exoskeleton/oracle.ts`、`src/effectLedger.ts`）：**
   - 将客观验证通过（`+1 alpha`）与回滚/重试（`+1 beta`）汇入 `Aletheia` 校准账本，并支持每美元期望验证信息增益路由（`rankCandidatesByEvigPerDollar`）。
4. **见证门控的 `Rigor` 验证（`src/primitives/thoughtGraph.ts`）：**
   - `ThoughtGraphTool.executeNode` 将无见证推理节点保持为 `hypothesis`（`unwitnessed-assertion`），直至提供可执行断言或 `witness_hash`。
5. **全息工作记忆摘要与中日韩感知令牌校准（`src/inTurnCompaction.ts`、`src/costTracker.ts`、`src/chatParticipant.ts`）：**
   - `planInTurnCompaction` 将超长工具输出替换为结构化摘要（`buildHolographicStub`）并持久化至 `.harmony/turn-spill/`（`persistTurnSpill`、`rehydrateTurnSpillSpan`）。
   - `costTracker.ts` 根据服务商返回的真实用量自校准双参数 CJK/ASCII 最小二乘令牌估算器。
6. **自主抗体结晶器（`src/careBloom.ts`）：**
   - `crystallizeAntibody` 将多次尝试后解决的问题沉淀至 `.harmony/antibodies/swe-kb-personal.jsonl`，并由 `recallAntibodiesForContext` 在重试前自动提示。
7. **两阶段顾问上下文拉取与反向耳语（`src/whisperInbox.ts`）：**
   - `fulfillConsultantContextSpans` 在本地安全读取指定文件/行区间，`emitReverseWhisper` / `listReverseWhispers` 在 `.harmony/reverse-whispers/` 下提供非阻塞 AI→人类价值权衡卡片。

---

## 🛠️ 其他修复与文档说明

- **🛡️ 上下文护盾与工作节点卸载（`src/chatParticipant.ts`、`src/geminiNativeStreaming.ts`、`src/inTurnCompaction.ts`、`src/costTracker.ts`、`src/sidebar.ts`、`src/lmTools.ts`）：**
  - **前缀锁定 KV 缓存（Prefix-Locked KV Caching）：** 将动态轮次上下文移至用户轮次的 `<turn_context>` 块，并对全部 201 个工具声明及 JSON Schema 进行确定性排序，提升前缀缓存命中率。
  - **同文件读取去重与阶段自适应思考：** 当后续步骤读取覆盖更广的同一文件区间时，`deduplicateSupersededToolResults` 自动将早期重复读取原地摘要化；在 `Automatic` 模式下对机械读取/待办步骤自动降低思考级别。
  - **三模式策略与工作节点路由（`harmony.costShield.mode`、`harmony.costShield.workerRoute`）：** 在 VS Code 侧边栏与独立桌面 Studio 中均可切换（`Automatic`、`Manual Only`、`Off`），工作节点卸载默认直接复用 **Agents 配置档**。
  - **服务商计费与缓存结算说明：** 部分云服务商（如 Google AI Studio / Google Cloud Billing）在对话进行中可能先按未缓存费率进行临时预授权扣减，随后在账单结算时将 75% 缓存折扣差额返还至可用余额。由于各服务商会按自身节奏调整计费与缓存规则，建议结合 Harmony 侧边栏（`⚡cache` / `🧠think` 实时指标）与服务商控制台共同关注用量。
- **VS Code Studio 编辑器标签页与无头 TypeScript 语言服务（`src/extension.ts`、`src/host/vscodeHostShim.ts`、`src/host/standaloneServer.ts`）：**
  - `Harmony: Open Studio Tab (Full Editor View)`（`harmony.openStudioTab`）在 VS Code 独立编辑器标签页中打开完整 Studio 界面，并与独立桌面（`8789`）及 Tauri 控制台（`8788`）共享状态。
  - `vscodeHostShim.ts` 内置无头 TypeScript 语言服务（`executeDefinitionProvider`、`executeReferenceProvider`、`executeDocumentRenameProvider`、`executeCodeActionProvider`、`languages.getDiagnostics` 及 `workspace.applyEdit`），使全部 201/201 个工具在 VS Code 内外均可完整运行。
- **17 服务商健康度平局排序（`src/providerHealth.ts`）：** `rankProviders` 的 `prefOrder` 现已覆盖全部 17 个服务商 ID，未知服务商排在末尾（`Number.MAX_SAFE_INTEGER`）而非 `-1`。
- **模型 ID 文档说明（`README.md`、`README.zh-CN.md`）：** 补充说明默认注册表中 GA 模型与前沿/预览/自定义网关模型 ID 的覆盖方式。
