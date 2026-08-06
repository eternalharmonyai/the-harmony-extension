/**
 * exoskeleton/utils.ts — Cross-platform utilities for the Exoskeleton system.
 *
 * No shell scripts. All logic in TypeScript/Node for Windows + Unix.
 */

import * as cp from 'child_process';
import * as path from 'path';
import * as crypto from 'crypto';
import { SECRET_PATTERNS } from './constants';

/**
 * Run a command cross-platform, returning stdout+stderr, exit code, and duration.
 * Uses arg arrays (never shell:true) for safety and Windows compatibility.
 */
export interface CommandResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
    timedOut: boolean;
}

export async function runCommand(
    command: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }
): Promise<CommandResult> {
    const t0 = Date.now();
    const timeoutMs = options?.timeoutMs ?? 60_000;

    // Windows needs .cmd suffix for npm/npx/etc.
    const resolvedCommand = process.platform === 'win32'
        ? (command.endsWith('.cmd') ? command : `${command}.cmd`)
        : command;

    return new Promise((resolve) => {
        const proc = cp.spawn(resolvedCommand, args, {
            cwd: options?.cwd,
            env: { ...process.env, ...options?.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            proc.kill('SIGTERM');
            // Force-kill after grace period
            setTimeout(() => {
                if (!proc.killed) proc.kill('SIGKILL');
            }, 3000);
        }, timeoutMs);

        proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

        proc.on('close', (code) => {
            clearTimeout(timer);
            resolve({
                stdout,
                stderr,
                exitCode: code ?? (timedOut ? 124 : 1),
                durationMs: Date.now() - t0,
                timedOut,
            });
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            resolve({
                stdout,
                stderr: stderr + '\n' + (err.message || String(err)),
                exitCode: 1,
                durationMs: Date.now() - t0,
                timedOut,
            });
        });
    });
}

/**
 * Strip ANSI escape codes from command output.
 */
export function stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Normalize command output for failure signature hashing.
 * Strips ANSI, normalizes line endings, normalizes paths, strips whitespace.
 */
export function normalizeOutput(text: string, workspaceRoot?: string): string {
    let result = stripAnsi(text);
    // Normalize line endings
    result = result.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // Normalize backslashes to forward slashes
    result = result.replace(/\\/g, '/');
    // Replace workspace root with <root> placeholder
    if (workspaceRoot) {
        const normalizedRoot = workspaceRoot.replace(/\\/g, '/');
        result = result.split(normalizedRoot).join('<root>');
    }
    // Strip trailing whitespace per line
    result = result.split('\n').map(l => l.trimEnd()).join('\n');
    // Collapse multiple blank lines
    result = result.replace(/\n{3,}/g, '\n\n');
    return result.trim();
}

/**
 * Hash a normalized failure signature using SHA-256.
 * Same bug → same hash; new bug → new hash.
 */
export function hashFailureSignature(normalizedOutput: string): string {
    return crypto.createHash('sha256').update(normalizedOutput).digest('hex').slice(0, 12);
}

/**
 * Estimate token count from character count (chars/4 heuristic).
 * Always measurable, no API calls needed.
 */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/**
 * Normalize a file path to POSIX-style for cross-platform comparison.
 */
export function normalizePath(p: string): string {
    return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

/**
 * Check if a path is within any of the protected path prefixes.
 */
export function isProtectedPath(filePath: string, protectedPaths: readonly string[]): boolean {
    const normalized = normalizePath(filePath);
    return protectedPaths.some(pp => {
        const normalizedPp = pp.toLowerCase();
        return normalized.includes(normalizedPp);
    });
}

/**
 * Redact secrets from text using the SECRET_PATTERNS list.
 * Used before writing failure output to BLOCKED artifacts.
 */
export function redactSecrets(text: string): string {
    let result = text;
    for (const pattern of SECRET_PATTERNS) {
        result = result.replace(pattern, (match) => {
            // Show first 4 + last 4 chars, redact middle
            if (match.length <= 12) return '***REDACTED***';
            return match.slice(0, 4) + '***REDACTED***' + match.slice(-4);
        });
    }
    return result;
}

/**
 * Extract the checklist section from a Markdown spine file and compute its hash.
 * Used by the freshness gate: the checklist MUST change for a phase transition.
 */
export function hashChecklistSection(spineMdContent: string): string {
    // Extract content between ## Checklist and the next ## heading
    const match = spineMdContent.match(/## Checklist\s*\n([\s\S]*?)(?=\n## |$)/);
    const checklistContent = match ? match[1].trim() : '';
    return crypto.createHash('sha256').update(checklistContent).digest('hex').slice(0, 12);
}

/**
 * Check if the checklist has any completed items ([x]).
 */
export function hasChecklistProgress(spineMdContent: string): boolean {
    return /\[x\]/i.test(spineMdContent);
}
