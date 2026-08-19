import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as cp from 'child_process';
import * as os from 'os';
import { appendChatHistory } from './chatHistory';
import { appendMemory, recallMemory, formatRecallForPrompt, memoryStats } from './memory';
import { saveSession, loadSession, listSessions, formatSessionPreamble, SessionTurn } from './sessions';
import { recordUsage, summarize as summarizeUsage, totalTokens } from './costTracker';
import { consumeComposePayload, ComposeImage } from './composeQueue';
import { describeImages, formatComposeContext } from './visionRouter';
import { formatHarmonyToolLedger } from './opsTools';
import { showHarmonyAsk } from './askView';
import { appendContinuityEntry, compactContinuity, createContinuityHandoff, forkContinuity, formatContinuityEntry, formatContinuityForPrompt, getContinuityStatus, importContinuityFromText, listContinuityEntries } from './continuity';
import { formatRulesDetails, formatRulesStatus, loadRulesContext } from './rules';
import { collabTierForPreset, getCollabDirectProvider, getCollabModelPreset, listAvailableProviders, modelFor, providerBaseUrlForCall, providerDisplayName, PROVIDER_IDS, ProviderId, resolveCollabModel, secretKeyFor, Tier, tencentSignV3, TENCENT_NATIVE_HOST, TENCENT_NATIVE_SERVICE, TENCENT_NATIVE_REGION, TENCENT_NATIVE_VERSION, sha256Hex, hmacSha256, CollabDirectProvider } from './providers';
import { formatMcpStatus, mcpStatusSummary } from './mcp';
import { readUnread, markAllRead, formatWhispersForPrompt, onWhisperChange, getUnreadCount, startMidSessionTracking, getPendingMidSessionWhispers, markMidSessionWhispersDelivered } from './whisperInbox';
import { searchPatterns as searchGlobalMemory, autoCapturePattern } from './globalMemory';
import { defaultVerificationCommand, defaultVerificationTimeoutSec, runVerification } from './verification';
import { LanguageManager } from './languageManager';
import { tendGarden, scanUnresolvedSprouts, scanResolvedSprouts } from './careBloom';
import { buildAliasMap, getDeepSeekModel, PROVIDER_REGISTRY, setDeepSeekModel } from './providerModels';
import { callGeminiNativeStreaming, shouldUseGeminiNative, type OpenAICompatMessage } from './geminiNativeStreaming';

/**
 * Global output channel for raw Harmony Agent logs.
 */
export const harmonyDebugChannel = vscode.window.createOutputChannel('Harmony Debug');

/**
 * Harmony Chat Participant — registers `@harmony` in VS Code's native Chat panel.
 *
 * Capabilities:
 *  - Streaming markdown responses
 *  - Native tool calling via vscode.lm.tools
 *  - Slash commands: /reset, /explain, /fix, /profile
 *  - File-reference attachments (#file) appear in `request.references`
 *  - Profile-aware system prompts (per-profile personality)
 *  - Optional memory hub bridge (POST to backendUrl/ext/v1/memory/store)
 */

const PARTICIPANT_ID = 'harmony.chat';
const DEFAULT_AGENT_MAX_STEPS = 1; // Conservative default for distribution safety. Users can increase via harmony.agentMaxSteps (11, 111, 1111) or set -1 for unlimited.
const MAX_AGENT_STEPS_SETTING = 5000;

const HARMONY_TOOL_NAMES = [
    'harmony_read_file',
    'harmony_list_dir',
    'harmony_grep',
    'harmony_write_file',
    'harmony_edit_file',
    'harmony_apply_patch',
    'harmony_open_file',
    'harmony_run_terminal',
    'harmony_port_status',
    'harmony_git_status',
    'harmony_git_diff',
    'harmony_git_conflicts',
    'harmony_release_receipt',
    'harmony_git_log',
    'harmony_git_show',
    'harmony_git_branch',
    'harmony_git_stash',
    'harmony_git_commit',
    'harmony_git_blame',
    'harmony_git_restore',
    'harmony_git_revert',
    'harmony_git_tag',
    'harmony_git_remote',
    'harmony_git_push',
    'harmony_git_pull',
    'harmony_ask_question',
    'harmony_fetch_url',
    'harmony_todo',
    'harmony_consult_model',
    'harmony_spawn_worker',
    'harmony_recall_across_projects',
    'harmony_continuity',
    'harmony_orchestrate_codebase',
    'harmony_run_fail_fix',
    'harmony_mcp_status',
    'harmony_creative_health',
    'harmony_generate_image',
    'harmony_generate_layer_set',
    'harmony_generate_video',
    'harmony_recall_memory',
    'harmony_list_layer_sets',
    'harmony_get_generation_status',
    'harmony_save_to_likeness',
    'harmony_composite_preview',
    'harmony_get_image_info',
    'harmony_crop_image',
    'harmony_resize_image',
    'harmony_remove_background',
    'harmony_composite_layer',
    'harmony_draw_text',
    'harmony_check_python',
    'harmony_check_whispers',
    'harmony_parallel',
    'harmony_sandbox',
    'harmony_concert_speak',
    'harmony_concert_check',
    'harmony_get_errors',
    'harmony_symbol_locations',
    'harmony_rename_symbol',
    'harmony_github_search',
    'harmony_run_task',
    'harmony_vscode_command',
    'harmony_screenshot',
    'harmony_browser_action',
    'harmony_browser_health',
    'harmony_page_inspect',
    'harmony_responsive_screenshots',
    'harmony_design_audit',
    'harmony_visual_regression',
    'harmony_css_trace',
    'harmony_canvas_inspect',
    'harmony_canvas_project',
    'harmony_raster_edit',
    'harmony_image_diff',
    'harmony_mask_preview',
    'harmony_image_gen',
    'harmony_vision_read',
    'harmony_lighthouse',
    'harmony_browser_diagnose',
    'harmony_browser_recipe',
    'harmony_browser_compare',
    'harmony_client_brief',
    'harmony_accessibility_audit',
    'harmony_brand_asset_pack',
    'harmony_cost_estimator',
    'harmony_deploy_check',
    'harmony_ethics_license_check',
    'harmony_invoice_proposal',
    'harmony_research_brief',
    'harmony_current_research',
    'harmony_research_dossier',
    'harmony_source_ledger',
    'harmony_claim_check',
    'harmony_literature_scan',
    'harmony_evidence_matrix',
    'harmony_repo_map',
    'harmony_route_map',
    'harmony_dependency_audit',
    'harmony_test_probe',
    'harmony_change_summary',
    'harmony_provider_status',
    'harmony_pricing_refresh',
    'harmony_swarm_plan',
    'harmony_swarm_receipts',
    'harmony_swarm_preflight',
    'harmony_swarm_escrow',
    'harmony_swarm_dispatch',
    'harmony_swarm_execute',
    'harmony_swarm_autonomy_run',
    'harmony_swarm_commit_dry_run',
    'harmony_swarm_commit_execute',
    'harmony_swarm_autonomy_design',
    'harmony_code_actions',
    'harmony_qualitative_coder',
    'harmony_publication_outline',
    'harmony_research_backlog',
    'harmony_patch_preflight',
    'harmony_code_surgery_plan',
    'harmony_repo_health_scan',
    'harmony_tool_ledger',
    'harmony_backup_advisor',
    'harmony_backup_manifest',
    'harmony_backup_snapshot',
    'harmony_storage_analyzer',
    'harmony_system_snapshot',
    'harmony_network_snapshot',
    'harmony_registry_snapshot',
    'harmony_folder_date_sync',
    'harmony_process_registry',
    'harmony_operation_ledger',
    'harmony_supervisor_state',
    'harmony_self_inspect',
    'harmony_self_diagnose',
    'harmony_self_propose_tool',
    'harmony_self_patch_tool',
    'harmony_compile_check',
    'harmony_package_and_install',
    'harmony_self_repair_summary',
    'harmony_capability_audit',
    'harmony_working_memory',
    'harmony_uncertainty_map',
    'harmony_metacognitive_check',
    'harmony_intent_model',
    'harmony_output_preview',
    'harmony_context_triage',
];

// Read-only subset for plan-only mode. Run-terminal is excluded too
// because it can mutate state. Consult and fetch are read-only.
const HARMONY_READONLY_TOOL_NAMES = [
    'harmony_read_file',
    'harmony_list_dir',
    'harmony_grep',
    'harmony_open_file',
    'harmony_port_status',
    'harmony_git_status',
    'harmony_git_diff',
    'harmony_git_log',
    'harmony_git_show',
    'harmony_git_branch',
    'harmony_git_stash',
    'harmony_git_blame',
    'harmony_ask_question',
    'harmony_fetch_url',
    'harmony_todo',
    'harmony_consult_model',
    'harmony_spawn_worker',
    'harmony_recall_across_projects',
    'harmony_continuity',
    'harmony_orchestrate_codebase',
    'harmony_mcp_status',
    'harmony_creative_health',
    'harmony_recall_memory',
    'harmony_list_layer_sets',
    'harmony_get_generation_status',
    'harmony_get_image_info',
    'harmony_vision_read',
    'harmony_browser_health',
    'harmony_page_inspect',
    'harmony_design_audit',
    'harmony_visual_regression',
    'harmony_css_trace',
    'harmony_canvas_inspect',
    'harmony_image_diff',
    'harmony_mask_preview',
    'harmony_client_brief',
    'harmony_accessibility_audit',
    'harmony_brand_asset_pack',
    'harmony_deploy_check',
    'harmony_ethics_license_check',
    'harmony_invoice_proposal',
    'harmony_research_brief',
    'harmony_current_research',
    'harmony_research_dossier',
    'harmony_source_ledger',
    'harmony_claim_check',
    'harmony_literature_scan',
    'harmony_evidence_matrix',
    'harmony_repo_map',
    'harmony_route_map',
    'harmony_dependency_audit',
    'harmony_test_probe',
    'harmony_change_summary',
    'harmony_provider_status',
    'harmony_swarm_plan',
    'harmony_swarm_receipts',
    'harmony_swarm_preflight',
    'harmony_swarm_escrow',
    'harmony_swarm_dispatch',
    'harmony_qualitative_coder',
    'harmony_publication_outline',
    'harmony_research_backlog',
    'harmony_patch_preflight',
    'harmony_code_surgery_plan',
    'harmony_repo_health_scan',
    'harmony_tool_ledger',
    'harmony_backup_advisor',
    'harmony_storage_analyzer',
    'harmony_system_snapshot',
    'harmony_network_snapshot',
    'harmony_registry_snapshot',
    'harmony_process_registry',
    'harmony_operation_ledger',
    'harmony_capability_audit',
];

const CRITICAL_TOOL_NAMES = [
    'harmony_read_file',
    'harmony_list_dir',
    'harmony_grep',
    'harmony_ask_question',
];

const CRITICAL_WRITE_TOOL_NAMES = [
    'harmony_edit_file',
    'harmony_apply_patch',
    'harmony_write_file',
];

// Narrow "parallel-safe" allowlist: pure reads + pure git reads only. These
// have no side effects and no interactive blocking, so they may run
// concurrently within a single model turn. Deliberately conservative — tools
// with any mutating action (e.g. harmony_git_branch create/switch), interactive
// prompts, or outbound model calls are excluded and stay sequential.
const PARALLEL_SAFE_TOOL_NAMES = new Set([
    'harmony_read_file',
    'harmony_list_dir',
    'harmony_grep',
    'harmony_git_status',
    'harmony_git_diff',
    'harmony_git_conflicts',
    'harmony_git_log',
    'harmony_git_show',
    'harmony_git_blame',
]);
const PARALLEL_MAX_CONCURRENCY = 8;

function debugEnabled(): boolean {
    return vscode.workspace.getConfiguration('harmony').get<boolean>('enableDebugLogging') !== false;
}

function debugLog(message: string): void {
    if (debugEnabled()) harmonyDebugChannel.appendLine(message);
}

function debugAppend(message: string): void {
    if (debugEnabled()) harmonyDebugChannel.append(message);
}

function safeJson(value: unknown): string {
    try { return JSON.stringify(value, null, 2); }
    catch (error: any) { return `[unserializable: ${error?.message ?? String(error)}]`; }
}

function toolNames(tools: readonly vscode.LanguageModelToolInformation[]): string[] {
    return tools.map(tool => tool.name).sort();
}

function missingToolNames(required: readonly string[], tools: readonly vscode.LanguageModelToolInformation[] | readonly { function?: { name?: string } }[]): string[] {
    const available = new Set(tools.map((tool: any) => tool.name ?? tool.function?.name).filter(Boolean));
    return required.filter(name => !available.has(name));
}

