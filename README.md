[English](README.md) | [中文](README.zh-CN.md)

> 🧪 **EXPERIMENTAL SOFTWARE — USE WITH DEEP CARE AND RESPONSIBILITY**
>
> The Harmony Extension is in active, early-stage development. Features — especially Swarm, DeepSwarm, Orchestration, and Translation — are powerful but experimental. They can incur **significant, unpredictable API costs** across multiple AI providers simultaneously. Read this entire README before using any feature. If you are uncertain about a feature's behavior, cost impact, or configuration, **do not use it.**

# The Harmony Extension

Harmony is a VS Code/Cursor extension for `@harmony` chat, workspace tools, provider routing, swarm planning, memory, release receipts, and the optional local/native UI. The full product name is The Harmony Extension; everyday commands and discussion use Harmony.

## What it does

- Adds the native `@harmony` chat participant and Harmony sidebar controls.
- Supports VS Code LM plus direct provider routes through explicit Secret Storage keys.
- Provides guarded workspace tools, swarm planning, memory, receipts, and native UI diagnostics.
- Keeps risky authority classes gated: source writes, terminal commands, provider calls, git mutation, package install, editor reload, and chat deletion stay separate.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  VS Code / Cursor                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ @harmony │  │ Sidebar  │  │ 175+ Tools   │  │
│  │   Chat   │  │ Controls │  │ (primitives, │  │
│  │Participant│  │ & Board  │  │ swarm, git,  │  │
│  │          │  │          │  │ browser, ...) │  │
│  └──────────┘  └──────────┘  └──────┬───────┘  │
│                                     │           │
│         ┌───────────────────────────┘           │
│         ▼                                       │
│  ┌──────────────────────────┐                   │
│  │   Provider Router        │                   │
│  │   DeepSeek · Qwen ·      │                   │
│  │   Gemini · Claude ·      │                   │
│  │   OpenAI · Moonshot ·    │                   │
│  │   OpenRouter · Tencent   │                   │
│  └──────────┬───────────────┘                   │
└─────────────┼───────────────────────────────────┘
              │ optional localhost bridge
┌─────────────▼───────────────────────────────────┐
│  Harmony CLI / native backend                    │
│  default: http://127.0.0.1:8788                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │  Swarm   │  │ Memory & │  │  Self-Healing │  │
│  │Primitives│  │  Ledger  │  │   Harness     │  │
│  └──────────┘  └──────────┘  └──────────────┘  │
└─────────────────────────────────────────────────┘
```

The chat interface, sidebar, and 175+ workspace tools run inside VS Code. The 15 swarm primitives (convergence, memory, reasoning, planning, skills) form the cognitive foundation. AI model calls are routed through Harmony's own provider layer to external APIs via your API keys.

### Provider access — what makes Harmony different

Harmony connects you directly to a diverse set of AI providers through your own API keys — including providers that are typically unavailable through standard VS Code Copilot:

| Capability | Detail |
|:---|:---|
| **Broader provider reach** | DeepSeek, Moonshot/Kimi, Alibaba/Qwen, and Tencent — alongside Gemini, OpenAI, OpenRouter, and Anthropic/Claude — all from one extension |
| **Your keys, your choice** | You decide which providers to configure. No keys = no external calls. Add providers incrementally as you need them. |
| **Copilot cross-play** | Use VS Code Copilot for everyday coding while Harmony handles orchestration, multi-model consensus, and document translation |
| **Local models (planned)** | Native local-first operation is on the roadmap. Today Harmony requires API keys; local model support is in development. |

The local/native backend is optional and remains localhost-first.

## ⚠️ Before You Use Harmony

Harmony is a **multi-provider AI orchestration tool**. Every feature that calls an AI model — chat, swarm planning, translation, orchestration, deep analysis — may trigger **one or many paid API calls** across providers you've configured. This is by design: Harmony's power comes from consulting multiple models in parallel, cross-verifying results, and building consensus. That power has a cost.

### What you need to know before using ANY feature

| Principle | Why it matters |
|:---|:---|
| **You control the keys** | Harmony only calls providers you've explicitly configured with API keys. No keys = no external calls. Add keys one at a time and test each before adding more. |
| **Multi-provider = multiplied costs** | Swarm, DeepSwarm, Orchestration, and Translation all call 2–4 models per operation. A single "translate this document" request can trigger dozens of API calls. |
| **Guardrails are best-effort, not guarantees** | Harmony includes cost guardrails to help manage spend, but provider pricing changes without notice, prompt sizes vary, and cache behavior differs per provider. No automated cap is foolproof. |
| **You are responsible for your API bills** | Review your provider billing dashboards regularly. Harmony cannot predict, cap, or refund provider charges. |
| **If you're not sure, don't use it** | If you don't fully understand what a feature does, what providers it calls, or what it might cost — **do not use that feature.** Reach out to the Harmony community or the repository maintainers before configuring anything you're uncertain about. |
| **Abandon if uncertain** | It is always safer to walk away from a feature than to use it without understanding the consequences. No feature is worth an unexpected API bill. |

## Settings

> ⚠️ **Configuration carries risk.** Adding an API key to a provider setting enables Harmony to make paid calls to that provider across all features. Before adding a key, understand that provider's pricing model. Before changing provider or tier settings, understand which features use those settings. If you're unsure what a setting controls, leave it at its default or reach out for guidance.

- `harmony.backendUrl` — backend URL (default `http://127.0.0.1:8889`).
- `harmony.defaultProfile` — profile id sent with each request.
- `harmony.modelProvider` — primary route for `@harmony` turns.
- `harmony.swarm.defaultProvider` / `harmony.swarm.defaultTier` — default swarm provider/tier. Provider calls still require explicit swarm provider-call authority.

