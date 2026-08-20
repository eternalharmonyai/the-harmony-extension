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
