/**
 * exoskeleton/taskSpine.ts — Task Spine: persistent state that survives compaction.
 *
 * The Spine is the single source of truth for task state. One read restores
 * full situational awareness. Compaction can wipe context; the Spine endures.
 *
 * State file: .harmony/spine.json (machine-readable)
 * Mirror file: .harmony/spine.md (human-readable TASK.md format)
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SPINE_JSON_PATH, SPINE_MD_PATH, SPINE_VERSION } from './constants';

export interface SpineChecklistItem {
    label: string;
    checked: boolean;
}

export interface SpineDecomposition {
    subQuestions: string[];
    independenceClaim: string;
    mergePlan: string;
}

export interface SpineBlocked {
    reason: string;
    failingOutput: string;  // redacted
    attempts: number;
    hypothesis: string;
    resolution?: string;     // operator-dated line required to resume
    resolvedAt?: string;
}

export interface SpineOracleAttempt {
    signature: string;
    count: number;
    lastAttempt: string;  // ISO timestamp
}

export interface TaskSpine {
    version: string;
    taskGoal: string;
    intent: string;
    nextAction: string;
    checklist: SpineChecklistItem[];
    decomposition?: SpineDecomposition;
    oracleAttempts: SpineOracleAttempt[];
    decisionsLog: { date: string; decision: string }[];
    openQuestions: string[];
    blocked?: SpineBlocked;
    createdAt: string;
    updatedAt: string;
    phase: number;
}

/** Get the workspace root path. */
function workspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

/** Full path to spine.json */
function spineJsonPath(): string {
    return path.join(workspaceRoot(), SPINE_JSON_PATH);
}

/** Full path to spine.md */
function spineMdPath(): string {
    return path.join(workspaceRoot(), SPINE_MD_PATH);
}