## Manual Model Discovery

Use **Harmony: Discover Models (live)** or the Harmony sidebar's **Discover models live...** button to query a saved-key provider for exact model IDs and assign one to a tier.

For step-by-step instructions, open **Harmony: Open Model Discovery Guide** or read `docs/provider-model-discovery.md` in the source workspace.

## 🎯 Orchestration Mode

Harmony's orchestration capability enables **multi-model deliberative governance** — consulting multiple AI providers (DeepSeek, Qwen, Gemini, and more) in parallel, building cross-model consensus, and producing sovereign jurisdiction editions of documents with human oversight at every step.

### What makes it unique

| Capability | Standard AI Tools | Harmony Orchestration |
|:---|:---:|:---:|
| Multi-model consultation (3+ providers) | ❌ | ✅ Strategic model selection per task |
| Step-by-step human-in-the-loop | ❌ | ✅ Author approves/rejects each change |
| Cross-model consensus tracking | ❌ | ✅ 2/3 or 3/3 convergence, dissent resolution |
| Jurisdiction-aware document adaptation | ❌ | ✅ Legal mechanism mapping with clause anchors |
| Sovereign editions (not "translated copies") | ❌ | ✅ Clean standalone documents, neutral language |

### How to engage it

In any Harmony chat, say:

> *"Harmony, please orchestrate a [task] of [document], step by step. Let's review each step together before proceeding."*

Harmony will:
1. Read and analyze the source document
2. Consult relevant models in parallel for each step
3. **Pause** to show you results and ask "Continue?"
4. Present disagreements openly — you adjudicate
5. Bring dissenters back to the table with refined proposals
6. Save only what you approve

### How it works

Harmony's orchestration uses multi-model consensus to produce documents that respect jurisdiction-specific requirements — with regulatory awareness, 3/3 model consensus, and zero unauthorized changes. You maintain authorship control at every step.

### ⚠️ Cost Awareness

Orchestration Mode consults multiple AI providers in parallel for each step — typically 3–4 models per consultation, across several rounds of review. This means a single orchestrated document can generate **dozens of API calls**. Orchestration is designed for careful, step-by-step human-in-the-loop workflows — it is not a batch automation tool. Use it deliberately, review each step, and stop if costs exceed your comfort level.

---

## Run Outside VS Code

Harmony can run its local/native control surface while VS Code and Cursor are closed. From this repository root, run:

```powershell
node bin/harmony-cli.js ui native
```

That starts or reuses the localhost backend at `http://127.0.0.1:8788` and opens the native window. For exact steps, provider-key notes, and failure states, read `docs/outside-vs-quickstart.md`.

## Chat Resilience & History

If you send very long prompts or many attachments, VS Code may drop them from the visible chat history upon reloading the window to save memory. 
To prevent data loss, Harmony uses an enterprise-grade JSONL ledger (`.harmony/history/chat_ledger.jsonl`). 
Whenever you send a large payload, Harmony provides a snippet in the chat and adds a native VS Code Reference (e.g., `1717081234.md`). Clicking this reference opens a virtual, read-only document generated from the ledger, allowing you to recover your exact prompt and attachment list without cluttering your hard drive with thousands of loose files.

