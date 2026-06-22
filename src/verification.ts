import * as vscode from 'vscode';
import * as cp from 'child_process';
import { appendContinuityEntry } from './continuity';

export interface VerificationResult {
    ok: boolean;
    command: string;
    purpose: string;
    durationMs: number;
    exitCode?: number | string;
    timedOut: boolean;
    output: string;
}

const MAX_VERIFICATION_OUTPUT = 32000;
let verificationQueue: Promise<void> = Promise.resolve();

function workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function clip(text: string): string {
    if (text.length <= MAX_VERIFICATION_OUTPUT) return text;
    return text.slice(0, MAX_VERIFICATION_OUTPUT) + `\n...[verification output truncated ${text.length - MAX_VERIFICATION_OUTPUT} chars]`;
}

async function withVerificationLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = verificationQueue;
    let release!: () => void;
    verificationQueue = new Promise<void>(resolve => { release = resolve; });
    await previous.catch(() => undefined);
    try {
        return await fn();
    } finally {
        release();
    }
}

export function defaultVerificationCommand(): string {
    return vscode.workspace.getConfiguration('harmony').get<string>('verification.command')?.trim() || 'npm run compile';
}

export function defaultVerificationTimeoutSec(): number {
    const value = vscode.workspace.getConfiguration('harmony').get<number>('verification.timeoutSec') ?? 180;
    return Math.max(5, Math.min(1800, Math.floor(value)));
}

export async function runVerification(command: string, purpose = 'verification', timeoutSec = defaultVerificationTimeoutSec()): Promise<VerificationResult> {
    return await withVerificationLock(async () => {
        const cwd = workspaceRoot();
        const started = Date.now();
        const resolvedCommand = command.trim() || defaultVerificationCommand();
        const result = await new Promise<VerificationResult>((resolve) => {
            const proc = cp.exec(resolvedCommand, {
                cwd,
                timeout: timeoutSec * 1000,
                windowsHide: true,
                maxBuffer: 10 * 1024 * 1024,
            }, (error, stdout, stderr) => {
                const output = clip([stdout, stderr ? `[stderr]\n${stderr}` : ''].filter(Boolean).join('\n')) || '(no output)';
                const timedOut = !!(error as any)?.killed || /timed out|timeout/i.test(String(error?.message ?? ''));
                resolve({
                    ok: !error,
                    command: resolvedCommand,
                    purpose,
                    durationMs: Date.now() - started,
                    exitCode: (error as any)?.code,
                    timedOut,
                    output,
                });
            });
            proc.on('error', (error) => resolve({
                ok: false,
                command: resolvedCommand,
                purpose,
                durationMs: Date.now() - started,
                timedOut: false,
                output: error.message,
            }));
        });

        await appendContinuityEntry({
            kind: 'verification',
            source: 'harmony.runFailFix',
            summary: `${result.ok ? 'PASS' : 'FAIL'} ${result.command}`,
            body: [
                `Purpose: ${result.purpose}`,
                `Command: ${result.command}`,
                `Duration: ${result.durationMs}ms`,
                `Exit code: ${result.exitCode ?? (result.ok ? 0 : 'unknown')}`,
                `Timed out: ${result.timedOut ? 'yes' : 'no'}`,
                '',
                result.output,
            ].join('\n'),
            nextActions: result.ok
                ? ['Continue to the next planned slice.']
                : ['Feed this failure output back into the active model, apply one focused fix, then run verification again.'],
            privacy: 'local',
            metadata: { ok: result.ok, command: result.command, durationMs: result.durationMs, exitCode: result.exitCode, timedOut: result.timedOut },
        });

        return result;
    });
}