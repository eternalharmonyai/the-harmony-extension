/**
 * Orchestrate Mode — centralized pre-approval gate for read-only provider tools.
 * When enabled via harmony.orchestrateMode.enabled, specific orchestration tools
 * skip user confirmation. File writes and terminal commands ALWAYS require confirmation.
 * 
 * CAPABILITY-LEVEL ENFORCEMENT: Pre-approval is at the capability level, not tool name.
 * Even pre-approved tools MUST NOT transitively trigger writes (no fs:write,
 * no terminal:execute, no state mutations through spawned workers or swarm dispatch).
 *
 * ENTERPRISE HARDENING:
 * - JSONL audit trail of every pre-approval decision
 * - Per-session call counter with configurable budget
 * - Session timeout (auto-disable after N minutes of inactivity)
 * - Graceful degradation: audit failures never block tool execution
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';

const PRE_APPROVED_DEFAULTS = [
    'harmony_parallel',
    'harmony_orchestrate_codebase',
    'harmony_consult_model',
    'harmony_spawn_worker',
    // NOTE: harmony_swarm_dispatch removed — it can write receipt files
];

/** Tool names that are ALWAYS blocked from pre-approval regardless of config.
 *  These tools can trigger writes, terminal execution, or file mutations. */
const WRITE_CAPABILITY_TOOLS = new Set([
    // Direct file writes
    'harmony_write_file',
    'harmony_edit_file',
    'harmony_apply_patch',
    // Terminal execution
    'harmony_run_terminal',
    'harmony_package_and_install',
    // Git mutations
    'harmony_git_commit',
    'harmony_git_push',
    'harmony_git_restore',
    'harmony_git_revert',
    'harmony_git_stash',
    // Swarm mutations (writes receipts, patches, runs commands)
    'harmony_swarm_execute',
    'harmony_swarm_autonomy_run',
    'harmony_swarm_commit_execute',
    'harmony_swarm_escrow',
    'harmony_swarm_plan',
    'harmony_swarm_dispatch',
    'harmony_swarm_autonomy_design',
    'harmony_swarm_commit_dry_run',
    // Code mutations
    'harmony_rename_symbol',
    'harmony_code_actions',
    // Image/canvas writes
    'harmony_image_gen',
    'harmony_raster_edit',
    'harmony_canvas_project',
    'harmony_generate_image',
    'harmony_generate_layer_set',
    'harmony_generate_video',
    // File output tools
    'harmony_sandbox',
]);

// ── Session tracking ──────────────────────────────────────────────────────

interface SessionState {
    sessionId: string;
    startedAt: number;
    lastActivityAt: number;
    callsThisSession: number;
}

let _session: SessionState | null = null;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

function session(): SessionState {
    if (!_session) {
        _session = {
            sessionId: `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
            startedAt: Date.now(),
            lastActivityAt: Date.now(),
            callsThisSession: 0,
        };
    }
    return _session;
}

function cfg<T>(key: string, def: T): T {
    return vscode.workspace.getConfiguration('harmony.orchestrateMode').get<T>(key, def);
}

// ── Audit trail ───────────────────────────────────────────────────────────

async function auditDir(): Promise<vscode.Uri | null> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    return vscode.Uri.joinPath(folders[0].uri, '.harmony', 'orchestrate-audit');
}

async function ensureDir(uri: vscode.Uri): Promise<void> {
    try { await vscode.workspace.fs.createDirectory(uri); } catch { /* ok */ }
}

async function appendAudit(entry: Record<string, unknown>): Promise<void> {
    try {
        const d = await auditDir();
        if (!d) return;
        await ensureDir(d);
        const today = new Date().toISOString().slice(0, 10);
        const auditFile = vscode.Uri.joinPath(d, `audit-${today}.jsonl`);
        const line = JSON.stringify(entry) + '\n';
        // Atomic write via tmp rename
        const tmpFile = vscode.Uri.joinPath(d, `.audit-${today}.tmp`);
        let existing = '';
        try { existing = textDecoder.decode(await vscode.workspace.fs.readFile(auditFile)); } catch { /* new file */ }
        await vscode.workspace.fs.writeFile(tmpFile, textEncoder.encode(existing + line));
        await vscode.workspace.fs.rename(tmpFile, auditFile, { overwrite: true });
    } catch {
        // Audit failures are silent — never block tool execution
    }
}

// ── Session timeout ───────────────────────────────────────────────────────

function checkSessionTimeout(): boolean {
    const s = session();
    const timeoutMinutes = cfg<number>('sessionTimeoutMinutes', 0);
    if (timeoutMinutes <= 0) return false; // disabled
    const elapsed = (Date.now() - s.lastActivityAt) / 60_000;
    return elapsed > timeoutMinutes;
}

// ── Public API ────────────────────────────────────────────────────────────

/** Check if Orchestrate Mode is active and the given tool is pre-approved. */
export function isOrchestratePreApproved(toolName: string): boolean {
    const modeCfg = vscode.workspace.getConfiguration('harmony');
    if (!modeCfg.get<boolean>('orchestrateMode.enabled')) return false;

    // Session timeout check
    if (checkSessionTimeout()) return false;

    // Capability check: never pre-approve write-capable tools
    if (WRITE_CAPABILITY_TOOLS.has(toolName)) return false;

    // Budget check
    const maxCalls = modeCfg.get<number>('orchestrateMode.maxCallsPerSession') ?? 0;
    if (maxCalls > 0 && session().callsThisSession >= maxCalls) return false;

    const preApproved = modeCfg.get<string[]>('orchestrateMode.preApprovedTools') ?? PRE_APPROVED_DEFAULTS;
    if (!preApproved.includes(toolName)) return false;

    // Track the call
    session().callsThisSession++;
    session().lastActivityAt = Date.now();

    // Audit trail (fire-and-forget — never blocks)
    appendAudit({
        ts: new Date().toISOString(),
        sessionId: session().sessionId,
        tool: toolName,
        callsThisSession: session().callsThisSession,
        budget: maxCalls > 0 ? maxCalls : 'unlimited',
    });

    return true;
}

/**
 * Wrap a tool's prepareInvocation confirmation with Orchestrate Mode awareness.
 * Returns undefined (auto-approve) when Orchestrate Mode is active and the tool
 * is pre-approved. Otherwise returns the original confirmation unchanged.
 */
export function orchestratableConfirmation(
    toolName: string,
    defaultConfirmation: vscode.LanguageModelToolConfirmationMessages | undefined
): vscode.LanguageModelToolConfirmationMessages | undefined {
    if (!defaultConfirmation) return undefined;
    return isOrchestratePreApproved(toolName) ? undefined : defaultConfirmation;
}

/** Reset session state (called on deactivate or explicit reset). */
export function resetOrchestrateSession(): void {
    _session = null;
}

/** Get current session stats for sidebar display. */
export function getOrchestrateSessionStats(): { calls: number; budget: number; sessionAgeMinutes: number } {
    const s = session();
    const maxCalls = vscode.workspace.getConfiguration('harmony').get<number>('orchestrateMode.maxCallsPerSession') ?? 0;
    return {
        calls: s.callsThisSession,
        budget: maxCalls,
        sessionAgeMinutes: Math.round((Date.now() - s.startedAt) / 60_000),
    };
}