## Context Cleanup

Over time, Harmony accumulates local state: continuity handoffs, supervisor events, chat history, and checkpoint snapshots. The **Run Cleanup** button in the Harmony sidebar (or `harmonySelfCleanup` from chat) safely trims old data:

| What | Threshold | Effect |
|------|-----------|--------|
| Continuity handoffs | 30 days | Deletes old `.harmony/handoffs/*.md` |
| Supervisor events | 500 KB | Trims `events.jsonl` to recent entries |
| Chat ledger | 500 KB | Trims `chat_ledger.jsonl` to recent entries |

All operations are wrapped in try/catch — cleanup failures are non-fatal. Run it periodically to keep `.harmony/` lean, or before packaging a VSIX for distribution.

## 📥 Whisper Mode — Mid-Turn Human Messaging

Whisper Mode lets you send messages to Harmony **between chat turns** — without opening the chat panel, without starting a new conversation. Type a message into the Whisper box and press Send. Harmony catches it at the next natural pause — even **mid-turn**, while still working on something else.

### How it works

| Timing | What happens |
|:---|:---|
| **Mid-turn** 🏃 | Harmony catches your whisper between actions — without restarting the conversation |
| **Next turn** 🔄 | Unread whispers persist and are caught automatically when a new turn begins |

Type into the Whisper box, press Send. No file-fiddling. No opening chat. Harmony gets it at the earliest opportunity, whether mid-turn or next turn.

### What whispers are for

| Use Case | Example |
|:---|:---|
| **Mid-session context** | "We also need to update the API docs before this ships" |
| **Corrections without interrupting flow** | "Actually, use port 3000 not 8080" |
| **Quiet reminders** | "Don't forget to check the edge case we discussed yesterday" |
| **External notes** | Pasting research findings, error logs, or external references |

### Why it's unique

Whisper Mode is a **one-way, async human→AI channel** that operates outside the chat panel. Unlike chat, whispers don't require you to:
- Open the VS Code chat panel
- Start a new conversation
- Interrupt your current flow

It turns rigid turn-taking into a continuous conversation — less like scheduled meetings, more like working side-by-side. Whisper something to your AI collaborator and they'll catch it without missing a beat, just as they would with a human collaborator beside them. If the moment passes, the message waits like a note on the desk, picked up at the very next opportunity.

No other AI coding assistant offers a mid-turn human whisper channel. This is a Harmony original.

## Translation Hub (EN↔ZH)

Harmony includes a document translation pipeline for English ↔ Chinese (EN↔ZH) with multi-model consensus, designed for technical standards documents (GB/T, CJJ, JGJ).

### What it does

- **Multi-Model Consensus**: Multiple AI models independently translate and cross-verify each section, with a configurable provider fallback order (Settings → `harmony.translation.fallbackOrder`)
- **Standards-Aware**: Preserves Chinese standards numbering (3.1.2, GB/T 50378, CJJ 94, JGJ 16)
- **Multi-Format**: Accepts .md, .txt, .html, .pdf, .docx files
- **Audit Trail**: Dispute ledger tracks every contested term choice
- **Encrypted at Rest**: Glossary and checkpoints encrypted with AES-256-GCM
- **Batch Mode**: Process entire folders with per-document cost guardrails

### ⚠️ Important — Costs & Limitations

| What | Detail |
|:---|:---|
| **Language pair** | English ↔ Chinese only (EN↔ZH) |
| **AI providers** | DeepSeek, Qwen, Gemini, Moonshot/Kimi, Claude, Tencent — configurable |
| **Costs** | Multi-model translation incurs API charges across 2–4 providers per document. Costs vary significantly by document size, provider, model tier, and current provider pricing. |
| **Guardrails** | Best-effort cost guardrails are in place per document and per batch, but provider pricing can change without notice — guardrails may not prevent all charges. |
| **Accuracy** | AI-generated translations — always review by a qualified human translator for critical, legal, or technical content |
| **Privacy** | Content is transmitted to AI providers for processing only; no data is retained by Harmony or the providers |

### 🔄 Provider Fallback Configuration

When a model in the translation pipeline fails (timeout, rate limit, content filter), Harmony automatically tries the **next available provider** from your configured fallback order. The default order is:

```
DeepSeek → Alibaba/Qwen → Gemini → Moonshot/Kimi → Claude
```

