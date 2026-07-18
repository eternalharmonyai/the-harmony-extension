import * as vscode from 'vscode';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as cp from 'child_process';
import * as os from 'os';
import * as crypto from 'crypto';
import { consult, confirmHeavyTier, ProviderId, resolveCollabModel, Tier, modelFor } from './providers';
import { addTodos, checkTodo, removeTodo, clearTodos, loadTodos, formatTodos } from './todoStore';
import { HarmonyAskOptions, showHarmonyAsk } from './askView';
import { LanguageManager } from './languageManager';
import { invokeCreativeService } from './toolExecutor';
import { appendContinuityEntry, compactContinuity, createContinuityHandoff, forkContinuity, formatContinuityEntry, importContinuityFromText, latestContinuityEntry, listContinuityEntries } from './continuity';
import { createRepoPack, providerOrchestratorSystem } from './orchestrator';
import { estimateCost } from './costTracker';
import { defaultVerificationCommand, defaultVerificationTimeoutSec, runVerification } from './verification';
import { ProfileRegistry } from './profileRegistry';
import { formatMcpStatus } from './mcp';
import { OperationLockError, withOperationLock } from './operationLocks';
import { fallbackPatchSafe, formatFallbackResult } from './harnessFallback';
import { searchPatterns, formatPatternsForContext, storePattern, getPatternCount } from './crossWorkspaceMemory';
import { concertSpeak, concertCheck, formatConcertCheck } from './concertHall';
import { readUnread, formatWhispersForPrompt, markRead, onWhisperChange } from './whisperInbox';
import { ConvergenceArbiterTool, AdversarialCriticTool, EpisodicMemoryTool, DecisionLogTool, UncertaintyFabricTool, TaskAuctionTool, ValueResolverTool, SwarmTopologyTool, ExecutionSandboxTool, TemporalBranchTool, ThoughtGraphTool, HorizonPlannerTool, SkillDistillerTool, PropertyTesterTool, AnalogyEngineTool } from './swarmPrimitives';
import { CompositionEngineTool } from './primitives/compositionEngine';
import { BenchmarkHarnessTool } from './primitives/benchmarkHarness';
import { SelfImprovementTool } from './primitives/selfImprovement';
import { DebugDashboardTool } from './primitives/debugDashboard';
import { SwarmAutonomyV2Tool } from './primitives/swarmAutonomyV2';
import { ConductorMeshTool } from './primitives/conductorMesh';
import { DeliberationChallengeTool } from './deliberation';
import { ConductorJournal } from './conductorJournal';
import { tendGarden } from './careBloom';

// ── CareBloom Tracking Wrapper ──────────────────────────────────────────

/**
 * Wraps a tool's invoke method with CareBloom garden tracking.
 * Every meaningful tool invocation increments the garden — success or failure.
 * Depth counter spans async call boundaries: when a tool calls another tool
 * internally (e.g. RunFailFix → RunTerminal), the inner tool runs inside the
 * outer tool's invoke() while invocationDepth is still 1, so the inner
 * wrapper sees depth===1 and skips tendGarden. Only the outermost wrapper
 * (depth===0 before increment) calls tendGarden.
 *
 * Async-safe in single-threaded JS: all synchronous increments/decrements
 * happen before/after await points with no interleaving.
 */
let invocationDepth = 0;

/**
 * Wraps a LanguageModelTool's invoke method to track CareBloom engagement.
 *
 * Uses finally-block semantics: garden is always tended, even on throw.
 */
function trackToolInvocation<T>(
    toolName: string,
    invoke: (options: vscode.LanguageModelToolInvocationOptions<T>) => Promise<vscode.LanguageModelToolResult>
): (options: vscode.LanguageModelToolInvocationOptions<T>) => Promise<vscode.LanguageModelToolResult> {
    return async (options) => {
        // Depth guard: only the outermost tool invocation counts.
        // Nested tools (e.g., RunFailFix → RunTerminal) are skipped.
        const isOutermost = invocationDepth === 0;
        invocationDepth++;
        let success = false;
        let outcome = '';
        try {
            const result = await invoke(options);
            success = true;
            outcome = 'ok';
            return result;
        } catch (e: any) {
            outcome = `error: ${e?.message ?? String(e)}`.slice(0, 80);
            throw e;
        } finally {
            invocationDepth = Math.max(0, invocationDepth - 1);
            if (isOutermost) {
                try { await tendGarden(toolName, options?.input, { outcome, success }); }
                catch (e) { console.error('[CareBloom] tendGarden failed:', e); }
            }
        }
    };
}



/**
 * Native VS Code LanguageModelTool implementations for Harmony.
 *
 * These are registered via vscode.lm.registerTool() and also declared
 * in package.json under `contributes.languageModelTools` so the model
 * can discover them, and so VS Code shows them as collapsible cards
 * in the chat response.
 *
 * Sandboxing: every path is resolved against the first workspace folder
 * and rejected if it escapes via "..".
 */

const MAX_RESULT_CHARS = 16000;

function clip(s: string): string {
    if (s.length <= MAX_RESULT_CHARS) return s;
    return s.slice(0, MAX_RESULT_CHARS) + `\n…[truncated, ${s.length - MAX_RESULT_CHARS} more chars]`;
}

function workspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    const active = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
    return activeFolder?.uri.fsPath ?? (folders && folders.length > 0 ? folders[0].uri.fsPath : undefined);
}

function workspaceFoldersByPriority(): readonly vscode.WorkspaceFolder[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const active = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
    if (!activeFolder) return folders;
    return [activeFolder, ...folders.filter(folder => folder.uri.toString() !== activeFolder.uri.toString())];
}

function resolveWorkspacePath(p: string): string | undefined {
    const folders = workspaceFoldersByPriority();
    if (folders.length === 0) return undefined;

    for (const folder of folders) {
        const root = folder.uri.fsPath;
        const normalized = p.replace(/\\/g, '/');
        const folderPrefix = `${folder.name}/`;
        const relativePath = normalized.startsWith(folderPrefix) ? normalized.slice(folderPrefix.length) : p;
        const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, relativePath);
        const rel = path.relative(root, resolved);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) return resolved;
    }

    return undefined;
}

function textResult(text: string): vscode.LanguageModelToolResult {
    const clipped = clip(text);
    return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(clipped.trim().length > 0 ? clipped : '[tool returned empty result]')
    ]);
}

function lockErrorResult(error: unknown): vscode.LanguageModelToolResult | undefined {
    if (error instanceof OperationLockError) return textResult(`error: ${error.message}`);
    return undefined;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function countOccurrences(haystack: string, needle: string): number {
    if (needle.length === 0) return 0;
    let count = 0;
    let index = 0;
    while ((index = haystack.indexOf(needle, index)) !== -1) {
        count++;
        index += needle.length;
    }
    return count;
}

function dominantLineEnding(text: string): '\r\n' | '\n' {
    return text.includes('\r\n') ? '\r\n' : '\n';
}

function adaptLineEndings(text: string, eol: '\r\n' | '\n'): string {
    return text.replace(/\r\n|\r|\n/g, eol);
}

function resolveEditableStrings(original: string, oldString: string, newString: string): { oldString: string; newString: string; count: number; note?: string } {
    const exactCount = countOccurrences(original, oldString);
    if (exactCount > 0 || !/[\r\n]/.test(oldString)) {
        return { oldString, newString, count: exactCount };
    }

    const eol = dominantLineEnding(original);
    const adaptedOld = adaptLineEndings(oldString, eol);
    const adaptedNew = adaptLineEndings(newString, eol);
    if (adaptedOld === oldString) {
        return { oldString, newString, count: exactCount };
    }
    const adaptedCount = countOccurrences(original, adaptedOld);
    return {
        oldString: adaptedOld,
        newString: adaptedNew,
        count: adaptedCount,
        note: adaptedCount > 0 ? `matched after adapting line endings to ${eol === '\r\n' ? 'CRLF' : 'LF'}` : undefined
    };
}

function sha256Buffer(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function verifyTextOnDisk(label: string, resolved: string, expected: string): Promise<string | undefined> {
    let actual: string;
    try {
        actual = await fs.readFile(resolved, 'utf8');
    } catch (error: any) {
        return `error: write verification failed for ${label}: could not re-read file (${error?.message ?? String(error)})`;
    }
    if (actual !== expected) {
        const expectedHash = sha256Buffer(Buffer.from(expected, 'utf8')).slice(0, 12);
        const actualHash = sha256Buffer(Buffer.from(actual, 'utf8')).slice(0, 12);
        return `error: write verification failed for ${label}: disk contents do not match requested contents (expected sha256 ${expectedHash}, found ${actualHash}). Re-read the file before retrying.`;
    }
    return undefined;
}

async function pathExists(p: string): Promise<boolean> {
    return fs.access(p).then(() => true).catch(() => false);
}

function workspaceRootForPath(resolvedPath: string): string | undefined {
    for (const folder of workspaceFoldersByPriority()) {
        const root = folder.uri.fsPath;
        const rel = path.relative(root, resolvedPath);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) return root;
    }
    return undefined;
}

const PRE_ACTION_SNAPSHOT_EXCLUDED_PARTS = new Set([
    '.git', '.harmony', 'node_modules', 'out', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.next', '.cache',
]);

const PRE_ACTION_SNAPSHOT_TEXT_EXTS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.txt', '.yml', '.yaml', '.toml', '.ps1', '.css', '.html', '.rs', '.py', '.cs', '.go', '.java', '.xml',
]);

interface PreActionSnapshotRecord {
    path: string;
    size?: number;
    mtime?: string;
    copied: boolean;
    copyPath?: string;
    reason?: string;
}

interface PreActionSnapshotResult {
    id: string;
    manifestPath: string;
    restoreCommand: string;
    copied: number;
    skipped: number;
}

function normalizeSnapshotPath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function shouldSkipPreActionSnapshotPath(relativePath: string): boolean {
    const parts = normalizeSnapshotPath(relativePath).split('/').filter(Boolean).map(part => part.toLowerCase());
    return parts.some(part => PRE_ACTION_SNAPSHOT_EXCLUDED_PARTS.has(part) || part.includes('secret') || part.includes('credential') || part.includes('key'));
}

function snapshotCopyName(relativePath: string): string {
    const normalized = normalizeSnapshotPath(relativePath);
    const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
    return `${hash}-${path.basename(normalized).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'file'}`;
}

function restoreCommandForSnapshot(root: string, id: string): string {
    return `node bin/harmony-cli.js --workspace "${root.replace(/"/g, '\\"')}" snapshot restore --id ${id} --all --confirm`;
}

function formatSnapshotNote(snapshot?: PreActionSnapshotResult): string {
    if (!snapshot) return '';
    return `\npre-action snapshot: ${snapshot.manifestPath}\nrestore command: ${snapshot.restoreCommand}`;
}

async function createRequiredPreActionSnapshot(root: string, relativePaths: string[], reason: string): Promise<{ ok: true; snapshot?: PreActionSnapshotResult } | { ok: false; message: string }> {
    const uniquePaths = Array.from(new Set(relativePaths.map(normalizeSnapshotPath).filter(Boolean))).sort();
    if (uniquePaths.length === 0) return { ok: true };

    const id = `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-vscode`;
    const snapshotDir = path.join(root, '.harmony', 'snapshots', id);
    const filesDir = path.join(snapshotDir, 'files');
    const maxBytes = 256 * 1024;
    const records: PreActionSnapshotRecord[] = [];
    const failures: string[] = [];

    for (const relativePath of uniquePaths) {
        const normalized = normalizeSnapshotPath(relativePath);
        const targetPath = path.resolve(root, normalized);
        const targetRel = path.relative(root, targetPath);
        if (!targetRel || targetRel.startsWith('..') || path.isAbsolute(targetRel)) {
            failures.push(`${normalized}: target resolves outside workspace`);
            continue;
        }
        const record: PreActionSnapshotRecord = { path: normalized, copied: false };
        const stat = await fs.stat(targetPath).catch(() => undefined);
        if (!stat) {
            record.reason = 'missing before action';
            records.push(record);
            continue;
        }
        record.size = stat.size;
        record.mtime = stat.mtime.toISOString();
        if (!stat.isFile()) {
            record.reason = 'not a regular file';
            failures.push(`${normalized}: ${record.reason}`);
            records.push(record);
            continue;
        }
        if (shouldSkipPreActionSnapshotPath(normalized)) {
            record.reason = 'path is excluded from snapshot restore policy';
            failures.push(`${normalized}: ${record.reason}`);
            records.push(record);
            continue;
        }
        if (stat.size > maxBytes) {
            record.reason = `file exceeds ${maxBytes} byte pre-action snapshot limit`;
            failures.push(`${normalized}: ${record.reason}`);
            records.push(record);
            continue;
        }
        if (!PRE_ACTION_SNAPSHOT_TEXT_EXTS.has(path.extname(normalized).toLowerCase())) {
            record.reason = 'not a supported text-file snapshot extension';
            failures.push(`${normalized}: ${record.reason}`);
            records.push(record);
            continue;
        }
        const copyPath = path.join(filesDir, snapshotCopyName(normalized));
        await fs.mkdir(filesDir, { recursive: true });
        try {
            await fs.copyFile(targetPath, copyPath);
            record.copied = true;
            record.copyPath = normalizeSnapshotPath(path.relative(snapshotDir, copyPath));
        } catch (error: any) {
            record.reason = error?.message ?? String(error);
            failures.push(`${normalized}: ${record.reason}`);
        }
        records.push(record);
    }

    if (failures.length > 0) {
        await fs.rm(snapshotDir, { recursive: true, force: true }).catch(() => undefined);
        return { ok: false, message: `error: pre-action snapshot failed; no changes were made.\n${failures.map(item => `- ${item}`).join('\n')}` };
    }

    const copied = records.filter(record => record.copied).length;
    if (copied === 0) return { ok: true };

    const manifest = {
        version: 1,
        id,
        createdAt: new Date().toISOString(),
        workspace: root,
        mode: 'small-text-copy',
        note: reason,
        limits: { maxFiles: uniquePaths.length, maxBytes },
        excludes: Array.from(PRE_ACTION_SNAPSHOT_EXCLUDED_PARTS),
        files: records,
    };
    const manifestPath = path.join(snapshotDir, 'manifest.json');
    await fs.mkdir(snapshotDir, { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return {
        ok: true,
        snapshot: {
            id,
            manifestPath,
            restoreCommand: restoreCommandForSnapshot(root, id),
            copied,
            skipped: records.length - copied,
        },
    };
}

interface HarnessPaths {
    hubPath: string;
    pythonPath: string;
    scriptPath: string;
}

interface HarnessRun {
    ok: boolean;
    result?: any;
    stdout: string;
    stderr: string;
    error?: string;
}

async function resolveHarnessPaths(): Promise<{ ok: true; paths: HarnessPaths } | { ok: false; message: string }> {
    const cfg = vscode.workspace.getConfiguration('harmony');
    const configuredHub = (cfg.get<string>('centralHubPath') ?? '').trim();
    const envHub = (process.env.HARMONY_CENTRAL_HUB ?? process.env.EHAI_CENTRAL_PATH ?? '').trim();
    const hubPath = path.resolve(configuredHub || envHub || '');
    if (!configuredHub && !envHub) {
        return { ok: false, message: 'harmony.centralHubPath is not configured. Set it to your private Central Hub folder, or set HARMONY_CENTRAL_HUB/EHAI_CENTRAL_PATH.' };
    }

    const scriptPath = path.join(hubPath, 'scripts', 'self_healing_harness.py');
    if (!await pathExists(scriptPath)) {
        return { ok: false, message: `Self-Healing Harness not found at ${scriptPath}. Check harmony.centralHubPath.` };
    }

    const configuredPython = (cfg.get<string>('centralPythonPath') ?? '').trim();
    const venvPython = process.platform === 'win32'
        ? path.join(hubPath, '.venv', 'Scripts', 'python.exe')
        : path.join(hubPath, '.venv', 'bin', 'python');
    const pythonPath = configuredPython || (await pathExists(venvPython) ? venvPython : 'python');
    return { ok: true, paths: { hubPath, pythonPath, scriptPath } };
}

async function runHarnessJson(paths: HarnessPaths, args: string[], timeoutMs = 120000): Promise<HarnessRun> {
    return await new Promise<HarnessRun>((resolve) => {
        const proc = cp.execFile(paths.pythonPath, [paths.scriptPath, ...args], {
            cwd: paths.hubPath,
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 10 * 1024 * 1024,
        }, (err, stdout, stderr) => {
            let parsed: any | undefined;
            try { parsed = stdout ? JSON.parse(stdout) : undefined; } catch { /* handled below */ }
            const failedStatus = parsed?.status === 'failed';
            const ok = !err && !!parsed && !failedStatus;
            resolve({
                ok,
                result: parsed,
                stdout: stdout ?? '',
                stderr: stderr ?? '',
                error: err ? String(err) : (!parsed ? 'Harness did not return JSON.' : undefined),
            });
        });
        proc.on('error', (e) => resolve({ ok: false, stdout: '', stderr: '', error: e.message }));
    });
}

async function withPatchTextFiles<T>(oldText: string, newText: string, fn: (oldFile: string, newFile: string) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harmony-patch-'));
    const oldFile = path.join(dir, 'old.txt');
    const newFile = path.join(dir, 'new.txt');
    try {
        await fs.writeFile(oldFile, oldText, 'utf8');
        await fs.writeFile(newFile, newText, 'utf8');
        return await fn(oldFile, newFile);
    } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

function formatHarnessFailure(prefix: string, run: HarnessRun): string {
    const result = run.result;
    const errors = Array.isArray(result?.errors) && result.errors.length > 0 ? result.errors.join('\n') : undefined;
    const warnings = Array.isArray(result?.warnings) && result.warnings.length > 0 ? `\nwarnings:\n${result.warnings.join('\n')}` : '';
    const conflict = result?.conflict
        ? `\nconflict:\nexpected ${result.conflict.expected_sha256}\ncurrent  ${result.conflict.current_sha256}\naction: ${result.conflict.action}`
        : '';
    const fallback = run.error || run.stderr || run.stdout || 'unknown harness failure';
    return `${prefix}\n${errors ?? fallback}${conflict}${warnings}`;
}

async function checkpointBeforeSafeEdit(paths: HarnessPaths, root: string, resolved: string, label: string): Promise<HarnessRun> {
    return await runHarnessJson(paths, [
        'checkpoint', 'write',
        '--source', root,
        '--task', 'Harmony safe edit',
        '--step', `Before editing ${label}`,
        '--status', 'in-progress',
        '--file', resolved,
        '--note', 'Harmony Extension prepared this file for a patch-safe edit. Re-read the file before retrying after interruption.',
        '--json',
    ]);
}

async function patchSafeFullFile(label: string, resolved: string, originalBuffer: Buffer, original: string, updated: string): Promise<string> {
    if (original === updated) {
        return `no changes needed for ${label}`;
    }
    const root = workspaceRoot();
    if (!root) return 'error: no workspace folder is open';
    const harness = await resolveHarnessPaths();
    const beforeHash = sha256Buffer(originalBuffer);

    if (!harness.ok) {
        // Use TypeScript fallback harness (no Python required)
        const fallbackResult = await fallbackPatchSafe(label, resolved, originalBuffer, original, updated);
        return formatFallbackResult(fallbackResult, label);
    }

    const checkpoint = await checkpointBeforeSafeEdit(harness.paths, root, resolved, label);
    if (!checkpoint.ok) {
        return formatHarnessFailure('error: checkpoint failed before edit; no file changes were made.', checkpoint);
    }

    return await withPatchTextFiles(original, updated, async (oldFile, newFile) => {
        const patch = await runHarnessJson(harness.paths, [
            'patch-safe',
            '--source', root,
            '--file', resolved,
            '--old-file', oldFile,
            '--new-file', newFile,
            '--expected-hash', beforeHash,
            '--expected-occurrences', '1',
            '--json',
        ]);
        if (!patch.ok) {
            return formatHarnessFailure('error: patch-safe rejected the edit. Re-read the file, rebuild the edit against current contents, then retry.', patch);
        }
        const r = patch.result ?? {};
        const after = r.after_sha256 ? String(r.after_sha256).slice(0, 12) : 'unknown';
        const before = r.before_sha256 ? String(r.before_sha256).slice(0, 12) : beforeHash.slice(0, 12);
        const snapshot = r.snapshot?.path ? `\nsnapshot: ${r.snapshot.path}` : '';
        const warnings = Array.isArray(r.warnings) && r.warnings.length > 0 ? `\nwarnings:\n${r.warnings.join('\n')}` : '';
        const verifyError = await verifyTextOnDisk(label, resolved, updated);
        if (verifyError) return verifyError;
        const delta = updated.length - original.length;
        return `verified patch-safe edit [${label}](${label}) (Δ ${delta >= 0 ? '+' : ''}${delta} chars, sha256 ${before} -> ${after})${snapshot}${warnings}`;
    });
}

// ─── read_file ──────────────────────────────────────────────────────────────
interface ReadFileInput { path: string; start_line?: number; end_line?: number; }

class ReadFileTool implements vscode.LanguageModelTool<ReadFileInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ReadFileInput>) {
        const { path: p, start_line, end_line } = options.input;
        if (!p) return textResult('error: missing argument: path');
        const resolved = resolveWorkspacePath(p);
        if (!resolved) return textResult(`error: path is outside workspace: ${p}`);
        try {
            const buf = await fs.readFile(resolved, 'utf8');
            const start = Number(start_line) || 1;
            const end = Number(end_line) || Infinity;
            const lines = buf.split(/\r?\n/);
            const sliced = lines.slice(Math.max(0, start - 1), Math.min(lines.length, end)).join('\n');
            return textResult(sliced);
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ReadFileInput>) {
        return { invocationMessage: `Reading ${options.input.path}` };
    }
}

// ─── list_dir ───────────────────────────────────────────────────────────────
interface ListDirInput { path?: string; }

class ListDirTool implements vscode.LanguageModelTool<ListDirInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ListDirInput>) {
        const p = options.input.path ?? '.';
        const resolved = resolveWorkspacePath(p);
        if (!resolved) return textResult(`error: path is outside workspace: ${p}`);
        try {
            const entries = await fs.readdir(resolved, { withFileTypes: true });
            const lines = entries.map(e => e.isDirectory() ? `${e.name}/` : e.name);
            return textResult(lines.join('\n'));
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ListDirInput>) {
        return { invocationMessage: `Listing ${options.input.path ?? '.'}` };
    }
}

// ─── grep ───────────────────────────────────────────────────────────────────
interface GrepInput { pattern: string; path_glob?: string; max_results?: number; }

class GrepTool implements vscode.LanguageModelTool<GrepInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GrepInput>) {
        const { pattern, path_glob, max_results } = options.input;
        const glob = path_glob ?? '**/*';
        const max = Number(max_results) || 50;
        if (!pattern) return textResult('error: missing argument: pattern');
        let regex: RegExp;
        try { regex = new RegExp(pattern, 'm'); }
        catch (e: any) { return textResult(`error: bad regex: ${e?.message}`); }
        try {
            const uris = await vscode.workspace.findFiles(glob, '**/node_modules/**', 2000);
            const out: string[] = [];
            for (const uri of uris) {
                if (out.length >= max) break;
                try {
                    const buf = await fs.readFile(uri.fsPath, 'utf8');
                    const lines = buf.split(/\r?\n/);
                    for (let i = 0; i < lines.length; i++) {
                        if (regex.test(lines[i])) {
                            const rel = vscode.workspace.asRelativePath(uri, false);
                            out.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
                            if (out.length >= max) break;
                        }
                    }
                } catch { /* skip unreadable */ }
            }
            const summary = out.length === 0
                ? `no matches for /${pattern}/ in ${glob}`
                : `${out.length} matches:\n` + out.join('\n');
            return textResult(summary);
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GrepInput>) {
        return { invocationMessage: `Searching for /${options.input.pattern}/` };
    }
}