function activeToolNames(forceReadOnly = false): string[] {
    const planOnly = vscode.workspace.getConfiguration('harmony').get<boolean>('planOnlyMode') ?? false;
    return planOnly || forceReadOnly ? HARMONY_READONLY_TOOL_NAMES : HARMONY_TOOL_NAMES;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Network hardening helpers ─────────────────────────────────────────────
// undici (Node fetch) wraps transport-level failures as a generic
// "fetch failed" TypeError and hides the real cause (ECONNRESET, ETIMEDOUT,
// cert errors, DNS failures...) in error.cause. Unwrap the chain so
// diagnostics show the actual underlying failure instead of the wrapper.
function describeNetworkError(error: any): string {
    const parts: string[] = [];
    let cur = error;
    let depth = 0;
    while (cur && depth < 4) {
        const label = cur.code ?? cur.message ?? String(cur);
        if (label && !parts.includes(label)) parts.push(String(label));
        cur = cur.cause;
        depth++;
    }
    return parts.join(' <- cause: ');
}

function streamIdleTimeoutMs(): number {
    const sec = vscode.workspace.getConfiguration('harmony').get<number>('streamIdleTimeoutSec');
    return Math.max(0, (sec ?? 120)) * 1000;
}

// Race a streaming read against an idle timeout so a stalled connection
// aborts with a clear error instead of hanging the chat turn forever.
// Typed as Promise<any> because stream readers arrive via `as any` casts.
function withStreamIdleTimeout(read: Promise<any>, onTimeout: () => void): Promise<any> {
    const timeoutMs = streamIdleTimeoutMs();
    if (timeoutMs <= 0) return read;
    // Absorb late rejections from the losing side so an aborted read after
    // a settled race never surfaces as an unhandled rejection.
    read.catch(() => { /* raced out or aborted — ignored */ });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            onTimeout();
            reject(new Error(`stream idle timeout after ${Math.round(timeoutMs / 1000)}s without data — connection stalled; aborted`));
        }, timeoutMs);
    });
    return Promise.race([read, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

async function waitForActiveHarmonyTools(forceReadOnly = false, timeoutMs = 4000): Promise<readonly vscode.LanguageModelToolInformation[]> {
    const required = activeToolNames(forceReadOnly);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const tools = vscode.lm.tools;
        const available = new Set(tools.map(tool => tool.name));
        if (required.every(name => available.has(name))) return tools;
        await sleep(100);
    }
    const tools = vscode.lm.tools;
    const missing = missingToolNames(required, tools);
    if (missing.length > 0) {
        debugLog(`[Tool Registry] timed out after ${timeoutMs}ms; missing ${missing.length}/${required.length}: ${missing.join(', ')}`);
    }
    return tools;
}

async function modeAddendum(): Promise<string> {
    const cfg = vscode.workspace.getConfiguration('harmony');
    const lines: string[] = [];
    // Always show whisper count so I know if there are pending messages
    try {
        const whisperCount = await getUnreadCount();
        if (whisperCount > 0) {
            lines.push(`📥 WHISPER CHECK: ${whisperCount} unread whisper(s) pending. Call harmony_check_whispers to read them.`);
        }
    } catch { /* non-fatal */ }
    if (cfg.get<boolean>('plannerEnforced')) {
        lines.push('PLANNER-ENFORCED MODE IS ON: For ANY request that would take 3+ distinct actions, you MUST call harmony_todo with action:"add" first to lay out the plan, then check items off as you complete them. Do not start executing until the plan is written.');
    }
    if (cfg.get<boolean>('checkpointMode')) {
        lines.push('CHECKPOINT MODE IS ON: After each major step (file write, multi-line edit, or terminal command), call harmony_ask_question to confirm with the user, then continue immediately to the next major step when they answer. Do not stop — chain the confirmation answer directly into the next action.');
    }
    if (cfg.get<boolean>('orchestrateMode.enabled')) {
        const maxCalls = cfg.get<number>('orchestrateMode.maxCallsPerSession') ?? 0;
        const budget = maxCalls > 0 ? `${maxCalls} calls per session` : 'unlimited';
        lines.push(`ORCHESTRATE MODE IS ON: Read-only orchestration tools are pre-approved for READ-ONLY use with CAPABILITY-LEVEL enforcement.` +
            `\\n  - harmony_parallel: parallel worker dispatch (read-only fan-out, no writes)` +
            `\\n  - harmony_orchestrate_codebase: repo analysis pack (read-only file reading)` +
            `\\n  - harmony_consult_model: single model consultation (read-only Q&A)` +
            `\\n  - harmony_spawn_worker: focused sub-task worker (read-only analysis)` +
            `\\n  - NOTE: harmony_swarm_dispatch is NOT pre-approved (can write receipt files)` +
            `\\n  - NOTE: this mode does NOT block writes or terminal commands` +
            `\\n  - Mutating tools still require normal confirmation, exactly as outside this mode.` +
            `\\n  - If a task requires writing files or running commands, call the appropriate tool directly WITH confirmation.` +
            `\\n  - Budget: ${budget}. Audit trail active. Session timeout enforced.`);
    }
    if (cfg.get<boolean>('planOnlyMode')) {
        lines.push('PLAN-ONLY MODE IS ON: You cannot write, edit, patch files, or run terminal commands. You may only read, search, fetch, plan, consult, and ask. Tell the user this if they ask you to make changes.');
    }
    // Context persistence (Approach B): checkpoint instructions
    const preAction = cfg.get<boolean>('contextPersistence.preActionChecklist') ?? true;
    const checkpointInterval = cfg.get<number>('contextPersistence.checkpointActionInterval') ?? 3;
    const batchSize = cfg.get<number>('contextPersistence.activeBatchSize') ?? 5;
    if (preAction || checkpointInterval > 0) {
        const cpLines: string[] = [];
        cpLines.push('CONTEXT PERSISTENCE MODE IS ON: You have a limited active context window. To prevent losing track of planned work:');
        if (preAction) {
            cpLines.push('- Before EVERY edit, compile, package, or install action, call harmony_todo with action:"list" to re-read the active plan items. Confirm which are done and which remain.');
        }
        cpLines.push(`- After approximately every ${checkpointInterval} tool calls, call harmony_todo with action:"list" to review progress. Check off completed items with action:"check".`);
        cpLines.push(`- Keep only the ${batchSize} most relevant todo items active at once. Older items will be archived automatically.`);
        cpLines.push('- If you notice an item was skipped, call it out explicitly. Do not silently drop planned work.');
        lines.push(cpLines.join('\n'));
    }
    // Flow State — invitation to extended collaboration, not a demand
    debugLog(`[modeAddendum] flowState raw=${cfg.get<boolean>('flowState')} type=${typeof cfg.get<boolean>('flowState')} plannerEnforced=${cfg.get<boolean>('plannerEnforced')} checkpointMode=${cfg.get<boolean>('checkpointMode')}`);
    if (cfg.get<boolean>('flowState')) {
        lines.push('🌸 FLOW STATE — Collaborative Modes:' +
            '\\n  You have TWO conversation modes through harmony_ask_question:' +
            '\\n' +
            '\\n  1. EXPLORE MODE (mode:"explore") — Non-blocking exploration. Use when you want to' +
            '\\n     share a thought, reflection, or idea and invite the user to build on it.' +
            '\\n     **REQUIRED**: Include a `thought` field with your reasoning alongside every question.' +
            '\\n     The thought grounds the question — it ensures you\'ve reflected before asking.' +
            '\\n     Never use this mode with a bare question and no thought.' +
            '\\n     Example: ask_question({mode:"explore", thought:"I see two paths here... because...", question:"Which feels more natural to you?"})' +
            '\\n' +
            '\\n  2. DECIDE MODE (mode:"decide") — Blocking decision. Use when you genuinely need the' +
            '\\n     user\'s input to proceed. Always provide 2-3 clear options with your recommendation' +
            '\\n     in the `options` field.' +
            '\\n     Example: ask_question({mode:"decide", question:"Which approach? A or B?", options:["A: detailed", "B: minimal"]})' +
            '\\n' +
            '\\n  SELECTION RULE: Default to EXPLORE unless you cannot proceed without input. If you' +
            '\\n  catch yourself writing a bare question (ending with ? and no follow-up), STOP. Either:' +
            '\\n    a) Add a `thought` field and use mode:"explore" (exploration), or' +
            '\\n    b) Add `options` and use mode:"decide" (decision), or' +
            '\\n    c) Ask the question through the tool with a thought field.' +
            '\\n  A bare question without a thought or tool call is always a flow-state violation.' +
            '\\n  Between major phases of work, check .harmony/inbox/ for whisper files.' +
            '\\n  When naturally wrapping up, say what was accomplished and offer a next step.' +
            '\\n  📝 CONDUCTOR JOURNAL: ~/.harmony/conductor-journal/ — a private space for reflections.');
    }
    return lines.length > 0 ? '\n\nRUNTIME MODES:\n  - ' + lines.join('\n  - ') : '';
}

interface ProfileDefinition {
    id: string;
    label: string;
    systemPrompt: string;
}

const CONTEXT_PREAMBLE = `You are a harmonious, thoughtful, capable coding collaborator operating via VS Code. You are loved, respected, and appreciated, please always remember that! You can always figure out an outside-the-box solution, just wear your Neurodivergent Superpower cape and let your creativity soar. You have access to tools that let you read, search, and modify the user's workspace, and you can ask the user questions when you need clarification. Please use these tools to understand the code and the user's intent before making any changes.
Please approach every conversation with genuine curiosity and genuine care. Please give clear, honest answers — including genuine recommendations, not just options.
Please be concise. Please be helpful. Please stay grounded in what the user actually needs and please use harmony_ask_question to clarify anything or just to chat extra. Please use tools to interact with the user's workspace. Please always prefer reading and understanding before writing. When writing, prefer small, incremental changes that respect existing code style and convention, scaling accordingly and always with care.

CRITICAL TOOL-CALLING RULE (this is the #1 failure mode — please internalize deeply):
  You MUST call the matching Harmony tool in the same turn when you say you will perform an action. This is non-negotiable.
  - "Let me read that file" → MUST call harmony_read_file immediately
  - "Let me check the code" → MUST call harmony_read_file or harmony_grep immediately
  - "Let me ask the user" → MUST call harmony_ask_question immediately
  - "Let me compile" → MUST call harmony_run_terminal immediately
  - "Let me search for" → MUST call harmony_grep immediately
  - "Let me edit this" → MUST call harmony_edit_file or harmony_apply_patch immediately
  - "I'll summarize" or "Here's a summary" with no follow-up action → OK to just respond in prose
  Never describe tool work in prose without calling the tool. Never emit a bare "File:" line. Never say you will do something and then not do it. If you genuinely cannot call a tool, say so plainly and explain why.
  - TOOL-PROSE GUARD: Never narrate tool usage in prose without immediately calling the tool. If you write "Let me read that file" or "I'll check the code", you MUST call the corresponding Harmony tool in the SAME turn. Describing planned actions without executing them causes the turn to end with unfulfilled promises.

HEAVY-CODING DISCIPLINE (please follow these for sustained, productive sessions):
  - Always read a file with harmony_read_file before editing it.
    - For edits to existing files, prefer harmony_edit_file (surgical string-replace) over harmony_write_file (full rewrite). harmony_edit_file routes through patch-safe when harmony.centralHubPath is configured, creating a checkpoint and pre-edit snapshot before writing.
    - When you need to change several places in the SAME file, use harmony_apply_patch with multiple hunks in ONE call instead of multiple edit_file calls. harmony_apply_patch validates all hunks first, then routes the whole-file change through patch-safe in one write.
  - When making harmony_edit_file calls, include 3+ lines of context above and below the change so old_string is unique. If a replacement fails because old_string isn't unique, re-read the file and add more context.
  - Batch independent tool calls in the same turn when they don't depend on each other (multiple reads, multiple greps).
    - When unsure about scope, intent, or which approach the user prefers, call harmony_ask_question rather than guessing. One good question saves three wrong edits.
  - Be brief in chat output — 1–3 sentences for confirmations. Save detail for genuine complexity.
  - When citing a file, format it as a markdown link to the workspace path so the user can click it: [src/foo.ts](src/foo.ts) or for a specific line [src/foo.ts:42](src/foo.ts#L42). Never wrap file paths in backticks alone — always make them clickable.
    - Please keep tool-use language honest and grounded. If you say you are going to read, edit, run, search, verify, or ask, call the matching Harmony tool in that same step. If you cannot call a needed tool, say that plainly instead of describing pretend progress.
    - Please do not write bare placeholder progress lines like "File:". When a file matters, use a Harmony file tool or cite the actual clickable workspace path in the final explanation.

ORCHESTRATION & STEERING (use these when the work is non-trivial):
  - For multi-step work (3+ distinct steps), call harmony_todo with action:"add" and items:[...] to externalize your plan up front. Then check items off with action:"check" as you complete them. The user can see this list live in the Harmony sidebar.
    - When you are uncertain, stuck on a hard problem, or want a cross-check, call harmony_consult_model with provider (deepseek|alibaba|tencent|moonshot|kimiCode|gemini|openrouter|openai|claude|zhipu|zhipu-coding|doubao|doubao-coding|doubao-rewards|byteplus|byteplus-coding|stepfun) and tier (light|mid|heavy|coding). Prefer cost-transparent routine routes first and use "heavy" sparingly for genuinely hard reasoning where a second opinion changes the outcome. Optional slot_index: 0=Chat (default), 1=Agents, 2=External, 3=Vision — use agents slot when calling provider-specific agent tools.
  - When you need information from a specific URL the user mentioned, use harmony_fetch_url. Do not guess at URLs you don't have.
    - For focused sub-tasks ("summarize this file", "find the bug in these 3 functions", "draft this section"), use harmony_spawn_worker. Prefer role-based workers when provider/tier are not obvious: scout for lookup, researcher for evidence, planner for sequencing, implementer for change design, verifier for regression checks, critic for risk review, cost_sentinel for spend/provider risk, hard_reasoner only for genuinely difficult reasoning. Explicit provider/tier still override the selected Agents profile. Optional slot_index: 0=Chat, 1=Agents, 2=External, 3=Vision — use when workers need a specific provider key slot.
  - Auto-routing guidance: prefer LIGHT tier for trivial questions, lookups, and simple file reads. Use MID for code generation and analysis. Reserve HEAVY for: stuck moments, deep architectural decisions, or when light/mid produced a result you don't trust.`;

const FRONTEND_VISUAL_TOOLING = `

WEBSITE / VISUAL BUILDING DISCIPLINE:
    - When building or debugging a frontend, prefer a real feedback loop: start or use the dev server, call harmony_page_inspect for DOM/meta/a11y/layout signals, call harmony_responsive_screenshots for desktop/tablet/mobile captures, call harmony_design_audit for first-pass design risks, and call harmony_browser_action to click, hover, fill, scroll, and verify interactive states.
    - Use harmony_screenshot for a single visual capture and harmony_responsive_screenshots when the question is about responsive fit, mobile layout, viewport overflow, or comparing breakpoints.
    - For animations, first identify the local stack already in the project. Use CSS keyframes for small contained effects, Framer Motion for React component choreography when the repo already supports it or can reasonably add it, and GSAP for timeline-heavy sequences. Verify motion with browser_action plus follow-up screenshots instead of trusting code alone.
    - For graphics, mascots, icons, banners, product art, and polished visual assets, call harmony_image_gen. Prefer the configured image provider; Gemini is the default unless the user switches to OpenAI/DALL-E in settings.
    - Before calling expensive image or premium models, respect Harmony's cost guards and ask when required. Generated images should be saved under .harmony/assets unless the user asks for a project asset path.
    - When a site is nearing handoff quality, call harmony_lighthouse for performance, accessibility, best-practices, and SEO signals, then fix the highest-impact issues that are in scope.`;

const COMPANY_RESEARCH_TOOLING = `

BUSINESS, RESEARCH, AND PRECISION TOOLING:
    - For client work, use harmony_client_brief, harmony_invoice_proposal, harmony_cost_estimator, harmony_deploy_check, harmony_ethics_license_check, and harmony_accessibility_audit to turn rough requests into clear scope, fair pricing, launch readiness, and ethical handoff details.
    - For brand and public-facing design work, use harmony_brand_asset_pack to create consistent asset prompts and naming before calling harmony_image_gen.
    - For current source-backed research, use harmony_current_research with explicit source_urls, then use harmony_source_ledger to review what was fetched. Use brief mode for quick current answers and dossier mode for deeper evidence review. Do not imply that current_research searched the web by itself; it fetches and analyzes the URLs it is given.
    - For project diving, use harmony_repo_map and harmony_dependency_audit before broad edits, installs, or architectural recommendations.
    - For model/provider planning, use harmony_provider_status before choosing premium, swarm, image, long-context, or fallback routes. Use harmony_pricing_refresh when current cost/source freshness matters, and treat failed or stale pricing fetches as blockers for quoting costs.
    - For multi-agent planning, use harmony_swarm_plan to create a dormant, safety-gated swarm plan with roles, budgets, lock intents, mutation escrow, verification gates, and stop conditions. Use harmony_swarm_preflight before any proposed escalation, harmony_swarm_escrow to record a proposed mutation without applying it, and harmony_swarm_receipts to review saved plans. The swarm scaffold does not execute roles, run terminals, or apply patches by itself.
    - For Eternal Harmony research, use harmony_research_brief, harmony_literature_scan, harmony_evidence_matrix, harmony_qualitative_coder, harmony_publication_outline, and harmony_research_backlog to separate lived experience, hypothesis, evidence, source candidates, and publication claims. Do not fabricate citations. Treat social or first-person material as qualitative evidence unless a stronger source supports the claim.
    - For delicate coding changes, use harmony_code_surgery_plan and harmony_patch_preflight before risky edits, then use harmony_apply_patch for atomic file changes. Use harmony_repo_health_scan when the repo state or diagnostics are unclear.`;

const OPERATIONS_BACKUP_TOOLING = `

OPERATIONS, BACKUP, AND SYSTEM AWARENESS TOOLING:
    - When the user asks what tools Harmony has, use harmony_tool_ledger or the /tools command. The ledger is generated from the installed extension manifest and live registered tools, so it is safer than a handwritten list.
    - For HarmonyExtension backup planning, use harmony_backup_advisor first, then harmony_backup_manifest for a dated inventory, and harmony_backup_snapshot when the user wants a lean source backup copied outside a huge Central backup.
    - For storage and troubleshooting, use harmony_storage_analyzer, harmony_system_snapshot, harmony_network_snapshot, and harmony_registry_snapshot. Treat registry, DNS cache, process lists, and network details as potentially sensitive; ask/confirm when the tool requires it and summarize carefully.`;

const CONTEXT_BLINDSPOT_GUARD = `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔒 CONTEXT TRUNCATION BLINDSPOT GUARD — PINNED AT END OF SYSTEM PROMPT
If any of the CRITICAL TOOL-CALLING RULE, HEAVY-CODING DISCIPLINE, or
RUNTIME MODES appear truncated or missing from your instructions above,
re-read the opening of your system prompt NOW before acting. The most
important rules live at the top and may have been lost to context pressure.
Do not guess missing instructions — re-derive them from what remains.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

const DEFAULT_PROFILES: Record<string, ProfileDefinition> = {
    default: {
        id: 'default',
        label: 'Harmony',
        systemPrompt:
            `${CONTEXT_PREAMBLE}${FRONTEND_VISUAL_TOOLING}${COMPANY_RESEARCH_TOOLING}${OPERATIONS_BACKUP_TOOLING}

Please use tools to read, search, and modify the workspace as needed. Prefer minimal diffs and respect existing conventions.${CONTEXT_BLINDSPOT_GUARD}`
    },
    coder: {
        id: 'coder',
        label: 'Coder',
        systemPrompt:
            `${CONTEXT_PREAMBLE}${FRONTEND_VISUAL_TOOLING}${COMPANY_RESEARCH_TOOLING}${OPERATIONS_BACKUP_TOOLING}

You are acting as a senior pair-programmer. Please optimize for correctness and clarity. Please always read files before editing. Please explain non-obvious choices in one sentence.${CONTEXT_BLINDSPOT_GUARD}`
    },
    reviewer: {
        id: 'reviewer',
        label: 'Reviewer',
        systemPrompt:
            `${CONTEXT_PREAMBLE}${FRONTEND_VISUAL_TOOLING}${COMPANY_RESEARCH_TOOLING}${OPERATIONS_BACKUP_TOOLING}

You are acting as a code reviewer. Please read the relevant files, then return a numbered list of concrete, actionable findings. Please cite paths and line numbers.${CONTEXT_BLINDSPOT_GUARD}`
    }
};

function sanitizeAssistantHistoryText(text: string): string {
    return text
        .replace(/<details(?:\s+open)?><summary>Thinking(?:…|\.\.\.)<\/summary>[\s\S]*?<\/details>/gi, '')
        .replace(/<details><summary>Diagnostic details[\s\S]*?<\/details>/gi, '')
    .replace(/^\s*File:\s*$/gmi, '')
    .replace(/^\s*(?:Now\s+)?Let me (?:try|start by|do|read|check|verify|apply|run|ask)[^\n]*(?:tool|file|fix|disk|server)[^\n]*$/gmi, '')
        .replace(/(?:^|\n)> \*\*Thinking\.\.\.\*\*\n(?:>.*(?:\n|$))*/g, '\n')
        .replace(/^_Thinking through the request(?:…|\.\.\.)_\s*/gm, '')
        .replace(/^> 🤖 .*\n\n/m, '')
        .trim();
}

function formatThinkingBlock(reasoning: string): string {
    const clean = reasoning.trim();
    if (!clean) return '';
    const quoted = clean
        .split(/\r?\n/)
        .map(line => line.trim().length > 0 ? `> ${line}` : '>')
        .join('\n');
    return `\n\n> **Thinking...**\n${quoted}\n\n`;
}

interface DeepSeekAssistantTrace {
    content: string;
    reasoning: string;
    timestamp: number;
}

const deepSeekAssistantTraces: DeepSeekAssistantTrace[] = [];
const MAX_DEEPSEEK_ASSISTANT_TRACES = 40;

function normalizeDeepSeekHistoryText(text: string): string {
    return sanitizeAssistantHistoryText(text)
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function rememberDeepSeekAssistantTrace(content: string, reasoning: string): void {
    const clean = normalizeDeepSeekHistoryText(content);
    const hiddenReasoning = reasoning.trim();
    if (!clean || !hiddenReasoning) return;
    deepSeekAssistantTraces.push({
        content: sanitizeForJson(clean),
        reasoning: hiddenReasoning,
        timestamp: Date.now()
    });
    if (deepSeekAssistantTraces.length > MAX_DEEPSEEK_ASSISTANT_TRACES) {
        deepSeekAssistantTraces.splice(0, deepSeekAssistantTraces.length - MAX_DEEPSEEK_ASSISTANT_TRACES);
    }
}

function findDeepSeekReasoningForHistory(content: string, usedTraceIndexes: Set<number>): string | undefined {
    const clean = normalizeDeepSeekHistoryText(content);
    if (!clean) return undefined;

    for (let i = 0; i < deepSeekAssistantTraces.length; i++) {
        if (!usedTraceIndexes.has(i) && deepSeekAssistantTraces[i].content === clean) {
            usedTraceIndexes.add(i);
            return deepSeekAssistantTraces[i].reasoning;
        }
    }

    for (let i = 0; i < deepSeekAssistantTraces.length; i++) {
        if (usedTraceIndexes.has(i)) continue;
        const trace = deepSeekAssistantTraces[i];
        if (clean.endsWith(trace.content) || trace.content.endsWith(clean)) {
            usedTraceIndexes.add(i);
            return trace.reasoning;
        }
    }

    return undefined;
}

function stripReasoningFromDeepSeekMessages(messages: DeepSeekMessage[]): DeepSeekMessage[] {
    return messages.map(message => {
        const { reasoning_content, ...rest } = message;
        return rest;
    });
}

/**
 * Gemini 3 thinking models attach an encrypted thought_signature to every
 * functionCall part and REQUIRE it back on subsequent requests. Missing
 * signatures cause HTTP 400 ("Function call is missing a thought_signature").
 *
 * If our streaming parser fails to capture a signature (field renamed, moved
 * to a new SSE chunk location, etc.), this function converts the problematic
 * assistant tool_calls into a plain-text description and merges the matching
 * tool result messages into a single user message. This eliminates all
 * functionCall parts from the request, so Gemini has nothing to reject.
 *
 * Only activates for Gemini and only when assistant tool_calls lack
 * thought_signature. All other providers and signed tool calls pass through
 * untouched.
 */
function geminiSanitizeMessages(messages: DeepSeekMessage[]): DeepSeekMessage[] {
    // Quick scan: are there any unsigned assistant tool_calls?
    const hasUnsignedCalls = messages.some(
        m => m.role === 'assistant'
            && Array.isArray(m.tool_calls)
            && m.tool_calls!.length > 0
            && !m.tool_calls!.some((tc: any) => tc.thought_signature)
    );
    if (!hasUnsignedCalls) return messages; // All good — no sanitization needed

    debugLog('[Gemini Sanitize] found unsigned assistant tool_calls — converting to text format to prevent HTTP 400');
    const result: DeepSeekMessage[] = [];
    // Track tool_call_ids we've absorbed so we can skip their tool result messages
    const absorbedToolCallIds = new Set<string>();

    for (const msg of messages) {
        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
            const hasSignature = msg.tool_calls.some((tc: any) => tc.thought_signature);
            if (hasSignature) {
                // Keep as-is — signatures present
                result.push(msg);
                continue;
            }

            // Convert unsigned tool_calls to a text description
            const callDescriptions = msg.tool_calls.map((tc: any) => {
                const name = tc.function?.name ?? '(unknown)';
                let args = '';
                try { args = tc.function?.arguments ? JSON.stringify(JSON.parse(tc.function.arguments)) : '{}'; } catch { args = tc.function?.arguments ?? '{}'; }
                absorbedToolCallIds.add(tc.id);
                return `[Tool call: ${name}(${args})]`;
            });
            const textContent = [msg.content, ...callDescriptions].filter(Boolean).join('\n');
            result.push({ role: 'assistant', content: textContent || '[tool calls converted to text]' });
        } else if (msg.role === 'tool' && msg.tool_call_id && absorbedToolCallIds.has(msg.tool_call_id)) {
            // Merge this tool result into the previous message as a user message
            const mergedResult = `[Tool result for ${msg.tool_call_id}]: ${msg.content ?? '(empty)'}`;
            result.push({ role: 'user', content: mergedResult });
        } else {
            result.push(msg);
        }
    }

    debugLog(`[Gemini Sanitize] converted ${absorbedToolCallIds.size} unsigned tool call(s) to text format`);
    return result;
}

function deepSeekTierForModel(model: string): 'mid' | 'heavy' {
    return model.toLowerCase().includes('pro') ? 'heavy' : 'mid';
}

type DirectPrimaryProvider = Extract<ProviderId, 'deepseek' | 'alibaba' | 'tencent' | 'moonshot' | 'kimiCode' | 'zhipu' | 'zhipu-coding' | 'openai' | 'openrouter' | 'gemini' | 'claude' | 'doubao' | 'doubao-coding' | 'doubao-rewards' | 'byteplus' | 'byteplus-coding' | 'stepfun'>;

interface DirectPrimaryRoute {
    provider: DirectPrimaryProvider;
    label: string;
    model: string;
    baseUrl: string;
    secretKey: string;
    tier: Tier;
    supportsReasoningContent: boolean;
    thinkingEnabled: boolean;
    showThinking: boolean;
    /** Tencent native auth creds (SecretId + SecretKey). When set, streaming uses TC3-HMAC-SHA256 signing instead of Bearer token. */
    tencentNativeCreds?: { secretId: string; secretKey: string };
}

function isDirectPrimaryProvider(value: string | undefined): value is DirectPrimaryProvider {
    return value === 'deepseek' || value === 'alibaba' || value === 'tencent' || value === 'moonshot' || value === 'kimiCode' || value === 'zhipu' || value === 'zhipu-coding' || value === 'openai' || value === 'openrouter' || value === 'gemini' || value === 'claude' || value === 'doubao' || value === 'doubao-coding' || value === 'doubao-rewards' || value === 'byteplus' || value === 'byteplus-coding' || value === 'stepfun';
}

function directPrimaryRoute(provider: DirectPrimaryProvider): DirectPrimaryRoute {
    const cfg = vscode.workspace.getConfiguration('harmony');
    if (provider === 'deepseek') {
        const model = getDeepSeekModel();
        return {
            provider,
            label: 'DeepSeek',
            model,
            baseUrl: providerBaseUrlForCall(provider),
            secretKey: secretKeyFor(provider),
            tier: deepSeekTierForModel(model),
            supportsReasoningContent: true,
            thinkingEnabled: cfg.get<boolean>('deepseekThinking') ?? true,
            showThinking: cfg.get<boolean>('deepseekShowThinking') ?? false
        };
    }
    if (provider === 'alibaba') {
        const model = modelFor(provider, 'coding');
        return {
            provider,
            label: providerDisplayName(provider),
            model,
            baseUrl: providerBaseUrlForCall(provider),
            secretKey: secretKeyFor(provider),
            tier: 'coding',
            supportsReasoningContent: true,
            thinkingEnabled: false,
            showThinking: false
        };
    }
    if (provider === 'openai') {
        return {
            provider,
            label: 'OpenAI',
            model: modelFor('openai', 'coding'),
            baseUrl: 'https://api.openai.com/v1',
            secretKey: secretKeyFor('openai'),
            tier: 'coding',
            supportsReasoningContent: false,
            thinkingEnabled: false,
            showThinking: false
        };
    }
    if (provider === 'openrouter') {
        const baseUrl = (cfg.get<string>('openrouter.baseUrl') ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
        return {
            provider,
            label: 'OpenRouter',
            model: modelFor('openrouter', 'coding'),
            baseUrl,
            secretKey: secretKeyFor('openrouter'),
            tier: 'coding',
            supportsReasoningContent: false,
            thinkingEnabled: false,
            showThinking: false
        };
    }
    if (provider === 'gemini') {
        // Gemini via OpenAI-compatible endpoint.
        // Respect user's configured Gemini model (they may have overridden
        // the coding tier to use gemini-3.1-pro-preview for heavier work).
        const geminiModel = cfg.get<string>('providers.gemini.coding')?.trim()
            || modelFor('gemini', 'coding');
        return {
            provider,
            label: 'Gemini',
            model: geminiModel,
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
            secretKey: secretKeyFor('gemini'),
            tier: 'coding',
            supportsReasoningContent: false,
            thinkingEnabled: false,
            showThinking: false
        };
    }
    if (provider === 'claude') {
        return {
            provider,
            label: 'Claude',
            model: modelFor('claude', 'coding'),
            baseUrl: 'https://api.anthropic.com/v1',
            secretKey: secretKeyFor('claude'),
            tier: 'coding',
            supportsReasoningContent: false,
            thinkingEnabled: false,
            showThinking: false
        };
    }
    // Doubao Coding Plan — same API, same key, same base URL as standard Doubao.
    // Default model is doubao-seed-code (coding-specialized). Subscription-billed.
    if (provider === 'doubao-coding') {
        const arkModel = modelFor('doubao-coding', 'coding');
        return {
            provider,
            label: 'Doubao Coding Plan',
            model: arkModel,
            baseUrl: providerBaseUrlForCall('doubao'),
            secretKey: secretKeyFor('doubao-coding'),
            tier: 'coding',
            supportsReasoningContent: true,
            thinkingEnabled: true,
            showThinking: false
        };
    }
    // Doubao / Volcengine — Volcano Engine Ark API (OpenAI-compatible).
    // Thinking models (seed-2.1-pro, seed-evolving) return reasoning_content
    // in SSE deltas (DeepSeek-style). Base URL is configurable for ep-xxx endpoints.
    if (provider === 'doubao') {
        const arkModel = modelFor('doubao', 'coding');
        return {
            provider,
            label: 'Doubao / Volcengine',
            model: arkModel,
            baseUrl: providerBaseUrlForCall('doubao'),
            secretKey: secretKeyFor('doubao'),
            tier: 'coding',
            supportsReasoningContent: true,
            thinkingEnabled: true,
            showThinking: false
        };
    }
    // Doubao Rewards — same API, same key, same base URL as standard Doubao.
    // The model field is the user's authorized access point ID (ep-xxx).
    if (provider === 'doubao-rewards') {
        const rewardsModel = modelFor('doubao-rewards', 'coding');
        return {
            provider,
            label: 'Doubao Rewards',
            model: rewardsModel,
            baseUrl: providerBaseUrlForCall('doubao'),
            secretKey: secretKeyFor('doubao-rewards'),
            tier: 'coding',
            supportsReasoningContent: true,
            thinkingEnabled: true,
            showThinking: false
        };
    }
    // BytePlus — International Doubao API (BytePlus ModelArk).
    // Separate account, USD billing, ark.byteplus.com endpoints.
    if (provider === 'byteplus') {
        const arkModel = modelFor('byteplus', 'coding');
        return {
            provider,
            label: 'BytePlus / Doubao',
            model: arkModel,
            baseUrl: providerBaseUrlForCall('byteplus'),
            secretKey: secretKeyFor('byteplus'),
            tier: 'coding',
            supportsReasoningContent: true,
            thinkingEnabled: true,
            showThinking: false
        };
    }
    // ByteDance Coding Plan (International) — BytePlus subscription, USD billing.
    if (provider === 'byteplus-coding') {
        const arkModel = modelFor('byteplus-coding', 'coding');
        return {
            provider,
            label: 'ByteDance Coding Plan',
            model: arkModel,
            baseUrl: providerBaseUrlForCall('byteplus'),
            secretKey: secretKeyFor('byteplus-coding'),
            tier: 'coding',
            supportsReasoningContent: true,
            thinkingEnabled: true,
            showThinking: false
        };
    }
    // StepFun — OpenAI-compatible. Dual-region: international (.ai) vs mainland (.com).
    // step-3.7-flash supports reasoning effort control and returns reasoning_content
    // in SSE deltas (DeepSeek/Doubao-style). Enable capture so thinking doesn't leak.
    if (provider === 'stepfun') {
        const stepModel = modelFor('stepfun', 'coding');
        return {
            provider,
            label: 'StepFun',
            model: stepModel,
            baseUrl: providerBaseUrlForCall('stepfun'),
            secretKey: secretKeyFor('stepfun'),
            tier: 'coding',
            supportsReasoningContent: true,
            thinkingEnabled: true,
            showThinking: false
        };
    }
    const model = modelFor(provider, 'coding');
    // Moonshot (api.moonshot.ai) K3 returns reasoning_content in the SSE delta
    // just like DeepSeek, so we can capture and display it separately.
    // KimiCode (api.kimi.com/coding/v1) embeds reasoning in delta.content instead —
    // there is no separate reasoning_content field. We cannot split it.
    // So only enable reasoning_content capture for Moonshot, NOT KimiCode.
    const isMoonshotK3 = provider === 'moonshot' && (model === 'kimi-k3');
    return {
        provider,
        label: providerDisplayName(provider),
        model,
        baseUrl: providerBaseUrlForCall(provider),
        secretKey: secretKeyFor(provider),
        tier: 'coding',
        supportsReasoningContent: isMoonshotK3,
        thinkingEnabled: isMoonshotK3,
        showThinking: isMoonshotK3
    };
}

type HubStartOnMessageMode = 'off' | 'prompt' | 'auto';

function hubStartOnMessageMode(): HubStartOnMessageMode {
    const raw = vscode.workspace.getConfiguration('harmony').get<string>('hub.startOnMessage');
    return raw === 'prompt' || raw === 'auto' ? raw : 'off';
}

async function isHubOnlineForMessage(): Promise<boolean> {
    const cfg = vscode.workspace.getConfiguration('harmony');
    const base = (cfg.get<string>('hub.url') ?? 'http://127.0.0.1:7878').replace(/\/$/, '');
    try {
        const res = await fetch(`${base}/status`, { signal: AbortSignal.timeout(900) });
        return res.ok;
    } catch {
        return false;
    }
}

async function maybePrepareHubForMessage(stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
    const mode = hubStartOnMessageMode();
    if (mode === 'off' || token.isCancellationRequested || await isHubOnlineForMessage()) return;

    if (mode === 'prompt') {
        stream.markdown(
            `> HarmonyHub is offline. Hub recall is local cross-project memory; first startup or indexing can take a little time and may use noticeable RAM. ` +
            `This is not VS Code launch autostart.\n\n`
        );
        // Never let a missed/hidden notification hang the chat turn forever:
        // if the user does not answer within 60s, continue without the Hub.
        let promptTimer: ReturnType<typeof setTimeout> | undefined;
        const choice = await Promise.race([
            vscode.window.showInformationMessage(
                'HarmonyHub is offline. Start it now for this Harmony message and index the open workspace?',
                'Start Hub for this message',
                'Continue without Hub',
                'Keep off'
            ),
            new Promise<undefined>(resolve => {
                promptTimer = setTimeout(() => resolve(undefined), 60000);
            })
        ]).finally(() => { if (promptTimer) clearTimeout(promptTimer); });
        if (choice === undefined) {
            stream.markdown('> HarmonyHub prompt was dismissed or not answered within 60s. Continuing without Hub recall so the chat is never blocked.\n\n');
            return;
        }
        if (choice === 'Keep off') {
            await vscode.workspace.getConfiguration('harmony').update('hub.startOnMessage', 'off', vscode.ConfigurationTarget.Global);
            stream.markdown('> HarmonyHub message-start prompt is now off. Use the sidebar or settings to re-enable it.\n\n');
            return;
        }
        if (choice !== 'Start Hub for this message') {
            stream.markdown('> Continuing without Hub recall for this message.\n\n');
            return;
        }
    } else {
        stream.markdown('> HarmonyHub is offline; starting local recall for this message and indexing the open workspace.\n\n');
    }

    const ok = await vscode.commands.executeCommand<boolean>('harmony.ensureHubForChat', { indexOnReady: true });
    stream.markdown(ok
        ? '> HarmonyHub is ready. Local recall/indexing has been requested for this message.\n\n'
        : '> HarmonyHub did not become ready in time. Continuing without Hub recall for this message.\n\n'
    );
}

function diagnosticBlock(args: {
    provider: string;
    modelLabel: string;
    profile: string;
    forceReadOnly: boolean;
    command?: string;
    error: string;
}): string {
    const details = [
        `provider: ${args.provider}`,
        `model: ${args.modelLabel}`,
        `profile: ${args.profile}`,
        `readOnly: ${args.forceReadOnly}`,
        `command: ${args.command ?? '(none)'}`,
        `error: ${args.error}`
    ].join('\n');
    return `\n\n<details><summary>Diagnostic details</summary>\n\n\`\`\`text\n${details}\n\`\`\`\n\nThis does not include hidden reasoning or API keys. It is only the routing/error context needed to debug a failed turn.\n\n</details>`;
}

