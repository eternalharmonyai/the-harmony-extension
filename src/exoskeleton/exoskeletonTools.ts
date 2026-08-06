/**
 * exoskeleton/exoskeletonTools.ts — VS Code LanguageModelTool wrappers for
 * the Exoskeleton system. Registers 4 tools that expose all 6 modules:
 *
 *   harmony_spine     → Task Spine (persistent state)
 *   harmony_oracle    → Verification Oracle (stop-rule, halt, BLOCKED)
 *   harmony_guard     → Enforcement Hooks (secrets, protected paths, pre-commit)
 *   harmony_dispatch  → Specialist Dispatch (return contracts, adjudication)
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import {
    initSpine,
    readSpine,
    updateSpine,
    checkChecklistItem,
    recordDecision,
    restoreSpine,
    type TaskSpine,
} from './taskSpine';

import {
    runOracle,
    logFlakyCheck,
    type OracleResult,
} from './oracle';

import {
    scanForSecrets,
    checkProtectedPaths,
    budgetLint,
    installPreCommitHook,
    type ScanResult,
} from './hooks';

import {
    validateReturn,
    saveFullReport,
    detectConflicts,
    type DispatchReturn,
    type ConflictRecord,
} from './dispatch';

// ── Helpers ──────────────────────────────────────────────────────────

const MAX_RESULT_CHARS = 60_000;

function clip(text: string): string {
    if (text.length <= MAX_RESULT_CHARS) return text;
    return text.slice(0, MAX_RESULT_CHARS) + `\n...[truncated, ${text.length - MAX_RESULT_CHARS} more chars]`;
}

function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(clip(text))]);
}

function jsonResult(value: unknown): vscode.LanguageModelToolResult {
    return textResult(JSON.stringify(value, null, 2));
}

function workspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

function resolveWorkspacePath(relPath: string): string | undefined {
    const root = workspaceRoot();
    if (!root) return undefined;
    return path.resolve(root, relPath || '.');
}

// ── 1. Task Spine Tool ───────────────────────────────────────────────

interface SpineInput {
    action: 'init' | 'read' | 'restore' | 'update' | 'check' | 'decision' | 'advance';
    taskGoal?: string;
    intent?: string;
    checklist?: string[];
    nextAction?: string;
    phase?: number;
    checkIndex?: number;
    decision?: string;
    openQuestions?: string[];
    decomposition?: {
        subQuestions: string[];
        independenceClaim: string;
        mergePlan: string;
    };
}

class TaskSpineTool implements vscode.LanguageModelTool<SpineInput> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<SpineInput>
    ): Promise<vscode.PreparedToolInvocation> {
        const action = options.input.action ?? 'read';
        return {
            invocationMessage: `Task Spine: ${action}`,
        };
    }

    async invoke(options: vscode.LanguageModelToolInvocationOptions<SpineInput>): Promise<vscode.LanguageModelToolResult> {
        const action = options.input.action ?? 'read';

        switch (action) {
            case 'init': {
                const taskGoal = options.input.taskGoal ?? '';
                const intent = options.input.intent ?? '';
                const checklist = options.input.checklist ?? [];
                if (!taskGoal) return textResult('❌ taskGoal is required for init.');
                const spine = initSpine(taskGoal, intent, checklist);
                return jsonResult({ ok: true, action: 'init', spine });
            }
            case 'read': {
                const spine = readSpine();
                if (!spine) return textResult('No spine initialized. Use action:"init" to create one.');
                return jsonResult({ spine });
            }
            case 'restore': {
                const summary = restoreSpine();
                if (!summary) return textResult('No spine to restore.');
                return jsonResult({ summary });
            }
            case 'update': {
                const updates: Partial<TaskSpine> = {};
                if (options.input.nextAction !== undefined) updates.nextAction = options.input.nextAction;
                if (options.input.phase !== undefined) updates.phase = options.input.phase;
                if (options.input.openQuestions !== undefined) updates.openQuestions = options.input.openQuestions;
                if (options.input.decomposition !== undefined) updates.decomposition = options.input.decomposition;
                if (options.input.intent !== undefined) updates.intent = options.input.intent;
                const spine = updateSpine(updates);
                if (!spine) return textResult('No spine initialized. Use action:"init" first.');
                return jsonResult({ ok: true, action: 'update', spine });
            }
            case 'check': {
                const idx = options.input.checkIndex ?? -1;
                const spine = checkChecklistItem(idx);
                if (!spine) return textResult('No spine or invalid index.');
                const done = spine.checklist.filter(c => c.checked).length;
                return jsonResult({ ok: true, action: 'check', checkedIndex: idx, progress: `${done}/${spine.checklist.length}`, spine });
            }
            case 'decision': {
                const decision = options.input.decision ?? '';
                if (!decision) return textResult('❌ decision text is required.');
                const spine = recordDecision(decision);
                if (!spine) return textResult('No spine initialized. Use action:"init" first.');
                return jsonResult({ ok: true, action: 'decision', decision, total: spine.decisionsLog.length });
            }
            case 'advance': {
                const spine = readSpine();
                if (!spine) return textResult('No spine initialized.');
                const newPhase = (options.input.phase ?? spine.phase + 1);
                const updated = updateSpine({ phase: newPhase });
                return jsonResult({ ok: true, action: 'advance', oldPhase: spine.phase, newPhase, spine: updated });
            }
            default:
                return textResult(`❌ Unknown action: ${action}. Valid: init, read, restore, update, check, decision, advance.`);
        }
    }
}

// ── 2. Verification Oracle Tool ──────────────────────────────────────

interface OracleInput {
    command: string;
    args?: string[];
    purpose: string;
    cwd?: string;
    flakyCheckName?: string;
    flakyDetails?: string;
}

class OracleTool implements vscode.LanguageModelTool<OracleInput> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<OracleInput>
    ): Promise<vscode.PreparedToolInvocation> {
        const cmd = options.input.command ?? '(no command)';
        return {
            invocationMessage: `Oracle: ${cmd}`,
        };
    }

    async invoke(options: vscode.LanguageModelToolInvocationOptions<OracleInput>): Promise<vscode.LanguageModelToolResult> {
        // Flaky check logging (separate from oracle run)
        if (options.input.flakyCheckName) {
            logFlakyCheck(options.input.flakyCheckName, options.input.flakyDetails ?? '');
            return jsonResult({ ok: true, action: 'flaky-quarantine', checkName: options.input.flakyCheckName });
        }

        const command = options.input.command;
        const args = options.input.args ?? [];
        const purpose = options.input.purpose ?? 'oracle verification';
        const cwd = options.input.cwd ? resolveWorkspacePath(options.input.cwd) : undefined;

        if (!command) return textResult('❌ command is required.');

        const result: OracleResult = await runOracle(command, args, purpose, cwd);
        return jsonResult({ result });
    }
}

// ── 3. Enforcement Guard Tool ────────────────────────────────────────

interface GuardInput {
    action: 'scan' | 'protected' | 'budget' | 'install-hook';
    files?: { path: string; content: string }[];
    paths?: string[];
    spineMdContent?: string;
    ratchetContents?: string[];
}

class GuardTool implements vscode.LanguageModelTool<GuardInput> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GuardInput>
    ): Promise<vscode.PreparedToolInvocation> {
        const action = options.input.action ?? 'scan';
        return {
            invocationMessage: `Guard: ${action}`,
        };
    }

    async invoke(options: vscode.LanguageModelToolInvocationOptions<GuardInput>): Promise<vscode.LanguageModelToolResult> {
        const action = options.input.action ?? 'scan';

        switch (action) {
            case 'scan': {
                const files = options.input.files ?? [];
                if (files.length === 0) return textResult('❌ files[] with {path, content} required for scan.');
                const result: ScanResult = scanForSecrets(files);
                return jsonResult({ result });
            }
            case 'protected': {
                const paths = options.input.paths ?? [];
                if (paths.length === 0) return textResult('❌ paths[] required for protected check.');
                const violations = checkProtectedPaths(paths);
                return jsonResult({ violations, count: violations.length });
            }
            case 'budget': {
                const spineMd = options.input.spineMdContent ?? '';
                const ratchet = options.input.ratchetContents ?? [];
                const result = budgetLint(spineMd, ratchet);
                return jsonResult({ result });
            }
            case 'install-hook': {
                const result = await installPreCommitHook();
                return jsonResult({ result });
            }
            default:
                return textResult(`❌ Unknown action: ${action}. Valid: scan, protected, budget, install-hook.`);
        }
    }
}

// ── 4. Specialist Dispatch Tool ──────────────────────────────────────

interface DispatchInput {
    action: 'validate' | 'conflicts';
    specialistId: string;
    taskId: string;
    rawReturn?: string;
    returns?: string[];  // for conflicts: raw returns from multiple specialists
}

class DispatchTool implements vscode.LanguageModelTool<DispatchInput> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<DispatchInput>
    ): Promise<vscode.PreparedToolInvocation> {
        const action = options.input.action ?? 'validate';
        return {
            invocationMessage: `Dispatch ${action}: ${options.input.specialistId ?? '?'}`,
        };
    }

    async invoke(options: vscode.LanguageModelToolInvocationOptions<DispatchInput>): Promise<vscode.LanguageModelToolResult> {
        const action = options.input.action ?? 'validate';
        const specialistId = options.input.specialistId;
        const taskId = options.input.taskId;

        switch (action) {
            case 'validate': {
                const rawReturn = options.input.rawReturn ?? '';
                if (!rawReturn) return textResult('❌ rawReturn required for validate.');
                const result: DispatchReturn = validateReturn(rawReturn, specialistId, taskId);
                const reportPath = saveFullReport(result);
                return jsonResult({ result, reportPath });
            }
            case 'conflicts': {
                const rawReturns = options.input.returns ?? [];
                if (rawReturns.length < 2) return textResult('❌ returns[] with 2+ entries required for conflicts.');
                const validated = rawReturns.map((raw, i) =>
                    validateReturn(raw, `${specialistId}-${i + 1}`, taskId)
                );
                const conflicts: ConflictRecord[] = detectConflicts(validated);
                return jsonResult({ conflicts, count: conflicts.length, validatedReturns: validated.length });
            }
            default:
                return textResult(`❌ Unknown action: ${action}. Valid: validate, conflicts.`);
        }
    }
}

// ── Registration ─────────────────────────────────────────────────────

export function registerExoskeletonTools(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.lm.registerTool('harmony_spine', new TaskSpineTool()),
        vscode.lm.registerTool('harmony_oracle', new OracleTool()),
        vscode.lm.registerTool('harmony_guard', new GuardTool()),
        vscode.lm.registerTool('harmony_dispatch', new DispatchTool()),
    );
}