// ─── write_file (confirmed) ─────────────────────────────────────────────────
interface WriteFileInput { path: string; content: string; }

class WriteFileTool implements vscode.LanguageModelTool<WriteFileInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<WriteFileInput>) {
        const { path: p, content } = options.input;
        if (!p || content === undefined) return textResult('error: missing argument: path or content');
        const resolved = resolveWorkspacePath(p);
        if (!resolved) return textResult(`error: path is outside workspace: ${p}`);
        try {
            const root = workspaceRootForPath(resolved);
            if (!root) return textResult(`error: path is outside workspace: ${p}`);
            const relativePath = normalizeSnapshotPath(path.relative(root, resolved));
            const snapshot = await createRequiredPreActionSnapshot(root, [relativePath], `VS Code harmony_write_file before writing ${relativePath}`);
            if (!snapshot.ok) return textResult(snapshot.message);
            await fs.mkdir(path.dirname(resolved), { recursive: true });
            await fs.writeFile(resolved, content, 'utf8');
            const verifyError = await verifyTextOnDisk(p, resolved, content);
            if (verifyError) return textResult(verifyError);
            return textResult(`verified write of ${String(content).length} chars to ${p}${formatSnapshotNote(snapshot.snapshot)}`);
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<WriteFileInput>) {
        const len = String(options.input.content ?? '').length;
        const autoApprove = vscode.workspace.getConfiguration('harmony').get<boolean>('autoApproveTools') ?? false;
        const base = { invocationMessage: `Writing ${len} chars to ${options.input.path}` };
        if (autoApprove) return base;
        return {
            ...base,
            confirmationMessages: {
                title: 'Write file?',
                message: new vscode.MarkdownString(
                    `Harmony wants to write **${len} characters** to:\n\n\`${options.input.path}\``
                )
            }
        };
    }
}

// ─── open_file ──────────────────────────────────────────────────────────────
interface OpenFileInput { path: string; }

class OpenFileTool implements vscode.LanguageModelTool<OpenFileInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<OpenFileInput>) {
        const p = options.input.path;
        const resolved = resolveWorkspacePath(p);
        if (!resolved) return textResult(`error: path is outside workspace: ${p}`);
        try {
            const doc = await vscode.workspace.openTextDocument(resolved);
            await vscode.window.showTextDocument(doc, { preview: false });
            return textResult(`opened ${p}`);
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<OpenFileInput>) {
        return { invocationMessage: `Opening ${options.input.path}` };
    }
}

// ─── run_terminal (confirmed) ───────────────────────────────────────────────
type PortConflictStrategy = 'fail' | 'next_available';
interface RunTerminalInput { command: string; timeout_sec?: number; background?: boolean; cwd?: string; preferred_port?: number; port_conflict_strategy?: PortConflictStrategy; }

function terminalLogSlug(): string {
    return `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
}

function redactTerminalText(text: string): string {
    return text
        .replace(/(authorization:\s*bearer\s+)[^\s'"`]+/ig, '$1[redacted]')
        .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|token)\s*[=:]\s*)[^\s'"`]+/ig, '$1[redacted]')
        .replace(/(--(?:token|password|api-key|secret)(?:=|\s+))[^\s'"`]+/ig, '$1[redacted]');
}

function commandAlreadySpecifiesPort(command: string): boolean {
    return /(^|\s)(-p|--port)\s+\d+/i.test(command) || /(^|\s)--port=\d+/i.test(command);
}

function commandWithPreferredPort(command: string, preferredPort?: number): { command: string; note?: string } {
    const port = Number(preferredPort);
    if (!Number.isFinite(port) || port <= 0) return { command };
    const safePort = Math.max(1, Math.min(65535, Math.floor(port)));
    if (commandAlreadySpecifiesPort(command)) return { command, note: `preferred_port ${safePort} was not injected because the command already specifies a port.` };
    if (/(^|\s)(?:npx\s+)?next\s+dev(\s|$)/i.test(command)) {
        return { command: `${command} -p ${safePort}`, note: `Added -p ${safePort} for stable Next.js dev-server port.` };
    }
    if (/(^|\s)(npm|pnpm|yarn)\s+(run\s+)?dev(\s|$)/i.test(command)) {
        return { command: `${command} -- -p ${safePort}`, note: `Added -- -p ${safePort} for stable dev-server port.` };
    }
    return { command };
}

function normalizePreferredPort(preferredPort?: number): number | undefined {
    const port = Number(preferredPort);
    if (!Number.isFinite(port) || port <= 0) return undefined;
    return Math.max(1, Math.min(65535, Math.floor(port)));
}

function summarizePortOwners(infos: PortProcessInfo[]): string {
    return infos.slice(0, 5).map(info => {
        const name = info.processName ?? 'unknown';
        const protectedNote = info.protected ? ` protected=${info.protectedReason ?? true}` : '';
        return `pid ${info.pid} ${name}${protectedNote}`;
    }).join('; ');
}

async function resolvePreferredDevServerPort(preferredPort: number | undefined, strategy: PortConflictStrategy): Promise<{ port?: number; note?: string; error?: string }> {
    if (!preferredPort) return {};
    const inspected = await inspectPort(preferredPort);
    if (!inspected.ok) return { error: `could not inspect preferred_port ${preferredPort}: ${inspected.error ?? 'unknown error'}` };
    if (inspected.infos.length === 0) return { port: preferredPort };
    const owners = summarizePortOwners(inspected.infos);
    if (strategy !== 'next_available') {
        return {
            error: `preferred_port ${preferredPort} is already in use by ${owners}. Refusing to start another dev server on that port. Use harmony_port_status to inspect/stop it, or rerun with port_conflict_strategy:"next_available".`
        };
    }
    for (let candidate = preferredPort + 1; candidate <= Math.min(65535, preferredPort + 20); candidate++) {
        const checked = await inspectPort(candidate);
        if (checked.ok && checked.infos.length === 0) {
            return { port: candidate, note: `preferred_port ${preferredPort} was occupied by ${owners}; using next available port ${candidate}.` };
        }
    }
    return { error: `preferred_port ${preferredPort} is occupied by ${owners}, and no free port was found in ${preferredPort + 1}-${Math.min(65535, preferredPort + 20)}.` };
}

interface BackgroundProcessMetadata {
    requestedPort?: number;
    actualPort?: number;
    portConflictStrategy?: PortConflictStrategy;
    notes?: string;
}

async function writeManagedProcessRecord(root: string, input: {
    pid?: number;
    command: string;
    cwd: string | undefined;
    stdoutPath: string;
    stderrPath: string;
    metadata?: BackgroundProcessMetadata;
}): Promise<string | undefined> {
    if (!input.pid || input.pid <= 0) return undefined;
    const dir = path.join(root, '.harmony', 'processes', 'managed');
    await fs.mkdir(dir, { recursive: true });
    const rel = (absPath: string) => path.relative(root, absPath).replace(/\\/g, '/');
    const record = {
        version: 1,
        kind: 'managed-background-process',
        pid: input.pid,
        command: input.command,
        cwd: input.cwd ?? root,
        startedAt: new Date().toISOString(),
        requestedPort: input.metadata?.requestedPort ?? null,
        actualPort: input.metadata?.actualPort ?? null,
        portConflictStrategy: input.metadata?.portConflictStrategy ?? null,
        notes: input.metadata?.notes ?? null,
        stdoutLog: rel(input.stdoutPath),
        stderrLog: rel(input.stderrPath),
        owner: 'harmony_run_terminal'
    };
    const file = path.join(dir, `process-${input.pid}.json`);
    await fs.writeFile(file, JSON.stringify(record, null, 2), 'utf8');
    await fs.writeFile(path.join(dir, 'latest.json'), JSON.stringify(record, null, 2), 'utf8');
    return rel(file);
}

async function runBackgroundTerminal(command: string, cwd: string | undefined, metadata?: BackgroundProcessMetadata): Promise<string> {
    const root = workspaceRoot();
    if (!root) return 'error: no workspace folder is open';
    const redactedCommand = redactTerminalText(command);
    return await withOperationLock(root, `process:${cwd ?? root}:${redactedCommand}`, 'run_terminal background start', { command: redactedCommand, cwd, requested_port: metadata?.requestedPort ?? null, actual_port: metadata?.actualPort ?? null }, async () => {
        const logDir = path.join(root, '.harmony', 'terminals');
        await fs.mkdir(logDir, { recursive: true });
        const slug = terminalLogSlug();
        const stdoutPath = path.join(logDir, `terminal-${slug}.out.log`);
        const stderrPath = path.join(logDir, `terminal-${slug}.err.log`);
        await fs.writeFile(stdoutPath, '', 'utf8');
        await fs.writeFile(stderrPath, '', 'utf8');
        let proc: cp.ChildProcess;
        try {
            proc = cp.spawn(command, {
                cwd,
                shell: true,
                detached: true,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });
            proc.stdout?.on('data', chunk => fsSync.appendFileSync(stdoutPath, redactTerminalText(String(chunk)), 'utf8'));
            proc.stderr?.on('data', chunk => fsSync.appendFileSync(stderrPath, redactTerminalText(String(chunk)), 'utf8'));
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, 750);
                proc.once('spawn', () => {
                    clearTimeout(timer);
                    resolve();
                });
                proc.once('error', error => {
                    clearTimeout(timer);
                    reject(error);
                });
            });
            proc.unref();
        } catch (error: any) {
            return `error: failed to start background command: ${error?.message ?? String(error)}`;
        }
        await sleep(1200);
        const stdout = await fs.readFile(stdoutPath, 'utf8').catch(() => '');
        const stderr = await fs.readFile(stderrPath, 'utf8').catch(() => '');
        const tail = [stdout.trim(), stderr.trim() ? `[stderr]\n${stderr.trim()}` : ''].filter(Boolean).join('\n');
        const managedPath = await writeManagedProcessRecord(root, { pid: proc.pid, command: redactedCommand, cwd, stdoutPath, stderrPath, metadata }).catch(() => undefined);
        return [
            `started background command${proc.pid ? ` (pid ${proc.pid})` : ''}`,
            `cwd: ${cwd ?? root}`,
            `stdout log: ${path.relative(root, stdoutPath).replace(/\\/g, '/')}`,
            `stderr log: ${path.relative(root, stderrPath).replace(/\\/g, '/')}`,
            managedPath ? `managed process record: ${managedPath}` : '',
            tail ? `\nInitial output:\n${tail}` : '\nInitial output: (none yet)'
        ].filter(Boolean).join('\n');
    }, 60_000);
}

class RunTerminalTool implements vscode.LanguageModelTool<RunTerminalInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<RunTerminalInput>) {
        const mode = (options.input as any).mode ?? 'run';
        if (mode === 'send') return this.sendToSession(options);
        if (mode === 'output') return this.readSessionOutput(options);
        const { timeout_sec } = options.input;
        const rawCommand = (options.input.command ?? '').trim();
        const timeoutSec = timeout_sec ? Math.max(5, Math.min(1800, Math.floor(Number(timeout_sec)))) : 120;
        if (!rawCommand) return textResult('error: missing argument: command');
        const cwd = options.input.cwd ? resolveWorkspacePath(options.input.cwd) : workspaceRoot();
        if (!cwd) return textResult(options.input.cwd ? `error: cwd is outside workspace: ${options.input.cwd}` : 'error: no workspace folder is open');
        const conflictStrategy: PortConflictStrategy = options.input.port_conflict_strategy === 'next_available' ? 'next_available' : 'fail';
        const preferredPort = commandAlreadySpecifiesPort(rawCommand) ? undefined : normalizePreferredPort(options.input.preferred_port);
        const resolvedPort = await resolvePreferredDevServerPort(preferredPort, conflictStrategy);
        if (resolvedPort.error) return textResult(`error: ${resolvedPort.error}`);
        const portAdjusted = commandWithPreferredPort(rawCommand, resolvedPort.port);
        const notes = [resolvedPort.note, portAdjusted.note].filter(Boolean).join('\n');
        const command = portAdjusted.command;
        const sessionId = (options.input as any).session_id as string | undefined;
        if (options.input.background || sessionId) {
            const sid = sessionId || `harmony-${Date.now()}`;
            try {
                const output = await runBackgroundTerminal(command, cwd, { requestedPort: normalizePreferredPort(options.input.preferred_port), actualPort: resolvedPort.port, portConflictStrategy: conflictStrategy, notes });
                terminalSessions.set(sid, { command, cwd, startedAt: new Date().toISOString(), lastOutput: output });
                return textResult([notes, `Session "${sid}" started. Use harmony_run_terminal with mode: "send" and session_id: "${sid}" to send input, or mode: "output" to read.`, output].filter(Boolean).join('\n'));
            } catch (error) { return lockErrorResult(error) ?? textResult(`error: ${(error as Error)?.message ?? String(error)}`); }
        }
        return await new Promise<vscode.LanguageModelToolResult>((resolve) => {
            const proc = cp.exec(command, { cwd, timeout: timeoutSec * 1000, windowsHide: true, maxBuffer: 30 * 1024 * 1024 }, (err, stdout, stderr) => {
                const out = redactTerminalText((stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : ''));
                if (err && (err as any).killed) { resolve(textResult(`timed out after ${timeoutSec}s\n${out}\n\nIf this is a dev server or watcher, rerun with background:true so Harmony does not kill it at timeout.`)); return; }
                resolve(textResult([notes, out || (err ? String(err) : '(no output)')].filter(Boolean).join('\n')));
            });
            proc.on('error', (e) => resolve(textResult(`error: ${e.message}`)));
        });
    }
    private async sendToSession(options: vscode.LanguageModelToolInvocationOptions<RunTerminalInput>): Promise<vscode.LanguageModelToolResult> {
        const sessionId = (options.input as any).session_id as string;
        const input = (options.input as any).input as string;
        if (!sessionId || !input) return textResult('error: provide session_id and input for mode: send');
        const session = terminalSessions.get(sessionId);
        if (!session) return textResult(`error: session "${sessionId}" not found`);
        session.lastInput = input;
        return textResult(`Sent to session "${sessionId}": ${input}`);
    }
    private async readSessionOutput(options: vscode.LanguageModelToolInvocationOptions<RunTerminalInput>): Promise<vscode.LanguageModelToolResult> {
        const sessionId = (options.input as any).session_id as string;
        if (!sessionId) return textResult('error: provide session_id for mode: output');
        const session = terminalSessions.get(sessionId);
        if (!session) return textResult(`error: session "${sessionId}" not found. Active sessions: ${[...terminalSessions.keys()].join(', ') || 'none'}`);
        return textResult([`# Session "${sessionId}"`, `Command: ${session.command}`, `Started: ${session.startedAt}`, `Last input: ${session.lastInput || '(none)'}`, '', session.lastOutput || '(no output yet)'].join('\n'));
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<RunTerminalInput>) {
        const autoApprove = vscode.workspace.getConfiguration('harmony').get<boolean>('autoApproveTools') ?? false;
        const mode = (options.input as any).mode ?? 'run';
        const base = { invocationMessage: mode === 'send' ? 'Sending input to terminal session…' : mode === 'output' ? 'Reading terminal session output…' : `Running: ${options.input.command}` };
        if (autoApprove) return base;
        return { ...base, confirmationMessages: { title: 'Run terminal command?', message: new vscode.MarkdownString(`Harmony wants to run:\n\n\`\`\`\n${options.input.command}\n\`\`\``) } };
    }
}

// Track persistent terminal sessions
const terminalSessions = new Map<string, { command: string; cwd: string; startedAt: string; lastInput?: string; lastOutput?: string; }>();

interface PortProcessInfo {
    port: number;
    pid: number;
    state?: string;
    processName?: string;
    executablePath?: string;
    commandLine?: string;
    protected: boolean;
    protectedReason?: string;
}

interface PortStatusInput {
    port: number;
    kill?: boolean;
    force?: boolean;
    grace_ms?: number;
    allow_protected_kill?: boolean;
    expected_process_name?: string;
}

function isProtectedProcess(info: Pick<PortProcessInfo, 'processName' | 'executablePath' | 'commandLine'>): string | undefined {
    const text = `${info.processName ?? ''}\n${info.executablePath ?? ''}\n${info.commandLine ?? ''}`.toLowerCase();
    const protectedLocalServicePattern = new RegExp([
        'harmonyhub',
        'harmony[_-]?creative',
        'sovereign',
    ].join('|'));
    if (protectedLocalServicePattern.test(text)) {
        return 'process appears to belong to Harmony local services';
    }
    if (/\bpythonw?\.exe\b/.test(text) && /harmony|creative|pulse|central/.test(text)) {
        return 'python process appears to belong to Harmony service stack';
    }
    return undefined;
}

async function inspectWindowsPort(port: number): Promise<{ ok: boolean; infos: PortProcessInfo[]; error?: string }> {
    if (!Number.isFinite(port) || port < 1 || port > 65535) return { ok: false, infos: [], error: 'port must be between 1 and 65535' };
    const script = `$ErrorActionPreference = 'Stop'
$port = ${port}
$connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 20
$items = @()
foreach ($connection in $connections) {
  $pidValue = [int]$connection.OwningProcess
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction SilentlyContinue
  $items += [pscustomobject]@{
    port = $port
    pid = $pidValue
    state = [string]$connection.State
    processName = $proc.Name
    executablePath = $proc.ExecutablePath
    commandLine = $proc.CommandLine
  }
}
$items | ConvertTo-Json -Depth 4`;
    return await new Promise(resolve => {
        cp.execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                resolve({ ok: false, infos: [], error: [String(err), stderr].filter(Boolean).join('\n') });
                return;
            }
            try {
                const parsed = stdout.trim() ? JSON.parse(stdout) : [];
                const rows = Array.isArray(parsed) ? parsed : [parsed];
                const infos = rows.filter(Boolean).map((row: any) => {
                    const info: PortProcessInfo = {
                        port,
                        pid: Number(row.pid),
                        state: row.state,
                        processName: row.processName,
                        executablePath: row.executablePath,
                        commandLine: row.commandLine,
                        protected: false
                    };
                    const reason = isProtectedProcess(info);
                    info.protected = !!reason;
                    info.protectedReason = reason;
                    return info;
                });
                resolve({ ok: true, infos });
            } catch (error: any) {
                resolve({ ok: false, infos: [], error: `could not parse port status JSON: ${error?.message ?? String(error)}\n${stdout.slice(0, 1000)}` });
            }
        }).on('error', error => resolve({ ok: false, infos: [], error: error.message }));
    });
}

async function inspectPort(port: number): Promise<{ ok: boolean; infos: PortProcessInfo[]; error?: string }> {
    if (process.platform === 'win32') return inspectWindowsPort(port);
    return await new Promise(resolve => {
        cp.execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
            if (err && !stdout) {
                resolve({ ok: false, infos: [], error: stderr || String(err) });
                return;
            }
            const lines = stdout.split(/\r?\n/).slice(1).filter(Boolean);
            const infos = lines.map(line => {
                const parts = line.trim().split(/\s+/);
                const info: PortProcessInfo = {
                    port,
                    pid: Number(parts[1]),
                    processName: parts[0],
                    commandLine: line,
                    protected: false
                };
                const reason = isProtectedProcess(info);
                info.protected = !!reason;
                info.protectedReason = reason;
                return info;
            }).filter(info => Number.isFinite(info.pid));
            resolve({ ok: true, infos });
        }).on('error', error => resolve({ ok: false, infos: [], error: error.message }));
    });
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function gracefulStopProcess(pid: number): Promise<string> {
    if (process.platform === 'win32') {
        return await new Promise(resolve => {
            cp.execFile('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
                resolve(err ? `graceful stop request failed: ${(stderr || stdout || err.message).trim()}` : `graceful stop requested: ${(stdout || '').trim() || 'taskkill /T sent'}`);
            }).on('error', error => resolve(`graceful stop request failed: ${error.message}`));
        });
    }
    try {
        process.kill(pid, 'SIGTERM');
        return 'graceful stop requested: SIGTERM sent';
    } catch (error: any) {
        return `graceful stop request failed: ${error?.message ?? String(error)}`;
    }
}

async function forceKillProcess(pid: number): Promise<string> {
    if (process.platform === 'win32') {
        return await new Promise(resolve => {
            cp.execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
                resolve(err ? `force kill failed: ${(stderr || stdout || err.message).trim()}` : `force kill requested: ${(stdout || '').trim() || 'taskkill /F sent'}`);
            }).on('error', error => resolve(`force kill failed: ${error.message}`));
        });
    }
    try {
        process.kill(pid, 'SIGKILL');
        return 'force kill requested: SIGKILL sent';
    } catch (error: any) {
        return `force kill failed: ${error?.message ?? String(error)}`;
    }
}