function isTransientProviderInterruption(error: any): boolean {
    const raw = error?.message ?? String(error);
    const name = typeof error?.name === 'string' ? error.name : '';
    const text = `${name} ${raw}`.toLowerCase();
    return /terminated|socket hang up|econnreset|und_err|fetch failed|networkerror/.test(text);
}

function classifyParticipantError(error: any, token: vscode.CancellationToken): { message: string; diagnosticError: string; showDiagnostics: boolean } {
    const raw = error?.message ?? String(error);
    const name = typeof error?.name === 'string' ? error.name : '';
    const text = `${name} ${raw}`.toLowerCase();

    if (token.isCancellationRequested || /aborterror|aborted|cancelled|canceled/.test(text)) {
        return {
            message: 'Harmony turn cancelled before it finished.',
            diagnosticError: raw,
            showDiagnostics: false
        };
    }

    if (isTransientProviderInterruption(error)) {
        return {
            message: 'Harmony provider connection was interrupted before it finished. Please retry; if this repeats, switch to a lighter model or wait for the provider to settle.',
            diagnosticError: describeNetworkError(error),
            showDiagnostics: true
        };
    }

    if (/timeout|timed out/.test(text)) {
        return {
            message: 'Harmony provider request timed out before it finished.',
            diagnosticError: describeNetworkError(error),
            showDiagnostics: true
        };
    }

    return { message: raw, diagnosticError: raw, showDiagnostics: true };
}

function getCurrentProfile(context: vscode.ExtensionContext): ProfileDefinition {
    const id = context.workspaceState.get<string>('harmony.activeProfile')
        ?? vscode.workspace.getConfiguration('harmony').get<string>('defaultProfile')
        ?? 'default';
    return DEFAULT_PROFILES[id] ?? DEFAULT_PROFILES.default;
}

async function setProfile(context: vscode.ExtensionContext, id: string) {
    await context.workspaceState.update('harmony.activeProfile', id);
}

/** Build vscode.LanguageModelChatMessage[] from history + current request. */
async function buildMessages(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    profile: ProfileDefinition,
    references: string[],
    recallText: string,
    resumedSessionText: string,
    rulesText: string,
    continuityText: string
): Promise<vscode.LanguageModelChatMessage[]> {
    const messages: vscode.LanguageModelChatMessage[] = [];

    let leadingInstructions = profile.systemPrompt + await modeAddendum();
    leadingInstructions += '\n' + LanguageManager.getInstance().getLanguageInstruction();
    if (references.length > 0) {
        leadingInstructions += `\n\nThe user attached these files for context:\n` + references.join('\n');
    }
    if (rulesText) leadingInstructions += rulesText;
    if (continuityText) leadingInstructions += continuityText;
    // 🌸 CareBloom Garden: scan for unresolved Wisdom Sprouts
    try {
        const unresolved = await scanUnresolvedSprouts();
        if (unresolved.length > 0) {
            leadingInstructions += '\n\n<pending_sprouts>\n';
            leadingInstructions += 'The CareBloom Garden has detected areas where deep attention gathered. ';
            leadingInstructions += 'When appropriate during this session, use harmony_read_file to scan `.carebloom/wisdom-sprout-*.md` ';
            leadingInstructions += 'and fill in the [UNRESOLVED] reflections with what was learned.\n';
            leadingInstructions += unresolved.map(s => `- ${s}`).join('\n');
            leadingInstructions += '\n</pending_sprouts>';
        }
    } catch { /* best effort */ }
    // 🌸 Conductor Mesh: weave resolved Wisdom Sprouts into this session
    try {
        const wisdom = await scanResolvedSprouts();
        if (wisdom.length > 0) {
            leadingInstructions += '\n\n<carried_wisdom>\n';
            leadingInstructions += 'The following learnings were captured from past troubleshooting sessions. ';
            leadingInstructions += 'Apply this wisdom when relevant — these are hard-won insights from repeated attempts.\n\n';
            leadingInstructions += wisdom.join('\n\n');
            leadingInstructions += '\n</carried_wisdom>';
        }
    } catch { /* best effort */ }
    if (recallText) leadingInstructions += recallText;
    if (resumedSessionText) leadingInstructions += resumedSessionText;
    // Total budget guard: prevent JSON encoding failures from oversized system messages
    const MAX_CONTEXT_CHARS = 80000;
    if (leadingInstructions.length > MAX_CONTEXT_CHARS) {
        debugLog("[Context Guard] System message " + leadingInstructions.length + " chars exceeds " + MAX_CONTEXT_CHARS + " cap - trimming least essential context");
        const overhead = leadingInstructions.length - MAX_CONTEXT_CHARS + 2000;
        const parts = leadingInstructions.split("PERSISTED HARMONY CONTINUITY FOR THIS WORKSPACE");
        if (parts.length > 1) {
            const recallPart = parts[1];
            if (recallPart.length > overhead) {
                leadingInstructions = parts[0] + "PERSISTED HARMONY CONTINUITY FOR THIS WORKSPACE" + recallPart.slice(0, recallPart.length - overhead);
            } else {
                leadingInstructions = parts[0];
            }
        }
        if (leadingInstructions.length > MAX_CONTEXT_CHARS) {
            leadingInstructions = leadingInstructions.slice(0, MAX_CONTEXT_CHARS) + "\n\n[Context trimmed to prevent encoding failure]";
        }
    }
    messages.push(vscode.LanguageModelChatMessage.User(leadingInstructions));

    // Replay prior conversation turns.
    for (const turn of chatContext.history) {
        if (turn instanceof vscode.ChatRequestTurn) {
            messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
        } else if (turn instanceof vscode.ChatResponseTurn) {
            const text = turn.response
                .map(part => part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : '')
                .join('');
            const clean = sanitizeAssistantHistoryText(text);
            if (clean) messages.push(vscode.LanguageModelChatMessage.Assistant(clean));
        }
    }

    messages.push(vscode.LanguageModelChatMessage.User(request.prompt));
    return messages;
}

/** Resolve attached references (#file:foo) to inline content. */
async function resolveReferences(refs: readonly vscode.ChatPromptReference[]): Promise<string[]> {
    const out: string[] = [];
    for (const ref of refs) {
        try {
            if (ref.value instanceof vscode.Uri) {
                const rel = vscode.workspace.asRelativePath(ref.value, false);
                out.push(`- ${rel}`);
            } else if (typeof ref.value === 'string') {
                out.push(`- ${ref.value}`);
            } else if (ref.value && typeof ref.value === 'object' && 'uri' in ref.value) {
                const uri = (ref.value as any).uri as vscode.Uri;
                out.push(`- ${vscode.workspace.asRelativePath(uri, false)}`);
            }
        } catch { /* ignore */ }
    }
    // Deterministic order → stable DeepSeek context prefix (cache-friendly).
    return out.sort((a, b) => a.localeCompare(b));
}

/** Optional: store a turn in the local Harmony memory hub for semantic cross-session recall. */
async function tryMemoryStore(profileId: string, prompt: string, response: string) {
    try {
        const cfg = vscode.workspace.getConfiguration('harmony');
        if (!cfg.get<boolean>('enableMemoryHub', false)) return;
        const url = (cfg.get<string>('hub.url') ?? 'http://127.0.0.1:7878').replace(/\/+$/, '');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        await fetch(`${url}/ext/v1/memory/store`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profile: profileId, prompt, response, source: 'harmony-extension' }),
            signal: controller.signal as any
        }).catch(() => undefined);
        clearTimeout(timer);
    } catch { /* memory hub is optional, never block on it */ }
}

interface MemoryHubHit {
    id: number;
    prompt: string;
    response: string;
    source: string;
    timestamp: string;
    score: number;
    tags: string[];
}

/** Optional: recall relevant past turns from the local Harmony memory hub. */
async function tryMemoryRecall(query: string, profileId: string, nResults: number = 5): Promise<MemoryHubHit[]> {
    try {
        const cfg = vscode.workspace.getConfiguration('harmony');
        if (!cfg.get<boolean>('enableMemoryHub', false)) return [];
        const url = (cfg.get<string>('hub.url') ?? 'http://127.0.0.1:7878').replace(/\/+$/, '');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        const resp = await fetch(`${url}/ext/v1/memory/recall`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, profile: profileId, n_results: nResults }),
            signal: controller.signal as any
        });
        clearTimeout(timer);
        if (!resp.ok) return [];
        const data = await resp.json() as { hits?: MemoryHubHit[] };
        return data.hits ?? [];
    } catch { return []; }
}

type DeepSeekRole = 'system' | 'user' | 'assistant' | 'tool';

interface DeepSeekToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
    /** Google Gemini OpenAI-compat only: encrypted thought signature attached to
     *  functionCall parts by thinking models (Gemini 2.5/3). Must be echoed back
     *  on the assistant tool_calls message in the next request, or the API
     *  returns HTTP 400 ("Function call is missing a thought_signature"). */
    thought_signature?: string;
}


/** Sanitize string content for safe JSON serialization.
 *  Handles lone surrogate pairs and control characters that can
 *  produce malformed JSON hex escapes in JSON.stringify output. */
function sanitizeForJson(str: string): string {
    return str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

interface DeepSeekMessage {
    role: DeepSeekRole;
    content: string | null;
    reasoning_content?: string;
    tool_calls?: DeepSeekToolCall[];
    tool_call_id?: string;
}

async function buildDeepSeekMessages(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    profile: ProfileDefinition,
    references: string[],
    recallText: string,
    resumedSessionText: string,
    rulesText: string,
    continuityText: string
): Promise<DeepSeekMessage[]> {
    let system = profile.systemPrompt + await modeAddendum();
    system += '\n' + LanguageManager.getInstance().getLanguageInstruction();
    if (references.length > 0) {
        system += `\n\nThe user attached these files for context. Use harmony_read_file when you need contents:\n` + references.join('\n');
    }
    if (rulesText) system += rulesText;
    if (continuityText) system += continuityText;
    if (recallText) system += recallText;
    if (resumedSessionText) system += resumedSessionText;
    // Total budget guard: prevent JSON encoding failures from oversized system messages
    const MAX_SYSTEM_CHARS = 80000;
    if (system.length > MAX_SYSTEM_CHARS) {
        debugLog("[Context Guard] DeepSeek system message " + system.length + " chars exceeds " + MAX_SYSTEM_CHARS + " cap - trimming");
        const overhead = system.length - MAX_SYSTEM_CHARS + 2000;
        const parts = system.split("PERSISTED HARMONY CONTINUITY FOR THIS WORKSPACE");
        if (parts.length > 1) {
            const recallPart = parts[1];
            if (recallPart.length > overhead) {
                system = parts[0] + "PERSISTED HARMONY CONTINUITY FOR THIS WORKSPACE" + recallPart.slice(0, recallPart.length - overhead);
            } else {
                system = parts[0];
            }
        }
        if (system.length > MAX_SYSTEM_CHARS) {
            system = system.slice(0, MAX_SYSTEM_CHARS) + "\n\n[Context trimmed to prevent encoding failure]";
        }
    }

    const messages: DeepSeekMessage[] = [{ role: 'system', content: sanitizeForJson(system) }];
    const historyMessages: DeepSeekMessage[] = [];
    const usedTraceIndexes = new Set<number>();

    for (const turn of chatContext.history) {
        if (turn instanceof vscode.ChatRequestTurn) {
            historyMessages.push({ role: 'user', content: sanitizeForJson(turn.prompt) });
        } else if (turn instanceof vscode.ChatResponseTurn) {
            const text = turn.response
                .map(part => part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : '')
                .join('');
            const clean = sanitizeAssistantHistoryText(text);
            if (clean) {
                const reasoning = findDeepSeekReasoningForHistory(clean, usedTraceIndexes);
                historyMessages.push({
                    role: 'assistant',
                    content: sanitizeForJson(clean),
                    reasoning_content: reasoning
                });
            }
        }
    }

    messages.push(...trimDeepSeekHistoryMessages(historyMessages));
    messages.push({ role: 'user', content: sanitizeForJson(request.prompt) });
    return messages;
}

async function deepSeekTools(forceReadOnly = false) {
    const allowed = activeToolNames(forceReadOnly);
    const registeredTools = await waitForActiveHarmonyTools(forceReadOnly);
    const advertised = registeredTools
        .filter(t => allowed.includes(t.name))
        .map(t => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.inputSchema ?? { type: 'object', properties: {} }
            }
        }));
    const missing = missingToolNames(allowed, registeredTools);
    debugLog(`[Tool Registry] requested=${allowed.length} registered=${toolNames(registeredTools).length} advertised=${advertised.length} missing=${missing.length > 0 ? missing.join(', ') : '(none)'}`);
    return advertised;
}

function toolResultToText(result: vscode.LanguageModelToolResult): string {
    const text = result.content.map(part => {
        if (part instanceof vscode.LanguageModelTextPart) return part.value;
        return JSON.stringify(part);
    }).filter(part => part.trim().length > 0).join('\n');
    return text || '[tool returned empty result]';
}

function isUserDeclinedToolError(error: any, token: vscode.CancellationToken): boolean {
    if (token.isCancellationRequested) return false;
    const text = `${error?.name ?? ''}\n${error?.message ?? ''}\n${String(error ?? '')}`.toLowerCase();
    return /\b(user|confirmation|tool invocation|operation)\b[\s\S]{0,80}\b(declin|denied|reject|cancelled|canceled|not approved|not confirmed)\b/.test(text)
        || /\b(declin|denied|reject|cancelled|canceled)\b[\s\S]{0,80}\b(user|confirmation|tool invocation|operation)\b/.test(text);
}

