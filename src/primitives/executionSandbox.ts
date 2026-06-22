/**
 * Execution Sandbox (Simulacrum) — 3-tier safe execution with ASYNC job queue.
 *
 * 100% upgrade: non-blocking run→job_id→result polling.
 *   - `run` returns a job_id immediately, writes job to .harmony/sandbox-jobs/
 *   - `result` polls for job completion, returns output when ready
 *   - `status` lists all jobs with timestamps and statuses
 *
 * @example
 *   // Run async:
 *   const { job_id } = invoke({ action: 'run', code: '5+3' });
 *   // Poll:
 *   invoke({ action: 'result', job_id });  // => { status: 'running' | 'complete', ... }
 */
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { workspaceRoot, textResult, ensureDir, uid } from './shared';
import { safeHarmonyDir } from '../swarmHarden';
import { BasePrimitive } from './basePrimitive';

const ALLOWED_LANGUAGES = ['javascript', 'typescript', 'python'];
const MAX_CODE_LENGTH = 10000;

interface ESandboxInput { action: 'run' | 'result' | 'status' | 'capabilities'; language?: string; code?: string; test?: string; timeout_sec?: number; memory_limit_mb?: number; job_id?: string; }

export class ExecutionSandboxTool extends BasePrimitive<ESandboxInput> {
    constructor() { super('execution-sandbox'); }
    protected async invokeImpl(options: vscode.LanguageModelToolInvocationOptions<ESandboxInput>, token: vscode.CancellationToken) {
        const fieldErr = this.requireFields(options.input as any, ['action']);
        if (fieldErr) return textResult(JSON.stringify({ error: fieldErr }));
        const { action, language = 'javascript', code, test, timeout_sec = 30, memory_limit_mb = 64 } = options.input;
        const root = workspaceRoot(); if (!root) return textResult(JSON.stringify({ error: 'no workspace' }));
        if (token.isCancellationRequested) return textResult(JSON.stringify({ error: 'cancelled', detail: 'Operation cancelled by user' }));
        
        switch (action) {
            case 'run': {
                if (!code) return textResult(JSON.stringify({ error: 'code required' }));
                if (!ALLOWED_LANGUAGES.includes(language)) return textResult(JSON.stringify({ error: `unsupported language '${language}'`, allowed: ALLOWED_LANGUAGES }));
                if (code.length > MAX_CODE_LENGTH) return textResult(JSON.stringify({ error: 'code too long', length: code.length, max: MAX_CODE_LENGTH }));
                // Sanity check: block obviously dangerous patterns
                const dangerous = ['require("child_process")', 'require("fs")', 'exec(', 'execSync(', 'spawn(', 'subprocess', '__import__("os")', '__import__("subprocess")'];
                for (const pattern of dangerous) { if (code.includes(pattern)) return textResult(JSON.stringify({ error: 'dangerous pattern detected', pattern })); }

                // Async job queue: write job file, fire execution, return job_id immediately
                const jobId = uid();
                const jobsDir = safeHarmonyDir(root, 'sandbox-jobs');
                await ensureDir(jobsDir);
                const jobFile = path.join(jobsDir, jobId + '.json');
                const job: any = {
                    job_id: jobId, action: 'run', language, code: code.slice(0, 200), test: test?.slice(0, 200),
                    status: 'queued', created_at: Date.now(), timeout_sec, memory_limit_mb
                };
                await fs.writeFile(jobFile, JSON.stringify(job, null, 2), 'utf-8');

                // Fire-and-forget async execution
                this.executeJobAsync(jobId, jobFile, code, test, language, timeout_sec, memory_limit_mb, root).catch(() => {});

                return textResult(JSON.stringify({ status: 'queued', job_id: jobId, note: 'Execution started asynchronously. Poll with action:result and job_id.' }, null, 2));
            }
            case 'result': {
                const jobId = options.input.job_id;
                if (!jobId) return textResult(JSON.stringify({ error: 'job_id required for result polling' }));
                const jobsDir = safeHarmonyDir(root, 'sandbox-jobs');
                const jobFile = path.join(jobsDir, jobId + '.json');
                let jobRaw: string;
                try { jobRaw = await fs.readFile(jobFile, 'utf-8'); } catch { return textResult(JSON.stringify({ error: 'job not found', job_id: jobId })); }
                const job = JSON.parse(jobRaw);
                if (job.status === 'running' || job.status === 'queued') {
                    return textResult(JSON.stringify({ status: 'running', job_id: jobId, note: 'Job still executing. Poll again.' }, null, 2));
                }
                // Return full result
                const elapsed_ms = job.completed_at ? job.completed_at - job.created_at : undefined;
                return textResult(JSON.stringify({
                    status: job.status, job_id: jobId, pass: job.pass, output: job.output?.slice(0, 4000),
                    error: job.error, tier: job.tier, metrics: job.metrics, diagnostics: job.diagnostics,
                    fallback_used: job.fallback_used, elapsed_ms,
                    note: job.tier === 1 ? 'Executed in isolated-vm (V8 isolate)' : job.tier === 2 ? 'Executed in Pyodide (CPython WASM)' : 'Executed in Windows Sandbox (Hyper-V VM)'
                }, null, 2));
            }
            case 'capabilities': {
                let caps: any = { tier1: false, tier2: false, tier3: false };
                try { const mod = await import('../sandboxRunner'); const runner = new mod.SandboxRunner(root); caps = await runner.detectCapabilities(); } catch {}
                return textResult(JSON.stringify({ tiers: { tier1: caps.tier1 ? 'available — isolated-vm (JS/TS, <1s)' : 'unavailable', tier2: caps.tier2 ? 'available — Pyodide (Python, 3-5s)' : 'unavailable — install Pyodide', tier3: caps.tier3 ? 'available — Windows Sandbox (any language, 30-60s)' : 'unavailable — requires Windows Pro/Enterprise' }, recommended: `tier${caps.recommended ?? 1}` }, null, 2));
            }
            case 'status': {
                const dir = safeHarmonyDir(root, 'sandbox-exec'); const runs: string[] = [];
                try { await ensureDir(dir); const entries = await fs.readdir(dir); for (const e of entries) { const s = await fs.stat(path.join(dir, e)); if (s.isDirectory()) runs.push(e); } } catch {}
                return textResult(JSON.stringify({ sandbox_dir: dir, total_runs: runs.length, recent: runs.slice(-10) }, null, 2));
            }
            default: return textResult(JSON.stringify({ error: `unknown action: ${action}` }));
        }
    }