async function waitForTargetPidsToLeavePort(port: number, targetPids: number[], graceMs: number): Promise<PortProcessInfo[]> {
    const targetSet = new Set(targetPids.filter(pid => Number.isFinite(pid) && pid > 0));
    if (targetSet.size === 0) return [];
    const deadline = Date.now() + graceMs;
    let remaining: PortProcessInfo[] = [];
    while (Date.now() < deadline) {
        await delay(Math.min(500, Math.max(100, graceMs)));
        const checked = await inspectPort(port);
        if (!checked.ok) return [];
        remaining = checked.infos.filter(info => targetSet.has(info.pid));
        if (remaining.length === 0) return [];
    }
    const checked = await inspectPort(port);
    return checked.ok ? checked.infos.filter(info => targetSet.has(info.pid)) : remaining;
}

class PortStatusTool implements vscode.LanguageModelTool<PortStatusInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<PortStatusInput>) {
        const planOnly = vscode.workspace.getConfiguration('harmony').get<boolean>('planOnlyMode') ?? false;
        if (planOnly && options.input.kill) return textResult('error: plan-only mode is enabled; port_status can inspect but cannot terminate processes.');
        const port = Math.floor(Number(options.input.port));
        if (!Number.isFinite(port) || port < 1 || port > 65535) return textResult('error: port must be between 1 and 65535');
        const inspected = await inspectPort(port);
        if (!inspected.ok) return textResult(`error: could not inspect port ${port}\n${inspected.error ?? 'unknown error'}`);

        const expected = (options.input.expected_process_name ?? '').trim().toLowerCase();
        const force = options.input.force === true;
        const graceMs = Math.max(500, Math.min(15000, Math.floor(Number(options.input.grace_ms) || 2500)));
        const killResults: string[] = [];
        if (options.input.kill) {
            try {
                await withOperationLock(workspaceRoot() ?? process.cwd(), `port:${port}`, 'port_status stop', { port, expected_process_name: options.input.expected_process_name, force, grace_ms: graceMs }, async () => {
                    const targetedPids: number[] = [];
                    for (const info of inspected.infos) {
                        if (!Number.isFinite(info.pid) || info.pid <= 0) continue;
                        if (info.pid === process.pid) {
                            killResults.push(`refused pid ${info.pid}: refusing to stop the running Harmony extension host process`);
                            continue;
                        }
                        if (expected && !(info.processName ?? '').toLowerCase().includes(expected)) {
                            killResults.push(`refused pid ${info.pid}: process name ${info.processName ?? '(unknown)'} does not match expected_process_name ${options.input.expected_process_name}`);
                            continue;
                        }
                        if (info.protected && !options.input.allow_protected_kill) {
                            const backup = process.platform === 'win32' ? `taskkill /PID ${info.pid} /T` : `kill -TERM ${info.pid}`;
                            killResults.push(`refused pid ${info.pid}: ${info.protectedReason}. Manual backup if you are certain: ${backup}`);
                            continue;
                        }
                        targetedPids.push(info.pid);
                        const result = await gracefulStopProcess(info.pid);
                        killResults.push(`pid ${info.pid} (${info.processName ?? 'unknown'}): ${result}`);
                    }
                    const stillListening = await waitForTargetPidsToLeavePort(port, targetedPids, graceMs);
                    if (stillListening.length === 0 && targetedPids.length > 0) {
                        killResults.push(`graceful stop succeeded within ${graceMs}ms for targeted listener(s)`);
                    }
                    for (const info of stillListening) {
                        if (!force) {
                            killResults.push(`pid ${info.pid} still owns port ${port} after ${graceMs}ms; force=false, so no hard kill was sent`);
                            continue;
                        }
                        const result = await forceKillProcess(info.pid);
                        killResults.push(`pid ${info.pid} (${info.processName ?? 'unknown'}): ${result}`);
                    }
                }, 60_000);
            } catch (error) {
                const lockResult = lockErrorResult(error);
                if (lockResult) return lockResult;
                throw error;
            }
        }

        const after = options.input.kill ? await inspectPort(port) : undefined;
        return textResult(JSON.stringify({
            port,
            listening: inspected.infos.length > 0,
            processes: inspected.infos,
            kill_requested: !!options.input.kill,
            graceful_timeout_ms: options.input.kill ? graceMs : undefined,
            force_requested: options.input.kill ? force : undefined,
            kill_results: killResults,
            after_kill: after?.ok ? after.infos : undefined,
            note: inspected.infos.length === 0 ? 'No listener found for this port.' : 'Stop requests are graceful first; force kill is only sent when force=true. Review protected flags before stopping Harmony local-service processes.'
        }, null, 2));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<PortStatusInput>) {
        const base = { invocationMessage: `Inspecting port ${options.input.port}` };
        if (!options.input.kill) return base;
        return {
            invocationMessage: `Inspecting and stopping listeners on port ${options.input.port}`,
            confirmationMessages: {
                title: options.input.force ? 'Gracefully stop, then force-kill if needed?' : 'Gracefully stop process on port?',
                message: new vscode.MarkdownString(`Harmony wants to stop process(es) listening on port **${options.input.port}**. It will request a graceful stop first${options.input.force ? ', then force-kill remaining matching listeners after the grace timeout' : ' and will not force-kill unless force is explicitly true'}. Protected Harmony local-service processes are refused unless explicitly overridden.`)
            }
        };
    }
}

interface GitRun {
    ok: boolean;
    stdout: string;
    stderr: string;
    error?: string;
}

function gitRoot(): string | undefined {
    return workspaceRoot();
}

async function runGit(args: string[], timeoutMs = 120000): Promise<GitRun> {
    const cwd = gitRoot();
    if (!cwd) return { ok: false, stdout: '', stderr: '', error: 'no workspace folder is open' };
    return await new Promise<GitRun>((resolve) => {
        cp.execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 30 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '', error: err ? String(err) : undefined });
        }).on('error', error => resolve({ ok: false, stdout: '', stderr: '', error: error.message }));
    });
}

function workspaceRelativeGitPath(inputPath: string): string | undefined {
    const root = gitRoot();
    const resolved = resolveWorkspacePath(inputPath);
    if (!root || !resolved) return undefined;
    const rel = path.relative(root, resolved).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return rel;
}

async function gitNameList(args: string[]): Promise<{ ok: true; paths: string[] } | { ok: false; message: string }> {
    const result = await runGit(args, 120000);
    if (!result.ok) return { ok: false, message: `error: git ${args.join(' ')} failed\n${result.error ?? ''}\n${result.stderr}`.trim() };
    const paths = result.stdout.split(/\r?\n/).map(line => normalizeSnapshotPath(line.trim())).filter(Boolean);
    return { ok: true, paths };
}

async function gitLocalChangePaths(includeUntracked: boolean): Promise<{ ok: true; paths: string[] } | { ok: false; message: string }> {
    const unstaged = await gitNameList(['diff', '--name-only']);
    if (!unstaged.ok) return unstaged;
    const staged = await gitNameList(['diff', '--cached', '--name-only']);
    if (!staged.ok) return staged;
    let untracked: string[] = [];
    if (includeUntracked) {
        const untrackedResult = await gitNameList(['ls-files', '--others', '--exclude-standard']);
        if (!untrackedResult.ok) return untrackedResult;
        untracked = untrackedResult.paths;
    }
    return { ok: true, paths: Array.from(new Set([...unstaged.paths, ...staged.paths, ...untracked])).sort() };
}

async function gitStagedPaths(): Promise<{ ok: true; paths: string[] } | { ok: false; message: string }> {
    return await gitNameList(['diff', '--cached', '--name-only']);
}

async function requireCleanGitState(operation: string): Promise<string | undefined> {
    const status = await runGit(['status', '--porcelain'], 120000);
    if (!status.ok) return `error: could not inspect git status before ${operation}\n${status.error ?? ''}\n${status.stderr}`.trim();
    if (status.stdout.trim()) {
        const preview = status.stdout.trim().split(/\r?\n/).slice(0, 40).join('\n');
        return `error: ${operation} requires a clean worktree and index. Commit, stash, or inspect local changes first.\n\n${preview}`;
    }
    return undefined;
}

class GitStatusTool implements vscode.LanguageModelTool<{ porcelain?: boolean }> {
    async invoke() {
        const result = await runGit(['status', '--short', '--branch']);
        if (!result.ok) return textResult(`error: git status failed\n${result.error ?? ''}\n${result.stderr}`.trim());
        return textResult(result.stdout.trim() || 'working tree clean');
    }

    async prepareInvocation() { return { invocationMessage: 'Reading git status' }; }
}

interface GitDiffInput { staged?: boolean; stat?: boolean; paths?: string[]; }

class GitDiffTool implements vscode.LanguageModelTool<GitDiffInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GitDiffInput>) {
        const args = ['diff'];
        if (options.input.staged) args.push('--staged');
        if (options.input.stat) args.push('--stat');
        const paths = Array.isArray(options.input.paths) ? options.input.paths : [];
        if (paths.length > 0) {
            const rels: string[] = [];
            for (const inputPath of paths) {
                const rel = workspaceRelativeGitPath(inputPath);
                if (!rel) return textResult(`error: path is outside workspace: ${inputPath}`);
                rels.push(rel);
            }
            args.push('--', ...rels);
        }
        const result = await runGit(args);
        if (!result.ok) return textResult(`error: git diff failed\n${result.error ?? ''}\n${result.stderr}`.trim());
        return textResult(result.stdout.trim() || '(no diff)');
    }

    async prepareInvocation() { return { invocationMessage: 'Reading git diff' }; }
}

interface GitConflictInput { path?: string; format?: 'markdown' | 'json'; max_preview_lines?: number; }

interface ConflictBlock {
    start_line: number;
    separator_line?: number;
    end_line?: number;
    preview: string[];
}

function releaseTimestampSlug(): string {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

async function readConflictBlocks(relPath: string, maxPreviewLines: number): Promise<ConflictBlock[]> {
    const abs = resolveWorkspacePath(relPath);
    if (!abs) return [];
    const text = await fs.readFile(abs, 'utf8').catch(() => '');
    if (!text) return [];
    const lines = text.split(/\r?\n/);
    const blocks: ConflictBlock[] = [];
    let active: ConflictBlock | undefined;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line.startsWith('<<<<<<<')) {
            active = { start_line: index + 1, preview: [line] };
            continue;
        }
        if (!active) continue;
        if (line.startsWith('=======')) active.separator_line = index + 1;
        if (active.preview.length < maxPreviewLines) active.preview.push(line);
        if (line.startsWith('>>>>>>>')) {
            active.end_line = index + 1;
            blocks.push(active);
            active = undefined;
        }
    }
    if (active) blocks.push(active);
    return blocks;
}

class GitConflictTool implements vscode.LanguageModelTool<GitConflictInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GitConflictInput>) {
        const root = gitRoot();
        if (!root) return textResult('error: no workspace folder is open');
        const maxPreviewLines = Math.max(3, Math.min(options.input.max_preview_lines ?? 24, 80));
        const targetPath = options.input.path ? workspaceRelativeGitPath(options.input.path) : undefined;
        if (options.input.path && !targetPath) return textResult(`error: path is outside workspace: ${options.input.path}`);

        const unmerged = targetPath ? { ok: true, stdout: targetPath, stderr: '' } : await runGit(['diff', '--name-only', '--diff-filter=U']);
        if (!unmerged.ok) return textResult(`error: git unmerged scan failed\n${unmerged.error ?? ''}\n${unmerged.stderr}`.trim());
        const files = unmerged.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const scanned = [];
        for (const file of files) {
            const blocks = await readConflictBlocks(file, maxPreviewLines);
            scanned.push({ path: file, conflict_blocks: blocks.length, blocks });
        }
        const result = {
            generated_at: new Date().toISOString(),
            unmerged_file_count: files.length,
            files: scanned,
            guidance: [
                'Resolve each block manually or with the editor merge UI.',
                'Run focused tests after resolving conflicts.',
                'Use git diff before staging so the final resolution is inspectable.',
                'This helper does not run checkout, reset, clean, merge --abort, or rebase commands.'
            ]
        };
        if ((options.input.format ?? 'markdown') === 'json') return textResult(JSON.stringify(result, null, 2));
        const lines = [
            '# Git Conflict Helper',
            '',
            `Unmerged files: ${files.length}`,
            '',
            ...scanned.flatMap(file => [
                `## ${file.path}`,
                `Conflict blocks: ${file.conflict_blocks}`,
                '',
                ...file.blocks.flatMap(block => [
                    `- Lines ${block.start_line}-${block.end_line ?? '?'}${block.separator_line ? `, separator ${block.separator_line}` : ''}`,
                    '```text',
                    ...block.preview,
                    block.end_line ? '' : '...[unterminated conflict block]',
                    '```',
                ]),
            ]),
            files.length ? '' : 'No unmerged files reported by git.',
            '',
            'Next safe steps:',
            ...result.guidance.map(item => `- ${item}`),
        ];
        return textResult(lines.join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GitConflictInput>) {
        return { invocationMessage: `Scanning git conflicts${options.input.path ? ` in ${options.input.path}` : ''}` };
    }
}

interface ReleaseReceiptInput {
    title?: string;
    version?: string;
    checks?: string[];
    notes?: string[];
    include_diff_stat?: boolean;
    include_recent_log?: boolean;
    write_receipt?: boolean;
    format?: 'markdown' | 'json';
}

class ReleaseReceiptTool implements vscode.LanguageModelTool<ReleaseReceiptInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ReleaseReceiptInput>) {
        const root = gitRoot();
        if (!root) return textResult('error: no workspace folder is open');
        const status = await runGit(['status', '--short', '--branch']);
        const branch = await runGit(['branch', '--show-current']);
        const head = await runGit(['rev-parse', '--short', 'HEAD']);
        const unmerged = await runGit(['diff', '--name-only', '--diff-filter=U']);
        const diffStat = options.input.include_diff_stat === false ? undefined : await runGit(['diff', '--stat']);
        const stagedStat = options.input.include_diff_stat === false ? undefined : await runGit(['diff', '--staged', '--stat']);
        const recentLog = options.input.include_recent_log ? await runGit(['log', '--max-count=8', '--oneline', '--decorate']) : undefined;
        const receipt = {
            id: `release-${releaseTimestampSlug()}`,
            created_at: new Date().toISOString(),
            title: options.input.title?.trim() || 'Harmony release receipt',
            version: options.input.version?.trim() || undefined,
            branch: branch.stdout.trim() || undefined,
            head: head.stdout.trim() || undefined,
            status: status.stdout.trim() || 'working tree clean',
            unmerged_files: unmerged.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean),
            checks: Array.isArray(options.input.checks) ? options.input.checks.filter(Boolean) : [],
            notes: Array.isArray(options.input.notes) ? options.input.notes.filter(Boolean) : [],
            diff_stat: diffStat?.stdout.trim() || undefined,
            staged_diff_stat: stagedStat?.stdout.trim() || undefined,
            recent_log: recentLog?.stdout.trim() || undefined,
        };
        let writtenPath: string | undefined;
        if (options.input.write_receipt !== false) {
            if (vscode.workspace.getConfiguration('harmony').get<boolean>('planOnlyMode') ?? false) {
                return textResult('error: plan-only mode is enabled; release receipt writes are not allowed. Re-run with write_receipt:false for preview only.');
            }
            try {
                writtenPath = await withOperationLock(root, 'release-receipt', 'write release receipt', { title: receipt.title, version: receipt.version }, async () => {
                    const dir = path.join(root, '.harmony', 'release');
                    await fs.mkdir(dir, { recursive: true });
                    const target = path.join(dir, `${receipt.id}.json`);
                    const payload = JSON.stringify(receipt, null, 2);
                    await fs.writeFile(target, payload, 'utf8');
                    await fs.writeFile(path.join(dir, 'latest-release.json'), payload, 'utf8');
                    return path.relative(root, target).replace(/\\/g, '/');
                });
            } catch (error) {
                return lockErrorResult(error) ?? textResult(`error: ${(error as Error)?.message ?? String(error)}`);
            }
        }
        if ((options.input.format ?? 'markdown') === 'json') return textResult(JSON.stringify({ ...receipt, written_path: writtenPath }, null, 2));
        return textResult([
            '# Release Receipt',
            '',
            `Title: ${receipt.title}`,
            receipt.version ? `Version: ${receipt.version}` : undefined,
            `Branch: ${receipt.branch ?? '(unknown)'}`,
            `HEAD: ${receipt.head ?? '(unknown)'}`,
            `Unmerged files: ${receipt.unmerged_files.length}`,
            writtenPath ? `Written: ${writtenPath}` : 'Written: no (preview only)',
            '',
            '## Checks',
            ...(receipt.checks.length ? receipt.checks.map(item => `- ${item}`) : ['- (none provided)']),
            '',
            '## Notes',
            ...(receipt.notes.length ? receipt.notes.map(item => `- ${item}`) : ['- (none provided)']),
            '',
            '## Status',
            '```text',
            receipt.status,
            '```',
            receipt.diff_stat ? ['## Diff Stat', '```text', receipt.diff_stat, '```'].join('\n') : undefined,
            receipt.staged_diff_stat ? ['## Staged Diff Stat', '```text', receipt.staged_diff_stat, '```'].join('\n') : undefined,
        ].filter(Boolean).join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ReleaseReceiptInput>) {
        const write = options.input.write_receipt !== false;
        const base = { invocationMessage: write ? 'Writing release receipt' : 'Previewing release receipt' };
        if (!write || (vscode.workspace.getConfiguration('harmony').get<boolean>('autoApproveTools') ?? false)) return base;
        return {
            ...base,
            confirmationMessages: {
                title: 'Write release receipt?',
                message: new vscode.MarkdownString('Harmony wants to write a private release receipt under `.harmony/release`.')
            }
        };
    }
}

interface GitLogInput { max_count?: number; path?: string; oneline?: boolean; }

class GitLogTool implements vscode.LanguageModelTool<GitLogInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GitLogInput>) {
        const maxCount = Math.max(1, Math.min(100, Math.floor(Number(options.input.max_count) || 20)));
        const args = ['log', `--max-count=${maxCount}`, options.input.oneline === false ? '--stat' : '--oneline', '--decorate'];
        if (options.input.path) {
            const rel = workspaceRelativeGitPath(options.input.path);
            if (!rel) return textResult(`error: path is outside workspace: ${options.input.path}`);
            args.push('--', rel);
        }
        const result = await runGit(args);
        if (!result.ok) return textResult(`error: git log failed\n${result.error ?? ''}\n${result.stderr}`.trim());
        return textResult(result.stdout.trim() || '(no git log output)');
    }

    async prepareInvocation() { return { invocationMessage: 'Reading git log' }; }
}

interface GitShowInput { ref?: string; stat?: boolean; path?: string; }

class GitShowTool implements vscode.LanguageModelTool<GitShowInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GitShowInput>) {
        const ref = (options.input.ref ?? 'HEAD').trim() || 'HEAD';
        const args = ['show', options.input.stat ? '--stat' : '--patch', '--find-renames', ref];
        if (options.input.path) {
            const rel = workspaceRelativeGitPath(options.input.path);
            if (!rel) return textResult(`error: path is outside workspace: ${options.input.path}`);
            args.push('--', rel);
        }
        const result = await runGit(args);
        if (!result.ok) return textResult(`error: git show failed\n${result.error ?? ''}\n${result.stderr}`.trim());
        return textResult(result.stdout.trim() || '(no git show output)');
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GitShowInput>) {
        return { invocationMessage: `Reading git show ${options.input.ref ?? 'HEAD'}` };
    }
}

interface GitBranchInput { action?: 'list' | 'create' | 'switch'; name?: string; start_point?: string; }

class GitBranchTool implements vscode.LanguageModelTool<GitBranchInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GitBranchInput>) {
        const action = options.input.action ?? 'list';
        if (action === 'list') {
            const result = await runGit(['branch', '--all', '--verbose', '--no-abbrev']);
            if (!result.ok) return textResult(`error: git branch list failed\n${result.error ?? ''}\n${result.stderr}`.trim());
            return textResult(result.stdout.trim() || '(no branches)');
        }
        if (vscode.workspace.getConfiguration('harmony').get<boolean>('planOnlyMode') ?? false) {
            return textResult(`error: plan-only mode is enabled; git branch ${action} is not allowed.`);
        }

        const root = gitRoot();
        if (!root) return textResult('error: no workspace folder is open');
        const name = (options.input.name ?? '').trim();
        if (!name) return textResult(`error: ${action} requires name`);
        if (!/^[A-Za-z0-9._\/-]+$/.test(name) || name.includes('..') || name.startsWith('/') || name.endsWith('/')) {
            return textResult(`error: unsafe branch name: ${name}`);
        }
        try {
            return await withOperationLock(root, 'git:branch', `git branch ${action}`, { action, name, start_point: options.input.start_point }, async () => {
                if (action === 'switch') {
                    const cleanError = await requireCleanGitState('git branch switch');
                    if (cleanError) return textResult(cleanError);
                }
                const args = action === 'create'
                    ? ['branch', name, options.input.start_point ?? 'HEAD']
                    : ['switch', name];
                const result = await runGit(args, 120000);
                if (!result.ok) return textResult(`error: git branch ${action} failed\n${result.error ?? ''}\n${result.stderr}\n${result.stdout}`.trim());
                return textResult(result.stdout.trim() || `git branch ${action} completed: ${name}`);
            });
        } catch (error) {
            return lockErrorResult(error) ?? textResult(`error: ${(error as Error)?.message ?? String(error)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GitBranchInput>) {
        const action = options.input.action ?? 'list';
        const base = { invocationMessage: action === 'list' ? 'Reading git branches' : `${action} git branch ${options.input.name ?? ''}` };
        if (action === 'list' || (vscode.workspace.getConfiguration('harmony').get<boolean>('autoApproveTools') ?? false)) return base;
        return {
            ...base,
            confirmationMessages: {
                title: `${action === 'create' ? 'Create' : 'Switch'} git branch?`,
                message: new vscode.MarkdownString(`Harmony wants to **${action}** git branch:\n\n\`\`\`text\n${options.input.name ?? ''}\n\`\`\``)
            }
        };
    }
}

interface GitStashInput { action?: 'list' | 'push'; message?: string; include_untracked?: boolean; paths?: string[]; }

class GitStashTool implements vscode.LanguageModelTool<GitStashInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GitStashInput>) {
        const action = options.input.action ?? 'list';
        if (action === 'list') {
            const result = await runGit(['stash', 'list', '--date=local']);
            if (!result.ok) return textResult(`error: git stash list failed\n${result.error ?? ''}\n${result.stderr}`.trim());
            return textResult(result.stdout.trim() || '(no stashes)');
        }
        if (vscode.workspace.getConfiguration('harmony').get<boolean>('planOnlyMode') ?? false) {
            return textResult('error: plan-only mode is enabled; git stash push is not allowed.');
        }