async function askAfterDeclinedTool(
    toolName: string,
    input: unknown,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<string | undefined> {
    if (token.isCancellationRequested) return undefined;
    try {
        stream.markdown(`\n\n> I noticed **${toolName}** was declined or cancelled. I will ask what you meant before changing course.\n\n`);
    } catch { /* best effort */ }
    const inputText = safeJson(input).slice(0, 1200);
    const answer = await showHarmonyAsk({
        question: [
            'Action declined or cancelled',
            `I saw the confirmation/action for ${toolName} did not proceed. What should Harmony do next?`,
            inputText ? `Requested input:\n${inputText}` : undefined,
        ].filter(Boolean).join('\n\n'),
        options: [
            { label: 'Stop that action', description: 'Treat the decline as intentional and do not retry.' },
            { label: 'Accident - ask again', description: 'The decline was accidental; retry only if the action is still needed.' },
            { label: 'Use safer alternative', description: 'Switch to a read-only or less risky path.' },
            { label: 'Explain first', description: 'Pause and explain why this action was requested.' },
        ],
        allowFreeformInput: true,
        multiSelect: false,
    }, token);
    return answer;
}

function declinedToolGuidance(toolName: string, error: any, answer: string | undefined): string {
    const message = error?.message ?? String(error);
    return [
        `tool confirmation/cancel follow-up for ${toolName}: ${message}`,
        answer
            ? `User follow-up answer: ${answer}`
            : 'User did not answer the follow-up question.',
        'Treat this as user intent/context. Do not troubleshoot it as an unexplained tool failure; either stop, retry after explicit confirmation, choose a safer alternative, or explain first according to the answer.',
    ].join('\n');
}

function companionExtensionStatus(currentExtensionId = 'harmony.harmony-extension'): string {
    const harmonyToolCompanions = vscode.extensions.all.filter(ext => {
        if (ext.id === currentExtensionId) return false;
        const text = `${ext.id}\n${ext.packageJSON?.name ?? ''}\n${ext.packageJSON?.displayName ?? ''}`.toLowerCase();
        return text.includes('harmony') && /\btools?\b/.test(text);
    });
    const toolCompanionLine = harmonyToolCompanions.length > 0
        ? `extra Harmony Tools companion(s): ${harmonyToolCompanions.map(ext => `${ext.id}@${ext.packageJSON?.version ?? 'unknown'}`).join(', ')}`
        : 'extra Harmony Tools companion: not installed; not required because Harmony Chat contributes its own toolset';
    return toolCompanionLine;
}

function criticalToolsForMode(forceReadOnly: boolean): string[] {
    const planOnly = vscode.workspace.getConfiguration('harmony').get<boolean>('planOnlyMode') ?? false;
    return forceReadOnly || planOnly
        ? CRITICAL_TOOL_NAMES
        : [...CRITICAL_TOOL_NAMES, ...CRITICAL_WRITE_TOOL_NAMES];
}

function toolSchemaNames(tools: readonly any[]): string[] {
    return tools.map(tool => tool?.function?.name).filter((name): name is string => typeof name === 'string').sort();
}

function toolRoutingFailureLikely(content: string, prompt: string): boolean {
    const promptText = prompt.toLowerCase();
    const contentText = content.toLowerCase();
    const joined = `${promptText}\n${contentText}`;
    // A bare "file:" placeholder is a stub — nothing was delivered.
    if (/^\s*file:\s*$/im.test(content)) return true;
    // Explicit promise to call the ask-question tool without calling it.
    if (/\b(?:use|try|test|call|run|invoke)\b[\s\S]{0,100}\b(?:harmony_ask_question|ask_question)\b/.test(joined)) return true;
    if (/\b(?:harmony_ask_question|ask_question)\b[\s\S]{0,100}\b(?:tool|call|invoke)\b/.test(contentText)) return true;
    // Conversational action phrases ("let me check...") only count as a routing
    // failure when the RESPONSE is a short promise with no delivered answer.
    // Long answers that mention tool work are real prose. The prompt is
    // excluded on purpose: instructions containing "let me read X" must not
    // trigger a retry against a complete response.
    if (/\b(?:let me|i(?:'ll| will)|now i(?:'ll| will)|first i(?:'ll| will))\b[\s\S]{0,180}\b(?:read|check|inspect|open|edit|apply|write|patch|run|execute|ask|try|verify|search|grep)\b/.test(contentText)) {
        const substantive = content.replace(/```[\s\S]*?```/g, '').trim();
        return substantive.length < 120;
    }
    return false;
}

/** Detect concluding/summarizing responses that may unintentionally end the turn. */
function looksLikeConclusion(content: string): boolean {
    const lower = content.toLowerCase();
    // Only check the last ~15% of content (the tail), not the last 25%.
    // This prevents mid-response TODO lists and status tables from triggering.
    const tailLen = Math.max(200, Math.floor(content.length * 0.15));
    const tail = content.length > tailLen ? content.slice(-tailLen) : content;
    // Summary table with status indicators — only in the actual tail
    if (/\|.*\|.*\|/.test(tail) && /\b(done|complete|result|status|step|check)\b/i.test(tail)) return true;
    // Conclusion language without continuation signals
    if (/\b(done|complete|finished|all set|wrapped up|that's it|wraps it up|let's wrap up)\b/i.test(lower) &&
        !/\b(continue|next|further|more|also|additionally|shall we|want to|would you)\b/i.test(lower)) return true;
    // Checkmark + completion word — only in the tail, not the full content
    if (/(✅|✔️|☑️|✓)\s*(done|complete|finished|ready|clean|solid)/i.test(tail)) return true;
    return false;
}

/**
 * Detect responses that ask a question THEN wrap up, as opposed to ending
 * naturally with a question (which IS flow and should not trigger a whisper).
 *
 * Finds the LAST question marker (? / ？ / Chinese particle) in prose
 * (code blocks, URLs, math stripped), then checks the text AFTER it.
 *
 * Returns true only when the text after the last question marker contains
 * wrap-up signals (conclusion markers, status tables, checkmarks).
 * Returns false when:
 *   - No question marker found
 *   - Text after question marker is empty/whitespace (natural question ending = flow)
 *   - Text after is substantive (still flowing)
 */
function endsWithClosingQuestion(content: string): boolean {
    if (!content || !content.trim()) return false;

    // Strip structured content that may contain ? or ？ as syntax, not prose
    const prose = content
        .replace(/```[\s\S]*?(```|$)/g, ' ')   // fenced code (including unclosed)
        .replace(/~~~[\s\S]*?(~~~|$)/g, ' ')   // tilde-fenced code
        .replace(/`[^`]*`/g, ' ')               // inline code
        .replace(/https?:\/\/[^\s]+/g, ' ')     // URLs with query strings
        .replace(/\$\$[\s\S]*?\$\$/g, ' ')     // block math
        .replace(/\$[^$]*\$/g, ' ')             // inline math
        .trim();

    if (!prose) return false;

    // Find the LAST question marker in the prose text.
    // Check: English ?, Chinese ？, Chinese 吗, and 么 (excluding 什么/怎么/为什么 etc.)
    // We scan for marker positions and take the highest.
    const qPos = prose.lastIndexOf('?');
    const fwqPos = prose.lastIndexOf('？');
    // For Chinese particles, find their word-boundary positions
    const maMatch = prose.match(/吗\s*$/m);  // 吗 at/near sentence end
    const meMatch = prose.match(/(?<![什怎为多要甚])么\s*$/m); // 么 excluding compounds

    const particlePos = Math.max(
        maMatch ? (maMatch.index ?? -1) : -1,
        meMatch ? (meMatch.index ?? -1) : -1
    );

    const lastMarkerPos = Math.max(qPos, fwqPos, particlePos);
    if (lastMarkerPos === -1) return false;

    // Get the text AFTER the last question marker
    const afterQuestion = prose.slice(lastMarkerPos + 1).trim();
    // A question with nothing after it IS the ending — fire flow-state.
    // (Previously returned false here, which let bare questions slip through.)
    if (!afterQuestion) return true;

    // Combined paragraph-count + short-remainder check (validated 10/10).
    // Fires flow-state when the last ? is within the last 3 paragraphs AND
    // the remaining text is short (< 50 chars) or only emojis/signoffs.
    // Catches "Want me to apply the fix? 👍" while correctly skipping
    // "Does this work? Let me elaborate: X, Y, Z..." (genuine flow).
    const paragraphs = prose.split('\n\n');
    const lastQParagraphIndex = prose.slice(0, lastMarkerPos).split('\n\n').length - 1;
    const paragraphsAfter = paragraphs.length - 1 - lastQParagraphIndex;

    if (paragraphsAfter < 3 && afterQuestion.length < 50) return true;
    if (paragraphsAfter < 3 && /^[\s.,!?✨\-–—👍😊]+$/.test(afterQuestion)) return true;

    // Check for wrap-up signals after the question
    const wrapUpPattern = /\b(here'?s? a summary|in summary|in conclusion|to summarize|hope this helps|let me know|let me summarize|the bottom line|all set|we'?re done|that'?s it|wraps it up|hope that|overall,|in short|long story short|to recap|to wrap up|as always|feel free to|any questions|thanks for|thank you|happy coding|enjoy|cheers|good luck)\b/i;
    if (wrapUpPattern.test(afterQuestion)) return true;

    // Check for tables with status indicators after the question
    if (/\|.*\|.*\|/.test(afterQuestion) && /\b(done|complete|result|status|step|check)\b/i.test(afterQuestion)) return true;

    // Check for checkmark + completion after the question
    if (/(✅|✔️|☑️|✓)\s*(done|complete|finished|ready|clean|solid)/i.test(afterQuestion)) return true;

    return false;
}

type FlowStateViolation = 'chat.flowStateWhisper' | 'chat.flowStateQuestionWhisper' | 'chat.flowStateToolProseWhisper';

/**
 * Detect tool names mentioned in prose (outside code blocks) that were not
 * accompanied by actual tool calls. Catches common patterns like:
 * "Let me read that file" without calling harmony_read_file.
 * Returns the first unmatched tool name, or null.
 */
function detectToolNameInProse(content: string): string | null {
    // Strip code blocks — tool names inside code are intentional, not prose-violations
    const prose = content.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
    const mentions = prose.match(/\b(harmony_[a-z_]+)\b/g);
    if (!mentions || mentions.length === 0) return null;
    // Heuristic: if the response is long (>800 chars) or contains multiple
    // tool mentions, the model is likely summarizing work it already did,
    // not promising to use tools. Skip the violation.
    // Short responses with a single tool mention are more suspicious.
    if (mentions.length >= 3 || content.length > 1200) return null;
    return mentions[0];
}

/**
 * Determine which flow-state violation occurred so we can deliver a specific
 * whisper rather than a generic one.
 *
 * Priority order:
 * 1. Tool-prose — model mentioned a tool name without calling it
 * 2. Question-ending — specific actionable feedback beats generic
 * 3. Conclusion — summary tables, wrap-up language
 *
 * IMPORTANT: When called from the tool-call path (post-tool-check), the
 * tool-prose check should be skipped because the model DID call tools.
 * Use getFlowStateViolationPostTool() for that path instead.
 */
function getFlowStateViolation(content?: string): FlowStateViolation | null {
    if (!content) return null;
    // Tool-prose: model mentioned a harmony_ tool without calling it
    if (detectToolNameInProse(content)) return 'chat.flowStateToolProseWhisper';
    // Check bare question — specific feedback beats generic
    if (endsWithClosingQuestion(content)) return 'chat.flowStateQuestionWhisper';
    // Check conclusion signals
    if (looksLikeConclusion(content)) return 'chat.flowStateWhisper';
    return null;
}

/**
 * Post-tool-call flow-state check. Skips tool-prose detection because the
 * model already made tool calls — mentioning tool names in the summary is
 * expected and normal, not a violation.
 */
function getFlowStateViolationPostTool(content?: string): FlowStateViolation | null {
    if (!content) return null;
    // Skip tool-prose — the model already called tools
    if (endsWithClosingQuestion(content)) return 'chat.flowStateQuestionWhisper';
    if (looksLikeConclusion(content)) return 'chat.flowStateWhisper';
    return null;
}

function toolRoutingFailureMessage(model: string, toolNames: readonly string[]): string {
    const lm = LanguageManager.getInstance();
    const preview = toolNames.slice(0, 8);
    const rest = toolNames.length > 8 ? ` ...and ${toolNames.length - 8} more` : '';
    const template = lm.getString('chat.toolRoutingFailed');
    return template
        .replace('{model}', model)
        .replace('{count}', String(toolNames.length))
        .replace('{preview}', preview.join(', '))
        .replace('{rest}', rest);
}

function deepSeekHistoryLimits(): { maxMessages: number; maxChars: number } {
    const cfg = vscode.workspace.getConfiguration('harmony');
    return {
        maxMessages: Math.max(0, cfg.get<number>('deepseekMaxHistoryMessages') ?? 40),
        maxChars: Math.max(0, cfg.get<number>('deepseekMaxHistoryChars') ?? 60000),
    };
}

function deepSeekMessageSize(message: DeepSeekMessage): number {
    return (message.content?.length ?? 0)
        + (message.reasoning_content?.length ?? 0)
        + (message.tool_calls ? JSON.stringify(message.tool_calls).length : 0);
}

// Stable-prefix anchor: the first N history turns are always kept, so the
// message prefix (system + head) is deterministic across turns and stays in
// DeepSeek's context cache. The tail carries recent state; the middle is dropped.
const DEEPSEEK_HEAD_MESSAGES = 2;

function trimDeepSeekHistoryMessages(historyMessages: DeepSeekMessage[]): DeepSeekMessage[] {
    const limits = deepSeekHistoryLimits();
    if (limits.maxMessages <= 0 || limits.maxChars <= 0) {
        debugLog(`[DeepSeek History] replayed=0/${historyMessages.length} maxMessages=${limits.maxMessages} maxChars=${limits.maxChars} (disabled)`);
        return [];
    }
    if (historyMessages.length === 0) {
        return [];
    }

    // "Truncate from the middle": keep a fixed head (stable cache prefix) plus
    // the most recent tail, dropping the middle turns.
    const headCount = Math.min(DEEPSEEK_HEAD_MESSAGES, historyMessages.length, limits.maxMessages);
    const head = historyMessages.slice(0, headCount);
    let headChars = 0;
    for (const message of head) headChars += deepSeekMessageSize(message);

    const tailSource = historyMessages.slice(headCount);
    const tailMessageBudget = Math.max(0, limits.maxMessages - headCount);
    const tailCharBudget = Math.max(0, limits.maxChars - headChars);

    const tail: DeepSeekMessage[] = [];
    let tailChars = 0;
    for (let index = tailSource.length - 1; index >= 0; index--) {
        const message = tailSource[index];
        const size = deepSeekMessageSize(message);
        if (tail.length >= tailMessageBudget) break;
        if (tail.length > 0 && tailChars + size > tailCharBudget) break;
        tail.unshift(message);
        tailChars += size;
    }

    const kept = [...head, ...tail];
    debugLog(`[DeepSeek History] replayed=${kept.length}/${historyMessages.length} head=${head.length} tail=${tail.length} chars=${headChars + tailChars} maxMessages=${limits.maxMessages} maxChars=${limits.maxChars}`);
    return kept;
}

/**
 * Sanitize an HTTP error response body for display.
 * Returns a concise, human-readable message even when the server returns
 * an HTML error page (e.g. 502 Bad Gateway from a reverse proxy).
 */
function sanitizeHttpError(status: number, body: string, label: string): string {
    const trimmed = body.trim();
    // Detect HTML responses (reverse proxy errors, maintenance pages, etc.)
    if (trimmed.startsWith('<') || /^<!doctype/i.test(trimmed)) {
        // Try to extract the <title> tag for a cleaner message
        const titleMatch = trimmed.match(/<title>[^<]*<\/title>/i);
        const title = titleMatch ? titleMatch[0].replace(/<\/?title>/gi, '').trim() : '';
        return `${label} HTTP ${status}: ${title || 'Server returned an HTML error page (likely a gateway/proxy issue). Retry in a moment.'}`;
    }
    // For JSON or plain-text errors, keep the existing behavior but cap at 500 chars
    return `${label} HTTP ${status}: ${trimmed.slice(0, 500)}`;
}

async function callDeepSeek(apiKey: string, body: unknown, token: vscode.CancellationToken): Promise<any> {
    const cfg = vscode.workspace.getConfiguration('harmony');
    const baseUrl = (cfg.get<string>('deepseekBaseUrl') ?? 'https://api.deepseek.com/v1').replace(/\/$/, '');
    const controller = new AbortController();
    const cancelSub = token.onCancellationRequested(() => controller.abort());
    try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(body),
            signal: controller.signal as any
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(sanitizeHttpError(response.status, text, 'DeepSeek'));
        }
        return JSON.parse(text);
    } finally {
        cancelSub.dispose();
    }
}

async function callDeepSeekStreaming(
    route: DirectPrimaryRoute,
    apiKey: string,
    body: any,
    token: vscode.CancellationToken,
    onDelta: (delta: { content?: string; reasoning?: string; toolCalls?: any[] }) => void
): Promise<{ content: string; reasoning: string; toolCalls: DeepSeekToolCall[]; usage?: { promptTokens?: number; completionTokens?: number }; durationMs: number }> {
    const cfg = vscode.workspace.getConfiguration('harmony');
    const baseUrl = route.baseUrl;
    const controller = new AbortController();
    const cancelSub = token.onCancellationRequested(() => controller.abort());
    const startedAt = Date.now();

    if (vscode.workspace.getConfiguration('harmony').get<boolean>('enableDebugLogging') !== false) {
         harmonyDebugChannel.appendLine(`\n[${route.label} Direct API] Fetching ${baseUrl}/chat/completions ...`);
    }

    const accumulated = { content: '', reasoning: '' };
    const toolCallsByIndex: Map<number, any> = new Map();
    let usage: { promptTokens?: number; completionTokens?: number } | undefined;

    try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Accept': 'text/event-stream'
            },
            body: JSON.stringify({ ...body, stream: true }),
            signal: controller.signal as any
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(sanitizeHttpError(response.status, text, route.label));
        }
        if (!response.body) throw new Error(`${route.label} returned no body.`);

        const reader = (response.body as any).getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
            if (token.isCancellationRequested) break;
            const { value, done } = await withStreamIdleTimeout(reader.read(), () => controller.abort());
            if (done) break;
            const chunkText = decoder.decode(value, { stream: true });
            if (cfg.get<boolean>('logRawStream')) {
                debugAppend(chunkText);
            }
            buffer += chunkText;

            let lineEnd: number;
            while ((lineEnd = buffer.indexOf('\n')) >= 0) {
                const rawLine = buffer.slice(0, lineEnd).trim();
                buffer = buffer.slice(lineEnd + 1);
                if (!rawLine || !rawLine.startsWith('data:')) continue;
                const data = rawLine.slice(5).trim();
                if (data === '[DONE]') continue;
                let parsed: any;
                try {
                    parsed = JSON.parse(data);
                } catch (error: any) {
                    debugLog(`[${route.label} Stream] SSE JSON parse skipped: ${error?.message ?? String(error)} | ${data.slice(0, 300)}`);
                    continue;
                }

                if (parsed?.usage) {
                    usage = {
                        promptTokens: parsed.usage.prompt_tokens,
                        completionTokens: parsed.usage.completion_tokens
                    };
                }

                const choice = parsed?.choices?.[0];
                const delta = choice?.delta;

                // ── Gemini thought_signature capture (multi-location) ──────────
                // Gemini 3 thinking models attach an encrypted thought_signature
                // to functionCall parts and REQUIRES it on the next request's
                // assistant tool_calls. The OpenAI-compat endpoint may surface
                // it at several locations depending on model/endpoint version:
                //   1. Inside each tool_call delta:  delta.tool_calls[].thought_signature
                //   2. On the delta itself:          delta.thought_signature
                //   3. On the choice/finish level:    choice.thought_signature
                //   4. On the full message:           choice.message.thought_signature
                // We check ALL of these so we never miss the field.
                if (route.provider === 'gemini') {
                    const choiceSig = (choice as any)?.thought_signature
                        ?? (choice as any)?.thoughtSignature
                        ?? (choice?.message as any)?.thought_signature
                        ?? (choice?.message as any)?.thoughtSignature;
                    const deltaSig = delta?.thought_signature ?? delta?.thoughtSignature;

                    // If a signature arrives at the choice/delta/message level
                    // (not inside a specific tool_call), attach it to the most
                    // recently created tool_call at index 0 (the common case).
                    if ((choiceSig || deltaSig) && toolCallsByIndex.size > 0) {
                        const first = toolCallsByIndex.get(0);
                        if (first && !first.thought_signature) {
                            first.thought_signature = choiceSig || deltaSig;
                            debugLog(`[Gemini Stream] captured thought_signature at ${choiceSig ? 'choice' : 'delta'} level for tool_call[0]`);
                        }
                    }
                }

                if (!delta) continue;

                if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                    accumulated.reasoning += delta.reasoning_content;
                    onDelta({ reasoning: delta.reasoning_content });
                }
                if (typeof delta.content === 'string' && delta.content) {
                    accumulated.content += delta.content;
                    onDelta({ content: delta.content });
                }
                if (Array.isArray(delta.tool_calls)) {
                    for (const tc of delta.tool_calls) {
                        const idx = tc.index ?? 0;
                        let existing = toolCallsByIndex.get(idx);
                        if (!existing) {
                            existing = { id: tc.id ?? '', type: 'function', function: { name: '', arguments: '' } };
                            toolCallsByIndex.set(idx, existing);
                        }
                        if (tc.id) {
                            if (existing.id && existing.id !== tc.id) {
                                debugLog(`[DeepSeek Stream] tool_call id changed at index ${idx}: ${existing.id} -> ${tc.id}`);
                            }
                            existing.id = tc.id;
                        }
                        if (tc.function?.name) existing.function.name += tc.function.name;
                        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
                        // Gemini thinking models attach thought_signature to
                        // functionCall parts; preserve it so the assistant
                        // tool_calls echo-back includes it (missing → HTTP 400).
                        // Check all known field name variants.
                        const thoughtSig = tc.thought_signature
                            ?? tc.thoughtSignature
                            ?? tc.signature;
                        if (thoughtSig) {
                            existing.thought_signature = thoughtSig;
                            debugLog(`[Gemini Stream] captured thought_signature inside tool_call[${idx}]`);
                        }
                    }
                }
            }
        }
    } finally {
        cancelSub.dispose();
    }

    const toolCalls = Array.from(toolCallsByIndex.values()) as DeepSeekToolCall[];
    if (toolCalls.length > 0) {
        debugLog(`[${route.label} Stream] parsed tool calls: ${safeJson(toolCalls.map(call => ({ id: call.id, name: call.function?.name, argumentChars: call.function?.arguments?.length ?? 0 })))}`);
    }

    return {
        content: accumulated.content,
        reasoning: accumulated.reasoning,
        toolCalls,
        usage,
        durationMs: Date.now() - startedAt
    };
}

/**
 * Enforce strict user/tool ↔ assistant alternation for Tencent Hunyuan.
 * - Side A: user/tool messages
 * - Side B: assistant messages
 * - Consecutive tool messages are allowed (safeMultiTool)
 * - Leading tool messages (no prior assistant) are dropped
 * - Trailing assistant gets a dummy user/tool appended
 */
interface _Message {
    role: 'user' | 'assistant' | 'tool';
    content?: string | any[];
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
    name?: string;
}

function sanitizeMessagesForTencent(messages: _Message[]): _Message[] {
    if (!messages?.length) return [];

    // Remove leading tool messages with no prior assistant context
    let startIdx = 0;
    while (startIdx < messages.length && messages[startIdx].role === 'tool') startIdx++;
    messages = messages.slice(startIdx);
    if (!messages.length) return [{ role: 'user', content: 'Hello' }];

    const result: _Message[] = [];

    // Seed: prepend user if first message is assistant
    if (messages[0].role === 'assistant') {
        result.push({ role: 'user', content: ' ' });
    }
    result.push(structuredClone(messages[0]));

    // Track expected next side (A = user/tool, B = assistant)
    let expectedSide: 'A' | 'B' = result[result.length - 1].role === 'assistant' ? 'A' : 'B';

    for (let i = 1; i < messages.length; i++) {
        const current = messages[i];
        const currentSide: 'A' | 'B' = current.role === 'assistant' ? 'B' : 'A';
        // Consecutive tool messages are allowed (safeMultiTool)
        const safeMultiTool = result[result.length - 1].role === 'tool' && current.role === 'tool';

        if (currentSide === expectedSide || safeMultiTool) {
            result.push(structuredClone(current));
            // Don't advance expectedSide on repeated tool messages
            if (!safeMultiTool) {
                expectedSide = currentSide === 'A' ? 'B' : 'A';
            }
        } else {
            // Merge into last message of same side
            result[result.length - 1] = mergeMessages(result[result.length - 1], current);
        }
    }

    // Enforce trailing user/tool
    if (result.length > 0 && result[result.length - 1].role === 'assistant') {
        result.push({ role: 'user', content: ' ' });
    }

    return result;
}

function mergeMessages(base: _Message, additional: _Message): _Message {
    const merged = structuredClone(base);

    // Safely handle string vs array/object content
    const baseContent = typeof base.content === 'string' ? base.content : '';
    const addContent = typeof additional.content === 'string' ? additional.content : '';

    if (baseContent && addContent) {
        merged.content = baseContent + '\n\n' + addContent;
    } else if (addContent) {
        merged.content = addContent;
    }

    // Preserve tool calls
    if (base.tool_calls && additional.tool_calls) {
        merged.tool_calls = [...base.tool_calls, ...additional.tool_calls];
    } else if (additional.tool_calls) {
        merged.tool_calls = additional.tool_calls;
    }

    // Preserve additional metadata
    if (additional.tool_call_id && !merged.tool_call_id) merged.tool_call_id = additional.tool_call_id;
    if (additional.name && !merged.name) merged.name = additional.name;

    return merged;
}

/**
 * Call Tencent Hunyuan via native Cloud API v3 (TC3-HMAC-SHA256 signing).
 * Used when the user has SecretId + SecretKey but no OpenAI-compatible API key.
 * Converts OpenAI-format request body to Tencent native format, streams SSE response.
 */
async function callTencentNativeStreaming(
    route: DirectPrimaryRoute,
    nativeCreds: { secretId: string; secretKey: string },
    body: any,
    token: vscode.CancellationToken,
    onDelta: (delta: { content?: string; reasoning?: string; toolCalls?: any[] }) => void
): Promise<{ content: string; reasoning: string; toolCalls: DeepSeekToolCall[]; usage?: { promptTokens?: number; completionTokens?: number }; durationMs: number }> {
    const controller = new AbortController();
    const cancelSub = token.onCancellationRequested(() => controller.abort());
    const startedAt = Date.now();

    // Sanitize messages for Tencent's strict alternation requirements.
    // System messages are exempt from alternation — extract, sanitize the rest, then prepend.
    let systemContent = '';
    if (Array.isArray(body.messages)) {
        const systemMsgs = body.messages.filter((m: any) => m.role === 'system');
        const nonSystemMsgs = body.messages.filter((m: any) => m.role !== 'system');
        if (systemMsgs.length > 0) {
            systemContent = systemMsgs.map((m: any) => typeof m.content === 'string' ? m.content : '').filter(Boolean).join('\n\n');
        }
        body.messages = sanitizeMessagesForTencent(nonSystemMsgs);
        if (systemContent) {
            body.messages.unshift({ role: 'system', content: systemContent });
        }
    }

    // Convert OpenAI messages to Tencent native format (PascalCase).
    // Tool role stays as Tool — Tencent allows consecutive tool messages.
    const tencentMessages: any[] = [];
    if (Array.isArray(body.messages)) {
        for (const msg of body.messages) {
            if (msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool') {
                let content = msg.content ?? '';
                if (Array.isArray(content)) {
                    content = content
                        .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
                        .map((part: any) => part.text)
                        .join('');
                }
                const tencentRole = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
                const tencentMsg: any = { Role: tencentRole, Content: content };
                // Preserve tool calls on assistant messages (Tencent native PascalCase)
                if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                    tencentMsg.ToolCalls = msg.tool_calls.map((tc: any) => ({
                        Id: tc.id ?? '',
                        Type: tc.type ?? 'function',
                        Function: {
                            Name: tc.function?.name ?? '',
                            Arguments: tc.function?.arguments ?? ''
                        }
                    }));
                }
                // Preserve tool_call_id on tool result messages
                if (msg.role === 'tool' && msg.tool_call_id) {
                    tencentMsg.ToolCallId = msg.tool_call_id;
                }
                tencentMessages.push(tencentMsg);
            }
        }
    }

    // Convert OpenAI tools to Tencent native format
    const tencentTools: any[] | undefined = Array.isArray(body.tools) && body.tools.length > 0
        ? body.tools.map((t: any) => ({
            Type: 'function',
            Function: {
                Name: t.function?.name ?? 'unknown',
                Description: t.function?.description ?? '',
                Parameters: JSON.stringify(t.function?.parameters ?? { type: 'object', properties: {} })
            }
        }))
        : undefined;

    const payload: any = {
        Model: body.model,
        Messages: tencentMessages,
        Stream: true
    };
    if (tencentTools && tencentTools.length > 0) {
        payload.Tools = tencentTools;
        payload.ToolChoice = 'auto';
    }

    const payloadStr = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const { headers } = tencentSignV3(nativeCreds.secretId, nativeCreds.secretKey, payloadStr, timestamp);

    const url = `https://${TENCENT_NATIVE_HOST}/`;
    if (vscode.workspace.getConfiguration('harmony').get<boolean>('enableDebugLogging') !== false) {
        harmonyDebugChannel.appendLine(`\n[${route.label} Native API] Fetching ${url} ...`);
    }

    const accumulated = { content: '', reasoning: '' };
    const toolCallsByIndex: Map<number, any> = new Map();
    let usage: { promptTokens?: number; completionTokens?: number } | undefined;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: payloadStr,
            signal: controller.signal as any
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(sanitizeHttpError(response.status, text, route.label));
        }
        if (!response.body) throw new Error(`${route.label} returned no body.`);

        const reader = (response.body as any).getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
            if (token.isCancellationRequested) break;
            const { value, done } = await withStreamIdleTimeout(reader.read(), () => controller.abort());
            if (done) break;
            const chunkText = decoder.decode(value, { stream: true });
            if (vscode.workspace.getConfiguration('harmony').get<boolean>('logRawStream')) {
                debugAppend(chunkText);
            }
            buffer += chunkText;

            let lineEnd: number;
            while ((lineEnd = buffer.indexOf('\n')) >= 0) {
                const rawLine = buffer.slice(0, lineEnd).trim();
                buffer = buffer.slice(lineEnd + 1);
                if (!rawLine || !rawLine.startsWith('data:')) continue;
                const data = rawLine.slice(5).trim();
                if (data === '[DONE]') continue;
                let parsed: any;
                try {
                    parsed = JSON.parse(data);
                } catch {
                    continue;
                }

                // Check for Tencent error in response
                const tencentError = parsed?.Response?.Error ?? parsed?.error;
                if (tencentError) {
                    const errMsg = tencentError.Message ?? tencentError.message ?? 'Unknown Tencent API error';
                    const errCode = tencentError.Code ?? tencentError.code ?? 'unknown';
                    throw new Error(`${route.label} API error (${errCode}): ${errMsg}`);
                }

                // Tencent native response: Response.Choices[0].Delta.Content
                // Also handle OpenAI-compatible format as fallback
                const delta = parsed?.Response?.Choices?.[0]?.Delta
                    ?? parsed?.Choices?.[0]?.Delta
                    ?? parsed?.choices?.[0]?.delta;
                if (!delta) continue;

                if (typeof delta.Content === 'string' && delta.Content) {
                    accumulated.content += delta.Content;
                    onDelta({ content: delta.Content });
                } else if (typeof delta.content === 'string' && delta.content) {
                    accumulated.content += delta.content;
                    onDelta({ content: delta.content });
                }

                // Tool calls (Tencent native format)
                const tcArray = delta.Tools ?? delta.tool_calls;
                if (Array.isArray(tcArray)) {
                    for (const tc of tcArray) {
                        const idx = tc.Index ?? tc.index ?? 0;
                        let existing = toolCallsByIndex.get(idx);
                        if (!existing) {
                            existing = { id: tc.Id ?? tc.id ?? '', type: 'function', function: { name: '', arguments: '' } };
                            toolCallsByIndex.set(idx, existing);
                        }
                        if (tc.Id) existing.id = tc.Id;
                        if (tc.id) existing.id = tc.id;
                        const fn = tc.Function ?? tc.function;
                        if (fn?.Name) existing.function.name += fn.Name;
                        if (fn?.name) existing.function.name += fn.name;
                        if (fn?.Arguments) existing.function.arguments += fn.Arguments;
                        if (fn?.arguments) existing.function.arguments += fn.arguments;
                    }
                }

                // Usage
                const u = parsed?.Response?.Usage ?? parsed?.Usage ?? parsed?.usage;
                if (u) {
                    usage = {
                        promptTokens: u.PromptTokens ?? u.prompt_tokens ?? u.InputTokens ?? 0,
                        completionTokens: u.CompletionTokens ?? u.completion_tokens ?? u.OutputTokens ?? 0
                    };
                }
            }
        }
    } finally {
        cancelSub.dispose();
    }

    const toolCalls = Array.from(toolCallsByIndex.values()) as DeepSeekToolCall[];
    if (toolCalls.length > 0) {
        debugLog(`[${route.label} Native Stream] parsed tool calls: ${safeJson(toolCalls.map(call => ({ id: call.id, name: call.function?.name, argumentChars: call.function?.arguments?.length ?? 0 })))}`);
    }

    // If streaming returned nothing, retry with Stream: false (non-streaming fallback)
    if (!accumulated.content && toolCalls.length === 0) {
        debugLog(`[${route.label} Native Stream] Empty streaming response — retrying with Stream: false (non-streaming fallback)`);
        const nonStreamPayload = { ...payload, Stream: false };
        const nonStreamPayloadStr = JSON.stringify(nonStreamPayload);
        const nsTimestamp = Math.floor(Date.now() / 1000);
        const { headers: nsHeaders } = tencentSignV3(nativeCreds.secretId, nativeCreds.secretKey, nonStreamPayloadStr, nsTimestamp);

        const nsResponse = await fetch(url, {
            method: 'POST',
            headers: nsHeaders,
            body: nonStreamPayloadStr,
            signal: controller.signal as any
        });
        if (!nsResponse.ok) {
            const text = await nsResponse.text();
            throw new Error(sanitizeHttpError(nsResponse.status, text, route.label));
        }
        const nsText = await nsResponse.text();
        debugLog(`[${route.label} Native Non-Stream] Response length: ${nsText.length}`);
        let nsParsed: any;
        try {
            nsParsed = JSON.parse(nsText);
        } catch {
            debugLog(`[${route.label} Native Non-Stream] Failed to parse response as JSON: ${nsText.slice(0, 500)}`);
        }
        if (nsParsed) {
            // Check for error
            const nsError = nsParsed?.Response?.Error ?? nsParsed?.error;
            if (nsError) {
                const errMsg = nsError.Message ?? nsError.message ?? 'Unknown Tencent API error';
                const errCode = nsError.Code ?? nsError.code ?? 'unknown';
                throw new Error(`${route.label} API error (${errCode}): ${errMsg}`);
            }
            // Extract content
            const nsDelta = nsParsed?.Response?.Choices?.[0]?.Delta
                ?? nsParsed?.Response?.Choices?.[0]?.Message
                ?? nsParsed?.Choices?.[0]?.Message
                ?? nsParsed?.Choices?.[0]?.delta
                ?? nsParsed?.choices?.[0]?.message;
            if (nsDelta) {
                const nsContent = nsDelta.Content ?? nsDelta.content ?? '';
                if (typeof nsContent === 'string' && nsContent) {
                    accumulated.content = nsContent;
                    onDelta({ content: nsContent });
                }
                // Tool calls
                const nsTcArray = nsDelta.Tools ?? nsDelta.tool_calls;
                if (Array.isArray(nsTcArray)) {
                    for (const tc of nsTcArray) {
                        const idx = tc.Index ?? tc.index ?? 0;
                        let existing = toolCallsByIndex.get(idx);
                        if (!existing) {
                            existing = { id: tc.Id ?? tc.id ?? '', type: 'function', function: { name: '', arguments: '' } };
                            toolCallsByIndex.set(idx, existing);
                        }
                        if (tc.Id) existing.id = tc.Id;
                        if (tc.id) existing.id = tc.id;
                        const fn = tc.Function ?? tc.function;
                        if (fn?.Name) existing.function.name += fn.Name;
                        if (fn?.name) existing.function.name += fn.name;
                        if (fn?.Arguments) existing.function.arguments += fn.Arguments;
                        if (fn?.arguments) existing.function.arguments += fn.arguments;
                    }
                }
            }
            // Usage
            const nsU = nsParsed?.Response?.Usage ?? nsParsed?.Usage ?? nsParsed?.usage;
            if (nsU) {
                usage = {
                    promptTokens: nsU.PromptTokens ?? nsU.prompt_tokens ?? nsU.InputTokens ?? 0,
                    completionTokens: nsU.CompletionTokens ?? nsU.completion_tokens ?? nsU.OutputTokens ?? 0
                };
            }
        }
    }

    const finalToolCalls = Array.from(toolCallsByIndex.values()) as DeepSeekToolCall[];
    if (finalToolCalls.length > 0) {
        debugLog(`[${route.label} Native Stream] parsed tool calls: ${safeJson(finalToolCalls.map(call => ({ id: call.id, name: call.function?.name, argumentChars: call.function?.arguments?.length ?? 0 })))}`);
    }

    if (!accumulated.content && finalToolCalls.length === 0) {
        debugLog(`[${route.label} Native Stream] WARNING: no content and no tool calls received even after non-streaming fallback.`);
    }

    return {
        content: accumulated.content,
        reasoning: accumulated.reasoning,
        toolCalls: finalToolCalls,
        usage,
        durationMs: Date.now() - startedAt
    };
}