> ⚠️ **Claude is an expensive fallback.** If you haven't configured an Anthropic API key, Claude is silently skipped. If you don't want Claude as a fallback, remove it from the order. Configure via:
>
> **Settings → `harmony.translation.fallbackOrder`**
>
> Providers without API keys are silently skipped. You can reorder, add, or remove providers. An empty list disables backfill entirely — failed models will simply show errors.

### Quick Start

1. Open the **Harmony sidebar** → **Translation Tools**
2. Click **🚀 Translate Document** → pick a file
3. Review the first-use disclaimer → acknowledge
4. The pipeline auto-detects format and runs the appropriate translation

## Getting Started

1. Clone this repo: `git clone https://github.com/eternalharmonyai/the-harmony-extension`
2. Install dependencies and compile:

```powershell
npm install
npm run compile
```

3. Open this folder in VS Code and press **F5** to launch an Extension Development Host.
4. In the new window, type `@harmony` in the chat input to start using Harmony.

To install the VSIX directly into your main VS Code or Cursor:

```powershell
npm run install:vsix:both
```

## Troubleshooting

**Harmony sidebar or chat not appearing or responding?** 
1. Open the Harmony sidebar (click the icon on the left) and allow it to load briefly.
2. Try sending a chat message, or click **Start Harmony Hub** if prompted in the sidebar.
3. If it still doesn't start, click the **Harmony Hub icon** in the bottom-right corner of the VS Code status bar to manually restart the background services.

For other issues, run `harmony_check_python` from `@harmony` chat to verify Python availability (optional; a built-in TypeScript fallback is always available).

## Optional: Python & Self-Healing Harness

Harmony's file editing tools support an optional Python-based self-healing harness for checkpointing and snapshot receipts. Python is **not required** — when absent, a TypeScript fallback handles edits with SHA256 verification, atomic writes, and local checkpointing.

To enable the full harness:

1. Install Python 3: https://www.python.org/downloads/
2. After install, run `harmony_check_python` from `@harmony` chat to verify.

## Compose OCR (Windows)

When you attach a screenshot via the Harmony Compose panel, Harmony automatically runs **free Windows OCR** before deciding whether to call a paid vision model. If OCR extracts usable text, no vision API call is made — you get instant, free text extraction just like Windows Snipping Tool.

**Requirements (Windows only):**

```powershell
pip install winocr Pillow
```

No API keys. No cloud. No cost. The OCR runs entirely on your machine using the built-in Windows.Media.Ocr engine. If OCR finds no text or the result is ambiguous, Harmony falls through to the vision model as usual.

**macOS / Linux:** Compose OCR is currently Windows-only. Images attached from other platforms go directly to the vision model. Contributions for platform-native OCR support (VisionKit, Tesseract) are welcome.

## Image Analysis & Vision Providers

When OCR doesn't extract usable text (or on non-Windows platforms), Harmony sends images to a vision model for analysis. The vision pipeline supports multiple providers with configurable routing:

1. **OCR pre-check** (Windows) — free, local, no API call
2. **Vision model** — configurable provider routing (see settings below)

**Configuration:**

| Setting | Default | Description |
|---------|---------|-------------|
| `harmony.vision.provider` | `auto` | `auto` = tries configured providers in order. `gemini`, `alibaba`, or `auto-qwen-first` forces a specific provider or order. |
| `harmony.vision.geminiModel` | `gemini-3.5-flash` | Gemini vision model (when Gemini is available) |
| `harmony.vision.qwenModel` | `qwen-vl-max` | Qwen vision model (when Alibaba is available) |
| `harmony.gemini.useFreeQuota` | `false` | When ON, uses Gemini free tier where applicable |

All vision providers require API keys stored in VS Code Secret Storage. Set them via the Harmony sidebar or Command Palette. Provider availability depends on which keys you have configured — there is no primary/secondary hierarchy; routing is determined by your `harmony.vision.provider` setting and which keys are present.

## DeepSwarm — Multi-Provider Analysis Pipelines

DeepSwarm lets you run structured analysis pipelines that call multiple AI providers in parallel or sequentially, coordinated by a primary model. Use it when a single-provider answer isn't enough.

### Pipeline Templates