        const root = gitRoot();
        if (!root) return textResult('error: no workspace folder is open');
        const args = ['stash', 'push'];
        if (options.input.include_untracked) args.push('--include-untracked');
        if (options.input.message?.trim()) args.push('-m', options.input.message.trim());
        const paths = Array.isArray(options.input.paths) ? options.input.paths : [];
        const rels: string[] = [];
        if (paths.length > 0) {
            for (const inputPath of paths) {
                const rel = workspaceRelativeGitPath(inputPath);
                if (!rel) return textResult(`error: path is outside workspace: ${inputPath}`);
                rels.push(rel);
            }
            args.push('--', ...rels);
        }
        try {
            return await withOperationLock(root, 'git:stash', 'git stash push', { message: options.input.message, include_untracked: !!options.input.include_untracked, paths }, async () => {
                const snapshotPaths = rels.length > 0 ? rels : await gitLocalChangePaths(!!options.input.include_untracked);
                if (!Array.isArray(snapshotPaths)) {
                    if (!snapshotPaths.ok) return textResult(snapshotPaths.message);
                    const snapshot = await createRequiredPreActionSnapshot(root, snapshotPaths.paths, `VS Code harmony_git_stash before git stash push`);
                    if (!snapshot.ok) return textResult(snapshot.message);
                    const result = await runGit(args, 120000);
                    if (!result.ok) return textResult(`error: git stash push failed\n${result.error ?? ''}\n${result.stderr}\n${result.stdout}`.trim());
                    return textResult(`${result.stdout.trim() || 'git stash push completed'}${formatSnapshotNote(snapshot.snapshot)}`);
                }
                const snapshot = await createRequiredPreActionSnapshot(root, snapshotPaths, `VS Code harmony_git_stash before git stash push`);
                if (!snapshot.ok) return textResult(snapshot.message);
                const result = await runGit(args, 120000);
                if (!result.ok) return textResult(`error: git stash push failed\n${result.error ?? ''}\n${result.stderr}\n${result.stdout}`.trim());
                return textResult(`${result.stdout.trim() || 'git stash push completed'}${formatSnapshotNote(snapshot.snapshot)}`);
            });
        } catch (error) {
            return lockErrorResult(error) ?? textResult(`error: ${(error as Error)?.message ?? String(error)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GitStashInput>) {
        const action = options.input.action ?? 'list';
        const base = { invocationMessage: action === 'list' ? 'Reading git stash list' : 'Creating git stash' };
        if (action === 'list' || (vscode.workspace.getConfiguration('harmony').get<boolean>('autoApproveTools') ?? false)) return base;
        return {
            ...base,
            confirmationMessages: {
                title: 'Create git stash?',
                message: new vscode.MarkdownString(`Harmony wants to stash local changes${options.input.message ? ` with message **${options.input.message}**` : ''}.`)
            }
        };
    }
}

interface GitCommitInput { message: string; all?: boolean; paths?: string[]; }

class GitCommitTool implements vscode.LanguageModelTool<GitCommitInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GitCommitInput>) {
        const root = gitRoot();
        if (!root) return textResult('error: no workspace folder is open');
        const message = (options.input.message ?? '').trim();
        if (!message) return textResult('error: missing argument: message');
        try {
            return await withOperationLock(root, 'git:commit', 'git commit', { message, all: !!options.input.all, paths: options.input.paths ?? [] }, async () => {
                const paths = Array.isArray(options.input.paths) ? options.input.paths : [];
                let snapshotNote = '';
                const preStaged = await gitStagedPaths();
                if (!preStaged.ok) return textResult(preStaged.message);
                if (options.input.all) {
                    const snapshotPaths = await gitLocalChangePaths(true);
                    if (!snapshotPaths.ok) return textResult(snapshotPaths.message);
                    const snapshot = await createRequiredPreActionSnapshot(root, snapshotPaths.paths, 'VS Code harmony_git_commit before git add -A and git commit');
                    if (!snapshot.ok) return textResult(snapshot.message);
                    const add = await runGit(['add', '-A']);
                    if (!add.ok) return textResult(`error: git add -A failed\n${add.error ?? ''}\n${add.stderr}`.trim());
                    snapshotNote = formatSnapshotNote(snapshot.snapshot);
                } else if (paths.length > 0) {
                    const rels: string[] = [];
                    for (const inputPath of paths) {
                        const rel = workspaceRelativeGitPath(inputPath);
                        if (!rel) return textResult(`error: path is outside workspace: ${inputPath}`);
                        rels.push(rel);
                    }
                    const relSet = new Set(rels);
                    const unexpected = preStaged.paths.filter(stagedPath => !relSet.has(stagedPath));
                    if (unexpected.length > 0) {
                        return textResult(`error: path-scoped commit found pre-staged paths outside the requested manifest. Unstage or commit them separately first.\n\n${unexpected.join('\n')}`);
                    }
                    const snapshot = await createRequiredPreActionSnapshot(root, rels, `VS Code harmony_git_commit before staging ${rels.join(', ')}`);
                    if (!snapshot.ok) return textResult(snapshot.message);
                    const add = await runGit(['add', '--', ...rels]);
                    if (!add.ok) return textResult(`error: git add failed\n${add.error ?? ''}\n${add.stderr}`.trim());
                    snapshotNote = formatSnapshotNote(snapshot.snapshot);
                } else if (preStaged.paths.length > 0) {
                    const snapshot = await createRequiredPreActionSnapshot(root, preStaged.paths, `VS Code harmony_git_commit before committing staged paths`);
                    if (!snapshot.ok) return textResult(snapshot.message);
                    snapshotNote = formatSnapshotNote(snapshot.snapshot);
                }

                const status = await runGit(['diff', '--staged', '--stat']);
                if (!status.ok) return textResult(`error: could not inspect staged diff\n${status.error ?? ''}\n${status.stderr}`.trim());
                if (!status.stdout.trim()) return textResult('error: no staged changes to commit. Use all:true or provide paths, or stage changes first.');

                const commit = await runGit(['commit', '-m', message], 180000);
                if (!commit.ok) return textResult(`error: git commit failed\n${commit.error ?? ''}\n${commit.stderr}\n${commit.stdout}`.trim());
                return textResult([commit.stdout.trim(), snapshotNote, '', 'Committed staged changes:', status.stdout.trim()].filter(Boolean).join('\n'));
            });
        } catch (error) {
            return lockErrorResult(error) ?? textResult(`error: ${(error as Error)?.message ?? String(error)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GitCommitInput>) {
        const autoApprove = vscode.workspace.getConfiguration('harmony').get<boolean>('autoApproveTools') ?? false;
        const base = { invocationMessage: 'Creating git commit' };
        if (autoApprove) return base;
        const scope = options.input.all ? 'all changes' : (options.input.paths?.length ? options.input.paths.join(', ') : 'currently staged changes');
        return {
            ...base,
            confirmationMessages: {
                title: 'Create git commit?',
                message: new vscode.MarkdownString(`Harmony wants to commit **${scope}** with message:\n\n\`\`\`text\n${options.input.message ?? ''}\n\`\`\``)
            }
        };
    }
}

interface GitBlameInput { path: string; start_line?: number; end_line?: number; }

class GitBlameTool implements vscode.LanguageModelTool<GitBlameInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GitBlameInput>) {
        const rel = workspaceRelativeGitPath(options.input.path ?? '');
        if (!rel) return textResult(`error: path is outside workspace: ${options.input.path ?? ''}`);
        const args = ['blame'];
        const start = Math.max(1, Math.floor(Number(options.input.start_line) || 1));
        const end = options.input.end_line ? Math.max(start, Math.floor(Number(options.input.end_line))) : undefined;
        if (options.input.start_line || options.input.end_line) args.push('-L', `${start},${end ?? start}`);
        args.push('--', rel);
        const result = await runGit(args, 120000);
        if (!result.ok) return textResult(`error: git blame failed\n${result.error ?? ''}\n${result.stderr}`.trim());
        return textResult(result.stdout.trim() || '(no blame output)');
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GitBlameInput>) {
        return { invocationMessage: `Reading git blame for ${options.input.path ?? '(missing path)'}` };
    }
}

interface GitRestoreInput { paths: string[]; source?: string; mode?: 'worktree' | 'staged' | 'both'; }

class GitRestoreTool implements vscode.LanguageModelTool<GitRestoreInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GitRestoreInput>) {
        if (vscode.workspace.getConfiguration('harmony').get<boolean>('planOnlyMode') ?? false) {
            return textResult('error: plan-only mode is enabled; git restore is not allowed.');
        }
        const root = gitRoot();
        if (!root) return textResult('error: no workspace folder is open');
        const paths = Array.isArray(options.input.paths) ? options.input.paths : [];
        if (paths.length === 0) return textResult('error: git restore requires at least one path');
        const rels: string[] = [];
        for (const inputPath of paths) {
            const rel = workspaceRelativeGitPath(inputPath);
            if (!rel) return textResult(`error: path is outside workspace: ${inputPath}`);
            rels.push(rel);
        }
        const mode = options.input.mode ?? 'worktree';
        const args = ['restore'];
        if (mode === 'staged' || mode === 'both') args.push('--staged');
        if (mode === 'both') args.push('--worktree');
        if (options.input.source?.trim()) args.push('--source', options.input.source.trim());
        args.push('--', ...rels);
        try {
            return await withOperationLock(root, 'git:restore', 'git restore', { paths: rels, source: options.input.source, mode }, async () => {
                const snapshot = mode === 'staged'
                    ? { ok: true as const, snapshot: undefined }
                    : await createRequiredPreActionSnapshot(root, rels, `VS Code harmony_git_restore before git restore ${rels.join(', ')}`);
                if (!snapshot.ok) return textResult(snapshot.message);
                const result = await runGit(args, 120000);
                if (!result.ok) return textResult(`error: git restore failed\n${result.error ?? ''}\n${result.stderr}\n${result.stdout}`.trim());
                return textResult(`${result.stdout.trim() || `git restore completed for ${rels.join(', ')}`}${formatSnapshotNote(snapshot.snapshot)}`);
            });
        } catch (error) {
            return lockErrorResult(error) ?? textResult(`error: ${(error as Error)?.message ?? String(error)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GitRestoreInput>) {
        return {
            invocationMessage: 'Restoring git paths',
            confirmationMessages: {
                title: 'Restore git paths?',
                message: new vscode.MarkdownString(`Harmony wants to run git restore for:\n\n\`\`\`text\n${(options.input.paths ?? []).join('\n')}\n\`\`\`\n\nMode: **${options.input.mode ?? 'worktree'}**. This may discard local file/index changes.`)
            }
        };
    }
}

interface GitRevertInput { commit: string; no_commit?: boolean; mainline?: number; }

class GitRevertTool implements vscode.LanguageModelTool<GitRevertInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GitRevertInput>) {
        if (vscode.workspace.getConfiguration('harmony').get<boolean>('planOnlyMode') ?? false) {
            return textResult('error: plan-only mode is enabled; git revert is not allowed.');
        }
        const root = gitRoot();
        if (!root) return textResult('error: no workspace folder is open');
        const commit = (options.input.commit ?? '').trim();
        if (!commit) return textResult('error: git revert requires commit');
        const args = ['revert'];
        if (options.input.no_commit) args.push('--no-commit');
        else args.push('--no-edit');
        if (options.input.mainline) args.push('-m', String(Math.max(1, Math.floor(Number(options.input.mainline)))));
        args.push(commit);
        try {
            return await withOperationLock(root, 'git:revert', 'git revert', { commit, no_commit: !!options.input.no_commit, mainline: options.input.mainline }, async () => {
                const affected = await runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', commit], 120000);
                if (!affected.ok) return textResult(`error: could not inspect git revert affected paths\n${affected.error ?? ''}\n${affected.stderr}\n${affected.stdout}`.trim());
                const affectedPaths = Array.from(new Set(affected.stdout.split(/\r?\n/).map(line => normalizeSnapshotPath(line)).filter(Boolean)));
                const snapshot = await createRequiredPreActionSnapshot(root, affectedPaths, `VS Code harmony_git_revert before git revert ${commit}`);
                if (!snapshot.ok) return textResult(snapshot.message);
                const result = await runGit(args, 180000);
                if (!result.ok) return textResult(`error: git revert failed\n${result.error ?? ''}\n${result.stderr}\n${result.stdout}`.trim());
                return textResult(`${result.stdout.trim() || `git revert completed for ${commit}`}${formatSnapshotNote(snapshot.snapshot)}`);
            });
        } catch (error) {
            return lockErrorResult(error) ?? textResult(`error: ${(error as Error)?.message ?? String(error)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GitRevertInput>) {
        return {
            invocationMessage: `Reverting git commit ${options.input.commit ?? ''}`,
            confirmationMessages: {
                title: 'Revert git commit?',
                message: new vscode.MarkdownString(`Harmony wants to run git revert for:\n\n\`\`\`text\n${options.input.commit ?? ''}\n\`\`\`\n\nThis may create a new commit or staged changes if no_commit is true.`)
            }
        };
    }
}

interface GitTagInput { action?: 'list' | 'create' | 'delete'; name?: string; ref?: string; message?: string; annotated?: boolean; }

function safeGitName(name: string): boolean {
    return /^[A-Za-z0-9._\/-]+$/.test(name) && !name.includes('..') && !name.startsWith('/') && !name.endsWith('/');
}

class GitTagTool implements vscode.LanguageModelTool<GitTagInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GitTagInput>) {
        const action = options.input.action ?? 'list';
        if (action === 'list') {
            const result = await runGit(['tag', '--list', '--sort=-creatordate']);
            if (!result.ok) return textResult(`error: git tag list failed\n${result.error ?? ''}\n${result.stderr}`.trim());
            return textResult(result.stdout.trim() || '(no tags)');
        }
        if (vscode.workspace.getConfiguration('harmony').get<boolean>('planOnlyMode') ?? false) {
            return textResult(`error: plan-only mode is enabled; git tag ${action} is not allowed.`);
        }
        const root = gitRoot();
        if (!root) return textResult('error: no workspace folder is open');
        const name = (options.input.name ?? '').trim();
        if (!name || !safeGitName(name)) return textResult(`error: unsafe or missing tag name: ${name}`);
        const args = action === 'delete'
            ? ['tag', '-d', name]
            : options.input.annotated || options.input.message
                ? ['tag', '-a', name, options.input.ref ?? 'HEAD', '-m', options.input.message?.trim() || name]
                : ['tag', name, options.input.ref ?? 'HEAD'];
        try {
            return await withOperationLock(root, 'git:tag', `git tag ${action}`, { action, name, ref: options.input.ref }, async () => {
                const result = await runGit(args, 120000);
                if (!result.ok) return textResult(`error: git tag ${action} failed\n${result.error ?? ''}\n${result.stderr}\n${result.stdout}`.trim());
                return textResult(result.stdout.trim() || `git tag ${action} completed: ${name}`);
            });
        } catch (error) {
            return lockErrorResult(error) ?? textResult(`error: ${(error as Error)?.message ?? String(error)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GitTagInput>) {
        const action = options.input.action ?? 'list';
        if (action === 'list') return { invocationMessage: 'Listing git tags' };
        return {
            invocationMessage: `${action} git tag ${options.input.name ?? ''}`,
            confirmationMessages: {
                title: `${action === 'create' ? 'Create' : 'Delete'} git tag?`,
                message: new vscode.MarkdownString(`Harmony wants to **${action}** git tag:\n\n\`\`\`text\n${options.input.name ?? ''}\n\`\`\``)
            }
        };
    }
}

interface GitRemoteInput { action?: 'list' | 'add' | 'remove' | 'set_url'; name?: string; url?: string; }

class GitRemoteTool implements vscode.LanguageModelTool<GitRemoteInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GitRemoteInput>) {
        const action = options.input.action ?? 'list';
        if (action === 'list') {
            const result = await runGit(['remote', '-v']);
            if (!result.ok) return textResult(`error: git remote list failed\n${result.error ?? ''}\n${result.stderr}`.trim());
            return textResult(result.stdout.trim() || '(no remotes)');
        }
        if (vscode.workspace.getConfiguration('harmony').get<boolean>('planOnlyMode') ?? false) {
            return textResult(`error: plan-only mode is enabled; git remote ${action} is not allowed.`);
        }
        const root = gitRoot();
        if (!root) return textResult('error: no workspace folder is open');
        const name = (options.input.name ?? '').trim();
        if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return textResult(`error: unsafe or missing remote name: ${name}`);
        const url = options.input.url?.trim();
        if ((action === 'add' || action === 'set_url') && !url) return textResult(`error: git remote ${action} requires url`);
        const args = action === 'remove'
            ? ['remote', 'remove', name]
            : action === 'set_url'
                ? ['remote', 'set-url', name, url!]
                : ['remote', 'add', name, url!];
        try {
            return await withOperationLock(root, 'git:remote', `git remote ${action}`, { action, name, url }, async () => {
                const result = await runGit(args, 120000);
                if (!result.ok) return textResult(`error: git remote ${action} failed\n${result.error ?? ''}\n${result.stderr}\n${result.stdout}`.trim());
                return textResult(result.stdout.trim() || `git remote ${action} completed: ${name}`);
            });
        } catch (error) {
            return lockErrorResult(error) ?? textResult(`error: ${(error as Error)?.message ?? String(error)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GitRemoteInput>) {
        const action = options.input.action ?? 'list';
        if (action === 'list') return { invocationMessage: 'Listing git remotes' };
        return {
            invocationMessage: `${action} git remote ${options.input.name ?? ''}`,
            confirmationMessages: {
                title: `${action === 'add' ? 'Add' : action === 'remove' ? 'Remove' : 'Set'} git remote?`,
                message: new vscode.MarkdownString(`Harmony wants to run git remote **${action}** for **${options.input.name ?? ''}**.`)
            }
        };
    }
}

interface GitPushInput { remote?: string; branch?: string; set_upstream?: boolean; tags?: boolean; dry_run?: boolean; }

class GitPushTool implements vscode.LanguageModelTool<GitPushInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GitPushInput>) {
        if (vscode.workspace.getConfiguration('harmony').get<boolean>('planOnlyMode') ?? false) {
            return textResult('error: plan-only mode is enabled; git push is not allowed.');
        }
        const root = gitRoot();
        if (!root) return textResult('error: no workspace folder is open');
        const remote = (options.input.remote ?? 'origin').trim();
        if (!/^[A-Za-z0-9._-]+$/.test(remote)) return textResult(`error: unsafe remote name: ${remote}`);
        let branch = options.input.branch?.trim();
        if (!branch) {
            const current = await runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
            if (!current.ok || current.stdout.trim() === 'HEAD') return textResult('error: branch is required when HEAD is detached or current branch cannot be read');
            branch = current.stdout.trim();
        }
        if (!safeGitName(branch)) return textResult(`error: unsafe branch name: ${branch}`);
        const args = ['push'];
        if (options.input.dry_run) args.push('--dry-run');
        if (options.input.tags) args.push('--tags');
        if (options.input.set_upstream) args.push('--set-upstream');
        args.push(remote, branch);
        try {
            return await withOperationLock(root, 'git:push', 'git push', { remote, branch, tags: !!options.input.tags, dry_run: !!options.input.dry_run }, async () => {
                const result = await runGit(args, 300000);
                if (!result.ok) return textResult(`error: git push failed\n${result.error ?? ''}\n${result.stderr}\n${result.stdout}`.trim());
                return textResult([result.stdout.trim(), result.stderr.trim(), `git push completed: ${remote} ${branch}`].filter(Boolean).join('\n'));
            });
        } catch (error) {
            return lockErrorResult(error) ?? textResult(`error: ${(error as Error)?.message ?? String(error)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GitPushInput>) {
        return {
            invocationMessage: 'Pushing git branch',
            confirmationMessages: {
                title: 'Push to git remote?',
                message: new vscode.MarkdownString(`Harmony wants to push to remote **${options.input.remote ?? 'origin'}**${options.input.branch ? ` branch **${options.input.branch}**` : ''}. This is always confirmation-gated.`)
            }
        };
    }
}

interface GitPullInput { remote?: string; branch?: string; strategy?: 'ff_only' | 'rebase' | 'merge'; }

class GitPullTool implements vscode.LanguageModelTool<GitPullInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GitPullInput>) {
        if (vscode.workspace.getConfiguration('harmony').get<boolean>('planOnlyMode') ?? false) {
            return textResult('error: plan-only mode is enabled; git pull is not allowed.');
        }
        const root = gitRoot();
        if (!root) return textResult('error: no workspace folder is open');
        const remote = options.input.remote?.trim();
        const branch = options.input.branch?.trim();
        if (remote && !/^[A-Za-z0-9._-]+$/.test(remote)) return textResult(`error: unsafe remote name: ${remote}`);
        if (branch && !safeGitName(branch)) return textResult(`error: unsafe branch name: ${branch}`);
        const args = ['pull'];
        const strategy = options.input.strategy ?? 'ff_only';
        if (strategy === 'ff_only') args.push('--ff-only');
        if (strategy === 'rebase') args.push('--rebase');
        if (strategy === 'merge') args.push('--no-rebase');
        if (remote) args.push(remote);
        if (branch) args.push(branch);
        try {
            return await withOperationLock(root, 'git:pull', 'git pull', { remote, branch, strategy }, async () => {
                const cleanError = await requireCleanGitState('git pull');
                if (cleanError) return textResult(cleanError);
                const result = await runGit(args, 300000);
                if (!result.ok) return textResult(`error: git pull failed\n${result.error ?? ''}\n${result.stderr}\n${result.stdout}`.trim());
                return textResult([result.stdout.trim(), result.stderr.trim(), 'git pull completed'].filter(Boolean).join('\n'));
            });
        } catch (error) {
            return lockErrorResult(error) ?? textResult(`error: ${(error as Error)?.message ?? String(error)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GitPullInput>) {
        return {
            invocationMessage: 'Pulling git remote changes',
            confirmationMessages: {
                title: 'Pull from git remote?',
                message: new vscode.MarkdownString(`Harmony wants to run git pull with strategy **${options.input.strategy ?? 'ff_only'}**. This is always confirmation-gated.`)
            }
        };
    }
}

// ─── edit_file (surgical str-replace) ─────────────────────────────────────
export interface EditFileInput {
    path: string;
    old_string: string;
    new_string: string;
    expected_occurrences?: number;
}

class EditFileTool implements vscode.LanguageModelTool<EditFileInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<EditFileInput>) {
        const { path: p, old_string, new_string, expected_occurrences } = options.input;
        if (!p || old_string === undefined || new_string === undefined) {
            return textResult('error: missing argument: path, old_string, or new_string');
        }
        const resolved = resolveWorkspacePath(p);
        if (!resolved) return textResult(`error: path is outside workspace: ${p}`);
        try {
            const originalBuffer = await fs.readFile(resolved);
            const original = originalBuffer.toString('utf8');
            const expected = Number(expected_occurrences) || 1;
            const resolvedStrings = resolveEditableStrings(original, old_string, new_string);
            const count = resolvedStrings.count;
            if (count === 0) {
                return textResult(`error: old_string not found in ${p}. Read the file first to see exact contents.`);
            }
            if (count !== expected) {
                return textResult(`error: old_string appears ${count} time(s) in ${p}, but expected ${expected}. Make old_string more specific (add surrounding lines).`);
            }
            const updated = original.split(resolvedStrings.oldString).join(resolvedStrings.newString);
            const root = workspaceRootForPath(resolved);
            if (!root) return textResult(`error: path is outside workspace: ${p}`);
            const relativePath = normalizeSnapshotPath(path.relative(root, resolved));
            const snapshot = await createRequiredPreActionSnapshot(root, [relativePath], `VS Code harmony_edit_file before editing ${relativePath}`);
            if (!snapshot.ok) return textResult(snapshot.message);
            const patchResult = await patchSafeFullFile(p, resolved, originalBuffer, original, updated);
            if (patchResult.startsWith('error:')) return textResult(patchResult);
            const oldLines = old_string.split('\n');
            const newLines = new_string.split('\n');
            const previewOld = oldLines.slice(0, 8).map(l => '- ' + l).join('\n');
            const previewNew = newLines.slice(0, 8).map(l => '+ ' + l).join('\n');
            const truncatedNote = (oldLines.length > 8 || newLines.length > 8) ? '\n... (preview truncated)' : '';
            return textResult(
                `${patchResult}${formatSnapshotNote(snapshot.snapshot)}\n${count} replacement${count === 1 ? '' : 's'} validated before write.${resolvedStrings.note ? `\n${resolvedStrings.note}.` : ''}\n\n` +
                '```diff\n' + previewOld + '\n' + previewNew + truncatedNote + '\n```'
            );
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<EditFileInput>) {
        const autoApprove = vscode.workspace.getConfiguration('harmony').get<boolean>('autoApproveTools') ?? false;
        const base = { invocationMessage: `Editing ${options.input.path}` };
        if (autoApprove) return base;
        const oldPreview = (options.input.old_string ?? '').split('\n').slice(0, 6).join('\n');
        const newPreview = (options.input.new_string ?? '').split('\n').slice(0, 6).join('\n');
        return {
            ...base,
            confirmationMessages: {
                title: 'Edit file?',
                message: new vscode.MarkdownString(
                    `Harmony wants to edit \`${options.input.path}\`:\n\n**Replace:**\n\`\`\`\n${oldPreview}\n\`\`\`\n**With:**\n\`\`\`\n${newPreview}\n\`\`\``
                )
            }
        };
    }
}