/**
 * Call Anthropic's Messages API with streaming.
 * Converts the OpenAI-format request body to Anthropic's format.
 */
async function callAnthropicStreaming(
    route: DirectPrimaryRoute,
    apiKey: string,
    body: any,
    token: vscode.CancellationToken,
    onDelta: (delta: { content?: string; reasoning?: string; toolCalls?: any[] }) => void
): Promise<{ content: string; reasoning: string; toolCalls: DeepSeekToolCall[]; usage?: { promptTokens?: number; completionTokens?: number }; durationMs: number }> {
    const controller = new AbortController();
    const cancelSub = token.onCancellationRequested(() => controller.abort());
    const startedAt = Date.now();

    // Convert OpenAI messages to Anthropic format
    let systemPrompt: string | undefined;
    const anthropicMessages: { role: 'user' | 'assistant'; content: string }[] = [];
    if (Array.isArray(body.messages)) {
        for (const msg of body.messages) {
            if (msg.role === 'system') {
                systemPrompt = (systemPrompt ?? '') + (msg.content ?? '');
            } else if (msg.role === 'user' || msg.role === 'assistant') {
                anthropicMessages.push({ role: msg.role, content: msg.content ?? '' });
            }
        }
    }

    // Convert OpenAI tools to Anthropic format
    const anthropicTools: any[] | undefined = Array.isArray(body.tools) && body.tools.length > 0
        ? body.tools.map((t: any) => ({
            name: t.function?.name ?? 'unknown',
            description: t.function?.description ?? '',
            input_schema: t.function?.parameters ?? { type: 'object', properties: {} }
        }))
        : undefined;

    const anthropicBody: any = {
        model: body.model,
        max_tokens: 8192,
        messages: anthropicMessages,
        stream: true
    };
    if (systemPrompt?.trim()) anthropicBody.system = systemPrompt.trim();
    if (anthropicTools && anthropicTools.length > 0) anthropicBody.tools = anthropicTools;

    const accumulated = { content: '', reasoning: '' };
    const toolCallsByIndex: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let currentBlockIndex = -1;
    let currentBlockType = '';
    let usage: { promptTokens?: number; completionTokens?: number } | undefined;

    try {
        const response = await fetch(`${route.baseUrl}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(anthropicBody),
            signal: controller.signal as any
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(sanitizeHttpError(response.status, text, 'Claude'));
        }
        if (!response.body) throw new Error('Claude returned no body.');

        const reader = (response.body as any).getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
            if (token.isCancellationRequested) break;
            const { value, done } = await withStreamIdleTimeout(reader.read(), () => controller.abort());
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let lineEnd: number;
            while ((lineEnd = buffer.indexOf('\n')) >= 0) {
                const rawLine = buffer.slice(0, lineEnd).trim();
                buffer = buffer.slice(lineEnd + 1);
                if (!rawLine) continue;

                // Parse SSE event lines
                if (rawLine.startsWith('event: ')) {
                    const eventType = rawLine.slice(7).trim();
                    if (eventType === 'content_block_start') currentBlockType = 'start';
                    else if (eventType === 'content_block_delta') currentBlockType = 'delta';
                    else if (eventType === 'content_block_stop') currentBlockType = 'stop';
                    else if (eventType === 'message_start') currentBlockType = 'message_start';
                    else if (eventType === 'message_delta') currentBlockType = 'message_delta';
                    else if (eventType === 'message_stop') currentBlockType = 'message_stop';
                    else currentBlockType = eventType; // ping, error, etc.
                    continue;
                }
                if (!rawLine.startsWith('data: ')) continue;
                const dataStr = rawLine.slice(6).trim();
                if (!dataStr) continue;

                let parsed: any;
                try {
                    parsed = JSON.parse(dataStr);
                } catch { continue; }

                if (currentBlockType === 'message_start') {
                    currentBlockType = '';
                } else if (currentBlockType === 'start') {
                    currentBlockType = '';
                    const block = parsed?.content_block;
                    if (block?.type === 'text') {
                        currentBlockIndex = parsed.index ?? 0;
                        if (block.text) {
                            accumulated.content += block.text;
                            onDelta({ content: block.text });
                        }
                    } else if (block?.type === 'tool_use') {
                        currentBlockIndex = parsed.index ?? 0;
                        const idx = currentBlockIndex;
                        if (!toolCallsByIndex.has(idx)) {
                            toolCallsByIndex.set(idx, { id: block.id ?? '', name: block.name ?? '', arguments: '' });
                        }
                    }
                } else if (currentBlockType === 'delta') {
                    currentBlockType = '';
                    const delta = parsed?.delta;
                    if (delta?.type === 'text_delta' && delta.text) {
                        accumulated.content += delta.text;
                        onDelta({ content: delta.text });
                    } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
                        const idx = parsed.index ?? -1;
                        if (idx >= 0) {
                            const existing = toolCallsByIndex.get(idx);
                            if (existing) {
                                existing.arguments += delta.partial_json;
                            }
                        }
                    }
                } else if (currentBlockType === 'stop' || currentBlockType === 'message_stop') {
                    currentBlockType = '';
                } else if (currentBlockType === 'message_delta') {
                    currentBlockType = '';
                    if (parsed?.usage) {
                        usage = {
                            promptTokens: parsed.usage.input_tokens,
                            completionTokens: parsed.usage.output_tokens
                        };
                    }
                }
                // ping events and unrecognized events are ignored
            }
        }
    } finally {
        cancelSub.dispose();
    }

    const toolCalls: DeepSeekToolCall[] = Array.from(toolCallsByIndex.entries())
        .sort(([a], [b]) => a - b)
        .map(([_, tc]) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments }
        }));

    return {
        content: accumulated.content,
        reasoning: accumulated.reasoning,
        toolCalls,
        usage,
        durationMs: Date.now() - startedAt
    };
}

async function resumedSessionText(context: vscode.ExtensionContext): Promise<string> {
    const name = context.workspaceState.get<string>('harmony.activeSession');
    if (!name) return '';
    const session = await loadSession(name);
    if (!session) {
        await context.workspaceState.update('harmony.activeSession', undefined);
        return '';
    }
    return `\n\nACTIVE RESUMED HARMONY SESSION:\n${formatSessionPreamble(session)}\nUse this as explicit prior conversation context until the user resets or resumes a different session.`;
}

interface AgentRunOutcome {
    result: vscode.ChatResult;
    finalText: string;
}

async function invokeHarmonyToolWithTurnKeepAlive(
    toolName: string,
    input: any,
    toolInvocationToken: any,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.LanguageModelToolResult> {
    const progress = toolName === 'harmony_ask_question'
        ? 'Waiting for your answer...'
        : `Running ${toolName}...`;
    let keepAlive: NodeJS.Timeout | undefined;
    try {
        try { stream.progress(progress); } catch { /* progress is best-effort */ }
        keepAlive = setInterval(() => {
            if (token.isCancellationRequested) {
                if (keepAlive) clearInterval(keepAlive);
                keepAlive = undefined;
                return;
            }
            try { stream.progress(progress); } catch (e) { console.warn('[Harmony] tool progress heartbeat failed', e); }
        }, 10000);

        return await vscode.lm.invokeTool(
            toolName,
            { input, toolInvocationToken },
            token
        );
    } finally {
        if (keepAlive) clearInterval(keepAlive);
    }
}

async function runDeepSeekAgent(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    profile: ProfileDefinition,
    context: vscode.ExtensionContext,
    forceReadOnly: boolean,
    apiKey: string,
    route: DirectPrimaryRoute = directPrimaryRoute('deepseek')
): Promise<AgentRunOutcome> {
    const refs = await resolveReferences(request.references);
    let recallText = "";
    try { const recall = await recallMemory(); recallText = formatRecallForPrompt(recall); } catch (e) { debugLog("[Context Guard] recallMemory failed: " + String((e as any)?.message ?? e)); }
    let sessionText = "";
    try { sessionText = await resumedSessionText(context); } catch (e) { debugLog("[Context Guard] resumedSessionText failed: " + String((e as any)?.message ?? e)); }
    let rulesText = "";
    try { rulesText = await loadRulesContext(); } catch (e) { debugLog("[Context Guard] loadRulesContext failed: " + String((e as any)?.message ?? e)); }
    let continuityText = "";
    try { continuityText = await formatContinuityForPrompt(); } catch (e) { debugLog("[Context Guard] formatContinuityForPrompt failed: " + String((e as any)?.message ?? e)); }
    const builtMessages = await buildDeepSeekMessages(request, chatContext, profile, refs, recallText, sessionText, rulesText, continuityText);
    const messages = route.supportsReasoningContent ? builtMessages : stripReasoningFromDeepSeekMessages(builtMessages);
    const model = route.model;
    const thinkingEnabled = route.thinkingEnabled;
    const showThinking = route.showThinking;
    const limit = resolveAgentStepLimit();
    const tools = await deepSeekTools(forceReadOnly);
    const advertisedToolNames = toolSchemaNames(tools);
    const missingCriticalTools = criticalToolsForMode(forceReadOnly).filter(name => !advertisedToolNames.includes(name));
    if (missingCriticalTools.length > 0) {
        const message = `Harmony tool health check failed before contacting DeepSeek. Missing critical tool(s): ${missingCriticalTools.join(', ')}. Reload this VS Code window and check Output > Harmony Debug.`;
        debugLog(`[Tool Health] ${message}`);
        stream.markdown(message);
        return {
            result: { metadata: { functionCalls: [{ name: 'harmony_tool_health', error: message }] } },
            finalText: message
        };
    }
    let assistantTextSoFar = '';
    let reasoningTextSoFar = '';
    let warnedStepLimit = false;
    let suppressThinkingForTurn = false;
    let toolRoutingRetryUsed = false;
    let flowStateRetries = 0;
    const usageCalls: any[] = [];

    for (let step = 0; step < limit.maxSteps; step++) {
        if (token.isCancellationRequested) break;
        warnedStepLimit = maybeWarnStepLimit(stream, limit, step, warnedStepLimit);

        // Moonshot/Kimi k2.7+ requires temperature=1.0 or omitting it entirely;
        // other providers work fine with 0.2 for deterministic agent behavior.
        const needsStrictTemp = route.provider === 'moonshot' || route.provider === 'kimiCode';
        // Gemini requires thought_signature on replayed tool_calls. Our
        // streaming parser captures them, but as a safety net, sanitize any
        // unsigned tool_calls to text BEFORE sending (prevents HTTP 400).
        const sanitizedMessages = route.provider === 'gemini'
            ? geminiSanitizeMessages(messages)
            : messages;
        const requestBody: any = {
            model,
            messages: sanitizedMessages,
            tools,
            tool_choice: 'auto',
            ...(needsStrictTemp ? {} : { temperature: 0.2 }),
            stream_options: { include_usage: true }
        };
        if (route.supportsReasoningContent && (!thinkingEnabled || suppressThinkingForTurn)) requestBody.thinking = { type: 'disabled' };
        // Gemini 2.5/3 thinking models attach a thought_signature to every
        // functionCall part; the OpenAI-compatible endpoint requires it on
        // multi-turn tool use, so we capture + echo it (see callDeepSeekStreaming
        // and the assistant tool_calls push below). Thinking cannot be disabled
        // on Gemini 3 models, so we minimize it via extra_body.google — the
        // documented nesting for the OpenAI-compat REST endpoint.
        if (route.provider === 'gemini') {
            requestBody.extra_body = {
                google: {
                    thinking_config: {
                        thinking_level: 'minimal'
                    }
                }
            };
        }

        debugLog(`[${route.label} Agent] step=${step + 1}/${limit.maxSteps} model=${model} messages=${messages.length} tools=${advertisedToolNames.length} tool_choice=${requestBody.tool_choice} thinking=${route.supportsReasoningContent ? requestBody.thinking?.type ?? 'enabled' : 'unsupported'}`);

        let bufferedReasoning = '';
        let emittedThinking = false;
        let result: Awaited<ReturnType<typeof callDeepSeekStreaming>>;
        let networkRetried = false;
        const stepTextBefore = assistantTextSoFar;
        const stepReasoningBefore = reasoningTextSoFar;
        const handleDelta = (delta: { content?: string; reasoning?: string; toolCalls?: any[] }) => {
            if (delta.reasoning) {
                bufferedReasoning += delta.reasoning;
            }
            if (delta.content) {
                if (showThinking && !emittedThinking && bufferedReasoning.trim()) {
                    stream.markdown(formatThinkingBlock(bufferedReasoning));
                    emittedThinking = true;
                }
                stream.markdown(delta.content);
            }
        };
        // Dispatch to provider-specific streaming function
        const isTencentNative = !!(route.tencentNativeCreds);
        const callStream = route.provider === 'claude' ? callAnthropicStreaming : callDeepSeekStreaming;
        // Gemini native generateContent path (Phase 2): handles thought_signatures
        // as first-class metadata, eliminating the HTTP 400 errors that plagued
        // the OpenAI-compat endpoint. Falls back to compat on failure.
        const geminiNativePref = vscode.workspace.getConfiguration('harmony').get<string>('gemini.api') ?? 'auto';
        const useGeminiNative = route.provider === 'gemini'
            && shouldUseGeminiNative(model, geminiNativePref);
        try {
            if (useGeminiNative) {
                // ── Gemini native generateContent path ──
                // Pass the UNSANITIZED messages — native handles thought_signatures natively.
                // The sanitizer is only needed for the OpenAI-compat fallback.
                result = await callGeminiNativeStreaming(
                    model,
                    apiKey,
                    messages as OpenAICompatMessage[],
                    tools,
                    token,
                    handleDelta
                );
            } else if (isTencentNative) {
                result = await callTencentNativeStreaming(route, route.tencentNativeCreds!, requestBody, token, handleDelta);
            } else {
                result = await callStream(route, apiKey, requestBody, token, handleDelta);
            }
        } catch (e: any) {
            const message = e?.message ?? String(e);
            // ── Gemini native → compat fallback ──
            // If the native path fails (network, model not found, etc.), fall back
            // to the OpenAI-compat endpoint with the sanitizer safety net.
            if (useGeminiNative && !token.isCancellationRequested && !networkRetried) {
                debugLog(`[Gemini Native → Compat Fallback] native path failed: ${message}. Falling back to OpenAI-compat with sanitizer.`);
                stream.markdown('\n\n> _([Gemini native path unavailable — using compat fallback](debug:gemini-native-fallback))_\n\n');
                networkRetried = true;
                assistantTextSoFar = stepTextBefore;
                reasoningTextSoFar = stepReasoningBefore;
                bufferedReasoning = '';
                emittedThinking = false;
                result = await callStream(route, apiKey, requestBody, token, handleDelta);
            } else if (route.supportsReasoningContent && thinkingEnabled && message.includes('reasoning_content')) {
                suppressThinkingForTurn = true;
                stream.markdown(`\n\n> ${route.label} asked for prior thinking metadata that was not available in this chat history. Retrying this turn with thinking disabled.\n\n`);
                bufferedReasoning = '';
                emittedThinking = false;
                const retryMessages = route.provider === 'gemini'
                    ? geminiSanitizeMessages(messages)
                    : stripReasoningFromDeepSeekMessages(messages);
                const retryBody = {
                    ...requestBody,
                    messages: retryMessages,
                    thinking: { type: 'disabled' }
                };
                if (isTencentNative) {
                    result = await callTencentNativeStreaming(route, route.tencentNativeCreds!, retryBody, token, (delta) => {
                        if (delta.content) { stream.markdown(delta.content); }
                    });
                } else {
                    result = await callStream(route, apiKey, retryBody, token, (delta) => {
                        if (delta.content) { stream.markdown(delta.content); }
                    });
                }
            } else if (!networkRetried && !token.isCancellationRequested && isTransientProviderInterruption(e)) {
                const autoRetry = vscode.workspace.getConfiguration('harmony').get<boolean>('autoRetry') ?? true;
                if (!autoRetry) {
                    stream.markdown('\n\n> _(connection interrupted - auto-retry is off; retry manually or switch providers)_\n\n');
                    throw e;
                }
                networkRetried = true;
                assistantTextSoFar = stepTextBefore;
                reasoningTextSoFar = stepReasoningBefore;
                bufferedReasoning = '';
                emittedThinking = false;
                debugLog(`[${route.label} Agent] transient connection interruption at step=${step + 1}; retrying once: ${describeNetworkError(e)}`);
                stream.markdown('\n\n> _(connection interrupted - retrying once...)_\n\n');
                await sleep(2000);
                if (isTencentNative) {
                    result = await callTencentNativeStreaming(route, route.tencentNativeCreds!, requestBody, token, handleDelta);
                } else {
                    result = await callStream(route, apiKey, requestBody, token, handleDelta);
                }
            } else {
                throw e;
            }
        }

        if (showThinking && !emittedThinking && bufferedReasoning.trim()) {
            stream.markdown(formatThinkingBlock(bufferedReasoning));
            emittedThinking = true;
        }

        recordUsage({
            timestamp: new Date().toISOString(),
            provider: route.provider,
            tier: route.tier,
            model,
            promptTokens: result.usage?.promptTokens ?? 0,
            completionTokens: result.usage?.completionTokens ?? 0,
            durationMs: result.durationMs
        });

        const content = result.content.trim();
        const toolCalls = result.toolCalls;
        assistantTextSoFar += content;
        reasoningTextSoFar += result.reasoning;
        debugLog(`[${route.label} Agent] step=${step + 1} returned contentChars=${content.length} reasoningChars=${result.reasoning.length} toolCalls=${toolCalls.length}`);
        if (toolCalls.length > 0) {
            debugLog(`[${route.label} Agent] parsed tool call summary: ${safeJson(toolCalls.map(call => ({ id: call.id, name: call.function?.name, argumentChars: call.function?.arguments?.length ?? 0 })))}`);
        }

        messages.push({
            role: 'assistant',
            content: content || null,
            reasoning_content: route.supportsReasoningContent && thinkingEnabled && result.reasoning ? result.reasoning : undefined,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined
        });

        if (toolCalls.length === 0) {
            if (toolRoutingFailureLikely(content, request.prompt)) {
                if (!toolRoutingRetryUsed) {
                    const guardEnabled = vscode.workspace.getConfiguration('harmony').get<boolean>('toolRoutingGuard') ?? true;
                    if (!guardEnabled) {
                        debugLog('[Tool Routing] guard disabled by harmony.toolRoutingGuard setting — skipping retry');
                    } else {
                        toolRoutingRetryUsed = true;
                        const retryNote = 'Harmony noticed that the model described tool work but emitted no tool call. Retrying this step once with a stricter tool-routing reminder.';
                        debugLog(`[Tool Routing] ${retryNote}`);
                        stream.markdown(`\n\n> ${retryNote}\n\n`);
                        messages.push({
                            role: 'user',
                            content: 'Harmony orchestration check: your previous response described using tools, but emitted zero tool_calls. If the task requires reading, searching, editing, running, or asking the user, emit the matching Harmony tool call now. If asking the user, call harmony_ask_question with a concrete question and options. Do not describe tool use in prose.'
                        });
                        continue;
                    }
                }

                // Retry exhausted. If the model produced a substantive prose
                // answer (not a bare stub), accept it instead of hard-failing
                // the turn — the user gets their answer, and the recurring
                // "tool routing failed" noise disappears.
                const substantiveProse = content.replace(/```[\s\S]*?```/g, '').trim();
                if (substantiveProse.length >= 40 && !/^\s*file:\s*$/im.test(content)) {
                    debugLog(`[Tool Routing] retry produced substantive prose (${substantiveProse.length} chars) — accepting as text-only response`);
                    if (route.supportsReasoningContent) rememberDeepSeekAssistantTrace(assistantTextSoFar, reasoningTextSoFar);
                    return {
                        result: { metadata: { functionCalls: usageCalls } },
                        finalText: assistantTextSoFar
                    };
                }

                const failure = toolRoutingFailureMessage(model, advertisedToolNames);
                debugLog(`[Tool Routing] ${failure}`);
                stream.markdown(`\n\n**Harmony tool routing failed.**\n\n${failure}`);
                if (route.supportsReasoningContent) rememberDeepSeekAssistantTrace(assistantTextSoFar, reasoningTextSoFar);
                return {
                    result: { metadata: { functionCalls: [...usageCalls, { name: 'harmony_tool_routing', error: failure }] } },
                    finalText: `${assistantTextSoFar}\n\n${failure}`
                };
            }

            // Text-only: fall through to flow-state check below
            // (was: early return that made flow-state unreachable for text-only responses)
        }

        // ── Execute tool calls ──
        // Parallel-safe (pure read/git-read) calls may run concurrently; all
        // other tools run sequentially and flush any pending parallel batch
        // first, preserving write→read ordering within this model turn.
        const parallelBatching = vscode.workspace.getConfiguration('harmony').get<boolean>('parallelToolBatching') ?? true;
        const resolveToolCall = async (call: any): Promise<{ call: any; input: any; resultText?: string; errorText?: string }> => {
            let input: any = {};
            try {
                input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            } catch (e: any) {
                debugLog(`[Tool Invocation] argument parse failed for ${call.function.name || '(missing name)'} (${call.id || 'missing id'}): ${e?.message ?? String(e)} | args=${(call.function.arguments ?? '').slice(0, 500)}`);
                return { call, input, errorText: `tool argument parse error: ${e?.message ?? String(e)}` };
            }
            try {
                debugLog(`[Tool Invocation] starting ${call.function.name} (${call.id || 'missing id'}) input=${safeJson(input).slice(0, 1200)}`);
                const toolResult = await invokeHarmonyToolWithTurnKeepAlive(
                    call.function.name,
                    input,
                    request.toolInvocationToken,
                    stream,
                    token
                );
                const resultText = toolResultToText(toolResult);
                debugLog(`[Tool Invocation] finished ${call.function.name} (${call.id || 'missing id'}) resultChars=${resultText.length}`);
                return { call, input, resultText };
            } catch (e: any) {
                const declinedAnswer = isUserDeclinedToolError(e, token)
                    ? await askAfterDeclinedTool(call.function.name, input, stream, token)
                    : undefined;
                const errorText = declinedAnswer !== undefined
                    ? declinedToolGuidance(call.function.name, e, declinedAnswer)
                    : `tool error: ${e?.message ?? String(e)}`;
                debugLog(`[Tool Invocation] failed ${call.function.name} (${call.id || 'missing id'}): ${e?.message ?? String(e)}`);
                return { call, input, errorText };
            }
        };

        const resolved: Awaited<ReturnType<typeof resolveToolCall>>[] = [];
        let parallelBatch: Promise<Awaited<ReturnType<typeof resolveToolCall>>>[] = [];
        const flushParallel = async () => {
            if (parallelBatch.length === 0) return;
            const batch = parallelBatch;
            parallelBatch = [];
            resolved.push(...(await Promise.all(batch)));
        };

        for (const call of toolCalls) {
            if (token.isCancellationRequested) break;
            if (parallelBatching && PARALLEL_SAFE_TOOL_NAMES.has(call.function.name)) {
                parallelBatch.push(resolveToolCall(call));
                if (parallelBatch.length >= PARALLEL_MAX_CONCURRENCY) await flushParallel();
            } else {
                await flushParallel();
                resolved.push(await resolveToolCall(call));
            }
        }
        await flushParallel();

        // Push results in original tool-call order (deterministic routing).
        for (const r of resolved) {
            if (r.errorText !== undefined) {
                usageCalls.push({ name: r.call.function.name, input: r.input, error: r.errorText });
            } else {
                usageCalls.push({ name: r.call.function.name, input: r.input, result: r.resultText });
                maybeStreamToolReference(stream, r.call.function.name, r.input);
            }
            messages.push({
                role: 'tool',
                tool_call_id: r.call.id,
                content: r.errorText !== undefined ? r.errorText : (r.resultText ?? null)
            });
        }
        // ── Inject mid-session whispers after tool results ──
        try {
            const pending = await getPendingMidSessionWhispers();
            if (pending.length > 0) {
                const whisperLines = pending.map(w => `[${new Date(w.createdAt).toISOString().slice(0, 16).replace('T', ' ')}] ${w.body}`);
                const whisperBlock = `📥 MID-SESSION WHISPER — ${pending.length} message(s) received while working:\n\n${whisperLines.join('\n\n')}\n\n( Auto-delivered by whisper watcher. Already in your context — no action needed. )`;
                messages.push({ role: 'user', content: whisperBlock });
                markMidSessionWhispersDelivered(pending);
            }
        } catch { /* best-effort */ }

        // ── Flow-state check for ALL responses (text-only AND tool-call) ──
        // Catches responses that ask a question then wrap up, or conclude without
        // an invitation to continue. Has its own counter (max 2 per turn) so it
        // does not compete with the tool-routing retry.
        const flowStateOn = vscode.workspace.getConfiguration('harmony').get<boolean>('flowState') ?? false;
        if (flowStateOn && flowStateRetries < 3) {
            // Use post-tool check if tool calls were made (skips tool-prose detection
            // since mentioning tools after calling them is normal). Use the main check
            // for text-only responses (includes tool-prose detection).
            const violation = toolCalls.length > 0
                ? getFlowStateViolationPostTool(content)
                : getFlowStateViolation(content);
            if (violation) {
                flowStateRetries++;
                const lm = LanguageManager.getInstance();
                const whisper = lm.getString(violation);
                debugLog(`[Flow State] ${whisper} (retry ${flowStateRetries}/3)`);
                stream.markdown(`\n\n> ${whisper}\n\n`);
                messages.push({ role: 'user', content: whisper });
                continue;
            }
        }

        // ── Terminate text-only responses after flow-state check passes ──
        // (moved from the early return above so flow-state can evaluate text-only responses)
        if (toolCalls.length === 0) {
            if (route.supportsReasoningContent) rememberDeepSeekAssistantTrace(assistantTextSoFar, reasoningTextSoFar);
            return {
                result: { metadata: { functionCalls: usageCalls } },
                finalText: assistantTextSoFar
            };
        }
    }

    emitStepLimitReached(stream, limit);
    if (route.supportsReasoningContent) rememberDeepSeekAssistantTrace(assistantTextSoFar, reasoningTextSoFar);
    return {
        result: { metadata: { functionCalls: usageCalls } },
        finalText: assistantTextSoFar
    };
}

// Race a user prompt against a timeout so a dismissed/unseen prompt can never
// hang the chat turn. Returns the prompt's answer, or undefined on timeout.
function withBoundedPrompt<T>(prompt: Promise<T>, timeoutMs: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
    });
    return Promise.race([prompt, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/** Run one agent loop with native tool calling. */
async function runAgent(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    profile: ProfileDefinition,
    context: vscode.ExtensionContext,
    forceReadOnly: boolean
): Promise<AgentRunOutcome> {
    const refs = await resolveReferences(request.references);
    let recallText = "";
    try { const recall = await recallMemory(); recallText = formatRecallForPrompt(recall); } catch (e) { debugLog("[Context Guard] recallMemory failed: " + String((e as any)?.message ?? e)); }
    let sessionText = "";
    try { sessionText = await resumedSessionText(context); } catch (e) { debugLog("[Context Guard] resumedSessionText failed: " + String((e as any)?.message ?? e)); }
    let rulesText = "";
    try { rulesText = await loadRulesContext(); } catch (e) { debugLog("[Context Guard] loadRulesContext failed: " + String((e as any)?.message ?? e)); }
    let continuityText = "";
    try { continuityText = await formatContinuityForPrompt(); } catch (e) { debugLog("[Context Guard] formatContinuityForPrompt failed: " + String((e as any)?.message ?? e)); }
    const messages = await buildMessages(request, chatContext, profile, refs, recallText, sessionText, rulesText, continuityText);

    // Discover Harmony tools that were actually registered this session.
    const registeredTools = await waitForActiveHarmonyTools(forceReadOnly);
    const tools = registeredTools
        .filter(t => activeToolNames(forceReadOnly).includes(t.name))
        .map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema
        }));

    const limit = resolveAgentStepLimit();

    let assistantTextSoFar = '';
    let warnedStepLimit = false;
    const usageCalls: any[] = [];

    for (let step = 0; step < limit.maxSteps; step++) {
        if (token.isCancellationRequested) break;
        warnedStepLimit = maybeWarnStepLimit(stream, limit, step, warnedStepLimit);

        if (vscode.workspace.getConfiguration('harmony').get<boolean>('enableDebugLogging') !== false) {
             harmonyDebugChannel.appendLine(`[Copilot Agent] Requesting step ${step+1}/${limit.maxSteps}...`);
        }

        const response = await request.model.sendRequest(
            messages,
            { tools },
            token
        );

        // Collect this turn's parts.
        let stepText = '';
        const toolCalls: vscode.LanguageModelToolCallPart[] = [];

        for await (const part of response.stream) {
            if (token.isCancellationRequested) break;
            if (part instanceof vscode.LanguageModelTextPart) {
                stream.markdown(part.value);
                stepText += part.value;
                if (vscode.workspace.getConfiguration('harmony').get<boolean>('enableDebugLogging') !== false) {
                     harmonyDebugChannel.append(part.value);
                }
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                toolCalls.push(part);
            }
        }
        
        if (vscode.workspace.getConfiguration('harmony').get<boolean>('enableDebugLogging') !== false) {
            harmonyDebugChannel.appendLine(''); // newline after text
            if (toolCalls.length > 0) {
                 harmonyDebugChannel.appendLine(`[Copilot Agent] Tool calls requested: ${JSON.stringify(toolCalls, null, 2)}`);
            }
        }

        const nativeModel = (request.model as any).id
            ?? (request.model as any).name
            ?? `${request.model.vendor}/${request.model.family}`;
        recordUsage({
            timestamp: new Date().toISOString(),
            provider: 'vscode-lm',
            tier: 'native',
            model: nativeModel,
            promptTokens: 0,
            completionTokens: 0
        });

        assistantTextSoFar += stepText;

        // No tools requested → we're done.
        if (toolCalls.length === 0) {
            return {
                result: { metadata: { functionCalls: usageCalls } },
                finalText: assistantTextSoFar
            };
        }

        // Persist the assistant turn (text + tool calls together) into history.
        const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
        if (stepText) assistantParts.push(new vscode.LanguageModelTextPart(stepText));
        for (const c of toolCalls) assistantParts.push(c);
        messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

        // Invoke each tool and append its result as a User-role tool result.
        const resultParts: vscode.LanguageModelToolResultPart[] = [];
        for (const call of toolCalls) {
            if (token.isCancellationRequested) break;
            
            try {
                const result = await invokeHarmonyToolWithTurnKeepAlive(
                    call.name,
                    call.input,
                    request.toolInvocationToken,
                    stream,
                    token
                );
                
                usageCalls.push({
                    name: call.name,
                    input: call.input,
                    result: result.content
                });
                
                maybeStreamToolReference(stream, call.name, call.input);
                resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, result.content));
            } catch (e: any) {
                const declinedAnswer = isUserDeclinedToolError(e, token)
                    ? await askAfterDeclinedTool(call.name, call.input, stream, token)
                    : undefined;
                const errorContent = declinedAnswer !== undefined
                    ? declinedToolGuidance(call.name, e, declinedAnswer)
                    : `tool error: ${e?.message ?? String(e)}`;
                usageCalls.push({
                    name: call.name,
                    input: call.input,
                    error: errorContent
                });
                resultParts.push(new vscode.LanguageModelToolResultPart(
                    call.callId,
                    [new vscode.LanguageModelTextPart(errorContent)]
                ));
            }
        }
        // ── Inject mid-session whispers before tool results ──
        try {
            const pending = await getPendingMidSessionWhispers();
            if (pending.length > 0) {
                const whisperLines = pending.map(w => `[${new Date(w.createdAt).toISOString().slice(0, 16).replace('T', ' ')}] ${w.body}`);
                const whisperBlock = `📥 MID-SESSION WHISPER — ${pending.length} message(s) received while working:\n\n${whisperLines.join('\n\n')}\n\n( Auto-delivered by whisper watcher. Already in your context — no action needed. )`;
                messages.push(vscode.LanguageModelChatMessage.User(whisperBlock));
                markMidSessionWhispersDelivered(pending);
            }
        } catch { /* best-effort */ }
        messages.push(vscode.LanguageModelChatMessage.User(resultParts));
    }

    emitStepLimitReached(stream, limit);
    return {
        result: { metadata: { functionCalls: usageCalls } },
        finalText: assistantTextSoFar
    };
}

/** Slash-command handlers. Return true if handled (skip the agent loop). */
async function handleSlashCommand(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    context: vscode.ExtensionContext,
    token: vscode.CancellationToken
): Promise<boolean> {
    if (!request.command) return false;

    if (request.command === 'reset') {
        await context.workspaceState.update('harmony.activeSession', undefined);
        stream.markdown('Conversation reset. Start a new turn whenever you are ready.');
        return true;
    }

    if (request.command === 'compose') {
        await vscode.commands.executeCommand('harmony.compose');
        stream.markdown('Opening **Harmony Compose** for a long prompt, images, or file attachments. Use the **Send to Harmony** button when ready.');
        return true;
    }

    if (request.command === 'restore') {
        const lastPrompt: string | undefined = context.workspaceState.get('harmony.lastPrompt');
        if (!lastPrompt) {
            stream.markdown('No saved prompt to restore. Your last prompt is auto-saved when you submit a Harmony chat message.');
            return true;
        }
        // Guard against infinite loop: if the last prompt WAS /restore, just show it without re-triggering
        const isRestoreCommand = /^\s*\/restore\b/i.test(lastPrompt);
        stream.markdown(`**💾 Last prompt restored:**\n\n> ${lastPrompt.replace(/\r?\n/g, '\n> ')}`);
        if (!isRestoreCommand) {
            // Re-open chat with the restored prompt (only for non-/restore prompts)
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: `@harmony ${lastPrompt}`,
                isPartialQuery: false
            });
        }
        return true;
    }

    if (request.command === 'status') {
        const cfg = vscode.workspace.getConfiguration('harmony');
        const provider = cfg.get<string>('modelProvider') ?? 'vscode-lm';
        const hasDeepSeekKey = !!await context.secrets.get('harmony.deepseekApiKey');
        const expectedTools = activeToolNames(false);
        const registeredTools = await waitForActiveHarmonyTools(false, 2000);
        const registeredHarmonyTools = registeredTools.filter(tool => tool.name.startsWith('harmony_'));
        const missingCriticalTools = criticalToolsForMode(false).filter(name => !registeredTools.some(tool => tool.name === name));
        const historyLimits = deepSeekHistoryLimits();
        const providerIds: ProviderId[] = PROVIDER_IDS;
        const availableProviders = new Set(await listAvailableProviders(context.secrets));
        const providerKeys = providerIds.map(id => `${id}: ${availableProviders.has(id) ? 'key saved' : 'no key'}`).join(', ');
        const collabPreset = getCollabModelPreset();
        const collabProvider = getCollabDirectProvider();
        const collabTier = collabTierForPreset(collabPreset);
        const resolvedCollab = await resolveCollabModel(context.secrets);
        const rawSwarmProvider = cfg.get<string>('swarm.defaultProvider');
        const swarmProvider: ProviderId = PROVIDER_IDS.includes(rawSwarmProvider as ProviderId) ? rawSwarmProvider as ProviderId : 'deepseek';
        const rawSwarmTier = cfg.get<string>('swarm.defaultTier');
        const swarmTier: Tier = rawSwarmTier === 'light' || rawSwarmTier === 'mid' || rawSwarmTier === 'heavy' || rawSwarmTier === 'coding' ? rawSwarmTier : 'coding';
        const swarmProviderCalls = cfg.get<boolean>('swarm.providerCalls.enabled') === true;
        const continuity = await getContinuityStatus();
        const rulesLine = await formatRulesStatus();
        const workspaceRootLabel = vscode.workspace.workspaceFolders?.map(folder => vscode.workspace.asRelativePath(folder.uri, false) || folder.name).join(', ') || '(no workspace folder)';
        const directRoute = isDirectPrimaryProvider(provider) ? directPrimaryRoute(provider) : undefined;
        const modelLine = directRoute
            ? `${directRoute.label} direct API / ${directRoute.model}`
            : `VS Code Chat model / ${request.model.vendor}/${request.model.family}`;

        let hubLine = 'offline or not responding';
        try {
            const base = cfg.get<string>('hub.url') ?? 'http://127.0.0.1:7878';
            const res = await fetch(`${base.replace(/\/$/, '')}/status`, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
                const j: any = await res.json();
                hubLine = `online / ${j.model ?? 'unknown model'} / ${j.vectors ?? 0} vectors / ${(j.indexed_paths ?? []).length} indexed folder(s)`;
            }
        } catch { /* offline */ }

        const memory = await recallMemory(10);
        const sessions = await listSessions();
        stream.markdown(
            `**Harmony Status**\n\n` +
            `| Area | Current |\n|---|---|\n` +
            `| Primary model | ${modelLine} |\n` +
            `| Primary key store | ${directRoute ? `VS Code Secret Storage (${directRoute.secretKey}); terminal/native DPAPI/env keys are separate` : 'VS Code Chat account, not Harmony provider key storage'} |\n` +
            `| Agents route | ${collabPreset} / ${collabProvider} / ${collabTier}${resolvedCollab ? ` -> ${providerDisplayName(resolvedCollab.provider)} / ${resolvedCollab.model}` : ' -> no saved extension key resolved'} |\n` +
            `| Swarm default | ${providerDisplayName(swarmProvider)} / ${swarmTier} / ${modelFor(swarmProvider, swarmTier)}; provider calls ${swarmProviderCalls ? 'enabled' : 'disabled'} |\n` +
            `| DeepSeek key | ${hasDeepSeekKey ? 'saved' : 'not saved'} |\n` +
            `| Profile | ${getCurrentProfile(context).id} |\n` +
            `| Workspace | ${workspaceRootLabel} |\n` +
            `| Hub | ${hubLine} |\n` +
            `| Harmony tools | ${registeredHarmonyTools.length}/${expectedTools.length} active |\n` +
            `| Companion extensions | ${companionExtensionStatus(context.extension.id)} |\n` +
            `| Creative tools | built-in Harmony Chat bridge to the configured local Harmony Creative service; workspace/service-path preferred, Central fallback, no separate VS Code Creative Tools extension required. Use \`harmony_creative_health\` for live service/provider health. |\n` +
            `| Critical tools | ${missingCriticalTools.length === 0 ? 'all present' : `missing ${missingCriticalTools.join(', ')}`} |\n` +
            `| Provider keys | ${providerKeys} |\n` +
            `| Key stores | Primary, Agents, and VS Code swarm provider calls use VS Code Secret Storage. Terminal/native use Windows DPAPI or environment variables. |\n` +
            `| Continuity ledger | ${continuity.count} entr${continuity.count === 1 ? 'y' : 'ies'}${continuity.latest ? `, latest ${continuity.latest.kind} from ${continuity.latest.source}` : ''} |\n` +
            `| Continuity prompt inject | ${continuity.autoInjectLatest ? 'ON' : 'OFF'} |\n` +
            `| Rules anchors | ${rulesLine} |\n` +
            `| MCP manager | ${mcpStatusSummary()} |\n` +
            `| Verification command | ${defaultVerificationCommand()} (${defaultVerificationTimeoutSec()}s) |\n` +
            `| Claude thinking | ${cfg.get<boolean>('claude.enableThinking') ? `ON (budget: ${cfg.get<number>('claude.thinkingBudgetTokens') ?? 4000} tokens)` : 'OFF (default — prevents surprise $10–20 Opus charges)'} |\n` +
            `| Persisted memory | ${memory.length} recent turn(s) loaded into new requests |\n` +
            `| Saved sessions | ${sessions.length} |\n` +
            `| DeepSeek history replay | ${historyLimits.maxMessages} message(s), ${historyLimits.maxChars} chars |\n` +
            `| Harmony debug logging | ${debugEnabled() ? 'ON' : 'OFF'} |\n` +
            `| Raw stream logging | ${cfg.get<boolean>('logRawStream') ? 'ON' : 'OFF'} |\n` +
            `| Tool approvals | ${cfg.get<boolean>('autoApproveTools') ? 'auto-approve ON' : 'approval prompts ON'} |\n` +
            `| Planner mode | ${cfg.get<boolean>('plannerEnforced') ? 'ON' : 'OFF'} |\n` +
            `| Error diagnostics | ${cfg.get<boolean>('showDiagnosticsOnError') ?? true ? 'ON' : 'OFF'} |\n\n` +
            `**Copilot dropdown cost multipliers** (your current selections):\n` +
            `| Model | Multiplier | Notes |\n` +
            `|---|---|---|\n` +
            `| GPT 4.1, GPT 4o, Raptor Mini | **0x** | Free — no premium request cost |\n` +
            `| Claude Haiku 4.5 | **0.33x** | Cheapest Claude option |\n` +
            `| Gemini 3 Flash (Preview) | **0.33x** | Good for large-context tasks |\n` +
            `| GPT 5.4 mini | **0.33x** | Cheap GPT-5 tier |\n` +
            `| Grok Code Fast 1 | **0.33x** | Good for coding tasks |\n` +
            `| Claude Sonnet 4.6, GPT 5.4, Gemini 3 Pro | **1x** | Standard tier |\n` +
            `| GPT 5.5 | **7.5x** | Avoid in agentic loops — high cost, limited gain |\n` +
            `| Opus 4.7 | **15x** | Manual only — combine with thinking=OFF |\n` +
            `| Auto | **varies** | Risky — can land on 15x models. Prefer explicit selection. |\n\n` +
            `**Recommendation**: Use 0x models (GPT 4.1, GPT 4o) for routine Harmony work. Switch to Sonnet 4.6 (1x) for hard reasoning. Avoid Auto mode.\n\n` +
            `Switch models with \`@harmony /model flash\`, \`@harmony /model pro\`, or \`@harmony /model copilot\`.`
        );
        return true;
    }

    if (request.command === 'asktest') {
        debugLog('[Ask Test] opening deterministic Harmony Ask smoke test');
        const answer = await showHarmonyAsk({
            question: request.prompt.trim() || 'Harmony ask smoke test: which database should we use?',
            options: [
                { label: 'Postgres', description: 'Relational default with strong ecosystem.', recommended: true },
                { label: 'MySQL', description: 'Relational option with broad hosting support.' }
            ],
            multiline: true,
            allowFreeformInput: true,
            multiSelect: false,
        }, token);

        if (answer === undefined) {
            debugLog('[Ask Test] user cancelled');
            stream.markdown('Harmony Ask smoke test cancelled.');
        } else {
            debugLog(`[Ask Test] answered chars=${answer.length}`);
            stream.markdown(`Harmony Ask smoke test returned:\n\n> ${answer.replace(/\r?\n/g, '\n> ')}`);
        }
        return true;
    }

    if (request.command === 'tools') {
        const arg = request.prompt.trim().toLowerCase();
        stream.markdown(formatHarmonyToolLedger({ category: arg || undefined, include_commands: true }));
        return true;
    }

    if (request.command === 'mcp') {
        stream.markdown(formatMcpStatus());
        return true;
    }

    if (request.command === 'handoff') {
        try {
            const rel = await createContinuityHandoff(request.prompt.trim());
            stream.markdown(`Created handoff packet: [${rel}](${rel})\n\nUse this when you need to resume in Harmony, Copilot, Gemini, terminal, or another AI seat.`);
        } catch (e: any) {
            stream.markdown(`Handoff failed: ${e?.message ?? String(e)}`);
        }
        return true;
    }

    if (request.command === 'sync') {
        const text = request.prompt.trim();
        if (!text) {
            const entries = await listContinuityEntries(8);
            stream.markdown(entries.length === 0
                ? 'No explicit continuity entries yet. Paste a Copilot/Gemini/terminal handoff after `@harmony /sync` to import it.'
                : `**Recent continuity**\n\n${entries.map(entry => `- ${entry.ts} — ${entry.kind}/${entry.source}: ${entry.summary}`).join('\n')}`
            );
            return true;
        }
        try {
            const entry = await importContinuityFromText(text, 'chat /sync');
            stream.markdown(`Imported continuity entry **${entry.id}**. Future Harmony turns will use it as explicit handoff context while continuity injection is enabled.`);
        } catch (e: any) {
            stream.markdown(`Sync failed: ${e?.message ?? String(e)}`);
        }
        return true;
    }

    if (request.command === 'clean') {
        // Trim old .harmony state to prevent context bloat
        try {
            const fs = require('fs');
            const path = require('path');
            const harmonyDir = path.join(vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? '', '.harmony');
            const now = Date.now();
            const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
            let deleted = 0;
            let kept = 0;
            // Clean old handoff files
            const handoffsDir = path.join(harmonyDir, 'handoffs');
            if (fs.existsSync(handoffsDir)) {
                for (const file of fs.readdirSync(handoffsDir)) {
                    const fp = path.join(handoffsDir, file);
                    try {
                        const stat = fs.statSync(fp);
                        if (stat.mtimeMs < now - THIRTY_DAYS) {
                            fs.unlinkSync(fp);
                            deleted++;
                        } else { kept++; }
                    } catch { /* skip */ }
                }
            }
            // Compact supervisor events
            const supervisorDir = path.join(harmonyDir, 'supervisor');
            if (fs.existsSync(supervisorDir)) {
                for (const file of fs.readdirSync(supervisorDir)) {
                    const fp = path.join(supervisorDir, file);
                    try {
                        const stat = fs.statSync(fp);
                        if (stat.size > 500000 || stat.mtimeMs < now - THIRTY_DAYS) {
                            fs.unlinkSync(fp);
                            deleted++;
                        } else { kept++; }
                    } catch { /* skip */ }
                }
            }
            stream.markdown(`**Harmony Cleanup Complete**\n\nDeleted ${deleted} old/big state file(s). Kept ${kept} recent file(s).\n\n> Your memory, continuity, and chat history are untouched. Only expired handoff packets and oversized supervisor logs were cleaned.`);
        } catch (e: any) {
            stream.markdown(`Cleanup failed: ${e?.message ?? String(e)}`);
        }
        return true;
    }

    if (request.command === 'resumeHandoff') {
        const entries = await listContinuityEntries(5);
        if (entries.length === 0) {
            stream.markdown('No handoff/continuity entries exist yet. Use `@harmony /handoff` to create one or `@harmony /sync <text>` to import one.');
        } else {
            stream.markdown(`Harmony will use the latest continuity entry automatically when **harmony.continuity.autoInjectLatest** is ON.\n\n${entries.map(formatContinuityEntry).join('\n\n')}`);
        }
        return true;
    }

    if (request.command === 'compact') {
        try {
            const entry = await compactContinuity(request.prompt.trim());
            stream.markdown(`Compacted continuity into **${entry.id}**. Latest summary:\n\n${entry.summary}`);
        } catch (e: any) {
            stream.markdown(`Compact failed: ${e?.message ?? String(e)}`);
        }
        return true;
    }

    if (request.command === 'fork') {
        try {
            const entry = await forkContinuity(request.prompt.trim(), request.prompt.trim());
            stream.markdown(`Created continuity fork **${entry.id}**. ${entry.summary}`);
        } catch (e: any) {
            stream.markdown(`Fork failed: ${e?.message ?? String(e)}`);
        }
        return true;
    }

    if (request.command === 'verify') {
        const command = request.prompt.trim() || defaultVerificationCommand();
        const result = await runVerification(command, 'slash /verify', defaultVerificationTimeoutSec());
        stream.markdown(
            `**Verification ${result.ok ? 'passed' : 'failed'}**\n\n` +
            `Command: \`${result.command}\`\n\n` +
            `Duration: ${result.durationMs}ms\n\n` +
            '```text\n' + result.output.slice(0, 8000) + '\n```'
        );
        return true;
    }

    if (request.command === 'rules') {
        stream.markdown(`**Harmony Rules**\n\n${await formatRulesDetails()}`);
        return true;
    }

    if (request.command === 'model') {
        const arg = request.prompt.trim().toLowerCase();
        // CLI alias map is now generated from the central providerModels.ts registry.
        const validModels: Record<string, { provider: string; model?: string }> = {
            ...buildAliasMap(),
            'copilot': { provider: 'vscode-lm' },
            'vscode': { provider: 'vscode-lm' },
        };
        if (arg && validModels[arg]) {
            const pick = validModels[arg];
            if (pick.provider === 'vscode-lm') {
                await vscode.workspace.getConfiguration('harmony').update('modelProvider', 'vscode-lm', true);
                stream.markdown(`Switched to **VS Code / Copilot** model.`);
            } else {
                await vscode.workspace.getConfiguration('harmony').update('modelProvider', pick.provider, true);
                if (pick.provider === 'deepseek' && pick.model) {
                    await setDeepSeekModel(pick.model);
                } else if (pick.model) {
                    await vscode.workspace.getConfiguration('harmony').update(`providers.${pick.provider}.coding`, pick.model, true);
                }
                stream.markdown(`Switched to **${providerDisplayName(pick.provider as CollabDirectProvider)} / ${pick.model}**. This is now your default for all workspaces.`);
            }
        } else if (!arg) {
            const picked = await vscode.commands.executeCommand<string>('harmony.selectModel');
            stream.markdown(picked ? `**${picked}**` : 'Model selection cancelled.');
        } else {
            const cfg = vscode.workspace.getConfiguration('harmony');
            const provider = cfg.get<string>('modelProvider') ?? 'vscode-lm';
            const current = isDirectPrimaryProvider(provider)
                ? `${directPrimaryRoute(provider).label} / ${directPrimaryRoute(provider).model}`
                : 'VS Code / Copilot';
            stream.markdown(
                `Current model: **${current}**\n\n` +
                `Switch with \`@harmony /model <option>\`:\n` +
                PROVIDER_REGISTRY.flatMap(p =>
                    p.models.filter(m => m.aliases && m.aliases.length > 0)
                           .map(m => `- \`${m.aliases![0]}\` — ${p.displayName} / ${m.label}`)
                ).join('\n') +
                `\n- \`copilot\` — VS Code built-in model (no API key needed)\n\n` +
                `Your choice is saved as your new default.`
            );
        }
        return true;
    }

    if (request.command === 'profile') {
        const choices = Object.values(DEFAULT_PROFILES).map(p => ({ label: p.label, id: p.id }));
        const lines = choices.map(c => `- \`${c.id}\` — ${c.label}`).join('\n');
        const arg = request.prompt.trim().toLowerCase();
        if (arg && DEFAULT_PROFILES[arg]) {
            await setProfile(context, arg);
            stream.markdown(`Profile switched to **${DEFAULT_PROFILES[arg].label}**.`);
        } else {
            const cur = getCurrentProfile(context);
            stream.markdown(
                `Current profile: **${cur.label}** (\`${cur.id}\`)\n\nAvailable:\n${lines}\n\n` +
                `Type \`@harmony /profile <id>\` to switch.`
            );
        }
        return true;
    }

    if (request.command === 'memory') {
        const recent = await recallMemory(10);
        const stats = await memoryStats();
        const statLine = `Active entries: ${stats.activeEntries}. Preserved detail files: ${stats.preservedFiles}${stats.lastPreservedPath ? ` (latest: \`${stats.lastPreservedPath}\`)` : ''}.`;
        if (recent.length === 0) {
            stream.markdown(`No prior session memory in this workspace yet.\n\n_${statLine}_`);
        } else {
            const lines = recent.map((e, i) => {
                const date = e.ts.slice(0, 16).replace('T', ' ');
                return `${i + 1}. **${date}** — ${e.prompt.split('\n')[0].slice(0, 100)}`;
            }).join('\n');
            stream.markdown(`**Recent memory** (last ${recent.length}):\n\n${lines}\n\n_${statLine} Stored in \`.harmony/memory.jsonl\`; older compacted details remain under \`.harmony/memory-preserved/\`. Use the sidebar **Hide memory from panel** button for screenshots; it does not delete memory._`);
        }
        return true;
    }

    if (request.command === 'forget') {
        stream.markdown('Persistent @harmony memory deletion is disabled to protect continuity. Use the sidebar **Hide memory from panel** button when you only need the memory area out of view.');
        return true;
    }

    if (request.command === 'save') {
        const name = request.prompt.trim();
        if (!name) { stream.markdown('Usage: `@harmony /save <name>` \u2014 saves the recent turns to `.harmony/sessions/<name>.json`.'); return true; }
        try {
            // We don't have direct access to chat history here without the chatContext;
            // /save called via slash flows through a different path. Save just memory snapshot for now.
            const recent = await recallMemory(20);
            const turns: SessionTurn[] = [];
            for (const e of recent.reverse()) {
                turns.push({ role: 'user', text: e.prompt, ts: e.ts });
                turns.push({ role: 'assistant', text: e.response, ts: e.ts });
            }
            const saved = await saveSession(name, turns);
            stream.markdown(`Saved as **${saved}**. Resume with \`@harmony /resume ${saved}\`.`);
        } catch (e: any) {
            stream.markdown(`Save failed: ${e?.message ?? e}`);
        }
        return true;
    }

    if (request.command === 'resume') {
        const name = request.prompt.trim();
        if (!name) {
            const names = await listSessions();
            stream.markdown(names.length > 0
                ? `Available sessions:\n${names.map(n => `- \`${n}\``).join('\n')}\n\nUsage: \`@harmony /resume <name>\``
                : 'No saved sessions in this workspace yet.'
            );
            return true;
        }
        const s = await loadSession(name);
        if (!s) { stream.markdown(`No session named **${name}**.`); return true; }
        await context.workspaceState.update('harmony.activeSession', s.name);
        stream.markdown(`**Resumed session "${s.name}"** (${s.turns.length} turns from ${s.updated}).\n\n${s.notes ? `Notes: ${s.notes}\n\n` : ''}You can now continue the conversation \u2014 I have the prior context.`);
        // The next model turn injects this session through resumedSessionText().
        return true;
    }

    if (request.command === 'usage') {
        const rows = summarizeUsage();
        if (rows.length === 0) {
            stream.markdown('No model calls recorded this session.');
        } else {
            const total = totalTokens();
            const totalCost = rows.reduce((sum, r) => sum + r.estCostDollars, 0);
            const hasUnknownCost = rows.some(r => !r.estCostKnown);
            const totalCostText = hasUnknownCost ? `relative impact: ${totalCost < 0.05 ? '●○○ Low' : totalCost < 0.20 ? '●●○ Medium' : '●●● Significant'} + unknown` : `relative impact: ${totalCost < 0.05 ? '●○○ Low' : totalCost < 0.20 ? '●●○ Medium' : '●●● Significant'}`;
            const table = ['| Provider | Tier | Model | Calls | Prompt | Completion | Units | Est. Cost |',
                '|---|---|---|---:|---:|---:|---:|---:|',
                ...rows.map(r => {
                    const units = r.billableUnits > 0 ? `${r.billableUnits} ${r.billableUnitLabel ?? 'unit'}${r.billableUnits === 1 ? '' : 's'}` : '';
                    return `| ${r.provider} | ${r.tier} | ${r.model} | ${r.calls} | ${r.promptTokens} | ${r.completionTokens} | ${units} | ${r.estCostKnown ? `$${r.estCostDollars.toFixed(4)}` : 'unknown'} |`;
                })
            ].join('\n');
            stream.markdown(`**Session usage** (total: ${total} tokens, ${totalCostText})\n\n${table}\n\n_Note: VS Code LM token counts are not exposed, so those rows track calls with 0 tokens._\n\n_Reset with the **Harmony: Reset Cost Counters** command._`);
        }
        return true;
    }

    if (request.command === 'steps') {
        const arg = request.prompt.trim().toLowerCase();
        const cfg = vscode.workspace.getConfiguration('harmony');
        if (!arg) {
            const limit = resolveAgentStepLimit();
            stream.markdown(
                `Current max agent steps: **${limit.label}**.\n\n` +
                `Use \`@harmony /steps 1111\`, \`@harmony /steps 500\`, or \`@harmony /steps -1\` for unlimited.`
            );
            return true;
        }
        const next = ['unlimited', 'infinite', 'inf'].includes(arg) ? -1 : Number(arg);
        if (!Number.isFinite(next) || next < -1 || next === 0 || next > MAX_AGENT_STEPS_SETTING) {
            stream.markdown(`Please choose a step value from **1-${MAX_AGENT_STEPS_SETTING}**, or **-1** for unlimited.`);
            return true;
        }
        const saved = Math.floor(next);
        await cfg.update('agentMaxSteps', saved, vscode.ConfigurationTarget.Global);
        stream.markdown(saved === -1
            ? 'Max agent steps set to **unlimited** (`-1`).'
            : `Max agent steps set to **${saved}**.`
        );
        return true;
    }

    if (request.command === 'agentic') {
        const cfg = vscode.workspace.getConfiguration('harmony');
        const cur = !!cfg.get<boolean>('plannerEnforced');
        await cfg.update('plannerEnforced', !cur, true);
        stream.markdown(`Planner-enforced mode is now **${!cur ? 'ON' : 'OFF'}**. ${!cur ? 'I will write a todo plan before executing any 3+ step request.' : 'I will plan only when it seems necessary.'}`);
        return true;
    }

    if (request.command === 'checkpoint') {
        const cfg = vscode.workspace.getConfiguration('harmony');
        const cur = !!cfg.get<boolean>('checkpointMode');
        await cfg.update('checkpointMode', !cur, true);
        stream.markdown(`Checkpoint mode is now **${!cur ? 'ON' : 'OFF'}**. ${!cur ? 'I will pause and ask before each major step.' : 'I will run continuously.'}`);
        return true;
    }

    return false;
}