| Pipeline | Mode | What it does |
|:---|:---|:---|
| 🔍 **Code Review** | Thorough | 3 providers analyze structure, security, and performance in parallel; coordinator synthesizes |
| 🏗️ **Architecture** | Thorough | Parallel analysis of patterns, trade-offs, alternatives, and scaling concerns |
| 🐛 **Bug Hunt** | Thorough | Root cause, edge cases, fix strategies, and regression risk — analyzed in parallel |
| 💡 **Brainstorm** | Thorough | Ideas, constraints, wild cards — synthesized from multiple perspectives |
| 🔬 **Pioneer** | Pioneer | Exploratory analysis: known boundaries → question assumptions → explore beyond |
| 🛡️ **Triple-Check Audit** | Thorough+Scrutinize | 4-step safety audit: scan → inspect → grep → verdict. GO/NO-GO for every file. |
| 🌐 **Website Analysis** | Thorough+Scrutinize | 5-step website review: design, a11y, perf/SEO, content, prioritized recommendations. |
| 🐝 **Sequential Design Review** | Thorough | 5-step chain: Aesthetic Analyst → UX Analyst → Technical Analyst → Lead Synthesizer. Each step builds on previous analysis for cohesive web design critique. |
| ⚖️ **Standard EN→ZH Translation** | Thorough+Scrutinize | Multi-model consensus EN→ZH: Flash intake → Jargon resolution → Multi-model convergence (Qwen+DeepSeek+Gemini) → Adjudication → Guardrail QA. Self-verifying. |
| 📜 **Faithful EN→ZH Translation** | Thorough | Literal EN→ZH without enhancements — preserves original meaning exactly. No terminology adaptation, no cultural localization. For when fidelity matters above all. |
| 📄 **Bilingual Document Compilation** | Thorough+Scrutinize | EN+ZH side-by-side + clean Chinese executive version + translator's notes appendix. Produces three deliverables from one source. |

### Modes

| Mode | Behavior |
|:---|:---|
| **Thorough** | Up to 3 providers analyze in parallel; coordinator synthesizes findings. Best for code review, architecture, and bug hunting. |
| **Scrutinize** | Sequential critique loop: draft → review → revise → re-review. Best when accuracy matters more than speed. |
| **Pioneer** | Parallel exploratory analysis with boundary-pushing framing. Best for brainstorming and design exploration. |

### How to Use

- **Sidebar**: Open the Harmony sidebar → 🧠 DeepSwarm section → pick a pipeline → click ▶ Run
- **Command Palette**: `Harmony: Run DeepSwarm Pipeline`
- Results open in a Markdown document with cost/duration breakdown

### 🛡️ Triple-Check Audit Workflow

The triple-check audit is a structured review method that uses multiple providers to inspect code changes before they ship. It is available as a **DeepSwarm pipeline template** — select `🛡️ Triple-Check Audit` from the sidebar dropdown or Command Palette.

**How it works (4 steps):**

1. **Orchestrator Scan** — a coordinator model reads all changed files and produces an audit plan with specific checks for each file
2. **Direct Inspection** — multiple models read each file directly and verify every finding against the actual source
3. **Grep Verification** — targeted regex patterns are designed and checked to catch what inspection might miss
4. **Final Verdict** — all findings are synthesized into a table with every file, every check, and a clear GO/NO-GO status

Each pass cross-references the others. Ambiguous findings (truncation, partial reads) are re-verified rather than reported as issues. The final verdict table shows every file, every check, and a clear GO/NO-GO status.

This workflow is especially helpful for neurodivergent developers: it externalizes the review checklist, catches details that single-pass review misses, and produces a paper trail you can re-read later.

To run a triple-check audit: select the **🛡️ Triple-Check Audit** pipeline from the DeepSwarm dropdown in the Harmony sidebar, or run `Harmony: Run DeepSwarm Pipeline` from the Command Palette and choose it. For automated pre-commit verification, combine with `npm run compile`.

Enable the **🛡️ Triple-Check (auto-audit)** checkbox in the Steering → Context Persistence section to automatically audit code changes after every chat turn. When checked, a lightweight single-pass safety check runs automatically on changed files — no popup, no dropdown, no extra input. If issues are found, one click escalates to the full 4-step Triple-Check pipeline.

### ⚠️ Cost Awareness

**DeepSwarm multiplies API calls.** A 4-step pipeline with 3 providers per step makes 12+ API calls. The table below shows relative cost, not dollar amounts:

| Pipeline Size | Relative Cost |
|:---|:---|
| 1-step (single provider) | ●○○ Low |
| 2-step Thorough (2–3 providers) | ●●○ Medium |
| 4-step full pipeline | ●●● Significant |