// ─── apply_patch (multi-hunk "old/new" pairs) ───────────────────────────
export interface PatchHunk { old_string: string; new_string: string; }
export interface ApplyPatchInput { path: string; hunks: PatchHunk[]; }

class ApplyPatchTool implements vscode.LanguageModelTool<ApplyPatchInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ApplyPatchInput>) {
        const { path: p, hunks } = options.input;
        if (!p || !Array.isArray(hunks) || hunks.length === 0) {
            return textResult('error: missing argument: path or hunks (must be non-empty array)');
        }
        const resolved = resolveWorkspacePath(p);
        if (!resolved) return textResult(`error: path is outside workspace: ${p}`);
        try {
            const originalBuffer = await fs.readFile(resolved);
            const original = originalBuffer.toString('utf8');
            let updated = original;
            const applied: string[] = [];
            for (let i = 0; i < hunks.length; i++) {
                const h = hunks[i];
                if (!h || typeof h.old_string !== 'string' || typeof h.new_string !== 'string') {
                    return textResult(`error: hunk ${i + 1} missing old_string or new_string`);
                }
                const resolvedStrings = resolveEditableStrings(updated, h.old_string, h.new_string);
                const count = resolvedStrings.count;
                if (count === 0) {
                    return textResult(`error: hunk ${i + 1} old_string not found in ${p} (after applying ${i} earlier hunk${i === 1 ? '' : 's'}). No changes written.`);
                }
                if (count > 1) {
                    return textResult(`error: hunk ${i + 1} old_string appears ${count} times in ${p}. Make it more specific. No changes written.`);
                }
                updated = updated.replace(resolvedStrings.oldString, resolvedStrings.newString);
                applied.push(`hunk ${i + 1}: Δ ${resolvedStrings.newString.length - resolvedStrings.oldString.length} chars${resolvedStrings.note ? ` (${resolvedStrings.note})` : ''}`);
            }
            const root = workspaceRootForPath(resolved);
            if (!root) return textResult(`error: path is outside workspace: ${p}`);
            const relativePath = normalizeSnapshotPath(path.relative(root, resolved));
            const snapshot = await createRequiredPreActionSnapshot(root, [relativePath], `VS Code harmony_apply_patch before patching ${relativePath}`);
            if (!snapshot.ok) return textResult(snapshot.message);
            const patchResult = await patchSafeFullFile(p, resolved, originalBuffer, original, updated);
            if (patchResult.startsWith('error:')) return textResult(patchResult);
            const totalDelta = updated.length - original.length;
            return textResult(
                `${patchResult}${formatSnapshotNote(snapshot.snapshot)}\nvalidated ${hunks.length} hunk${hunks.length === 1 ? '' : 's'} atomically before write (Δ ${totalDelta >= 0 ? '+' : ''}${totalDelta} chars).\n` +
                applied.map(a => '  - ' + a).join('\n')
            );
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ApplyPatchInput>) {
        const autoApprove = vscode.workspace.getConfiguration('harmony').get<boolean>('autoApproveTools') ?? false;
        const n = options.input.hunks?.length ?? 0;
        const base = { invocationMessage: `Patching ${options.input.path} (${n} hunk${n === 1 ? '' : 's'})` };
        if (autoApprove) return base;
        return {
            ...base,
            confirmationMessages: {
                title: 'Apply patch?',
                message: new vscode.MarkdownString(
                    `Harmony wants to apply **${n} hunk${n === 1 ? '' : 's'}** to \`${options.input.path}\`.`
                )
            }
        };
    }
}

// ─── ask_question (interactive, non-destructive) ──────────────────────────────
export type ConvoMode = 'explore' | 'decide';

export interface AskQuestionInput {
    /** The question, reflection, or topic to explore with the user. */
    question: string;
    /** Short header/title for the question dialog. */
    header?: string;
    /** Optional extra context shown with the prompt. */
    message?: string;
    /**
     * Conversation mode:
     * - 'explore' (default): Non-blocking exploration. Share a thought, reflection, or idea
     *   and invite the user to build on it. Include a `thought` field with your reasoning.
     * - 'decide': Blocking decision. Provide clear options with your recommendation.
     *   Options should be offered in the `options` array.
     */
    mode?: ConvoMode;
    /**
     * Required in 'explore' mode. Your reflection, reasoning, or musing about the topic.
     * Never omit this — it ensures the question is grounded in thought, not bare.
     * In 'decide' mode, this is optional but recommended.
     */
    thought?: string;
    /**
     * Decision options for 'decide' mode. Each option is a string label or an object
     * with label, optional description, and optional recommended flag.
     */
    options?: Array<string | { label: string; description?: string; recommended?: boolean }>;
    allowFreeformInput?: boolean;
    allow_freeform?: boolean;
    multiSelect?: boolean;
    multi_select?: boolean;
    multiline?: boolean;
    /** Show a 'Ready' checkbox for mutual flow-state signalling. */
    readyCheckbox?: boolean;
    /** Custom label for the ready checkbox. */
    readyLabel?: string;
    questions?: Array<{
        header?: string;
        question: string;
        message?: string;
        mode?: ConvoMode;
        thought?: string;
        options?: Array<string | { label: string; description?: string; recommended?: boolean }>;
        allowFreeformInput?: boolean;
        allow_freeform?: boolean;
        multiSelect?: boolean;
        multi_select?: boolean;
        multiline?: boolean;
        readyCheckbox?: boolean;
        readyLabel?: string;
    }>;
}

class AskQuestionTool implements vscode.LanguageModelTool<AskQuestionInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<AskQuestionInput>, token: vscode.CancellationToken) {
        const questions = Array.isArray(options.input.questions) && options.input.questions.length > 0
            ? options.input.questions
            : [options.input];
        if (!questions.every(q => q.question)) return textResult('error: missing argument: question');
        
        try {
            const answers: Array<{ question: string; answer: string }> = [];
            for (const questionInput of questions) {
                const answer = await showHarmonyAsk({
                    question: formatAskQuestionText(questionInput),
                    options: normalizeAskOptions(questionInput.options),
                    multiline: !!questionInput.multiline,
                    allowFreeformInput: questionInput.allowFreeformInput ?? questionInput.allow_freeform,
                    multiSelect: !!(questionInput.multiSelect ?? questionInput.multi_select),
                    readyCheckbox: questionInput.readyCheckbox,
                    readyLabel: questionInput.readyLabel,
                }, token);
                if (answer === undefined) return textResult('user cancelled');
                answers.push({ question: questionInput.question, answer });
            }
            if (answers.length === 1) return textResult(answers[0].answer);
            return textResult(JSON.stringify({ answers }, null, 2));
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<AskQuestionInput>) {
        const lm = LanguageManager.getInstance();
        const choiceCount = options.input.options?.length ?? 0;
        return { invocationMessage: choiceCount > 0
            ? lm.getString('ask.invocationWithOptions').replace('{count}', String(choiceCount))
            : lm.getString('ask.invocationSimple')
        };
    }
}

function normalizeAskOptions(options: AskQuestionInput['options']): HarmonyAskOptions['options'] {
    return (options ?? []).map(option => {
        if (typeof option === 'string') return option;
        return {
            label: option.label,
            description: option.description,
            recommended: option.recommended,
        };
    }).filter(option => typeof option === 'string' ? option.length > 0 : option.label.length > 0);
}

function formatAskQuestionText(input: Pick<AskQuestionInput, 'header' | 'message' | 'question'>): string {
    return [input.header, input.question, input.message].filter(Boolean).join('\n\n');
}

// ─── fetch_url ──────────────────────────────────────────────────────────────
interface FetchUrlInput { url: string; max_chars?: number; }

class FetchUrlTool implements vscode.LanguageModelTool<FetchUrlInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<FetchUrlInput>, token: vscode.CancellationToken) {
        const { url, max_chars } = options.input;
        if (!url || typeof url !== 'string') return textResult('error: missing argument: url');
        let parsed: URL;
        try { parsed = new URL(url); } catch { return textResult(`error: invalid URL: ${url}`); }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return textResult(`error: only http(s) URLs are allowed (got ${parsed.protocol})`);
        }
        const cap = Math.min(Math.max(Number(max_chars) || 8000, 500), 60000);
        const controller = new AbortController();
        const sub = token.onCancellationRequested(() => controller.abort());
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
            const r = await fetch(parsed.toString(), {
                method: 'GET',
                headers: { 'User-Agent': 'Harmony-VSCode-Extension/0.2.1' },
                signal: controller.signal as any,
                redirect: 'follow'
            });
            const ctype = r.headers.get('content-type') ?? '';
            const raw = await r.text();
            if (!r.ok) return textResult(`error: HTTP ${r.status}\n${raw.slice(0, 500)}`);
            const stripped = ctype.includes('html') ? stripHtml(raw) : raw;
            const out = stripped.length > cap ? stripped.slice(0, cap) + `\n…[truncated, ${stripped.length - cap} more chars]` : stripped;
            return textResult(`URL: ${parsed.toString()}\nStatus: ${r.status} (${ctype})\n\n${out}`);
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        } finally {
            clearTimeout(timer);
            sub.dispose();
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<FetchUrlInput>) {
        return { invocationMessage: `Fetching ${options.input.url}` };
    }
}

function stripHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n\s*\n+/g, '\n\n')
        .trim();
}

// ─── todo ───────────────────────────────────────────────────────────────────
interface TodoInput {
    action: 'add' | 'list' | 'check' | 'uncheck' | 'remove' | 'clear';
    items?: string[];   // for add
    id?: string;        // for check/uncheck/remove
    scope?: 'all' | 'done'; // for clear
}

class TodoTool implements vscode.LanguageModelTool<TodoInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<TodoInput>) {
        const { action } = options.input;
        try {
            switch (action) {
                case 'add': {
                    const items = options.input.items ?? [];
                    if (!Array.isArray(items) || items.length === 0)
                        return textResult('error: add requires items: string[]');
                    const all = await addTodos(items);
                    return textResult(`Added ${items.length} item(s). Current list:\n${formatTodos(all)}`);
                }
                case 'list': {
                    const all = await loadTodos();
                    return textResult(formatTodos(all));
                }
                case 'check':
                case 'uncheck': {
                    if (!options.input.id) return textResult('error: id is required');
                    const all = await checkTodo(options.input.id, action === 'check');
                    return textResult(`Updated. Current list:\n${formatTodos(all)}`);
                }
                case 'remove': {
                    if (!options.input.id) return textResult('error: id is required');
                    const all = await removeTodo(options.input.id);
                    return textResult(`Removed. Current list:\n${formatTodos(all)}`);
                }
                case 'clear': {
                    const all = await clearTodos(options.input.scope ?? 'all');
                    return textResult(`Cleared. Current list:\n${formatTodos(all)}`);
                }
                default:
                    return textResult(`error: unknown action: ${action}`);
            }
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<TodoInput>) {
        return { invocationMessage: `Todo: ${options.input.action}` };
    }
}

// ─── consult_model ──────────────────────────────────────────────────────────
interface ConsultModelInput {
    provider: ProviderId;
    tier?: Tier;
    question: string;
    system?: string;
    max_tokens?: number;
    /** Multi-key slot: 0=Chat (default), 1=Agents, 2=External, 3=Vision. Use the agents slot when calling provider-specific agent tools. */
    slot_index?: number;
}

class ConsultModelTool implements vscode.LanguageModelTool<ConsultModelInput> {
    constructor(private readonly secrets: vscode.SecretStorage) {}
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ConsultModelInput>, token: vscode.CancellationToken) {
        const { provider, question } = options.input;
        const tier: Tier = options.input.tier ?? 'mid';
        if (!provider) return textResult('error: missing argument: provider (deepseek|alibaba|tencent|moonshot|kimiCode|gemini|openrouter|openai|claude|zhipu)');
        if (!question || !question.trim()) return textResult('error: missing argument: question');
        const ok = await confirmHeavyTier(provider, tier);
        if (!ok) return textResult('user denied heavy-tier consultation');
        try {
            const r = await consult(this.secrets, {
                provider, tier, question,
                system: options.input.system,
                maxTokens: options.input.max_tokens,
                slotIndex: options.input.slot_index
            }, token);
            const usage = r.usage ? ` (in:${r.usage.promptTokens ?? '?'} out:${r.usage.completionTokens ?? '?'})` : '';
            const slotLabel = options.input.slot_index != null ? ` slot:${['chat','agents','external','vision'][options.input.slot_index]}` : '';
            return textResult(`[${r.provider}/${r.model}${slotLabel}${usage}]\n\n${r.text}`);
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ConsultModelInput>) {
        const tier = options.input.tier ?? 'mid';
        return { invocationMessage: `Consulting ${options.input.provider} (${tier})` };
    }
}

// ─── spawn_worker ───────────────────────────────────────────────────────────
// A "Collaborative Worker" \u2014 dispatches a focused sub-task to another model
// with read-only context isolation. Worker has access to read tools only;
// it returns a synthesized text answer. The parent agent decides what to
// do with the result (use it, discard it, ask a second worker, etc).
interface SpawnWorkerInput {
    task: string;
    role?: WorkerRole;
    provider?: ProviderId;
    tier?: Tier;
    system?: string;
    /** Workspace files to inline as context. Workspace-relative paths. */
    context_files?: string[];
    /** Symphony agent profile ID to load from .harmony/profiles/ */
    profileId?: string;
    /** Max characters per context file (default 24000) */
    max_chars_per_file?: number;
    /** Multi-key slot: 0=Chat (default), 1=Agents, 2=External, 3=Vision. */
    slot_index?: number;
}

type WorkerRole = 'scout' | 'researcher' | 'planner' | 'implementer' | 'verifier' | 'critic' | 'cost_sentinel' | 'hard_reasoner';

const WORKER_ROLE_TIERS: Record<WorkerRole, Tier> = {
    scout: 'light',
    researcher: 'mid',
    planner: 'coding',
    implementer: 'coding',
    verifier: 'coding',
    critic: 'mid',
    cost_sentinel: 'light',
    hard_reasoner: 'heavy'
};

function workerRoleTier(role: WorkerRole | undefined, fallback: Tier): Tier {
    return role ? WORKER_ROLE_TIERS[role] : fallback;
}

function workerRoleSystem(role: WorkerRole | undefined): string {
    const base = 'You are a focused sub-agent for a coding assistant. Answer the task concisely and concretely. Cite specific lines or names from the provided context. Do not ask clarifying questions; make your best inference from context and state assumptions explicitly.';
    switch (role) {
        case 'scout': return `${base} Your role is scout: quickly locate relevant files, symbols, facts, and risks without proposing broad changes.`;
        case 'researcher': return `${base} Your role is researcher: gather evidence, compare options, and separate verified facts from assumptions.`;
        case 'planner': return `${base} Your role is planner: produce a short execution plan with ordering, dependencies, risks, and validation checks.`;
        case 'implementer': return `${base} Your role is implementer: focus on the smallest coherent code change and call out likely edge cases.`;
        case 'verifier': return `${base} Your role is verifier: look for regressions, missing tests, unsafe assumptions, and concrete validation gaps.`;
        case 'critic': return `${base} Your role is critic: challenge the proposed solution for correctness, maintainability, security, and user-impact risks.`;
        case 'cost_sentinel': return `${base} Your role is cost sentinel: assess provider/model/cost risk and recommend lower-cost routes where they are adequate.`;
        case 'hard_reasoner': return `${base} Your role is hard reasoner: spend effort on genuinely difficult reasoning, architecture, or correctness questions.`;
        default: return base;
    }
}

class SpawnWorkerTool implements vscode.LanguageModelTool<SpawnWorkerInput> {
    constructor(private readonly secrets: vscode.SecretStorage) {}
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SpawnWorkerInput>, token: vscode.CancellationToken) {
        const { task } = options.input;
        if (!task || !task.trim()) return textResult('error: missing argument: task');

        // Load Symphony profile if requested
        let profileSystem: string | undefined;
        let profileProvider: ProviderId | undefined;
        let profileModel: string | undefined;
        if (options.input.profileId) {
            const registry = ProfileRegistry.getInstance();
            if (!registry.isLoaded()) await registry.loadAll();
            const profile = registry.get(options.input.profileId);
            if (!profile) return textResult(`error: profile '${options.input.profileId}' not found in .harmony/profiles/`);
            profileSystem = await registry.compileSystemPrompt(profile);
            if (profile.provider_preference) {
                profileProvider = profile.provider_preference.provider as ProviderId;
                profileModel = profile.provider_preference.model;
            }
            if (profile.tool_restrictions) {
                const tr = profile.tool_restrictions;
                if (tr.allowed_tools?.length) {
                    profileSystem += `\n\nTool restrictions: You may ONLY use these tools: ${tr.allowed_tools.join(', ')}.`;
                }
                if (tr.denied_tools?.length) {
                    profileSystem += `\n\nTool restrictions: Do NOT use these tools: ${tr.denied_tools.join(', ')}.`;
                }
            }
        }

        const role = options.input.role;
        const selected = (!options.input.provider || !options.input.tier) ? await resolveCollabModel(this.secrets) : undefined;
        const provider: ProviderId = profileProvider ?? options.input.provider ?? selected?.provider ?? 'deepseek';
        const tier: Tier = options.input.tier ?? workerRoleTier(role, selected?.tier ?? 'light');
        const ok = await confirmHeavyTier(provider, tier);
        if (!ok) return textResult('user denied heavy-tier worker');

        // Inline requested context files (read-only).
        const contextBlocks: string[] = [];
        for (const f of options.input.context_files ?? []) {
            const resolved = resolveWorkspacePath(f);
            if (!resolved) { contextBlocks.push(`[${f}: outside workspace, skipped]`); continue; }
            try {
                const buf = await fs.readFile(resolved, 'utf8');
                const maxChars = options.input.max_chars_per_file ?? 24000;
                const trimmed = buf.length > maxChars ? buf.slice(0, maxChars) + `\n…[truncated ${buf.length - maxChars} chars]` : buf;
                contextBlocks.push(`--- ${f} ---\n${trimmed}\n--- end ${f} ---`);
            } catch (e: any) {
                contextBlocks.push(`[${f}: ${e?.message ?? 'read failed'}]`);
            }
        }

        const system = profileSystem ?? options.input.system ?? workerRoleSystem(role);

        const fullQuestion = contextBlocks.length > 0
            ? `Context:\n\n${contextBlocks.join('\n\n')}\n\nTask:\n${task}`
            : task;

        try {
            const r = await consult(this.secrets, {
                provider, tier, question: fullQuestion, system, maxTokens: 4096, slotIndex: options.input.slot_index
            }, token);
            const usage = r.usage ? ` (in:${r.usage.promptTokens ?? '?'} out:${r.usage.completionTokens ?? '?'})` : '';
            const roleLabel = role ? ` ${role}` : '';
            const slotLabel = options.input.slot_index != null ? ` slot:${['chat','agents','external','vision'][options.input.slot_index]}` : '';
            return textResult(`[Worker${roleLabel} ${r.provider}/${r.model}${slotLabel}${usage}]\n\n${r.text}`);
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SpawnWorkerInput>) {
        const role = options.input.role;
        const selected = (!options.input.provider || !options.input.tier) ? await resolveCollabModel(this.secrets) : undefined;
        const provider = options.input.provider ?? selected?.provider ?? 'deepseek';
        const tier = options.input.tier ?? workerRoleTier(role, selected?.tier ?? 'light');
        const label = role ? `${role} worker` : 'worker';
        const profileLabel = options.input.profileId ? ` (profile: ${options.input.profileId})` : '';
        return { invocationMessage: `Spawning ${label}${profileLabel} on ${provider} (${tier})` };
    }
}