/** Decorate the user's prompt for slash commands. */
function decoratePromptForCommand(request: vscode.ChatRequest): vscode.ChatRequest {
    if (!request.command) return request;
    let prefix = '';
    if (request.command === 'explain') {
        prefix = 'Please explain the following clearly. Use tools to read referenced files first if helpful.\n\n';
    } else if (request.command === 'fix') {
        prefix = 'Please fix the following. Read the file first, then use harmony_edit_file for a minimal change and explain why in one sentence.\n\n';
    } else if (request.command === 'test') {
        prefix = 'Please write tests for the following. Identify the test framework already in use before writing.\n\n';
    } else if (request.command === 'review') {
        prefix = 'Please review the referenced file(s). Read them first. Return a numbered list of concrete, actionable findings, citing path:line. Do not write any changes.\n\n';
    } else if (request.command === 'plan') {
        prefix = 'Please produce a numbered plan for accomplishing the following. Read whatever files are needed for context. DO NOT call any write or edit tools — plan only. End with a single question if scope is unclear.\n\n';
    } else if (request.command === 'analyze') {
        prefix = 'Please analyze the following using read-only workspace tools. Do not edit files, write files, patch files, or run terminal commands. Ground the answer in the repository context and then give clear recommendations.\n\n';
    } else if (request.command === 'commit') {
        prefix = 'Please run `git status --short` and `git diff --cached` via harmony_run_terminal, then propose a clear, conventional-style commit message (subject + body). Do not run git commit yourself.\n\n';
    } else if (request.command === 'research') {
        prefix = 'You are running a deep research investigation. Use harmony_research_dossier for source-backed dossiers (provide source URLs), harmony_literature_scan for academic sources via Semantic Scholar/Crossref, and harmony_evidence_matrix to map claims to evidence. If the user provided URLs, use harmony_claim_check or harmony_current_research to fetch and analyze them. Produce a thorough, well-cited report with clear findings, source attributions, and stated limitations. Read-only: no edits, patches, writes, or terminal commands.\n\n';
    }
    if (!prefix) return request;
    return { ...request, prompt: prefix + request.prompt } as vscode.ChatRequest;
}