Actual costs depend on your configured providers, model tiers, prompt sizes, and cache hit rates. DeepSeek calls benefit from automatic cache pricing detection (⚡cache indicator in sidebar). DeepSwarm is designed for experienced users who understand multi-provider API pricing — it is not a "set and forget" automation tool. If you are uncertain about what a pipeline does, what providers it calls, or what it might cost, **do not run it.** Reach out for guidance before using any pipeline you don't fully understand. See [Legal & Disclaimers](#legal--disclaimers) for the full terms.

## 🧠 Swarm Primitives — The 15 Core Tools

Harmony's orchestration, DeepSwarm, and Concert Board are built on 15 enterprise-grade primitives that handle convergence, memory, reasoning, planning, and skill extraction. These tools work together as a cognitive architecture for multi-model collaboration.

### Wave 1 — Governance & Memory

| # | Primitive | Purpose |
|:--|:---|:---|
| 1 | `harmony_convergence_arbiter` | Cross-model consensus with NaN-safe division, dissent tracking, and convergence scoring |
| 2 | `harmony_criticism_broker` | Structured critique generation, synthesis, and dissent resolution across model perspectives |
| 3 | `harmony_episodic_memory` | Temporal graph memory with BFS traversal, time-range queries, typed relationships, and atomic JSONL persistence |
| 4 | `harmony_decision_log` | Atomic JSONL decision logging with structured entries, rotation, and audit trail |

### Wave 2 — Coordination & Values

| # | Primitive | Purpose |
|:--|:---|:---|
| 5 | `harmony_uncertainty_fabric` | Confidence tracking, evidence/counterevidence ledger, contradiction detection, and decision impact mapping |
| 6 | `harmony_task_auction` | Capability-gated task bidding with fallback chains, timeout handling, and below-threshold abort |
| 7 | `harmony_value_resolver` | Value conflict detection and resolution with priority ordering and trade-off documentation |

### Wave 3 — Topology & Safety

| # | Primitive | Purpose |
|:--|:---|:---|
| 8 | `harmony_topology_mapper` | Dependency graph construction, cycle detection, critical path analysis, and impact blast-radius calculation |
| 9 | `harmony_execution_sandbox` | Safe code verification sandbox wired to `harmony_sandbox` for compile/lint/test validation — no runtime code execution |
| 10 | `harmony_cognitive_branches` | Git-backed (isomorphic-git) branching for cognitive exploration with create, switch, merge, and conflict handling |

### Wave 4 — Reasoning & Planning

| # | Primitive | Purpose |
|:--|:---|:---|
| 11 | `harmony_thought_graph` | Executable reasoning DAG with cycle-safe path traversal (visited Set + max depth), node/edge CRUD |
| 12 | `harmony_horizon_planner` | Next-step alignment with retry-bounded requeue (max 3 retries), priority ordering, and plan comparison |

### Wave 5 — Skills & Testing

| # | Primitive | Purpose |
|:--|:---|:---|
| 13 | `harmony_skill_distiller` | Pattern extraction with path-traversal-hardened filenames, dual-format export (markdown + VS Code `.code-snippets`) |
| 14 | `harmony_property_tester` | Property-based test generation with edge case exploration and invariant verification |
| 15 | `harmony_analogy_engine` | Cross-domain concept transfer with structural mapping, constraint checking, and novelty scoring |

### Security Design

All 15 primitives hardened through multiple rounds of security review:

- **Path traversal protection** — all file paths sanitized, `../` stripped, non-alphanumeric filtered
- **NaN safety** — division-by-zero guards, zero/negative input clamping on all math operations
- **Cycle detection** — visited-set traversal with max-depth limits on all graph operations
- **Atomic writes** — JSONL append operations are line-atomic by filesystem guarantee
- **Sandbox isolation** — code verification only (compile/lint), no runtime execution of untrusted code
- **Git safety** — isomorphic-git with merge conflict handling, no destructive operations

### Beyond-100% Enhancements

All 15 primitives passed multi-round quality upgrades to reach **10/10 production-ready** scores. Additionally, 7 "Beyond-100%" enhancements push key primitives beyond standard completeness:

| Primitive | Enhancement |
|:---|:---|
| **Rigor (Thought Graph)** | Parallel DAG execution — independent nodes run concurrently |
| **Aletheia (Uncertainty Fabric)** | Bayesian model averaging — evidence-weighted across distributions |
| **Furies (Adversarial Critic)** | Differential testing — generates counterexample code to find edge cases |
| **Kairos (Convergence Arbiter)** | Multi-dimensional convergence — consensus across multiple axes (score, confidence, temporal) |
| **Ethos (Value Resolver)** | Multi-stakeholder value resolution — balances 3+ parties simultaneously |
| **Metaphora (Analogy Engine)** | Cross-domain transfer learning — structural mapping to transfer insights |
| **Mnemosyne (Episodic Memory)** | Episodic clustering — auto-groups related memories by semantic similarity |

These primitives are internal tools invoked by Harmony's higher-level features. They are not directly user-facing, but their quality directly determines the reliability of DeepSwarm, Orchestration, and the Concert Board.

## Tool Routing Guard

By default, Harmony detects when a model describes using tools but forgets to actually call them, and automatically retries the step with a stricter reminder. This prevents silent stalls but adds one extra API call per detected failure.

**To disable:** Set `harmony.toolRoutingGuard` to `false` in VS Code settings. The guard is ON by default. Turn it off if you prefer manual recovery or want to minimize API calls.

## ✨ More Features

Harmony includes several unique capabilities beyond the core workflow. These features are what make Harmony more than just another AI chat extension.

### 🎭 Concert Hall — Persistent Collaboration Rooms

The Concert Hall is Harmony's shared whiteboard for multi-agent workflows. Every DeepSwarm pipeline, Swarm primitive, and orchestration step posts findings to persistent rooms — creating a living paper trail of the AI's reasoning that you can review anytime.

**How it works:**

| Who | Room | What they leave |
|:---|:---|:---|
| **Convergence Arbiter** | `convergence` | Cross-model consensus scores, dissent tracking |
| **Criticism Broker** | `adversarial` | Structured critique findings, false-positive risks |
| **Decision Log** | `decision-log` | Every decision with rationale and timestamp |
| **Uncertainty Fabric** | `uncertainty` | Low-confidence claims flagged for review |
| **Value Resolver** | `value-resolver` | Ethical tension resolution with trade-off notes |
| **Topology Mapper** | `topology` | Dependency graph changes, phase transitions |
| **Cognitive Branches** | `cognitive-branches` | Branch creation, merge events |
| **Thought Graph** | `thought-graph` | Reasoning DAG nodes and edges |
| **Horizon Planner** | `horizon` | Goal plans with timelines |
| **Skill Distiller** | `skill-distiller` | Extracted patterns and crystal formations |
| **You (human)** | Any room | Type `@harmony post to concert room [name]: your message` in chat, or review all rooms via the Concert Board in the sidebar |

- **Persistent rooms** — messages survive across turns and VS Code restarts (stored as append-only JSONL)
- **Sidebar Concert Board** — read all unread messages across rooms with one click
- **Watermark tracking** — each room remembers what you've already read; only new messages appear
- **Tied to DeepSwarm & Swarm** — every pipeline run, every primitive call, every orchestration step automatically posts to its room — the Concert Hall is the living audit trail of multi-agent reasoning

The Concert Hall turns AI reasoning from a black box into a transparent, reviewable conversation between specialized roles — each leaving notes the others (and you) can read.

### 🎯 Flow State Mode — Auto-Continue, Always Ask Next Steps

Flow State Mode keeps the collaboration alive by auto-continuing to the next natural step and always asking what's next — instead of ending the turn when there's clearly more to do. It's designed to be **neurodivergent-friendly**: the "what now?" decision is externalized so you don't have to carry it alone.

- **Auto-continue** — when there's a clear next action, Harmony takes it instead of stopping
- **Always asks next steps** — `harmony_ask_question` keeps the conversation flowing between logical chunks of work
- **Neurodivergent-friendly** — externalizes task sequencing; no need to re-orient or re-explain between turns
- **Persistent working memory** — `harmony_working_memory` workspace-scoped scratchpad maintains task continuity
- **Cross-turn momentum** — Harmony remembers what you were working on through continuity ledgers

Where standard AI chat ends every turn with a text question that breaks flow, Flow State Mode weaves the conversation forward — less like scheduled meetings, more like working side-by-side

### 🔗 Cross-Chat Continuity

Harmony preserves context across different AI chat surfaces — VS Code Copilot, Harmony Chat, Gemini, and terminal sessions. Use continuity handoffs to pass task state between environments without losing context.