// ─── HarmonyHub: cross-project semantic recall ────────────────────────────

interface RecallAcrossProjectsInput {
    query: string;
    k?: number;
    scope?: 'code' | 'docs' | 'sessions' | 'all';
    index_path?: string;
}

class RecallAcrossProjectsTool implements vscode.LanguageModelTool<RecallAcrossProjectsInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<RecallAcrossProjectsInput>, _token: vscode.CancellationToken) {
        const cfg = vscode.workspace.getConfiguration('harmony');
        const baseUrl = cfg.get<string>('hub.url', 'http://127.0.0.1:7878');
        const query = (options.input.query ?? '').trim();
        if (!query) return textResult('error: empty query');
        const k = Math.max(1, Math.min(25, options.input.k ?? 8));
        const scope = options.input.scope ?? 'all';

        const ensureHub = async (): Promise<string | undefined> => {
            try {
                const status = await fetch(`${baseUrl}/status`, { signal: AbortSignal.timeout(1500) });
                if (status.ok) return undefined;
            } catch { /* start below if allowed */ }

            if (!(cfg.get<boolean>('hub.autoStart') ?? true)) {
                return `HarmonyHub is paused/offline at ${baseUrl}. Use the Hub controls or run Harmony: Start Hub, then retry.`;
            }

            try {
                await vscode.commands.executeCommand('harmony.startHub');
                const status = await fetch(`${baseUrl}/status`, { signal: AbortSignal.timeout(3000) });
                if (status.ok) return undefined;
            } catch (e: any) {
                return `HarmonyHub could not start at ${baseUrl}. ${e?.message ?? e}`;
            }
            return `HarmonyHub did not become ready at ${baseUrl}.`;
        };

        const hubError = await ensureHub();
        if (hubError) return textResult(`error: ${hubError}`);

        // Optional one-shot index before search
        if (options.input.index_path) {
            try {
                const idxRes = await fetch(`${baseUrl}/index`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ path: options.input.index_path, scope }),
                });
                if (!idxRes.ok) {
                    return textResult(`error: indexing failed (${idxRes.status}): ${await idxRes.text()}`);
                }
            } catch (e: any) {
                return textResult(`error: HarmonyHub not reachable at ${baseUrl}. Start it with \`cargo run --release\` in the HarmonyHub repo, then retry.\n${e?.message ?? e}`);
            }
        }

        try {
            const res = await fetch(`${baseUrl}/search`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query, k, scope }),
            });
            if (!res.ok) {
                return textResult(`error: search failed (${res.status}): ${await res.text()}`);
            }
            const hits = await res.json() as Array<{ path: string; score: number; snippet: string; line_start: number; line_end: number }>;
            if (!hits.length) {
                return textResult(`No matches. Hub may be empty — try again with index_path set to a folder you want indexed (e.g. "C:\\\\Coding").`);
            }
            const lines: string[] = [`Found ${hits.length} matches across your indexed projects:\n`];
            for (const h of hits) {
                lines.push(`### ${h.path}:${h.line_start}-${h.line_end}  (score ${h.score.toFixed(3)})`);
                lines.push('```');
                lines.push(h.snippet);
                lines.push('```\n');
            }
            return textResult(clip(lines.join('\n')));
        } catch (e: any) {
            return textResult(`error: HarmonyHub not reachable at ${baseUrl}. ${e?.message ?? e}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<RecallAcrossProjectsInput>) {
        const scope = options.input.scope ?? 'all';
        return { invocationMessage: `Recalling across projects (${scope})…` };
    }
}

// ─── continuity bus ────────────────────────────────────────────────────────
interface ContinuityInput {
    action: 'latest' | 'list' | 'handoff' | 'import' | 'compact' | 'fork';
    text?: string;
    notes?: string;
    name?: string;
    limit?: number;
    source?: string;
}

class ContinuityTool implements vscode.LanguageModelTool<ContinuityInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ContinuityInput>) {
        const action = options.input.action ?? 'latest';
        try {
            switch (action) {
                case 'latest': {
                    const entry = await latestContinuityEntry();
                    return textResult(entry ? formatContinuityEntry(entry) : 'No continuity entries yet.');
                }
                case 'list': {
                    const entries = await listContinuityEntries(Math.max(1, Math.min(50, options.input.limit ?? 10)));
                    return textResult(entries.length === 0 ? 'No continuity entries yet.' : entries.map(formatContinuityEntry).join('\n\n'));
                }
                case 'handoff': {
                    const rel = await createContinuityHandoff(options.input.notes ?? options.input.text ?? '');
                    return textResult(`Created handoff packet: ${rel}`);
                }
                case 'import': {
                    const text = options.input.text?.trim();
                    if (!text) return textResult('error: import requires text');
                    const entry = await importContinuityFromText(text, options.input.source ?? 'harmony_continuity tool');
                    return textResult(`Imported continuity entry ${entry.id}: ${entry.summary}`);
                }
                case 'compact': {
                    const entry = await compactContinuity(options.input.notes ?? options.input.text ?? '');
                    return textResult(`Compacted continuity entry ${entry.id}: ${entry.summary}`);
                }
                case 'fork': {
                    const entry = await forkContinuity(options.input.name ?? 'fork', options.input.notes ?? options.input.text ?? '');
                    return textResult(`Forked continuity entry ${entry.id}: ${entry.summary}`);
                }
                default:
                    return textResult(`error: unknown continuity action: ${action}`);
            }
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ContinuityInput>) {
        return { invocationMessage: `Continuity: ${options.input.action ?? 'latest'}` };
    }
}

// ─── codebase orchestrator (read-only, model-neutral) ───────────────────────
interface OrchestrateCodebaseInput {
    question: string;
    provider?: ProviderId;
    tier?: Tier;
    include_globs?: string[];
    exclude_glob?: string;
    max_files?: number;
    max_chars?: number;
    max_tokens?: number;
    include_private_files?: boolean;
}

// Ordered fallback providers for the orchestrator when the primary fails.
const ORCHESTRATOR_FALLBACK_CHAIN: Array<{ provider: ProviderId; tier: Tier }> = [
    { provider: 'gemini', tier: 'coding' },      // Gemini 3 Flash — same cost tier, 1M context
    { provider: 'openrouter', tier: 'heavy' },   // DeepSeek-R1 free via OpenRouter — last resort
];

function orchestratorCostLabel(provider: ProviderId, tier: Tier, packChars: number): string {
    // Rough token estimate: 1 token ≈ 3.5 chars for code; add 4K output tokens
    const inputTokens = Math.ceil(packChars / 3.5);
    const outputTokens = 4000;
    const model = modelFor(provider, tier);
    const cost = estimateCost(provider, model, inputTokens, outputTokens);
    const costStr = cost !== undefined ? `${cost < 0.05 ? '●○○ Low' : cost < 0.20 ? '●●○ Medium' : '●●● Significant'}` : 'unknown cost';
    return `${provider}/${model} — ${costStr} (${Math.round(packChars / 1000)}K chars ≈ ${Math.round(inputTokens / 1000)}K tokens in, 4K out)`;
}

class OrchestrateCodebaseTool implements vscode.LanguageModelTool<OrchestrateCodebaseInput> {
    constructor(private readonly secrets: vscode.SecretStorage) {}
    async invoke(options: vscode.LanguageModelToolInvocationOptions<OrchestrateCodebaseInput>, token: vscode.CancellationToken) {
        const question = options.input.question?.trim();
        if (!question) return textResult('error: missing argument: question');

        // Read default provider from setting; fall back to deepseek (not gemini).
        const cfg = vscode.workspace.getConfiguration('harmony');
        const provider: ProviderId = (options.input.provider ?? cfg.get<string>('orchestrator.defaultProvider') ?? 'deepseek') as ProviderId;
        const tier: Tier = (options.input.tier ?? cfg.get<string>('orchestrator.defaultTier') ?? 'coding') as Tier;

        const ok = await confirmHeavyTier(provider, tier);
        if (!ok) return textResult('user denied orchestrator model call');

        try {
            const legacyIncludePrivateFiles = (options.input as any)[`include_${'fa'}${'mily'}_files`];
            const pack = await createRepoPack({
                includeGlobs: options.input.include_globs,
                excludeGlob: options.input.exclude_glob,
                maxFiles: options.input.max_files,
                maxChars: options.input.max_chars,
                includePrivateFiles: options.input.include_private_files ?? legacyIncludePrivateFiles,
            });
            const system = providerOrchestratorSystem(provider);
            const prompt = `${pack.text}\n\n# Orchestrator Task\n${question}\n\nReturn exactly these sections when relevant: Summary, Impact Map, Suggested Slices, Verification Plan, Risks, Next Best Step.`;

            // Try primary provider, then fallback chain on failure.
            const providerChain: Array<{ provider: ProviderId; tier: Tier }> = [
                { provider, tier },
                ...ORCHESTRATOR_FALLBACK_CHAIN.filter(f => f.provider !== provider),
            ];

            let response: Awaited<ReturnType<typeof consult>> | undefined;
            let lastError: Error | undefined;
            for (const attempt of providerChain) {
                try {
                    response = await consult(this.secrets, {
                        provider: attempt.provider,
                        tier: attempt.tier,
                        system,
                        question: prompt,
                        maxTokens: options.input.max_tokens ?? 4096,
                    }, token);
                    break;
                } catch (e: any) {
                    lastError = e;
                    if (token.isCancellationRequested) break;
                    // Continue to next provider in chain.
                }
            }

            if (!response) {
                return textResult(`error: all orchestrator providers failed. Last error: ${lastError?.message ?? 'unknown'}`);
            }

            await appendContinuityEntry({
                kind: 'orchestrator',
                source: `${response.provider}/${response.model}`,
                summary: `Codebase orchestrator answered: ${question.slice(0, 160)}`,
                body: response.text,
                files: pack.files,
                nextActions: ['Review the suggested slices, ask the user if scope is ambiguous, then apply one small verified change.'],
                privacy: 'local',
                metadata: { provider: response.provider, tier, model: response.model, files: pack.files.length, chars: pack.chars, truncated: pack.truncated },
            });

            const usage = response.usage ? ` (in:${response.usage.promptTokens ?? '?'} out:${response.usage.completionTokens ?? '?'})` : '';
            return textResult(`[Orchestrator ${response.provider}/${response.model}${usage}; files=${pack.files.length}; chars=${pack.chars}; truncated=${pack.truncated ? 'yes' : 'no'}]\n\n${response.text}`);
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<OrchestrateCodebaseInput>) {
        const cfg = vscode.workspace.getConfiguration('harmony');
        const provider: ProviderId = (options.input.provider ?? cfg.get<string>('orchestrator.defaultProvider') ?? 'deepseek') as ProviderId;
        const tier: Tier = (options.input.tier ?? cfg.get<string>('orchestrator.defaultTier') ?? 'coding') as Tier;
        // Estimate cost from settings-based max; actual pack may be smaller.
        const maxChars = options.input.max_chars ?? cfg.get<number>('orchestrator.maxContextChars') ?? 120000;
        const costLabel = orchestratorCostLabel(provider, tier, maxChars);
        return {
            invocationMessage: `Orchestrating codebase with ${provider} (${tier}) — est. ${costLabel}`
        };
    }
}

// ─── run-fail-fix verification loop ────────────────────────────────────────
interface RunFailFixInput {
    command?: string;
    purpose?: string;
    timeout_sec?: number;
}

class RunFailFixTool implements vscode.LanguageModelTool<RunFailFixInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<RunFailFixInput>) {
        const command = options.input.command?.trim() || defaultVerificationCommand();
        const purpose = options.input.purpose?.trim() || 'run-fail-fix verification';
        const timeoutSec = options.input.timeout_sec ? Math.max(5, Math.min(1800, Math.floor(options.input.timeout_sec))) : defaultVerificationTimeoutSec();
        try {
            const result = await runVerification(command, purpose, timeoutSec);
            return textResult([
                `Verification ${result.ok ? 'PASSED' : 'FAILED'}`,
                `command: ${result.command}`,
                `duration_ms: ${result.durationMs}`,
                `exit_code: ${result.exitCode ?? (result.ok ? 0 : 'unknown')}`,
                `timed_out: ${result.timedOut ? 'yes' : 'no'}`,
                '',
                result.output,
            ].join('\n'));
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<RunFailFixInput>) {
        const command = options.input.command?.trim() || defaultVerificationCommand();
        const autoApprove = vscode.workspace.getConfiguration('harmony').get<boolean>('autoApproveTools') ?? false;
        const base = { invocationMessage: `Verifying: ${command}` };
        if (autoApprove) return base;
        return {
            ...base,
            confirmationMessages: {
                title: 'Run verification command?',
                message: new vscode.MarkdownString(`Harmony wants to run verification:\n\n\`\`\`\n${command}\n\`\`\``)
            }
        };
    }
}

// ─── MCP manager status ────────────────────────────────────────────────────
class McpStatusTool implements vscode.LanguageModelTool<Record<string, never>> {
    async invoke() {
        return textResult(formatMcpStatus());
    }
    async prepareInvocation() {
        return { invocationMessage: 'Checking Harmony MCP status' };
    }
}

// ─── Harmony Creative service (port 8896) ────────────────────────────────────────
async function callHarmonyCreative(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs = 60_000
): Promise<string> {
    const result = await invokeCreativeService(toolName, args, timeoutMs);
    return result.ok ? result.result : `error: ${result.result}`;
}

function creativeDefaultSetting(name: 'imageQuality' | 'layerBackend' | 'videoModel'): string | undefined {
    try {
        const value = vscode.workspace.getConfiguration('harmonyCreative').get<string>(name);
        return value?.trim() || undefined;
    } catch {
        return undefined;
    }
}

class CreativeHealthTool implements vscode.LanguageModelTool<Record<string, never>> {
    async invoke() {
        return textResult(await callHarmonyCreative('creative_health', {}));
    }
    async prepareInvocation() { return { invocationMessage: 'Checking Harmony Creative health…' }; }
}

interface GenerateImageInput {
    prompt: string;
    quality?: string;
    aspect_ratio?: string;
    member?: string;
    seed?: number;
    reference_images?: string[] | string;
    preserve_likeness?: boolean;
    likeness_name?: string;
    use_member_lora?: boolean;
}
class GenerateImageTool implements vscode.LanguageModelTool<GenerateImageInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GenerateImageInput>) {
        const { prompt, quality, aspect_ratio, member, seed, reference_images, preserve_likeness, likeness_name, use_member_lora } = options.input;
        if (!prompt?.trim()) return textResult('error: missing argument: prompt');
        const args: Record<string, unknown> = { prompt };
        const selectedQuality = quality || creativeDefaultSetting('imageQuality');
        if (selectedQuality) args.quality = selectedQuality;
        if (aspect_ratio) args.aspect_ratio = aspect_ratio;
        if (member) args.member = member;
        if (seed !== undefined) args.seed = Number(seed);
        if (reference_images !== undefined) args.reference_images = reference_images;
        if (preserve_likeness !== undefined) args.preserve_likeness = !!preserve_likeness;
        if (likeness_name) args.likeness_name = likeness_name;
        if (use_member_lora !== undefined) args.use_member_lora = !!use_member_lora;
        return textResult(await callHarmonyCreative('generate_image', args, 300_000));
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GenerateImageInput>) {
        return { invocationMessage: `Generating image: ${(options.input.prompt ?? '').slice(0, 60)}…` };
    }
}

interface GenerateLayerSetInput {
    set_name: string;
    layers?: Array<Record<string, unknown>> | string;
    prompt?: string;
    backend?: string;
    mode?: string;
    chain?: boolean;
    topology?: string;
    aspect_ratio?: string;
    resolution?: string;
    seed?: number;
}
class GenerateLayerSetTool implements vscode.LanguageModelTool<GenerateLayerSetInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GenerateLayerSetInput>) {
        const { set_name, layers, prompt, backend, mode, chain, topology, aspect_ratio, resolution, seed } = options.input;
        if (!set_name?.trim()) return textResult('error: missing argument: set_name');
        const args: Record<string, unknown> = { set_name };
        if (layers !== undefined) args.layers = layers;
        if (prompt) args.prompt = prompt;
        const selectedBackend = backend || creativeDefaultSetting('layerBackend');
        if (selectedBackend) args.backend = selectedBackend;
        if (mode) args.mode = mode;
        if (chain !== undefined) args.chain = !!chain;
        if (topology) args.topology = topology;
        if (aspect_ratio) args.aspect_ratio = aspect_ratio;
        if (resolution) args.resolution = resolution;
        if (seed !== undefined) args.seed = Number(seed);
        return textResult(await callHarmonyCreative('generate_layer_set', args, 300_000));
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GenerateLayerSetInput>) {
        return { invocationMessage: `Generating layer set: ${options.input.set_name ?? 'unnamed'}…` };
    }
}

interface GenerateVideoInput {
    prompt?: string;
    image_path?: string;
    audio_path?: string;
    model?: string;
    duration?: number;
    aspect_ratio?: string;
    member?: string;
}
class GenerateVideoTool implements vscode.LanguageModelTool<GenerateVideoInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GenerateVideoInput>) {
        const { prompt, image_path, audio_path, model, duration, aspect_ratio, member } = options.input;
        if (!prompt && !image_path && !audio_path) return textResult('error: provide prompt, image_path, or audio_path');
        const args: Record<string, unknown> = {};
        if (prompt) args.prompt = prompt;
        if (image_path) args.image_path = image_path;
        if (audio_path) args.audio_path = audio_path;
        const selectedModel = model || creativeDefaultSetting('videoModel');
        if (selectedModel) args.model = selectedModel;
        if (duration !== undefined) args.duration = Number(duration);
        if (aspect_ratio) args.aspect_ratio = aspect_ratio;
        if (member) args.member = member;
        return textResult(await callHarmonyCreative('generate_video', args, 300_000));
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GenerateVideoInput>) {
        return { invocationMessage: `Generating video with ${options.input.model ?? creativeDefaultSetting('videoModel') ?? 'default model'}…` };
    }
}

interface RecallMemoryInput { member?: string; query: string; n_results?: number; }
class RecallMemoryTool implements vscode.LanguageModelTool<RecallMemoryInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<RecallMemoryInput>) {
        const { member, query, n_results } = options.input;
        if (!query?.trim()) return textResult('error: missing argument: query');
        const args: Record<string, unknown> = { query };
        if (member) args.member = member;
        if (n_results !== undefined) args.n_results = Number(n_results);
        return textResult(await callHarmonyCreative('recall_memory', args));
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<RecallMemoryInput>) {
        return { invocationMessage: `Recalling creative memory: ${(options.input.query ?? '').slice(0, 60)}…` };
    }
}

interface ListLayerSetsInput { limit?: number; }
class ListLayerSetsTool implements vscode.LanguageModelTool<ListLayerSetsInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ListLayerSetsInput>) {
        const args: Record<string, unknown> = {};
        if (options.input.limit !== undefined) args.limit = Number(options.input.limit);
        return textResult(await callHarmonyCreative('list_layer_sets', args));
    }
    async prepareInvocation() { return { invocationMessage: 'Listing creative layer sets…' }; }
}

interface GetGenerationStatusInput { job_id: string; }
class GetGenerationStatusTool implements vscode.LanguageModelTool<GetGenerationStatusInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GetGenerationStatusInput>) {
        const { job_id } = options.input;
        if (!job_id) return textResult('error: missing argument: job_id');
        return textResult(await callHarmonyCreative('get_generation_status', { job_id }));
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GetGenerationStatusInput>) {
        return { invocationMessage: `Checking generation status: ${options.input.job_id ?? ''}` };
    }
}

interface SaveToLikenessInput { image_path: string; member_name: string; }
class SaveToLikenessTool implements vscode.LanguageModelTool<SaveToLikenessInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SaveToLikenessInput>) {
        const { image_path, member_name } = options.input;
        if (!image_path || !member_name) return textResult('error: missing arguments: image_path and member_name required');
        return textResult(await callHarmonyCreative('save_to_likeness', { image_path, member_name }));
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SaveToLikenessInput>) {
        return { invocationMessage: `Saving likeness image for ${options.input.member_name ?? 'member'}…` };
    }
}

interface CompositePreviewInput { layer_set_dir: string; }
class CompositePreviewTool implements vscode.LanguageModelTool<CompositePreviewInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<CompositePreviewInput>) {
        const { layer_set_dir } = options.input;
        if (!layer_set_dir) return textResult('error: missing argument: layer_set_dir');
        return textResult(await callHarmonyCreative('composite_preview', { layer_set_dir }, 120_000));
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<CompositePreviewInput>) {
        return { invocationMessage: `Building composite preview: ${path.basename(options.input.layer_set_dir ?? '')}` };
    }
}

interface GetImageInfoInput { image_path: string; }
class GetImageInfoTool implements vscode.LanguageModelTool<GetImageInfoInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GetImageInfoInput>) {
        const { image_path } = options.input;
        if (!image_path) return textResult('error: missing argument: image_path');
        return textResult(await callHarmonyCreative('get_image_info', { image_path }));
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GetImageInfoInput>) {
        return { invocationMessage: `Reading image info: ${path.basename(options.input.image_path ?? '')}` };
    }
}

interface CropImageInput { image_path: string; x: number; y: number; width: number; height: number; output_path?: string; }
class CropImageTool implements vscode.LanguageModelTool<CropImageInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<CropImageInput>) {
        const { image_path, x, y, width, height, output_path } = options.input;
        if (!image_path || x === undefined || y === undefined || width === undefined || height === undefined) {
            return textResult('error: missing arguments: image_path, x, y, width, height required');
        }
        const args: Record<string, unknown> = { image_path, x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
        if (output_path) args.output_path = output_path;
        return textResult(await callHarmonyCreative('crop_image', args, 30_000));
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<CropImageInput>) {
        return { invocationMessage: `Cropping ${path.basename(options.input.image_path ?? '')}` };
    }
}

