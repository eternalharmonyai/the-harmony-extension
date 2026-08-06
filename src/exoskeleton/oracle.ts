/**
 * exoskeleton/oracle.ts — Verification Oracle with stop-rule and halt protocol.
 *
 * The pilot never judges whether something works. It runs something that tells it.
 * This wrapper adds: failure signature hashing, persisted counter (survives
 * compaction), nudge at 3, halt at 5, flaky quarantine, and BLOCKED artifact.
 *
 * Exit codes: 0=pass, 1=fail (try again), 2=HALT or QUARANTINED.
 */

import * as vscode from 'vscode';
import {
    MAX_ORACLE_ATTEMPTS,
    NUDGE_AT,
    ORACLE_TIMEOUT_MS,
    ORACLE_TARGET_MS,
} from './constants';
import {
    runCommand,
    normalizeOutput,
    hashFailureSignature,
    redactSecrets,
} from './utils';
import {
    recordOracleAttempt,
    getAttemptCount,
    blockTask,
    readSpine,
} from './taskSpine';

export type OracleOutcome = 'PASS' | 'FAIL' | 'HALT' | 'QUARANTINED' | 'TIMEOUT';

export interface OracleResult {
    outcome: OracleOutcome;
    exitCode: number;        // 0=pass, 1=fail, 2=halt/quarantined
    signature: string;       // failure signature hash (empty on pass)
    attemptCount: number;    // attempts on this signature
    nudge: boolean;          // replan nudge printed?
    output: string;          // raw command output (redacted on halt)
    durationMs: number;
    flakyQuarantined: boolean;
    message: string;         // human-readable status
}

/** Flaky log path for non-deterministic check quarantine. */
function flakyLogPath(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const { join } = require('path');
    return join(root, '.harmony', 'oracle-flaky.log');
}

/**
 * Run the verification oracle with the full stop-rule machinery.
 *
 * @param command The command to run (e.g. "npm")
 * @param args Command arguments (e.g. ["test"])
 * @param purpose Why this oracle run (for logging)
 * @param cwd Working directory (defaults to workspace root)
 */
export async function runOracle(
    command: string,
    args: string[],
    purpose: string,
    cwd?: string
): Promise<OracleResult> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const workDir = cwd ?? workspaceRoot;

    // Run the command with timeout
    const result = await runCommand(command, args, {
        cwd: workDir,
        timeoutMs: ORACLE_TIMEOUT_MS,
    });

    // PASS — oracle passed
    if (result.exitCode === 0 && !result.timedOut) {
        return {
            outcome: 'PASS',
            exitCode: 0,
            signature: '',
            attemptCount: 0,
            nudge: false,
            output: result.stdout,
            durationMs: result.durationMs,
            flakyQuarantined: false,
            message: `✅ Oracle PASSED (${result.durationMs}ms) — ${purpose}`,
        };
    }

    // TIMEOUT — distinct failure signature
    if (result.timedOut) {
        const sig = 'TIMEOUT';
        return {
            outcome: 'TIMEOUT',
            exitCode: 1,
            signature: sig,
            attemptCount: 0,
            nudge: false,
            output: `Command timed out after ${ORACLE_TIMEOUT_MS}ms`,
            durationMs: result.durationMs,
            flakyQuarantined: false,
            message: `⏱️ Oracle TIMEOUT (${ORACLE_TIMEOUT_MS}ms) — ${purpose}`,
        };
    }

    // FAIL — compute failure signature and track attempts
    const combinedOutput = result.stdout + '\n' + result.stderr;
    const normalized = normalizeOutput(combinedOutput, workspaceRoot);
    const signature = hashFailureSignature(normalized);

    // Record attempt in spine (persists across compaction)
    const attempt = recordOracleAttempt(signature);
    const attemptCount = attempt?.count ?? getAttemptCount(signature) + 1;

    // NUDGE at 3 (non-blocking)
    const nudge = attemptCount === NUDGE_AT;

    // HALT at MAX_ORACLE_ATTEMPTS
    if (attemptCount >= MAX_ORACLE_ATTEMPTS) {
        const redactedOutput = redactSecrets(combinedOutput).slice(0, 2000);
        const spine = readSpine();
        const taskGoal = spine?.taskGoal ?? 'unknown task';
        const hypothesis = `Same failure signature ${signature} hit ${attemptCount} times`;

        blockTask(
            `Oracle failed ${attemptCount}x on signature ${signature}`,
            redactedOutput,
            attemptCount,
            hypothesis
        );

        return {
            outcome: 'HALT',
            exitCode: 2,
            signature,
            attemptCount,
            nudge: false,
            output: redactedOutput,
            durationMs: result.durationMs,
            flakyQuarantined: false,
            message: `🛑 HALT: Oracle failed ${attemptCount}x on signature ${signature}. BLOCKED artifact written to spine. Operator resolution required.\nTask: ${taskGoal}\nHypothesis: ${hypothesis}`,
        };
    }

    // Regular FAIL (attempt < halt threshold)
    const nudgeMessage = nudge
        ? `\n💡 NUDGE: This is attempt ${attemptCount} on the same failure. Consider replanning your approach before retrying.`
        : '';

    return {
        outcome: 'FAIL',
        exitCode: 1,
        signature,
        attemptCount,
        nudge,
        output: combinedOutput,
        durationMs: result.durationMs,
        flakyQuarantined: false,
        message: `❌ Oracle FAILED (attempt ${attemptCount}/${MAX_ORACLE_ATTEMPTS}, ${result.durationMs}ms, sig: ${signature}) — ${purpose}${nudgeMessage}`,
    };
}

/**
 * Detect flaky checks — if the same check returns both exit 0 and exit 1
 * on unchanged code, quarantine it.
 */
export function logFlakyCheck(checkName: string, details: string): void {
    const fs = require('fs');
    const { join } = require('path');
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const dir = join(root, '.harmony');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const logPath = flakyLogPath();
    const entry = `[${new Date().toISOString()}] QUARANTINED: ${checkName} — ${details}\n`;
    fs.appendFileSync(logPath, entry, 'utf-8');
}