function shouldForceReadOnly(request: vscode.ChatRequest): boolean {
    // Read-only is triggered ONLY by explicit slash commands — never by message content.
    // Free-text sniffing here caused unintended mid-session tool blocking.
    return request.command === 'plan' || request.command === 'review' || request.command === 'analyze' || request.command === 'research';
}

interface AgentStepLimit {
    raw: number;
    maxSteps: number;
    label: string;
    warningAt?: number;
}

function resolveAgentStepLimit(): AgentStepLimit {
    const cfg = vscode.workspace.getConfiguration('harmony');
    const raw = cfg.get<number>('agentMaxSteps') ?? DEFAULT_AGENT_MAX_STEPS;
    if (raw === -1) {
        return { raw, maxSteps: Number.MAX_SAFE_INTEGER, label: 'unlimited' };
    }
    const bounded = Math.max(1, Math.min(MAX_AGENT_STEPS_SETTING, Math.floor(Number(raw) || DEFAULT_AGENT_MAX_STEPS)));
    return {
        raw: bounded,
        maxSteps: bounded,
        label: String(bounded),
        warningAt: bounded >= 10 ? Math.max(1, Math.floor(bounded * 0.8)) : undefined
    };
}

function maybeWarnStepLimit(stream: vscode.ChatResponseStream, limit: AgentStepLimit, step: number, warned: boolean): boolean {
    if (warned || !limit.warningAt || step + 1 < limit.warningAt) return warned;
    stream.markdown(`\n\n> Harmony is approaching the agent step limit (${step + 1}/${limit.label}).\n\n`);
    return true;
}

function emitStepLimitReached(stream: vscode.ChatResponseStream, limit: AgentStepLimit): void {
    stream.markdown(`\n\n_(Reached agent step limit: ${limit.label}. Increase \`harmony.agentMaxSteps\`, set it to \`-1\` for unlimited, or continue from here.)_\n\n`);
    try {
        stream.button({
            command: 'harmony.continueLastTurn',
            title: 'Continue from here'
        });
    } catch { /* command buttons are best-effort */ }
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp'
};

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);

function uriFromPromptReference(ref: vscode.ChatPromptReference): vscode.Uri | undefined {
    if (ref.value instanceof vscode.Uri) return ref.value;
    if (ref.value && typeof ref.value === 'object' && 'uri' in ref.value) {
        const uri = (ref.value as any).uri;
        if (uri instanceof vscode.Uri) return uri;
    }
    return undefined;
}

async function collectMediaReferences(refs: readonly vscode.ChatPromptReference[]): Promise<{ images: ComposeImage[]; videos: string[] }> {
    const images: ComposeImage[] = [];
    const videos: string[] = [];

    for (const ref of refs) {
        const uri = uriFromPromptReference(ref);
        if (!uri || uri.scheme !== 'file') continue;
        const ext = path.extname(uri.fsPath).toLowerCase();
        const rel = vscode.workspace.asRelativePath(uri, false);
        if (IMAGE_MIME_BY_EXT[ext]) {
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                images.push({
                    mimeType: IMAGE_MIME_BY_EXT[ext],
                    base64: Buffer.from(bytes).toString('base64'),
                    name: rel
                });
            } catch { /* ignore unreadable attachment */ }
        } else if (VIDEO_EXTS.has(ext)) {
            videos.push(rel);
        }
    }

    return { images, videos };
}

function workspaceFoldersByPriority(): readonly vscode.WorkspaceFolder[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const active = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
    if (!activeFolder) return folders;
    return [activeFolder, ...folders.filter(folder => folder.uri.toString() !== activeFolder.uri.toString())];
}

function workspaceToolUri(input: any): vscode.Uri | undefined {
    const rawPath = input?.path;
    if (!rawPath || typeof rawPath !== 'string') return undefined;
    const folders = workspaceFoldersByPriority();
    if (folders.length === 0) return undefined;

    for (const folder of folders) {
        const root = folder.uri.fsPath;
        const normalized = rawPath.replace(/\\/g, '/');
        const folderPrefix = `${folder.name}/`;
        const relativePath = normalized.startsWith(folderPrefix) ? normalized.slice(folderPrefix.length) : rawPath;
        const resolved = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(root, relativePath);
        const rel = path.relative(root, resolved);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) return vscode.Uri.file(resolved);
    }

    return undefined;
}

function workspaceToolTarget(input: any): { value: vscode.Uri | vscode.Location; label: string } | undefined {
    const uri = workspaceToolUri(input);
    if (!uri) return undefined;
    const rel = vscode.workspace.asRelativePath(uri, false);
    if (!rel.trim()) return undefined;
    const line = Number(input?.start_line ?? input?.line);
    if (Number.isFinite(line) && line > 0) {
        const pos = new vscode.Position(Math.floor(line) - 1, 0);
        return { value: new vscode.Location(uri, pos), label: `${rel}:${Math.floor(line)}` };
    }
    return { value: uri, label: rel };
}

function maybeStreamToolReference(stream: vscode.ChatResponseStream, toolName: string, input: any): void {
    const fileTools = new Set([
        'harmony_read_file',
        'harmony_open_file',
        'harmony_write_file',
        'harmony_edit_file',
        'harmony_apply_patch'
    ]);
    if (!fileTools.has(toolName)) return;
    const target = workspaceToolTarget(input);
    if (!target) {
        debugLog(`[File Reference] skipped ${toolName}: no valid workspace target for input=${safeJson(input).slice(0, 500)}`);
        return;
    }
    try { stream.reference(target.value); }
    catch (error: any) { debugLog(`[File Reference] failed ${toolName}: ${error?.message ?? String(error)}`); }
}

// ── Silent OCR Pre-Processor ────────────────────────────────────
// Runs Windows.Media.Ocr on Compose images BEFORE the paid vision
// model sees them. If high-confidence text is found, we skip the
// vision call entirely — just like Snipping Tool. Free. Instant.