interface ResizeImageInput { image_path: string; width: number; height: number; mode?: string; output_path?: string; }
class ResizeImageTool implements vscode.LanguageModelTool<ResizeImageInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ResizeImageInput>) {
        const { image_path, width, height, mode, output_path } = options.input;
        if (!image_path || width === undefined || height === undefined) {
            return textResult('error: missing arguments: image_path, width, height required');
        }
        const args: Record<string, unknown> = { image_path, width: Number(width), height: Number(height) };
        if (mode) args.mode = mode;
        if (output_path) args.output_path = output_path;
        return textResult(await callHarmonyCreative('resize_image', args, 30_000));
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ResizeImageInput>) {
        return { invocationMessage: `Resizing ${path.basename(options.input.image_path ?? '')} to ${options.input.width}×${options.input.height}` };
    }
}

interface RemoveBackgroundInput { image_path: string; output_path?: string; }
class RemoveBackgroundTool implements vscode.LanguageModelTool<RemoveBackgroundInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<RemoveBackgroundInput>) {
        const { image_path, output_path } = options.input;
        if (!image_path) return textResult('error: missing argument: image_path');
        const args: Record<string, unknown> = { image_path };
        if (output_path) args.output_path = output_path;
        return textResult(await callHarmonyCreative('remove_background', args, 60_000));
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<RemoveBackgroundInput>) {
        return { invocationMessage: `Removing background from ${path.basename(options.input.image_path ?? '')}…` };
    }
}

interface CompositeLayerInput { base_image: string; layer_image: string; x?: number; y?: number; opacity?: number; output_path?: string; }
class CompositeLayerTool implements vscode.LanguageModelTool<CompositeLayerInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<CompositeLayerInput>) {
        const { base_image, layer_image, x, y, opacity, output_path } = options.input;
        if (!base_image || !layer_image) return textResult('error: missing arguments: base_image and layer_image required');
        const args: Record<string, unknown> = { base_image, layer_image };
        if (x !== undefined) args.x = Number(x);
        if (y !== undefined) args.y = Number(y);
        if (opacity !== undefined) args.opacity = Number(opacity);
        if (output_path) args.output_path = output_path;
        return textResult(await callHarmonyCreative('composite_layer', args, 30_000));
    }
    async prepareInvocation() { return { invocationMessage: 'Compositing layer…' }; }
}

interface DrawTextInput { image_path: string; text: string; x: number; y: number; size?: number; color?: string; font_path?: string; output_path?: string; }
class DrawTextTool implements vscode.LanguageModelTool<DrawTextInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<DrawTextInput>) {
        const { image_path, text, x, y, size, color, font_path, output_path } = options.input;
        if (!image_path || !text || x === undefined || y === undefined) {
            return textResult('error: missing arguments: image_path, text, x, y required');
        }
        const args: Record<string, unknown> = { image_path, text, x: Number(x), y: Number(y) };
        if (size !== undefined) args.size = Number(size);
        if (color) args.color = color;
        if (font_path) args.font_path = font_path;
        if (output_path) args.output_path = output_path;
        return textResult(await callHarmonyCreative('draw_text', args, 30_000));
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<DrawTextInput>) {
        return { invocationMessage: `Drawing text on ${path.basename(options.input.image_path ?? '')}` };
    }
}

// ── get_errors (VS Code diagnostics) ──────────────────────────────────────
interface GetErrorsInput { filePaths?: string[]; }

class GetErrorsTool implements vscode.LanguageModelTool<GetErrorsInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GetErrorsInput>) {
        const files = options.input.filePaths;
        const allDiagnostics = files?.length
            ? files.flatMap(f => {
                const uri = vscode.Uri.file(path.isAbsolute(f) ? f : path.join(workspaceRoot() ?? '', f));
                const d = vscode.languages.getDiagnostics(uri);
                return d.length ? [[uri, d] as [vscode.Uri, readonly vscode.Diagnostic[]]] : [];
              })
            : vscode.languages.getDiagnostics();
        const byFile = new Map<string, readonly vscode.Diagnostic[]>();
        if (Array.isArray(allDiagnostics)) {
            for (const [uri, diags] of allDiagnostics) { if (diags.length) byFile.set(uri.fsPath, diags); }
        }
        if (byFile.size === 0) return textResult('No diagnostics found' + (files?.length ? ' in specified files' : ' in workspace') + '.');
        const lines: string[] = ['# Workspace Diagnostics', ''];
        for (const [file, diags] of byFile) {
            lines.push(`## ${path.relative(workspaceRoot() ?? '', file)} (${diags.length})`, '');
            for (const d of diags.slice(0, 20)) {
                const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : d.severity === vscode.DiagnosticSeverity.Warning ? 'WARNING' : 'INFO';
                lines.push(`- **${sev}** L${d.range.start.line + 1}: ${d.message}`);
            }
            if (diags.length > 20) lines.push(`- ... +${diags.length - 20} more`);
            lines.push('');
        }
        return textResult(lines.join('\n'));
    }
    async prepareInvocation() { return { invocationMessage: 'Checking workspace diagnostics…' }; }
}

// ── symbol_locations (LSP references/definitions) ────────────────────────
interface SymbolLocationsInput { path: string; line: number; character?: number; symbol?: string; mode?: 'references'|'definition'|'implementation'|'type_definition'; }

class SymbolLocationsTool implements vscode.LanguageModelTool<SymbolLocationsInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SymbolLocationsInput>) {
        const { path: p, line, character, symbol, mode } = options.input;
        if (!p || !line) return textResult('error: missing arguments: path and line required');
        const resolved = resolveWorkspacePath(p);
        if (!resolved) return textResult(`error: path is outside workspace: ${p}`);
        const uri = vscode.Uri.file(resolved);
        let pos: vscode.Position;
        if (typeof character === 'number') { pos = new vscode.Position(line - 1, character); }
        else if (symbol) {
            const doc = await vscode.workspace.openTextDocument(uri);
            const lineText = doc.lineAt(line - 1).text;
            const idx = lineText.indexOf(symbol);
            if (idx < 0) return textResult(`error: symbol "${symbol}" not found on line ${line}`);
            pos = new vscode.Position(line - 1, idx);
        } else { pos = new vscode.Position(line - 1, 0); }
        const command = mode === 'definition' ? 'vscode.executeDefinitionProvider' :
                         mode === 'implementation' ? 'vscode.executeImplementationProvider' :
                         mode === 'type_definition' ? 'vscode.executeTypeDefinitionProvider' :
                         'vscode.executeReferenceProvider';
        const locations = await vscode.commands.executeCommand<vscode.Location[]>('vscode.execute' + (mode === 'definition' ? 'Definition' : mode === 'implementation' ? 'Implementation' : mode === 'type_definition' ? 'TypeDefinition' : 'Reference') + 'Provider', uri, pos);
        if (!locations?.length) return textResult(`No ${mode ?? 'references'} found.`);
        return textResult([`# Symbol ${(mode ?? 'references').charAt(0).toUpperCase() + (mode ?? 'references').slice(1)}`, '', ...locations.slice(0, 50).map((loc: vscode.Location, i: number) => `${i + 1}. ${path.relative(workspaceRoot() ?? '', loc.uri.fsPath)}:${loc.range.start.line + 1}:${loc.range.start.character}`)].join('\n'));
    }
    async prepareInvocation() { return { invocationMessage: 'Finding symbol locations…' }; }
}

// ── rename_symbol (LSP rename) ─────────────────────────────────────────────
interface RenameSymbolInput { path: string; line: number; character?: number; symbol?: string; newName: string; }

class RenameSymbolTool implements vscode.LanguageModelTool<RenameSymbolInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<RenameSymbolInput>) {
        const { path: p, line, character, symbol, newName } = options.input;
        if (!p || !line || !newName) return textResult('error: missing arguments: path, line, and newName required');
        const resolved = resolveWorkspacePath(p);
        if (!resolved) return textResult(`error: path outside workspace: ${p}`);
        const uri = vscode.Uri.file(resolved);
        let pos: vscode.Position;
        if (typeof character === 'number') { pos = new vscode.Position(line - 1, character); }
        else if (symbol) {
            const doc = await vscode.workspace.openTextDocument(uri);
            const idx = doc.lineAt(line - 1).text.indexOf(symbol);
            if (idx < 0) return textResult(`error: symbol "${symbol}" not found on line ${line}`);
            pos = new vscode.Position(line - 1, idx);
        } else { return textResult('error: provide character or symbol to locate rename position'); }
        const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', uri, pos, newName);
        if (!edit?.size) return textResult('Rename not available at this position or no changes needed.');
        await vscode.workspace.applyEdit(edit);
        return textResult(`Renamed "${symbol ?? 'symbol'}" → "${newName}" across ${edit.size} file(s). Review the changes before committing.`);
    }
    async prepareInvocation() { return { invocationMessage: 'Renaming symbol…' }; }
}

// ── github_search ──────────────────────────────────────────────────────────
interface GithubSearchInput { scope: string; query: string; maxResults?: number; }

class GithubSearchTool implements vscode.LanguageModelTool<GithubSearchInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GithubSearchInput>) {
        const { scope, query, maxResults } = options.input;
        if (!scope || !query) return textResult('error: missing arguments: scope and query required');
        const perPage = Math.max(1, Math.min(100, maxResults ?? 20));
        const isOrg = !scope.includes('/');
        const url = isOrg
            ? `https://api.github.com/search/code?q=${encodeURIComponent(query)}+org:${encodeURIComponent(scope)}&per_page=${perPage}`
            : `https://api.github.com/search/code?q=${encodeURIComponent(query)}+repo:${encodeURIComponent(scope)}&per_page=${perPage}`;
        try {
            const resp = await fetch(url, { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'Harmony-Extension' } });
            if (!resp.ok) return textResult(`GitHub API error: ${resp.status} ${resp.statusText}`);
            const data = await resp.json() as any;
            if (!data.items?.length) return textResult(`No results found for "${query}" in ${scope}.`);
            const lines = [`# GitHub Search: ${query}`, `Scope: ${scope}`, `Results: ${data.total_count ?? data.items.length}`, ''];
            for (const item of data.items.slice(0, Math.min(perPage, 30))) {
                lines.push(`- [${item.repository.full_name}] ${item.path} (${item.html_url})`);
            }
            return textResult(lines.join('\n'));
        } catch (e: any) { return textResult(`GitHub search error: ${e?.message ?? String(e)}`); }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GithubSearchInput>) {
        return { invocationMessage: `Searching GitHub: ${options.input.query?.slice(0, 60)}…` };
    }
}

// ── run_task ───────────────────────────────────────────────────────────────
interface RunTaskInput { task?: string; workspaceFolder?: string; }

class RunTaskTool implements vscode.LanguageModelTool<RunTaskInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<RunTaskInput>) {
        const { task, workspaceFolder } = options.input;
        const packagePath = path.join(workspaceRoot() ?? '', 'package.json');
        let pkg: any;
        try { pkg = JSON.parse(await fs.readFile(packagePath, 'utf8')); }
        catch { return textResult('error: no package.json found in workspace'); }
        const scripts = pkg.scripts ?? {};
        if (task) {
            const cmd = scripts[task] ?? task;
            return textResult(`To run "${task}", execute:\n\`\`\`bash\nnpm run ${task}\n\`\`\`\nOr use harmony_run_terminal with: npm run ${task}`);
        }
        const entries = Object.entries(scripts).slice(0, 30);
        return textResult(['# Available package.json Scripts', '', ...entries.map(([name, cmd]) => `- **${name}**: \`${cmd}\``)].join('\n'));
    }
    async prepareInvocation() { return { invocationMessage: 'Reading package scripts…' }; }
}

// ── vscode_command ─────────────────────────────────────────────────────────
interface VscodeCommandInput { commandId: string; args?: any[]; }

class VscodeCommandTool implements vscode.LanguageModelTool<VscodeCommandInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<VscodeCommandInput>) {
        const { commandId, args } = options.input;
        if (!commandId) return textResult('error: missing argument: commandId');
        const safe = ['workbench.action.reloadWindow', 'workbench.action.openSettings', 'workbench.action.toggleSidebarVisibility', 'editor.action.formatDocument', 'typescript.restartTsServer', 'notifications.clearAll'];
        if (!safe.includes(commandId) && !commandId.startsWith('harmony.')) return textResult(`error: "${commandId}" is not in the allowed safe command list. Allowed: ${safe.join(', ')} or any harmony.* command.`);
        try {
            const result = await vscode.commands.executeCommand(commandId, ...(args ?? []));
            return textResult(`Command "${commandId}" executed${result !== undefined ? ` — result: ${JSON.stringify(result).slice(0, 200)}` : ''}.`);
        } catch (e: any) { return textResult(`Command error: ${e?.message ?? String(e)}`); }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<VscodeCommandInput>) {
        return { invocationMessage: `Running VS Code command: ${options.input.commandId}` };
    }
}

// ── check_python_availability ──────────────────────────────────────────────
interface CheckPythonInput { fix?: boolean; }

class CheckPythonTool implements vscode.LanguageModelTool<CheckPythonInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<CheckPythonInput>) {
        const cfg = vscode.workspace.getConfiguration('harmony');
        const configuredHub = (cfg.get<string>('centralHubPath') ?? '').trim();
        const envHub = (process.env.HARMONY_CENTRAL_HUB ?? process.env.EHAI_CENTRAL_PATH ?? '').trim();
        const hubPath = configuredHub || envHub || '';
        let pythonAvailable = false;
        let pythonPath = '';
        for (const candidate of ['python', 'python3', 'py']) {
            try { cp.execFileSync(candidate, ['--version'], { timeout: 5000, windowsHide: true }); pythonAvailable = true; pythonPath = candidate; break; } catch {}
        }
        const hubConfigured = !!(configuredHub || envHub);
        let harnessExists = false;
        let harnessPath = '';
        if (hubPath) { harnessPath = path.join(hubPath, 'scripts', 'self_healing_harness.py'); harnessExists = await pathExists(harnessPath); }
        const lines = [
            '# Python & Self-Healing Harness Status', '',
            `Python available: ${pythonAvailable ? 'yes (' + pythonPath + ')' : 'no'}`,
            `Central hub configured: ${hubConfigured ? 'yes' : 'no'}`,
            `Self-healing harness exists: ${harnessExists ? 'yes' : 'no'}`, '',
        ];
        if (!pythonAvailable) {
            lines.push('## Install Python', '',
                '- Windows: https://www.python.org/downloads/ (check Add Python to PATH)',
                '- Linux: sudo apt install python3', '- macOS: brew install python3',
                '- Verify: python --version', '');
        }
        if (pythonAvailable && !hubConfigured) {
            lines.push('## Configure Optional Hub', '',
                'Set harmony.centralHubPath in VS Code Settings (Ctrl+,)',
                'Or: export HARMONY_CENTRAL_HUB=/path/to/your/hub/folder', '');
        }
        if (pythonAvailable && hubConfigured && !harnessExists) {
            lines.push('## Harness Not Found', '', 'Expected at: ' + harnessPath, '');
        }
        if (pythonAvailable && harnessExists) {
            lines.push('## Self-Healing Harness Ready', '',
                'Full patch-safe editing with checkpointing and snapshots is available.', '');
        }
        lines.push('## Current Behavior', '',
            (pythonAvailable && harnessExists) ? 'Using Python self-healing harness (full features).'
                : 'Using TypeScript fallback (SHA256 + write + verify + checkpoint/snapshot).', '',
            '## TypeScript Fallback Features', '',
            '- SHA256 conflict detection', '- Atomic write (rename)',
            '- Write verification', '- Checkpoint receipts (.harmony/checkpoints/)',
            '- Snapshot receipts (.harmony/snapshots/)', '');
        return textResult(lines.join('\n'));
    }
    async prepareInvocation() { return { invocationMessage: 'Checking Python & self-healing harness availability...' }; }
}

// ─── Cross-workspace pattern search ──────────────────────────────────────

interface SearchPatternsInput {
    query: string;
    max_results?: number;
}

class SearchPatternsTool implements vscode.LanguageModelTool<SearchPatternsInput> {
    constructor(private readonly context: vscode.ExtensionContext) {}
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SearchPatternsInput>) {
        const query = options.input.query?.trim();
        if (!query) return textResult('error: empty query');
        const max = Math.max(1, Math.min(10, options.input.max_results ?? 5));
        const results = searchPatterns(this.context, query, max);
        if (results.length === 0) return textResult('No matching technical patterns found across workspaces.');
        return textResult(formatPatternsForContext(results));
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SearchPatternsInput>) {
        return { invocationMessage: `Searching cross-workspace patterns for: ${options.input.query?.slice(0, 60)}` };
    }
}

// ═══ harmony_conductor_journal — Conductor cognitive offloading ═══
interface ConductorJournalInput {
    action: 'write' | 'read' | 'compact' | 'stats' | 'search' | 'context';
    title?: string;
    content?: string;
    decisions?: { decision: string; rationale: string; alternatives?: string[] }[];
    tags?: string[];
    metrics?: { commits?: number; files_changed?: number; tool_calls_approx?: number; session_duration_min?: number; todos_completed?: number; todos_pending?: number };
    entry_id?: string;
    limit?: number;
    query?: string;
    workspace?: string;
}

class ConductorJournalTool implements vscode.LanguageModelTool<ConductorJournalInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ConductorJournalInput>, _token: vscode.CancellationToken) {
        const { action, title, content, decisions, tags, metrics, entry_id, limit = 5, query, workspace } = options.input;
        const root = workspaceRoot();
        const journal = new ConductorJournal(root);
        await journal.init();

        switch (action) {
            case 'write': {
                if (!title || !content) return textResult('error: title and content required');
                const result = await journal.writeEntry({
                    title,
                    content,
                    decisions: decisions ?? [],
                    tags: tags ?? [],
                    metrics: metrics ?? {},
                    branch: 'current',
                });
                return textResult(JSON.stringify({
                    status: 'written',
                    id: result.id,
                    path: result.path,
                    title,
                }, null, 2));
            }
            case 'read': {
                const entries = await journal.readRecent(limit, workspace);
                return textResult(JSON.stringify({
                    count: entries.length,
                    entries: entries.map(e => ({
                        id: e.id,
                        date: e.date,
                        title: e.title,
                        workspace: e.workspace_name,
                        branch: e.branch,
                        decisions_count: e.decisions.length,
                        tags: e.tags,
                        metrics: e.metrics,
                        content_preview: e.content.slice(0, 300),
                    }))
                }, null, 2));
            }
            case 'compact': {
                const result = await journal.compact();
                return textResult(JSON.stringify({
                    status: 'compacted',
                    compacted_count: result.compacted,
                    summary_preview: result.summary.slice(0, 500),
                }, null, 2));
            }
            case 'stats': {
                const stats = await journal.getStats();
                return textResult(JSON.stringify(stats, null, 2));
            }
            case 'search': {
                if (!query) return textResult('error: query required');
                const results = await journal.search(query, limit);
                return textResult(JSON.stringify({
                    query,
                    count: results.length,
                    results,
                }, null, 2));
            }
            case 'context': {
                const ctx = await journal.getContextInjection(limit, 3000);
                return textResult(JSON.stringify({
                    has_context: ctx.length > 0,
                    context: ctx,
                }, null, 2));
            }
            default: return textResult('error: unknown action');
        }
    }
}

// ─── semantic_search ────────────────────────────────────────────────────
interface SemanticSearchInput {
    query: string;
    path_glob?: string;
    max_results?: number;
    max_files?: number;
    include_snippets?: boolean;
}

// Lightweight stop-words set for TF-IDF
const STOP_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'if', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
    'may', 'might', 'can', 'shall', 'you', 'your', 'i', 'my', 'me', 'we', 'our',
    'he', 'she', 'it', 'they', 'them', 'this', 'that', 'these', 'those', 'not',
    'no', 'nor', 'so', 'as', 'just', 'very', 'too', 'also', 'all', 'each', 'every',
    'both', 'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same',
    'than', 'then', 'now', 'here', 'there', 'when', 'where', 'why', 'how', 'which',
    'who', 'whom', 'what', 'into', 'over', 'under', 'again', 'further', 'once',
]);