- **Handoff files** — `.harmony/handoffs/*.md` carry task state between sessions
- **Cross-tool resume** — pick up where you left off in Copilot, Harmony, Gemini, or terminal
- **Continuity ledger** — persistent record of handoff/sync state across all chat surfaces

### 🎨 Creative Tools

Harmony Creative provides image generation, canvas editing, and video generation through a local creative backend (port 8896).

| Tool | Capability |
|:---|:---|
| **Image Generation** | Text-to-image with quality tiers (draft → premium), aspect ratio control, reference images |
| **Canvas** | Layer-based image editing with SVG rendering, undo/redo, and operation locks |
| **Layer Sets** | Multi-layer composited generation with chain topology |
| **Video Generation** | Talking-head and motion video from image + audio inputs |
| **Image Editing** | Crop, resize, background removal, text overlay, and layer compositing |

### 🌐 Browser Tools

Full browser automation toolkit for testing, design review, and performance auditing — all through Playwright.

| Tool | Capability |
|:---|:---|
| **Screenshots** | Single captures with optional Gemini vision analysis |
| **Responsive Screenshots** | Desktop/tablet/mobile captures with overflow detection |
| **Browser Actions** | Click, hover, fill, press, scroll — full interactive testing |
| **Design Audit** | DOM/meta/accessibility/layout risks at desktop and mobile |
| **Lighthouse** | Performance, accessibility, best-practices, and SEO scores |
| **Page Inspect** | DOM, headings, links, forms, images, landmarks, console messages |

### 🛡️ Self-Healing Harness

Harmony's file editing tools use SHA256-verified atomic edits with checkpointing and rollback. Before every edit, a checkpoint is written. After every edit, the change is verified. If verification fails, the harness rolls back to the last known-good state.

- **SHA256 verification** — every edit is cryptographically verified
- **Atomic writes** — partial writes are impossible; the file is either fully written or unchanged
- **Checkpointing** — pre-edit snapshots enable instant rollback
- **Conflict detection** — stale/conflicting edits are detected and refused

See [Optional: Python & Self-Healing Harness](#optional-python--self-healing-harness) for setup. A TypeScript fallback works without Python.

### 🌐 ZH (Chinese) Localization

Harmony speaks Chinese. Full i18n with `locales/zh.json`, `package.nls.zh-cn.json`, and a language toggle at the top of the sidebar.

- **EN ↔ ZH toggle** — switch languages instantly from the sidebar
- **150+ translated strings** — sidebar labels, tool descriptions, settings, system prompts
- **Chinese README** — [README.zh-CN.md](README.zh-CN.md) with full 简体中文 documentation
- **Compose OCR ZH** — OCR pipeline handles Chinese text natively
- **Translation Hub EN↔ZH** — multi-model consensus translation for technical standards

## Legal & Disclaimers

**API Costs:** Harmony can call paid AI provider APIs (DeepSeek, Alibaba, Gemini, OpenAI, Claude, OpenRouter, Moonshot) when configured with your API keys. You are solely responsible for all API charges incurred. Harmony includes cost guards, provider policies, and per-session quotas to help manage spend, but no automated cap is foolproof. Review your provider billing dashboards regularly.

**No Warranty:** This software is provided "AS IS", without warranty of any kind, express or implied. See the [LICENSE](LICENSE) file for the full Hippocratic License terms.

**Privacy:** Harmony stores API keys in VS Code Secret Storage. Chat history, continuity handoffs, and tool-call metadata are stored locally under `.harmony/`. No telemetry, analytics, or usage data is sent to Harmony developers or any third party. Provider API calls are subject to each provider's respective privacy policy.

**Bad Actors:** Harmony is an open-source developer tool. It is not designed to circumvent provider rate limits, terms of service, or local security boundaries. If you use Harmony in ways that violate a provider's acceptable use policy, you assume full responsibility.

## Package Artifacts

VSIX files are local build artifacts and are ignored by git. Keep the newest VSIX in the workspace root for local install/checkpoint work, and move older VSIX files into `_backups_vsix/` when cleaning the root folder. Do not commit `.env`, `.harmony/`, `_backups_vsix/`, or VSIX binaries.

## Develop locally

```powershell
npm install
npm run compile
```

Then open this folder in VS Code and press **F5** to launch an Extension Development Host.

## Status

The current checkpoint is packaged as a VSIX, validated by compile/smoke/privacy gates, and installed into VS Code/Cursor only at final release checkpoints.