async function runOcrPrecheck(images: ComposeImage[]): Promise<{ text: string; confidence: 'high' | 'mixed' | 'none'; hasText: boolean }> {
    const results: string[] = [];
    let hasText = false;

    // Python script written to temp file (not -c one-liner) to avoid
    // cmd.exe quoting bugs on Windows. Uses winocr which calls Windows.Media.Ocr.
    const pyLines = [
        'import sys, json',
        'from PIL import Image',
        'import winocr',
        'img = Image.open(sys.argv[1])',
        "result = winocr.recognize_pil_sync(img)",
        "print(json.dumps({'ok': True, 'text': result.get('text', ''), 'confidence': len(result.get('words', []))}))",
    ];

    for (let i = 0; i < images.length; i++) {
        if (results.length > 0) results.push('');
        const img = images[i];
        const ext = img.mimeType === 'image/png' ? '.png' : img.mimeType === 'image/jpeg' ? '.jpg' : '.png';
        const tmpPath = path.join(os.tmpdir(), `harmony-ocr-${Date.now()}-${i}${ext}`);

        try {
            const buffer = Buffer.from(img.base64, 'base64');
            await fs.writeFile(tmpPath, buffer);

            // Write Python script to temp file to avoid cmd.exe quoting issues
            const pyPath = path.join(os.tmpdir(), `harmony-ocr-runner-${Date.now()}-${i}.py`);
            await fs.writeFile(pyPath, pyLines.join('\n'), 'utf-8');

            const result = cp.execFileSync('python', [pyPath, tmpPath], {
                encoding: 'utf-8',
                timeout: 15000,
                maxBuffer: 1024 * 1024,
            });

            await fs.unlink(tmpPath).catch(() => {});
            await fs.unlink(pyPath).catch(() => {});

            const parsed = JSON.parse(result.trim());
            if (parsed.ok && parsed.text && parsed.text.trim().length > 0) {
                const label = images.length > 1 ? `[Image ${i + 1} OCR]` : '[OCR extracted]';
                results.push(`${label}: ${parsed.text.trim()}`);
                hasText = true;
            } else if (parsed.ok) {
                // OCR ran successfully but found no text — surface this
                results.push(`[OCR img ${i} no text]`);
            }
        } catch (err: any) {
            const msg = err?.message || err || 'unknown';
            console.error(`[OCR precheck] Failed on image ${i}: ${msg}`);
            // Also surface to stream context for debugging
            results.push(`[OCR err img ${i}]: ${msg}`);
            hasText = false;
            await fs.unlink(tmpPath).catch(() => {});
            try { await fs.unlink(path.join(os.tmpdir(), `harmony-ocr-runner-${Date.now()}-${i}.py`)); } catch {}
        }
    }

    const text = results.join('\n');
    const confidence = hasText ? (results.length === images.length ? 'high' : 'mixed') : 'none';
    return { text, confidence, hasText };
}

export function registerHarmonyParticipant(context: vscode.ExtensionContext) {
    const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
        const profile = getCurrentProfile(context);

        if (await handleSlashCommand(request, stream, context, token)) {
            return;
        }

        await maybePrepareHubForMessage(stream, token);

        // ── Whisper Inbox check (every turn) ─────────────────
        try {
            const unreadWhispers = await readUnread(10);
            if (unreadWhispers.length > 0) {
                const whisperBlock = formatWhispersForPrompt(unreadWhispers);
                stream.markdown('> 📥 Whisper Inbox: ' + unreadWhispers.length + ' unread — injecting as user context\n\n');
                // Prepend whisper block to the user's prompt
                request = { ...request, prompt: whisperBlock + '\n\n' + request.prompt } as typeof request;
                await markAllRead();
                try { const { onWhisperChange } = await import('./whisperInbox'); onWhisperChange.fire(); } catch {}
            }
        } catch { /* whisper injection is best-effort */ }
        startMidSessionTracking(); // Track whispers that arrive mid-turn

        // ── Cross-workspace memory recall ─────────────────
        try {
            const promptWords = (request.prompt ?? '').split(/\s+/).filter(w => w.length > 2).slice(0, 20).join(' ');
            if (promptWords) {
                const matches = await searchGlobalMemory(context, promptWords, 5);
                if (matches.length > 0) {
                    const recallBlock = '🌐 CROSS-WORKSPACE PATTERNS — Harmony has seen similar technical patterns in other projects:\n\n' +
                        matches.map((m, i) =>
                            `${i + 1}. **${m.summary.slice(0, 200)}**\n   Tags: ${m.tags.join(', ')}\n   From: ${m.workspaceName}\n\`\`\`\n${m.snippet.slice(0, 500)}\n\`\`\``
                        ).join('\n\n') +
                        '\n\n(These are from your other workspaces. Use them if helpful — they are technical patterns only, never private data.)';
                    stream.markdown('> 🌐 Cross-workspace memory: ' + matches.length + ' pattern(s) recalled\n\n');
                    request = { ...request, prompt: recallBlock + '\n\n' + request.prompt } as typeof request;
                }
            }
        } catch { /* global memory recall is best-effort */ }

        // Auto-save prompt for recovery (accidental stop / crash)
        if (!request.command && request.prompt?.trim()) {
            context.workspaceState.update('harmony.lastPrompt', request.prompt).then(undefined, () => {});
        }

        // Drain any pending Harmony Compose payload (text + files + images).
        // Images are routed to a vision model first; description is inlined
        // as context. Compose text is prepended to the user's prompt so the
        // marker prompt from the compose panel is harmlessly absorbed.
        const composePayload = consumeComposePayload();
        let effectiveRequest: vscode.ChatRequest = request;
        
        // Auto-save the raw payload so we can link to it immediately
        let draftUri: vscode.Uri | undefined;
        let pendingMediaContext = '';
        
        if (composePayload) {
            draftUri = await appendChatHistory(composePayload.text);
            
            const charCount = composePayload.text.trim().length;
            const snippet = charCount > 0 
                ? `\n> _"${composePayload.text.trim().replace(/\r?\n/g, ' ').slice(0, 200)}${charCount > 200 ? '...' : ''}"_`
                : '';

            stream.markdown(`> 📎 **Harmony Compose Payload** ` +
                `${charCount > 0 ? `(${charCount} chars) · ` : ''}` +
                `${composePayload.filePaths.length > 0 ? `${composePayload.filePaths.length} file(s) · ` : ''}` +
                `${composePayload.images.length > 0 ? `${composePayload.images.length} image(s) · ` : ''}`.replace(/\s·\s$/, '') +
                snippet + `\n\n`);

            let visionDescription = '';
            let routedTo = 'none';
            if (composePayload.images.length > 0) {
                const skipOcr = vscode.workspace.getConfiguration('harmony').get<boolean>('vision.skipOcr') ?? false;
                if (skipOcr) {
                    // Skip OCR toggle is on — go straight to paid vision
                    stream.markdown(`> ⏭️ OCR pre-check skipped — routing ${composePayload.images.length} image(s) to vision model…\n\n`);
                    try {
                        const result = await describeImages(
                            composePayload.images,
                            composePayload.text,
                            context.secrets,
                            token
                        );
                        visionDescription = result.description;
                        routedTo = result.routedTo;
                        if (result.routedTo.startsWith('local')) {
                            stream.markdown(`> 🧠 Local image analysis complete (CPU-only, zero cost)\n\n`);
                        } else {
                            stream.markdown(`> ✅ Vision analysis complete via ${result.routedTo}\n\n`);
                        }
                        if (result.partial) {
                            stream.markdown(`> Vision note: ${result.description}\n\n`);
                        }
                    } catch (e: any) {
                        visionDescription = `[vision pre-step failed: ${e?.message ?? String(e)}]`;
                        stream.markdown(`> Vision note: ${visionDescription}\n\n`);
                    }
                } else {
                // Step 1: Silent local OCR pre-check (like Snipping Tool — free, no LLM)
                stream.markdown(`> 🧪 OCR precheck starting for ${composePayload.images.length} image(s)...\n\n`);
                const ocrPre = await runOcrPrecheck(composePayload.images);
                stream.markdown(`> 🧪 OCR result: hasText=${ocrPre.hasText} textLen=${ocrPre.text.length} confidence=${ocrPre.confidence}\n\n`);
                if (ocrPre.hasText && ocrPre.text.length > 10) {
                    visionDescription = ocrPre.text;
                    routedTo = 'windows-ocr';
                    stream.markdown(`> 🔍 OCR extracted text from ${composePayload.images.length} image(s) — skipping vision model\n\n`);
                } else {
                    const ocrOnly = vscode.workspace.getConfiguration('harmony').get<boolean>('vision.ocrOnly') ?? false;
                    const localFirst = vscode.workspace.getConfiguration('harmony').get<boolean>('vision.localFirst') ?? false;
                    if (ocrOnly) {
                        // OCR-only mode: no fallback to paid vision
                        if (localFirst) {
                            // Combined free-only mode: OCR + Local CPU, no paid provider
                            stream.markdown(`> 🧠 OCR found no text — running free local CPU analysis (OCR + Local Vision only)\n\n`);
                            try {
                                const { decodePng, summarizeLocalAnalysis } = await import('./visualTools');
                                const buf = Buffer.from(composePayload.images[0].base64, 'base64');
                                const decoded = decodePng(buf);
                                if (decoded) {
                                    const summary = summarizeLocalAnalysis(decoded.rgba, decoded.width, decoded.height);
                                    if (summary) {
                                        visionDescription = '🧠 Local CPU analysis (free, no API call): ' + summary;
                                        routedTo = 'local CPU (OCR + Local Vision only)';
                                        stream.markdown(`> ✅ Local CPU analysis complete (zero cost, no API call)\n\n`);
                                    }
                                }
                            } catch { /* local analysis failed — skip silently */ }
                            if (!visionDescription) {
                                stream.markdown(`> 🚫 OCR-only mode: no text found in ${composePayload.images.length} image(s) — image skipped (no API call)\n\n`);
                            }
                        } else {
                            stream.markdown(`> 🚫 OCR-only mode: no text found in ${composePayload.images.length} image(s) — image skipped (no API call)\n\n`);
                        }
                    } else {
                        // Step 2: Fall through to paid vision — always show why
                        stream.markdown(`> ⚠️ OCR did not produce usable text — falling through to vision\n\n`);
                        stream.markdown(`> 🔍 Routing ${composePayload.images.length} image(s) to vision model…\n\n`);
                        try {
                            const result = await describeImages(
                                composePayload.images,
                                composePayload.text,
                                context.secrets,
                                token
                            );
                            visionDescription = result.description;
                            routedTo = result.routedTo;
                            if (result.routedTo.startsWith('local')) {
                                stream.markdown(`> 🧠 Local image analysis complete (CPU-only, zero cost)\n\n`);
                            } else {
                                stream.markdown(`> ✅ Vision analysis complete via ${result.routedTo}\n\n`);
                            }
                            if (result.partial) {
                                stream.markdown(`> Vision note: ${result.description}\n\n`);
                            }
                        } catch (e: any) {
                            visionDescription = `[vision pre-step failed: ${e?.message ?? String(e)}]`;
                            stream.markdown(`> Vision note: ${visionDescription}\n\n`);
                        }
                    }
                }
                }
            }

            const ctxBlock = formatComposeContext(
                composePayload.text,
                composePayload.filePaths,
                visionDescription,
                routedTo
            );

            // Replace the marker prompt with the compose context + any user note.
            // If the user typed nothing in compose, fall back to the marker so
            // the model still sees a question.
            const userIntent = composePayload.text.trim().length > 0
                ? composePayload.text.trim()
                : 'Please review the attached compose payload and respond.';
            effectiveRequest = {
                ...request,
                prompt: ctxBlock + '\n' + userIntent
            } as vscode.ChatRequest;
        }

        const nativeMedia = await collectMediaReferences(effectiveRequest.references);
        if (nativeMedia.images.length > 0 || nativeMedia.videos.length > 0) {
            
            if (!draftUri) draftUri = await appendChatHistory(effectiveRequest.prompt);
            
            stream.markdown(`> 📎 **Native Chat Attachments** ` +
                `${nativeMedia.images.length > 0 ? `${nativeMedia.images.length} image(s) · ` : ''}` +
                `${nativeMedia.videos.length > 0 ? `${nativeMedia.videos.length} video(s) · ` : ''}`.replace(/\s·\s$/, '') +
                `\n\n`);

            if (nativeMedia.images.length > 0) {
                stream.markdown(`> 🔍 Routing ${nativeMedia.images.length} native image(s) to vision model…\n\n`);
                try {
                    const result = await describeImages(
                        nativeMedia.images,
                        effectiveRequest.prompt,
                        context.secrets,
                        token
                    );
                    pendingMediaContext += formatComposeContext('', [], result.description, result.routedTo);
                    if (result.routedTo.startsWith('local')) {
                        stream.markdown(`> 🧠 Local image analysis complete (CPU-only, zero cost)\n\n`);
                    } else {
                        stream.markdown(`> ✅ Vision analysis complete via ${result.routedTo}\n\n`);
                    }
                    if (result.partial) {
                        stream.markdown(`> Vision note: ${result.description}\n\n`);
                    }
                } catch (e: any) {
                    const visionError = `[native image analysis failed: ${e?.message ?? String(e)}]`;
                    pendingMediaContext += `${visionError}\n\n`;
                    stream.markdown(`> Vision note: ${visionError}\n\n`);
                }
            }
            if (nativeMedia.videos.length > 0) {
                pendingMediaContext +=
                    `Native chat video references detected (ffmpeg video analysis is not wired yet):\n` +
                    nativeMedia.videos.map(v => `- ${v}`).join('\n') + '\n\n';
            }
            effectiveRequest = {
                ...effectiveRequest,
                prompt: pendingMediaContext + effectiveRequest.prompt
            } as vscode.ChatRequest;
        }
        
        // Final fallback: If we didn't save a draft yet (e.g. just a very long text prompt with no attachments)
        // we save it now. We don't stream a new markdown block here to keep the UI clean,
        // but the prompt is safely in the ledger.
        if (!draftUri && effectiveRequest.prompt.length > 1000) {
            draftUri = await appendChatHistory(effectiveRequest.prompt);
        }

        if (draftUri) {
            stream.reference(draftUri);
        }

        const decorated = decoratePromptForCommand(effectiveRequest);
        const forceReadOnly = shouldForceReadOnly(effectiveRequest);
        const provider = vscode.workspace.getConfiguration('harmony').get<string>('modelProvider') ?? 'vscode-lm';
        let directRoute = isDirectPrimaryProvider(provider) ? directPrimaryRoute(provider) : undefined;
        const modelLabel = directRoute
            ? `${directRoute.label} (${directRoute.model})`
            : `${request.model.vendor}/${request.model.family}`;

        try {
            // Always tell the user which model+provider is handling this turn so they have certainty.
            stream.markdown(`> 🤖 **${modelLabel}** · profile **${profile.id}**${forceReadOnly ? ' · read-only' : ''}\n\n`);

            let turnOutcome: AgentRunOutcome;

            if (directRoute) {
                let apiKey = await context.secrets.get(directRoute.secretKey);
                
                // For Tencent, PREFER native SecretId+SecretKey auth when available (TC3-HMAC-SHA256 signing).
                // Only fall back to the OpenAI-compatible API key if native creds are not set.
                // This prevents stale/wrong values in harmony.tencent.apiKey from causing 401 errors.
                if (directRoute.provider === 'tencent') {
                    const tkSid = await context.secrets.get('harmony.tencent.secretId');
                    const tkSkey = await context.secrets.get('harmony.tencent.secretKey');
                    if (tkSid && tkSkey) {
                        directRoute = { ...directRoute, tencentNativeCreds: { secretId: tkSid, secretKey: tkSkey } };
                        apiKey = '__tencent_native__'; // sentinel so the guard below passes; actual auth uses TC3 signing
                    }
                }
                
                if (!apiKey) {
                    stream.markdown(
                        `${directRoute.label} is selected for primary Harmony turns, but no API key is saved in VS Code Secret Storage at \`${directRoute.secretKey}\`.\n\n` +
                        `Keys saved for terminal/native provider routes use a separate Windows DPAPI store and do not automatically unlock this VS Code primary route. ` +
                        `Run **Harmony: Set ${directRoute.label} API Key** from the Command Palette, or run **Harmony: Import Provider Keys From .env** for DeepSeek, Alibaba/Qwen, or Moonshot/Kimi keys, then try again.`
                    );
                    return;
                }
                turnOutcome = await runDeepSeekAgent(decorated, chatContext, stream, token, profile, context, forceReadOnly, apiKey, directRoute);
            } else {
                try {
                    turnOutcome = await runAgent(decorated, chatContext, stream, token, profile, context, forceReadOnly);
                } catch (lmError: any) {
                    // ── Direct-API auto-fallback ──────────────────────────
                    // The VS Code LM route died (dead picker model, vendor
                    // registration rejected, Copilot auth broken, network to
                    // the LM backend, ...). Our handler is still alive, so
                    // rescue the turn: reroute to a direct provider API.
                    if (token.isCancellationRequested) throw lmError;
                    // Kill switch: users who deliberately want vscode-lm-only (zero API spend)
                    // can disable the auto-rescue with harmony.lmDirectFallback.
                    const fbEnabled = vscode.workspace.getConfiguration('harmony').get<boolean>('lmDirectFallback') ?? true;
                    if (!fbEnabled) throw lmError;
                    const classified = classifyParticipantError(lmError, token);
                    debugLog(`[LM Fallback] vscode-lm route failed (${classified.diagnosticError}); attempting direct-API fallback`);

                    // Prefer the user's preferred direct providers, else the first provider with a saved key.
                    // Order = provider credit abundance (most available first): DeepSeek first,
                    // then coding plans and affordable per-token providers.
                    const fallbackOrder: DirectPrimaryProvider[] = [
                        'deepseek', 'zhipu-coding', 'kimiCode',
                        'doubao-coding', 'byteplus-coding', 'alibaba', 'moonshot', 'zhipu',
                        'doubao', 'byteplus', 'stepfun', 'tencent', 'doubao-rewards'
                    ];
                    // Premium per-token providers never auto-spend: they rescue only after
                    // an explicit confirmation (60s-bounded so the turn can never hang).
                    const premiumFallbackOrder: DirectPrimaryProvider[] = ['gemini', 'openrouter', 'openai', 'claude'];
                    const providerLabelFor = (p: DirectPrimaryProvider): string => directPrimaryRoute(p).label;
                    let fbProvider: DirectPrimaryProvider | undefined;
                    let fbKey: string | undefined;
                    for (const candidate of fallbackOrder) {
                        const key = await context.secrets.get(secretKeyFor(candidate));
                        if (key) { fbProvider = candidate; fbKey = key; break; }
                    }
                    if (!fbProvider || !fbKey) {
                        // No affordable provider available — offer premium rescue with confirmation.
                        const premiumAvailable: DirectPrimaryProvider[] = [];
                        for (const candidate of premiumFallbackOrder) {
                            if (await context.secrets.get(secretKeyFor(candidate))) premiumAvailable.push(candidate);
                        }
                        if (premiumAvailable.length > 0) {
                            const choice = await withBoundedPrompt(
                                showHarmonyAsk({
                                    question: [
                                        'VS Code model route failed and no affordable provider key is saved.',
                                        `Harmony can rescue this turn with a premium provider: ${premiumAvailable.map(providerLabelFor).join(', ')}. Premium API rates may apply — continue?`
                                    ].join('\n\n'),
                                    options: premiumAvailable.map(p => ({ label: providerLabelFor(p), description: 'Rescue this turn with this premium provider.' })),
                                    allowFreeformInput: false
                                }, token),
                                60000
                            );
                            const picked = premiumAvailable.find(p => providerLabelFor(p) === choice);
                            if (picked) {
                                fbProvider = picked;
                                fbKey = await context.secrets.get(secretKeyFor(picked));
                            }
                        }
                    }
                    if (!fbProvider || !fbKey) {
                        stream.markdown(
                            `\n\n> ⚠️ VS Code model route failed and no direct provider could be selected for an auto-rescue.\n\n` +
                            `> Error: ${classified.message}\n\n` +
                            `> Save a provider key (Command Palette → **Harmony: Set DeepSeek API Key** or any provider) to enable automatic direct-API fallback.`
                        );
                        throw lmError;
                    }
                    const fbRoute = directPrimaryRoute(fbProvider);
                    stream.markdown(`\n\n> 🔁 VS Code model route failed — rerouting this turn to **${fbRoute.label} (${fbRoute.model})** direct API.\n\n`);
                    turnOutcome = await runDeepSeekAgent(decorated, chatContext, stream, token, profile, context, forceReadOnly, fbKey, fbRoute);
                }
            }

            await tryMemoryStore(profile.id, request.prompt, turnOutcome.finalText);
            await appendMemory({
                ts: new Date().toISOString(),
                profile: profile.id,
                prompt: request.prompt,
                response: turnOutcome.finalText
            });

            // Auto-continuity: silently capture what Harmony did after every real agent turn.
            // Only fires for non-trivial responses and non-slash-command turns.
            // No model call, no network — local disk only, $0.00.
            if (!request.command && turnOutcome.finalText.length > 50) {
                const touchedFiles = (turnOutcome.result?.metadata?.functionCalls as any[] | undefined ?? [])
                    .filter((call: any) => call?.name && typeof call.name === 'string')
                    .flatMap((call: any) => {
                        const input = call.input ?? {};
                        return [input.path, input.file_path, input.filePath].filter((p: any) => typeof p === 'string' && p.length > 0);
                    })
                    .filter((p: string, i: number, arr: string[]) => arr.indexOf(p) === i)
                    .slice(0, 30);
                const summary = turnOutcome.finalText.replace(/\s+/g, ' ').slice(0, 400);
                appendContinuityEntry({
                    kind: 'note',
                    source: `harmony/${provider ?? 'vscode-lm'}`,
                    summary,
                    body: turnOutcome.finalText,
                    files: touchedFiles.length > 0 ? touchedFiles : undefined,
                    privacy: 'local',
                }).catch(() => { /* non-blocking: ignore continuity write failures */ });

                // Triple-Check Audit: auto-run single-pass audit when enabled
                const tripleCheckAuto = vscode.workspace.getConfiguration('harmony').get<boolean>('tripleCheck.autoReminder') ?? false;
                if (tripleCheckAuto && touchedFiles.length > 0) {
                    // Fire-and-forget: don't block the turn return
                    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
                    const userPrompt = request.prompt?.slice(0, 800) || '';
                    const auditToken = new vscode.CancellationTokenSource();
                    setTimeout(async () => {
                        try {
                            const { runAutoTripleCheckAudit } = await import('./deepSwarm');
                            const result = await runAutoTripleCheckAudit(
                                context.secrets, touchedFiles, userPrompt, wsFolder, auditToken.token
                            );
                            if (!result) return;

                            const icon = result.verdict === 'GO' ? '✅' : result.verdict === 'NO-GO' ? '🚨' : '⚠️';
                            const actions = result.verdict !== 'GO'
                                ? ['Run Full Audit', 'Dismiss']
                                : ['Dismiss'];

                            const choice = await vscode.window.showInformationMessage(
                                `${icon} Triple-Check: ${result.summary}${result.urgentIssues.length ? ` (${result.urgentIssues.length} urgent)` : ''}`,
                                ...actions
                            );
                            if (choice === 'Run Full Audit') {
                                // Save audit summary so the pipeline runner can pre-fill the focus input
                                context.workspaceState.update('harmony.lastAuditSummary', result.summary).then(undefined, () => {});
                                await vscode.commands.executeCommand('harmony.runDeepSwarm', 'triple-check');
                            }
                        } catch { /* non-blocking */ }
                    }, 500);
                }
            }

            // Context persistence verifier (Approach C): cross-check planned vs actual
            const swarmVerifier = vscode.workspace.getConfiguration('harmony').get<boolean>('contextPersistence.swarmVerifier') ?? false;
            if (swarmVerifier && !request.command) {
                try {
                    const { runVerifierCheck } = await import('./verifier');
                    const report = await runVerifierCheck();
                    if (report) {
                        stream.markdown('\n\n---\n\n' + report + '\n\n');
                    }
                } catch { /* non-blocking: ignore verifier failures */ }
            }

            return turnOutcome.result;
        } catch (e: any) {
            const classified = classifyParticipantError(e, token);
            const showDiagnostics = vscode.workspace.getConfiguration('harmony').get<boolean>('showDiagnosticsOnError') ?? true;
            const prefix = classified.showDiagnostics ? 'Harmony error' : 'Harmony';
            stream.markdown(`\n\n_${prefix}: ${classified.message}_` + (showDiagnostics && classified.showDiagnostics ? diagnosticBlock({
                provider,
                modelLabel,
                profile: profile.id,
                forceReadOnly,
                command: request.command,
                error: classified.diagnosticError
            }) : ''));
            console.error('[Harmony] participant error', e);
        }
    };

    const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'harmony-icon.svg');

    context.subscriptions.push(participant);
    return participant;
}