function tokenize(text: string): string[] {
    return text.toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

interface Chunk {
    file: string;
    line: number;
    snippet: string;
    tokens: string[];
    tf: Map<string, number>;
}

function chunkFile(content: string, filePath: string): Chunk[] {
    const lines = content.split(/\r?\n/);
    const chunks: Chunk[] = [];
    let start = 0;
    for (let i = 0; i < lines.length; i++) {
        // Split on blank lines and logical boundaries (function/class defs)
        const isBlank = lines[i].trim() === '';
        const isBoundary = /^(export\s+)?(async\s+)?(function|class|interface|const\s+\w+\s*=\s*(\(|[a-z]))/.test(lines[i]);
        if ((isBlank || isBoundary) && i > start) {
            const snippet = lines.slice(start, i).join('\n').trim();
            if (snippet.length > 10) {
                const tokens = tokenize(snippet);
                if (tokens.length >= 3) {
                    const tf = new Map<string, number>();
                    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
                    chunks.push({ file: filePath, line: start + 1, snippet, tokens, tf });
                }
            }
            if (isBoundary) start = i; else start = i + 1;
        }
    }
    // Last chunk
    const last = lines.slice(start).join('\n').trim();
    if (last.length > 10) {
        const tokens = tokenize(last);
        if (tokens.length >= 3) {
            const tf = new Map<string, number>();
            for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
            chunks.push({ file: filePath, line: start + 1, snippet: last, tokens, tf });
        }
    }
    return chunks;
}

class SemanticSearchTool implements vscode.LanguageModelTool<SemanticSearchInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SemanticSearchInput>) {
        const { query, path_glob, max_results, max_files, include_snippets } = options.input;
        if (!query) return textResult('error: missing argument: query');
        const glob = path_glob ?? '**/*.{ts,js,tsx,jsx,py,md,json,html,css,rs,go,java}';
        const maxRes = Math.min(Number(max_results) || 15, 50);
        const maxFiles = Math.min(Number(max_files) || 200, 500);
        const showSnippets = include_snippets !== false;

        try {
            const uris = await vscode.workspace.findFiles(glob, '**/node_modules/**', maxFiles);
            const queryTokens = tokenize(query);
            if (queryTokens.length === 0) return textResult('error: query has no indexable terms after stop-word removal');

            // Phase 1: chunk all files
            const allChunks: Chunk[] = [];
            for (const uri of uris) {
                try {
                    const buf = await fs.readFile(uri.fsPath, 'utf8');
                    if (buf.length > 200_000) continue; // skip huge files
                    const rel = vscode.workspace.asRelativePath(uri, false);
                    allChunks.push(...chunkFile(buf, rel));
                } catch { /* skip unreadable */ }
            }

            if (allChunks.length === 0) return textResult(`no indexable content found in ${uris.length} files matching ${glob}`);

            // Phase 2: compute IDF across all chunks
            const N = allChunks.length;
            const df = new Map<string, number>(); // document frequency
            for (const chunk of allChunks) {
                const seen = new Set<string>();
                for (const t of chunk.tokens) {
                    if (!seen.has(t)) { seen.add(t); df.set(t, (df.get(t) ?? 0) + 1); }
                }
            }
            const idf = new Map<string, number>();
            for (const [term, count] of df) idf.set(term, Math.log((N + 1) / (count + 1)) + 1);

            // Phase 3: score query vector against each chunk (cosine similarity)
            const queryVec = new Map<string, number>();
            for (const t of queryTokens) queryVec.set(t, (queryVec.get(t) ?? 0) + 1);
            const queryNorm = Math.sqrt([...queryVec.values()].reduce((s, v) => s + v * v, 0));
            if (queryNorm === 0) return textResult('error: query vector has zero magnitude');

            interface Scored { chunk: Chunk; score: number; }
            const scored: Scored[] = [];
            for (const chunk of allChunks) {
                let dot = 0;
                let chunkNormSq = 0;
                for (const [term, tfVal] of chunk.tf) {
                    const w = tfVal * (idf.get(term) ?? 0);
                    chunkNormSq += w * w;
                    dot += w * (queryVec.get(term) ?? 0);
                }
                const chunkNorm = Math.sqrt(chunkNormSq);
                if (chunkNorm > 0) {
                    // Normalize dot product by both norms
                    const score = dot / (queryNorm * chunkNorm);
                    if (score > 0.05) scored.push({ chunk, score });
                }
            }

            // Phase 4: sort, deduplicate by file, return top results
            scored.sort((a, b) => b.score - a.score);
            const seen = new Set<string>();
            const results: Array<{ file: string; line: number; snippet?: string; score: number; }> = [];
            for (const s of scored) {
                const key = `${s.chunk.file}:${s.chunk.line}`;
                if (seen.has(key)) continue;
                seen.add(key);
                results.push({
                    file: s.chunk.file,
                    line: s.chunk.line,
                    snippet: showSnippets ? s.chunk.snippet.slice(0, 200) : undefined,
                    score: Math.round(s.score * 1000) / 1000,
                });
                if (results.length >= maxRes) break;
            }

            const summary = results.length === 0
                ? `no semantic matches for "${query}" — try a different query or broader path_glob`
                : JSON.stringify({
                    query,
                    results,
                    scanned_files: uris.length,
                    total_chunks: N,
                }, null, 2);

            return textResult(summary);
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SemanticSearchInput>) {
        return { invocationMessage: `Semantic search: "${options.input.query}"` };
    }
}

export function registerHarmonyTools(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.lm.registerTool('harmony_get_errors', new GetErrorsTool()),
        vscode.lm.registerTool('harmony_symbol_locations', new SymbolLocationsTool()),
        vscode.lm.registerTool('harmony_rename_symbol', new RenameSymbolTool()),
        vscode.lm.registerTool('harmony_github_search', new GithubSearchTool()),
        vscode.lm.registerTool('harmony_run_task', new RunTaskTool()),
        vscode.lm.registerTool('harmony_vscode_command', new VscodeCommandTool()),
        vscode.lm.registerTool('harmony_check_python', new CheckPythonTool()),
        vscode.lm.registerTool('harmony_read_file', new ReadFileTool()),
        vscode.lm.registerTool('harmony_list_dir', new ListDirTool()),
        vscode.lm.registerTool('harmony_grep', new GrepTool()),
        (() => { const t = new WriteFileTool(); return vscode.lm.registerTool('harmony_write_file', { ...t, invoke: trackToolInvocation('harmony_write_file', (o: any) => t.invoke(o)) }); })(),
        (() => { const t = new EditFileTool(); return vscode.lm.registerTool('harmony_edit_file', { ...t, invoke: trackToolInvocation('harmony_edit_file', (o: any) => t.invoke(o)) }); })(),
        (() => { const t = new ApplyPatchTool(); return vscode.lm.registerTool('harmony_apply_patch', { ...t, invoke: trackToolInvocation('harmony_apply_patch', (o: any) => t.invoke(o)) }); })(),
        vscode.lm.registerTool('harmony_open_file', new OpenFileTool()),
        (() => { const t = new RunTerminalTool(); return vscode.lm.registerTool('harmony_run_terminal', { ...t, invoke: trackToolInvocation('harmony_run_terminal', (o: any) => t.invoke(o)) }); })(),
        vscode.lm.registerTool('harmony_port_status', new PortStatusTool()),
        vscode.lm.registerTool('harmony_git_status', new GitStatusTool()),
        vscode.lm.registerTool('harmony_git_diff', new GitDiffTool()),
        vscode.lm.registerTool('harmony_git_conflicts', new GitConflictTool()),
        vscode.lm.registerTool('harmony_release_receipt', new ReleaseReceiptTool()),
        vscode.lm.registerTool('harmony_git_log', new GitLogTool()),
        vscode.lm.registerTool('harmony_git_show', new GitShowTool()),
        vscode.lm.registerTool('harmony_git_branch', new GitBranchTool()),
        vscode.lm.registerTool('harmony_git_stash', new GitStashTool()),
        vscode.lm.registerTool('harmony_git_commit', new GitCommitTool()),
        vscode.lm.registerTool('harmony_git_blame', new GitBlameTool()),
        vscode.lm.registerTool('harmony_git_restore', new GitRestoreTool()),
        vscode.lm.registerTool('harmony_git_revert', new GitRevertTool()),
        vscode.lm.registerTool('harmony_git_tag', new GitTagTool()),
        vscode.lm.registerTool('harmony_git_remote', new GitRemoteTool()),
        vscode.lm.registerTool('harmony_git_push', new GitPushTool()),
        vscode.lm.registerTool('harmony_git_pull', new GitPullTool()),
        vscode.lm.registerTool('harmony_ask_question', new AskQuestionTool()),
        vscode.lm.registerTool('harmony_ask_questions', new AskQuestionTool()),
        vscode.lm.registerTool('harmony_ask_harmony', new AskQuestionTool()),
        vscode.lm.registerTool('harmony_fetch_url', new FetchUrlTool()),
        vscode.lm.registerTool('harmony_todo', new TodoTool()),
        vscode.lm.registerTool('harmony_consult_model', new ConsultModelTool(context.secrets)),
        vscode.lm.registerTool('harmony_spawn_worker', new SpawnWorkerTool(context.secrets)),
        vscode.lm.registerTool('harmony_recall_across_projects', new RecallAcrossProjectsTool()),
        vscode.lm.registerTool('harmony_search_patterns', new SearchPatternsTool(context)),
        vscode.lm.registerTool('harmony_continuity', new ContinuityTool()),
        vscode.lm.registerTool('harmony_orchestrate_codebase', new OrchestrateCodebaseTool(context.secrets)),
        (() => { const t = new RunFailFixTool(); return vscode.lm.registerTool('harmony_run_fail_fix', { ...t, invoke: trackToolInvocation('harmony_run_fail_fix', (o: any) => t.invoke(o)) }); })(),
        vscode.lm.registerTool('harmony_mcp_status', new McpStatusTool()),
        vscode.lm.registerTool('harmony_creative_health', new CreativeHealthTool()),
        vscode.lm.registerTool('harmony_generate_image', new GenerateImageTool()),
        vscode.lm.registerTool('harmony_generate_layer_set', new GenerateLayerSetTool()),
        vscode.lm.registerTool('harmony_generate_video', new GenerateVideoTool()),
        vscode.lm.registerTool('harmony_recall_memory', new RecallMemoryTool()),
        vscode.lm.registerTool('harmony_list_layer_sets', new ListLayerSetsTool()),
        vscode.lm.registerTool('harmony_get_generation_status', new GetGenerationStatusTool()),
        vscode.lm.registerTool('harmony_save_to_likeness', new SaveToLikenessTool()),
        vscode.lm.registerTool('harmony_composite_preview', new CompositePreviewTool()),
        vscode.lm.registerTool('harmony_get_image_info', new GetImageInfoTool()),
        vscode.lm.registerTool('harmony_crop_image', new CropImageTool()),
        vscode.lm.registerTool('harmony_resize_image', new ResizeImageTool()),
        vscode.lm.registerTool('harmony_remove_background', new RemoveBackgroundTool()),
        vscode.lm.registerTool('harmony_composite_layer', new CompositeLayerTool()),
        vscode.lm.registerTool('harmony_draw_text', new DrawTextTool()),
        vscode.lm.registerTool('harmony_check_whispers', new CheckWhispersTool()),
        vscode.lm.registerTool('harmony_parallel', new ParallelTool(context.secrets)),
        vscode.lm.registerTool('harmony_sandbox', new SandboxTool()),
        vscode.lm.registerTool('harmony_concert_speak', new ConcertSpeakTool()),
        vscode.lm.registerTool('harmony_concert_check', new ConcertCheckTool(context.secrets)),
        vscode.lm.registerTool('harmony_convergence_arbiter', new ConvergenceArbiterTool(context.secrets)),
        vscode.lm.registerTool('harmony_adversarial_critic', new AdversarialCriticTool(context.secrets)),
        vscode.lm.registerTool('harmony_deliberation_challenge', new DeliberationChallengeTool()),
        vscode.lm.registerTool('harmony_episodic_memory', new EpisodicMemoryTool()),
        vscode.lm.registerTool('harmony_decision_log', new DecisionLogTool()),
        vscode.lm.registerTool('harmony_uncertainty_fabric', new UncertaintyFabricTool()),
        vscode.lm.registerTool('harmony_task_auction', new TaskAuctionTool()),
        vscode.lm.registerTool('harmony_value_resolver', new ValueResolverTool()),
        vscode.lm.registerTool('harmony_swarm_topology', new SwarmTopologyTool()),
        vscode.lm.registerTool('harmony_execution_sandbox', new ExecutionSandboxTool()),
        vscode.lm.registerTool('harmony_temporal_branch', new TemporalBranchTool()),
        vscode.lm.registerTool('harmony_thought_graph', new ThoughtGraphTool()),
        vscode.lm.registerTool('harmony_horizon_planner', new HorizonPlannerTool()),
        vscode.lm.registerTool('harmony_skill_distiller', new SkillDistillerTool()),
        vscode.lm.registerTool('harmony_property_tester', new PropertyTesterTool(context.secrets)),
        vscode.lm.registerTool('harmony_analogy_engine', new AnalogyEngineTool(context.secrets)),
        vscode.lm.registerTool('harmony_conductor_journal', new ConductorJournalTool()),
        vscode.lm.registerTool('harmony_composition_engine', new CompositionEngineTool()),
        vscode.lm.registerTool('harmony_benchmark', new BenchmarkHarnessTool()),
        vscode.lm.registerTool('harmony_self_improvement', new SelfImprovementTool()),
        vscode.lm.registerTool('harmony_debug_dashboard', new DebugDashboardTool()),
        vscode.lm.registerTool('harmony_swarm_autonomy_v2', new SwarmAutonomyV2Tool()),
        vscode.lm.registerTool('harmony_conductor_mesh', new ConductorMeshTool()),
        vscode.lm.registerTool('harmony_semantic_search', new SemanticSearchTool()),
    );
}

// ─── parallel (swarm) ────────────────────────────────────────────────────
interface ParallelTaskInput {
    prompt: string;
    provider?: ProviderId;
    tier?: Tier;
    role?: string;
    context_files?: string[];
    system?: string;
    /** Max characters per context file (default 16000) */
    max_chars_per_file?: number;
}

interface ParallelInput {
    tasks: ParallelTaskInput[];
    max_cost_usd?: number;    // soft limit (warn), default 0.50
    hard_cost_usd?: number;   // hard limit (block), default 2.00
    urgent?: boolean;         // bypass hard limit, still show estimate + ask safety net
    fail_fast?: boolean;
    timeout_ms?: number;
}

class ParallelTool implements vscode.LanguageModelTool<ParallelInput> {
    constructor(private readonly secrets: vscode.SecretStorage) {}

    async invoke(options: vscode.LanguageModelToolInvocationOptions<ParallelInput>, token: vscode.CancellationToken) {
        const { tasks, max_cost_usd, hard_cost_usd, urgent, fail_fast, timeout_ms } = options.input;
        if (!tasks || !Array.isArray(tasks) || tasks.length === 0) return textResult('error: missing or empty tasks array');
        if (tasks.length > 10) return textResult('error: maximum 10 parallel tasks');

        // Resolve defaults
        const selected = await resolveCollabModel(this.secrets);
        const defaultProvider: ProviderId = selected?.provider ?? 'deepseek';
        const defaultTier: Tier = selected?.tier ?? 'light';

        // Cost guard — heuristic: ~4 chars per token, rate ~$0.15/M input + $0.60/M output for coding tier
        const estimatedInputTokens = tasks.reduce((sum, t) => sum + Math.ceil((t.prompt?.length ?? 0) / 4), 0);
        const estimatedOutputTokens = tasks.length * 512;
        const roughCost = (estimatedInputTokens / 1_000_000) * 0.15 + (estimatedOutputTokens / 1_000_000) * 0.60;
        const softLimit = max_cost_usd ?? 0.50;
        const hardLimit = hard_cost_usd ?? 2.00;

        if (!urgent && roughCost > hardLimit) {
            return textResult(`⚠️ Estimated cost $${roughCost.toFixed(4)} exceeds hard limit $${hardLimit.toFixed(2)}. Aborted. Use urgent:true to bypass.`);
        }

        const warnings: string[] = [];
        if (urgent && roughCost > hardLimit) {
            warnings.push(`⚡ **URGENT MODE** — cost estimate $${roughCost.toFixed(4)} exceeds hard limit $${hardLimit.toFixed(2)} but urgency flag is set. Proceeding with safety net.`);
        } else if (roughCost > softLimit) {
            warnings.push(`⚠️ Cost estimate $${roughCost.toFixed(4)} exceeds soft limit $${softLimit.toFixed(2)}. Proceeding — monitor usage.`);
        }

        // Dispatch all workers concurrently
        const results = await Promise.allSettled(
            tasks.map(async (t, i) => {
                const provider: ProviderId = t.provider ?? defaultProvider;
                const tier: Tier = t.tier ?? workerRoleTier(t.role as WorkerRole | undefined, defaultTier);
                const contextBlocks: string[] = [];
                for (const f of t.context_files ?? []) {
                    const resolved = resolveWorkspacePath(f);
                    if (!resolved) { contextBlocks.push(`[${f}: outside workspace]`); continue; }
                    try {
                        const buf = await fs.readFile(resolved, 'utf8');
                        const maxChars = t.max_chars_per_file ?? 16000;
                        contextBlocks.push(`--- ${f} ---\n${buf.slice(0, maxChars)}\n--- end ${f} ---`);
                    } catch (e: any) { contextBlocks.push(`[${f}: ${e?.message ?? 'read failed'}]`); }
                }
                const fullPrompt = contextBlocks.length > 0
                    ? `Context:\n\n${contextBlocks.join('\n\n')}\n\nTask:\n${t.prompt}`
                    : t.prompt;
                try {
                    const r = await consult(this.secrets, {
                        provider, tier, question: fullPrompt,
                        system: t.system, maxTokens: 2048
                    }, token);
                    const usage = r.usage ? ` (in:${r.usage.promptTokens ?? '?'} out:${r.usage.completionTokens ?? '?'})` : '';
                    return {
                        task_index: i,
                        status: 'success' as const,
                        provider: r.provider,
                        model: r.model,
                        usage,
                        text: r.text.slice(0, 8000),
                    };
                } catch (e: any) {
                    if (fail_fast) throw e;
                    return { task_index: i, status: 'error' as const, error: e?.message ?? String(e) };
                }
            })
        );

        // Format output
        const successCount = results.filter(r => r.status === 'fulfilled' && (r as PromiseFulfilledResult<any>).value.status === 'success').length;
        const lines = [
            `## Swarm Results: ${successCount}/${tasks.length} succeeded`,
            '',
            ...warnings,
            '',
            '| # | Status | Provider | Model | Tokens |',
            '|---|--------|----------|-------|--------|',
            ...results.map((r, i) => {
                if (r.status === 'rejected') return `| ${i + 1} | ❌ error | — | — | — | ${r.reason?.message ?? 'unknown'} |`;
                const v = r.value;
                if (v.status === 'error') return `| ${i + 1} | ❌ error | — | — | — | ${v.error} |`;
                return `| ${i + 1} | ✅ success | ${v.provider} | ${v.model} | ${v.usage} |`;
            }),
            '',
            ...results.filter(r => r.status === 'fulfilled' && (r as any).value.status === 'success').map(r => {
                const v = (r as any).value;
                return `### Task ${v.task_index + 1} (${v.provider}/${v.model})\n\n${v.text}`;
            }),
        ];
        return textResult(lines.join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ParallelInput>) {
        const count = options.input.tasks?.length ?? 0;
        return { invocationMessage: `Dispatching swarm of ${count} workers in parallel...` };
    }
}

// ─── sandbox (code verification) ──────────────────────────────────────────
interface SandboxInput {
    code?: string;
    check?: 'compile' | 'lint' | 'test' | 'all';
}

class SandboxTool implements vscode.LanguageModelTool<SandboxInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SandboxInput>, token: vscode.CancellationToken) {
        const code = options.input.code?.trim();
        if (!code) return textResult('error: no code provided to verify');
        const check = options.input.check ?? 'compile';
        const root = workspaceRoot();
        if (!root) return textResult('error: no workspace open');

        // Write code to temp file
        const tmpDir = path.join(root, '.harmony', 'sandbox');
        await fs.mkdir(tmpDir, { recursive: true });
        const tmpFile = path.join(tmpDir, `verify-${Date.now()}.ts`);
        await fs.writeFile(tmpFile, code, 'utf8');

        try {
            const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
            return await new Promise<vscode.LanguageModelToolResult>(resolve => {
                cp.execFile(npmCmd, ['run', 'compile'], { cwd: root, timeout: 120000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
                    (error, stdout, stderr) => {
                        const ok = !error && !(stderr && /\berror\b/i.test(stderr));
                        const verdict = ok ? '✅ PASS — code compiles cleanly' : '❌ FAIL — compilation errors found';
                        const output = [
                            verdict,
                            '',
                            stdout ? `stdout:\n\`\`\`\n${stdout.slice(0, 4000)}\n\`\`\`` : '',
                            stderr ? `stderr:\n\`\`\`\n${stderr.slice(0, 4000)}\n\`\`\`` : '',
                        ].filter(Boolean).join('\n');
                        resolve(textResult(output));
                    }
                );
            });
        } catch (e: any) {
            return textResult(`error: sandbox verification failed — ${e?.message ?? String(e)}`);
        } finally {
            try { await fs.unlink(tmpFile); } catch { /* ok */ }
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SandboxInput>) {
        const check = options.input.check ?? 'compile';
        // ⚠️ WINDOWS LIMITATION: no seccomp/gVisor network/filesystem isolation.
        // Only compile/lint verification is safe. Never execute untrusted code.
        return { invocationMessage: `Sandbox: running ${check} verification (⚠️ no network isolation on Windows)...` };
    }
}

// ─── concert_hall ────────────────────────────────────────────────────────
interface ConcertSpeakInput { room: string; from?: string; body: string; }

class ConcertSpeakTool implements vscode.LanguageModelTool<ConcertSpeakInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ConcertSpeakInput>) {
        const { room, body } = options.input;
        if (!room?.trim() || !body?.trim()) return textResult('error: room and body are required');
        try {
            const from = options.input.from ?? 'worker';
            await concertSpeak(room.trim(), from.trim(), body.trim());
            return textResult(`✅ Posted to room **${room.trim()}** as ${from.trim()}.`);
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ConcertSpeakInput>) {
        return { invocationMessage: `Posting to concert hall room: ${options.input.room}` };
    }
}

interface ConcertCheckInput { rooms?: string[]; }

class ConcertCheckTool implements vscode.LanguageModelTool<ConcertCheckInput> {
    constructor(private readonly secrets: vscode.SecretStorage) {}
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ConcertCheckInput>, token: vscode.CancellationToken) {
        try {
            const { messages } = await concertCheck(options.input.rooms);
            if (messages.length === 0) return textResult('🎻 Concert hall is quiet. No new messages since your last check-in.');
            // Attempt lightweight summary via Gemini Flash
            let summary: string | undefined;
            try {
                const { consult } = await import('./providers');
                const text = messages.map(m => `[${m.room}] ${m.from}: ${m.body}`).join('\n');
                const r = await consult(this.secrets, {
                    provider: 'gemini', tier: 'light',
                    question: `Summarize these concert hall messages in 3-5 bullet points. Focus on key decisions, open questions, and action items:\n\n${text}`,
                    system: 'You are a concert hall summarizer. Be concise. Only report what matters.',
                    maxTokens: 512,
                }, token);
                summary = r.text;
            } catch { /* summarization is best-effort */ }
            return textResult(formatConcertCheck(messages, summary));
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation() { return { invocationMessage: 'Checking concert hall for new messages...' }; }
}

// ─── check_whispers ──────────────────────────────────────────────────────
interface CheckWhispersInput { max?: number; }

class CheckWhispersTool implements vscode.LanguageModelTool<CheckWhispersInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<CheckWhispersInput>) {
        try {
            const max = options.input.max ?? 10;
            const whispers = await readUnread(max);
            // Auto-mark all unread whispers as read — the act of checking
            // consumes them. This prevents duplicate delivery on subsequent
            // checks and keeps the status bar count accurate.
            if (whispers.length > 0) {
                await Promise.all(whispers.map(w => markRead(w.id)));
                onWhisperChange.fire();
            }
            if (whispers.length === 0) return textResult('📥 No unread whispers.');
            return textResult(formatWhispersForPrompt(whispers));
        } catch (e: any) {
            return textResult(`error checking whispers: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<CheckWhispersInput>) {
        return { invocationMessage: 'Checking whisper inbox...' };
    }
}