    /** Fire-and-forget: execute a job asynchronously and write results back to the job file. */
    private async executeJobAsync(jobId: string, jobFile: string, code: string, test: string | undefined, language: string, timeout_sec: number, memory_limit_mb: number, root: string): Promise<void> {
        const start = Date.now();
        try {
            // Update status → running
            await fs.writeFile(jobFile, JSON.stringify({ job_id: jobId, status: 'running', started_at: Date.now() }, null, 2), 'utf-8');

            let SandboxRunner: any;
            try { const mod = await import('../sandboxRunner'); SandboxRunner = mod.SandboxRunner; }
            catch (e: any) {
                await fs.writeFile(jobFile, JSON.stringify({ job_id: jobId, status: 'error', error: 'Sandbox runner unavailable: ' + (e?.message ?? String(e)), completed_at: Date.now(), elapsed_ms: Date.now() - start }, null, 2), 'utf-8');
                return;
            }

            const runner = new SandboxRunner(root);
            // Enforce timeout via Promise.race
            const timeoutMs = (timeout_sec || 30) * 1000;
            const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Execution timed out after ${timeout_sec}s`)), timeoutMs)
            );
            const result = await Promise.race([runner.execute(code, test, { language, timeoutSec: timeout_sec, memoryLimitMB: memory_limit_mb, allowFallback: true }), timeoutPromise]);

            const finalJob: any = {
                job_id: jobId, status: result.pass ? 'complete' : 'failed',
                pass: result.pass, output: result.output, error: result.error,
                tier: result.tier, metrics: result.metrics,
                diagnostics: result.diagnostics, fallback_used: result.fallback_used,
                completed_at: Date.now(), elapsed_ms: Date.now() - start
            };
            await fs.writeFile(jobFile, JSON.stringify(finalJob, null, 2), 'utf-8');
        } catch (e: any) {
            try {
                await fs.writeFile(jobFile, JSON.stringify({ job_id: jobId, status: 'error', error: e?.message ?? String(e), completed_at: Date.now(), elapsed_ms: Date.now() - start }, null, 2), 'utf-8');
            } catch {} // best effort
        }
    }
}