/** Ensure .harmony directory exists. */
function ensureHarmonyDir(): void {
    const dir = path.join(workspaceRoot(), '.harmony');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/** Read the current spine state. Returns undefined if not initialized. */
export function readSpine(): TaskSpine | undefined {
    const p = spineJsonPath();
    if (!fs.existsSync(p)) return undefined;
    try {
        const raw = fs.readFileSync(p, 'utf-8');
        return JSON.parse(raw) as TaskSpine;
    } catch {
        return undefined;
    }
}

/** Write spine state to JSON + generate human-readable Markdown mirror. */
export function writeSpine(spine: TaskSpine): void {
    ensureHarmonyDir();
    spine.updatedAt = new Date().toISOString();
    fs.writeFileSync(spineJsonPath(), JSON.stringify(spine, null, 2), 'utf-8');
    fs.writeFileSync(spineMdPath(), spineToMarkdown(spine), 'utf-8');
}

/** Initialize a new task spine. */
export function initSpine(taskGoal: string, intent: string, checklist: string[]): TaskSpine {
    const now = new Date().toISOString();
    const spine: TaskSpine = {
        version: SPINE_VERSION,
        taskGoal,
        intent,
        nextAction: '',
        checklist: checklist.map(label => ({ label, checked: false })),
        oracleAttempts: [],
        decisionsLog: [],
        openQuestions: [],
        createdAt: now,
        updatedAt: now,
        phase: 1,
    };
    writeSpine(spine);
    return spine;
}

/** Update fields on an existing spine. Merges partial updates. */
export function updateSpine(updates: Partial<TaskSpine>): TaskSpine | undefined {
    const current = readSpine();
    if (!current) return undefined;
    const updated = { ...current, ...updates, updatedAt: new Date().toISOString() };
    writeSpine(updated);
    return updated;
}

/** Check off a checklist item by index (0-based). */
export function checkChecklistItem(index: number): TaskSpine | undefined {
    const spine = readSpine();
    if (!spine || index < 0 || index >= spine.checklist.length) return spine;
    spine.checklist[index].checked = true;
    writeSpine(spine);
    return spine;
}

/** Record a decision in the decisions log. */
export function recordDecision(decision: string): TaskSpine | undefined {
    const spine = readSpine();
    if (!spine) return undefined;
    spine.decisionsLog.push({ date: new Date().toISOString(), decision });
    writeSpine(spine);
    return spine;
}

/** Write the BLOCKED artifact — halts task progression. */
export function blockTask(reason: string, failingOutput: string, attempts: number, hypothesis: string): TaskSpine | undefined {
    const spine = readSpine();
    if (!spine) return undefined;
    spine.blocked = {
        reason,
        failingOutput,
        attempts,
        hypothesis,
    };
    writeSpine(spine);
    return spine;
}

/** Resolve a BLOCKED state — requires operator-dated resolution line. */
export function resolveBlock(resolution: string): TaskSpine | undefined {
    const spine = readSpine();
    if (!spine || !spine.blocked) return spine;
    spine.blocked.resolution = resolution;
    spine.blocked.resolvedAt = new Date().toISOString();
    writeSpine(spine);
    return spine;
}

/** Update or create an oracle attempt record for a failure signature. */
export function recordOracleAttempt(signature: string): SpineOracleAttempt | undefined {
    const spine = readSpine();
    if (!spine) return undefined;
    const existing = spine.oracleAttempts.find(a => a.signature === signature);
    if (existing) {
        existing.count++;
        existing.lastAttempt = new Date().toISOString();
    } else {
        const attempt: SpineOracleAttempt = {
            signature,
            count: 1,
            lastAttempt: new Date().toISOString(),
        };
        spine.oracleAttempts.push(attempt);
    }
    writeSpine(spine);
    return spine.oracleAttempts.find(a => a.signature === signature);
}

/** Get the current attempt count for a signature. */
export function getAttemptCount(signature: string): number {
    const spine = readSpine();
    if (!spine) return 0;
    return spine.oracleAttempts.find(a => a.signature === signature)?.count ?? 0;
}

/** Restore read — returns the critical restore info in priority order. */
export interface RestoreSummary {
    intent: string;
    nextAction: string;
    blocked: boolean;
    blockedInfo?: SpineBlocked;
    checklistProgress: { done: number; total: number };
    phase: number;
    oracleAttemptCount: number;
}

export function restoreSpine(): RestoreSummary | undefined {
    const spine = readSpine();
    if (!spine) return undefined;
    const done = spine.checklist.filter(c => c.checked).length;
    return {
        intent: spine.intent,
        nextAction: spine.nextAction,
        blocked: !!spine.blocked && !spine.blocked.resolvedAt,
        blockedInfo: spine.blocked?.resolvedAt ? undefined : spine.blocked,
        checklistProgress: { done, total: spine.checklist.length },
        phase: spine.phase,
        oracleAttemptCount: spine.oracleAttempts.reduce((sum, a) => sum + a.count, 0),
    };
}

/** Convert spine to human-readable Markdown (TASK.md format). */
function spineToMarkdown(spine: TaskSpine): string {
    const lines: string[] = [];
    lines.push(`# TASK: ${spine.taskGoal}`);
    lines.push('');
    lines.push('## Intent');
    lines.push(spine.intent || '_(not set)_');
    lines.push('');
    lines.push('## Hard Invariants (never violate)');
    lines.push('- _(add invariants as needed)_');
    lines.push('');
    lines.push('## Next Action');
    lines.push(spine.nextAction || '_(not set — define the single next physical action)_');
    lines.push('');
    lines.push('## Checklist');
    for (const item of spine.checklist) {
        lines.push(`- [${item.checked ? 'x' : ' '}] ${item.label}`);
    }
    lines.push('');

    if (spine.decomposition) {
        lines.push('## Decomposition');
        lines.push(`- Sub-questions: ${spine.decomposition.subQuestions.join('; ')}`);
        lines.push(`- Independence claim: ${spine.decomposition.independenceClaim}`);
        lines.push(`- Merge plan: ${spine.decomposition.mergePlan}`);
        lines.push('');
    }

    if (spine.oracleAttempts.length > 0) {
        lines.push('## Oracle Attempts');
        for (const a of spine.oracleAttempts) {
            lines.push(`- ${a.signature} x${a.count} (last: ${a.lastAttempt})`);
        }
        lines.push('');
    }

    if (spine.decisionsLog.length > 0) {
        lines.push('## Decisions Log');
        for (const d of spine.decisionsLog) {
            lines.push(`- ${d.date} — ${d.decision}`);
        }
        lines.push('');
    }

    if (spine.openQuestions.length > 0) {
        lines.push('## Open Questions');
        for (const q of spine.openQuestions) {
            lines.push(`- ${q}`);
        }
        lines.push('');
    }

    if (spine.blocked) {
        lines.push('## BLOCKED');
        lines.push(`- Reason: ${spine.blocked.reason}`);
        lines.push(`- Attempts: ${spine.blocked.attempts}`);
        lines.push(`- Hypothesis: ${spine.blocked.hypothesis}`);
        if (spine.blocked.resolution) {
            lines.push(`- Resolution: ${spine.blocked.resolution} (resolved: ${spine.blocked.resolvedAt})`);
        } else {
            lines.push('- Resolution: _(operator must add a dated line to resume)_');
        }
        lines.push('');
    }

    lines.push(`## Last Updated: ${spine.updatedAt} | Phase: ${spine.phase}`);
    return lines.join('\n');
}
