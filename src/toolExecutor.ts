import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import { recordEffect } from './effectLedger';
import { createRequiredPreActionSnapshot, formatSnapshotNote, normalizeSnapshotPath } from './snapshotUtils';

/**
 * Tool executor for Harmony agent loop.
 *
 * Each tool returns { ok, result } where result is a string.
 * Destructive tools (write_file, run_terminal) prompt for confirmation.
 * ask_question is handled by the chat view (not here) since it needs UI.
 */

// ── Creative service auth ────────────────────────────────────────────────────
let _secrets: vscode.SecretStorage | undefined;
export function initSecrets(s: vscode.SecretStorage): void { _secrets = s; }
let _cachedCreativeToken: { filePath: string; mtimeMs: number; token: string } | undefined;

function creativeTokenFilePath(): string {
    return process.env.HARMONY_CREATIVE_TOKEN_FILE ||
        path.join(process.env.HARMONY_CREATIVE_HOME || path.join(os.homedir(), '.harmony_creative'), 'local_service.token');
}

async function refreshCreativeTokenFromFile(force = false): Promise<string | undefined> {
    if (!_secrets) return undefined;
    const tokenFile = creativeTokenFilePath();
    try {
        const stat = await fs.stat(tokenFile);
        if (!force && _cachedCreativeToken?.filePath === tokenFile && _cachedCreativeToken.mtimeMs === stat.mtimeMs) {
            return _cachedCreativeToken.token;
        }
        const token = (await fs.readFile(tokenFile, 'utf-8')).trim();
        if (!token) return undefined;
        _cachedCreativeToken = { filePath: tokenFile, mtimeMs: stat.mtimeMs, token };
        await _secrets.store('harmony.creativeToken', token);
        return token;
    } catch {
        return undefined;
    }
}

async function currentCreativeToken(): Promise<string | undefined> {
    return await refreshCreativeTokenFromFile() ?? await _secrets?.get('harmony.creativeToken');
}
// ── Bundled creative-service path (set during extension activation) ─────
let _bundledCreativePath: string | undefined;
export function initBundledCreativePath(extensionPath: string): void {
    _bundledCreativePath = path.join(extensionPath, 'creative-service');
}

// ── Creative service auto-start ──────────────────────────────────────────
let _creativeStartPromise: Promise<void> | undefined;

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

function creativeEndpoint(endpointPath: string, baseUrl = getCreativeServiceUrl()): URL {
    const raw = baseUrl.trim() || 'http://127.0.0.1:8896';
    const base = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    const href = base.href.endsWith('/') ? base.href : `${base.href}/`;
    return new URL(endpointPath.replace(/^\/+/, ''), href);
}

function creativeTransport(url: URL): typeof http | typeof https {
    return url.protocol === 'https:' ? https : http;
}

async function creativeHealthOk(baseUrl = getCreativeServiceUrl(), timeoutMs = 2000): Promise<boolean> {
    try {
        const url = creativeEndpoint('health', baseUrl);
        return await new Promise<boolean>((resolve) => {
            const req = creativeTransport(url).request(url, { method: 'GET' }, (res) => {
                const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 400;
                res.resume();
                resolve(ok);
            });
            req.setTimeout(timeoutMs, () => {
                req.destroy();
                resolve(false);
            });
            req.on('error', () => resolve(false));
            req.end();
        });
    } catch {
        return false;
    }
}

interface CreativeLaunchCandidate {
    source: string;
    dir: string;
}

interface CreativeLaunch {
    command: string;
    args: string[];
    cwd: string;
    source: string;
}

function creativeCandidateDirs(source: string, basePath: string): CreativeLaunchCandidate[] {
    const resolved = path.resolve(basePath);
    return [
        { source, dir: resolved },
        { source: `${source}/harmony-creative`, dir: path.join(resolved, 'harmony-creative') },
        { source: `${source}/mcp-servers/harmony-creative`, dir: path.join(resolved, 'mcp-servers', 'harmony-creative') },
    ];
}

function uniqueCreativeCandidates(candidates: CreativeLaunchCandidate[]): CreativeLaunchCandidate[] {
    const seen = new Set<string>();
    const unique: CreativeLaunchCandidate[] = [];
    for (const candidate of candidates) {
        const key = path.resolve(candidate.dir).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(candidate);
    }
    return unique;
}

function centralHubPathFromConfig(cfg: vscode.WorkspaceConfiguration): string {
    return cfg.get<string>('centralHubPath')
        || process.env.HARMONY_CENTRAL_HUB
        || process.env.EHAI_CENTRAL_PATH
    || path.join(os.homedir(), 'Documents', 'HarmonyCentral');
}

function creativeLaunchCandidates(cfg: vscode.WorkspaceConfiguration): CreativeLaunchCandidate[] {
    const candidates: CreativeLaunchCandidate[] = [];

    // 1. Bundled creative-service/ that ships with the extension
    if (_bundledCreativePath) {
        candidates.push(...creativeCandidateDirs('bundled:creative-service', _bundledCreativePath));
    }

    // 2. User-configured explicit service path
    const configuredCreative = (cfg.get<string>('creativeServicePath') ?? '').trim();
    if (configuredCreative) {
        candidates.push(...creativeCandidateDirs('harmony.creativeServicePath', configuredCreative));
    }

    // 3. Workspace folder scan
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        candidates.push(...creativeCandidateDirs(`workspace:${folder.name}`, folder.uri.fsPath));
    }

    // 4. Environment variable
    const envCreative = (process.env.HARMONY_CREATIVE_SERVICE_PATH || process.env.HARMONY_CREATIVE_ROOT || '').trim();
    if (envCreative) {
        candidates.push(...creativeCandidateDirs('HARMONY_CREATIVE_SERVICE_PATH', envCreative));
    }

    // 5. Central Hub fallback
    const centralPath = centralHubPathFromConfig(cfg);
    candidates.push({ source: 'harmony.centralHubPath/mcp-servers/harmony-creative', dir: path.join(centralPath, 'mcp-servers', 'harmony-creative') });
    return uniqueCreativeCandidates(candidates);
}

function creativeOwnerRoot(creativeDir: string): string {
    const parent = path.dirname(creativeDir);
    return path.basename(parent).toLowerCase() === 'mcp-servers' ? path.dirname(parent) : parent;
}

async function resolveCreativeDir(cfg: vscode.WorkspaceConfiguration): Promise<{ source: string; dir: string; script: string }> {
    const checked: string[] = [];
    for (const candidate of creativeLaunchCandidates(cfg)) {
        const script = path.join(candidate.dir, 'rest_api.py');
        checked.push(script);
        if (await pathExists(script)) {
            return { source: candidate.source, dir: candidate.dir, script };
        }
    }
    throw new Error(`Harmony Creative REST service script not found. Set harmony.creativeServicePath to the folder containing rest_api.py, or check harmony.centralHubPath. Checked: ${checked.join('; ')}`);
}

async function resolveCreativeLaunch(): Promise<CreativeLaunch> {
    const cfg = vscode.workspace.getConfiguration('harmony');
    const resolved = await resolveCreativeDir(cfg);

    const configuredPython = (cfg.get<string>('creativePythonPath') ?? '').trim() || (cfg.get<string>('centralPythonPath') ?? '').trim();
    const ownerRoot = creativeOwnerRoot(resolved.dir);
    const ownerVenvPython = process.platform === 'win32'
        ? path.join(ownerRoot, '.venv', 'Scripts', 'python.exe')
        : path.join(ownerRoot, '.venv', 'bin', 'python');
    const creativeVenvPython = process.platform === 'win32'
        ? path.join(resolved.dir, '.venv', 'Scripts', 'python.exe')
        : path.join(resolved.dir, '.venv', 'bin', 'python');
    const python = configuredPython
        || (await pathExists(creativeVenvPython) ? creativeVenvPython : '')
        || (await pathExists(ownerVenvPython) ? ownerVenvPython : '')
        || 'python';

    return { command: python, args: [resolved.script], cwd: resolved.dir, source: resolved.source };
}

async function waitForProcessSpawn(proc: cp.ChildProcess): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 750);
        proc.once('spawn', () => {
            clearTimeout(timer);
            resolve();
        });
        proc.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

/**
 * Try to start the Harmony Creative REST service (port 8896) if it isn't running.
 * Looks for rest_api.py from an explicit service path, the current workspace, then Central.
 * Silently returns if already running or if the script can't be found.
 */
export async function startCreativeService(): Promise<void> {
    _creativeStartPromise ??= startCreativeServiceOnce().finally(() => {
        _creativeStartPromise = undefined;
    });
    return _creativeStartPromise;
}

async function startCreativeServiceOnce(): Promise<void> {
    const baseUrl = getCreativeServiceUrl();
    if (await creativeHealthOk(baseUrl, 2000)) {
        return;
    }

    const launch = await resolveCreativeLaunch();
    const proc = cp.spawn(
        launch.command,
        launch.args,
        {
            cwd: launch.cwd,
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
        }
    );
    await waitForProcessSpawn(proc);
    proc.unref();

    for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 800));
        if (await creativeHealthOk(baseUrl, 1500)) {
            return;
        }
    }
    throw new Error(`Harmony Creative service did not become healthy at ${baseUrl}.`);
}
export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, any>;
}

export interface ToolResult {
    tool_call_id: string;
    ok: boolean;
    result: string;
}

export interface CreativeInvokeResult {
    ok: boolean;
    result: string;
}

const MAX_RESULT_CHARS = 16000;

function clip(s: string): string {
    if (s.length <= MAX_RESULT_CHARS) return s;
    return s.slice(0, MAX_RESULT_CHARS) + `\n…[truncated, ${s.length - MAX_RESULT_CHARS} more chars]`;
}

function sha256Text(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

async function verifyTextOnDisk(label: string, resolved: string, expected: string): Promise<string | undefined> {
    let actual: string;
    try {
        actual = await fs.readFile(resolved, 'utf8');
    } catch (error: any) {
        return `write verification failed for ${label}: could not re-read file (${error?.message ?? String(error)})`;
    }
    // Compare line-ending-agnostically to avoid CRLF/LF false-alarms.
    const normalizedActual = actual.replace(/\r\n|\r/g, '\n');
    const normalizedExpected = expected.replace(/\r\n|\r/g, '\n');
    if (normalizedActual !== normalizedExpected) {
        return `write verification failed for ${label}: disk contents do not match requested contents (expected sha256 ${sha256Text(normalizedExpected).slice(0, 12)}, found ${sha256Text(normalizedActual).slice(0, 12)}). Re-read the file before retrying.`;
    }
    return undefined;
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

function workspaceRootForPath(resolvedPath: string): string | undefined {
    for (const folder of workspaceFoldersByPriority()) {
        const root = folder.uri.fsPath;
        const rel = path.relative(root, resolvedPath);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) return root;
    }
    return undefined;
}

// Pre-action snapshot machinery moved to snapshotUtils.ts (shared single source).

async function readFileTool(args: any): Promise<ToolResult> {
    const id = args._id as string;
    const p = args.path;
    if (!p) return { tool_call_id: id, ok: false, result: 'missing argument: path' };
    const resolved = resolveWorkspacePath(p);
    if (!resolved) return { tool_call_id: id, ok: false, result: `path is outside workspace: ${p}` };
    try {
        const buf = await fs.readFile(resolved, 'utf8');
        const start = Number(args.start_line) || 1;
        const end = Number(args.end_line) || Infinity;
        const lines = buf.split(/\r?\n/);
        const sliced = lines.slice(Math.max(0, start - 1), Math.min(lines.length, end)).join('\n');
        return { tool_call_id: id, ok: true, result: clip(sliced) };
    } catch (e: any) {
        return { tool_call_id: id, ok: false, result: e?.message ?? String(e) };
    }
}

async function listDirTool(args: any): Promise<ToolResult> {
    const id = args._id as string;
    const p = args.path ?? '.';
    const resolved = resolveWorkspacePath(p);
    if (!resolved) return { tool_call_id: id, ok: false, result: `path is outside workspace: ${p}` };
    try {
        const entries = await fs.readdir(resolved, { withFileTypes: true });
        const lines = entries.map(e => e.isDirectory() ? `${e.name}/` : e.name);
        return { tool_call_id: id, ok: true, result: clip(lines.join('\n')) };
    } catch (e: any) {
        return { tool_call_id: id, ok: false, result: e?.message ?? String(e) };
    }
}

async function grepTool(args: any): Promise<ToolResult> {
    const id = args._id as string;
    const pattern = args.pattern;
    const glob = args.path_glob ?? '**/*';
    const max = Number(args.max_results) || 50;
    if (!pattern) return { tool_call_id: id, ok: false, result: 'missing argument: pattern' };

    let regex: RegExp;
    try {
        regex = new RegExp(pattern, 'm');
    } catch (e: any) {
        return { tool_call_id: id, ok: false, result: `bad regex: ${e?.message}` };
    }

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
            } catch {
                // Skip unreadable files (binary, perms, etc.)
            }
        }
        const summary = out.length === 0
            ? `no matches for /${pattern}/ in ${glob}`
            : `${out.length} matches:\n` + out.join('\n');
        return { tool_call_id: id, ok: true, result: clip(summary) };
    } catch (e: any) {
        return { tool_call_id: id, ok: false, result: e?.message ?? String(e) };
    }
}

async function writeFileTool(args: any): Promise<ToolResult> {
    const id = args._id as string;
    const p = args.path;
    const content = args.content;
    if (!p || content === undefined) {
        return { tool_call_id: id, ok: false, result: 'missing argument: path or content' };
    }
    const resolved = resolveWorkspacePath(p);
    if (!resolved) return { tool_call_id: id, ok: false, result: `path is outside workspace: ${p}` };

    // Confirmation gate.
    const exists = await fs.access(resolved).then(() => true).catch(() => false);
    const verb = exists ? 'OVERWRITE' : 'CREATE';
    const choice = await vscode.window.showWarningMessage(
        `Harmony agent wants to ${verb} file:\n${p}\n\n(${String(content).length} chars)`,
        { modal: true },
        'Allow once', 'Deny'
    );
    if (choice !== 'Allow once') {
        return { tool_call_id: id, ok: false, result: 'denied by user' };
    }

    try {
        const root = workspaceRootForPath(resolved);
        if (!root) return { tool_call_id: id, ok: false, result: `path is outside workspace: ${p}` };
        const relativePath = normalizeSnapshotPath(path.relative(root, resolved));
        const snapshot = await createRequiredPreActionSnapshot(root, [relativePath], `chat write_file before writing ${relativePath}`);
        if (!snapshot.ok) return { tool_call_id: id, ok: false, result: snapshot.message };
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content, 'utf8');
        const verifyError = await verifyTextOnDisk(p, resolved, content);
        if (verifyError) return { tool_call_id: id, ok: false, result: verifyError };
        await recordEffect({ kind: 'file', target: p, action: 'write', inverse: snapshot.snapshot?.id, compensating: snapshot.snapshot?.restoreCommand }).catch(() => undefined);
        return { tool_call_id: id, ok: true, result: `verified write of ${String(content).length} chars to ${p}${formatSnapshotNote(snapshot.snapshot)}` };
    } catch (e: any) {
        return { tool_call_id: id, ok: false, result: e?.message ?? String(e) };
    }
}

async function openFileTool(args: any): Promise<ToolResult> {
    const id = args._id as string;
    const p = args.path;
    const resolved = resolveWorkspacePath(p);
    if (!resolved) return { tool_call_id: id, ok: false, result: `path is outside workspace: ${p}` };
    try {
        const doc = await vscode.workspace.openTextDocument(resolved);
        await vscode.window.showTextDocument(doc, { preview: false });
        return { tool_call_id: id, ok: true, result: `opened ${p}` };
    } catch (e: any) {
        return { tool_call_id: id, ok: false, result: e?.message ?? String(e) };
    }
}

async function runTerminalTool(args: any): Promise<ToolResult> {
    const id = args._id as string;
    const command = args.command;
    const timeoutSec = Number(args.timeout_sec) || 30;
    if (!command) return { tool_call_id: id, ok: false, result: 'missing argument: command' };

    const choice = await vscode.window.showWarningMessage(
        `Harmony agent wants to run a terminal command:\n\n${command}\n\n(timeout ${timeoutSec}s)`,
        { modal: true },
        'Allow once', 'Deny'
    );
    if (choice !== 'Allow once') {
        return { tool_call_id: id, ok: false, result: 'denied by user' };
    }

    const cwd = workspaceRoot();
    return await new Promise((resolve) => {
        const proc = cp.exec(command, { cwd, timeout: timeoutSec * 1000, windowsHide: true }, async (err, stdout, stderr) => {
            const out = (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
            await recordEffect({ kind: 'terminal', target: command, action: 'exec', compensating: undefined, notes: err ? ((err as any).killed ? `timed out after ${timeoutSec}s` : `error: ${String(err)}`) : 'completed' }).catch(() => undefined);
            if (err && (err as any).killed) {
                resolve({ tool_call_id: id, ok: false, result: clip(`timed out after ${timeoutSec}s\n${out}`) });
                return;
            }
            const ok = !err;
            resolve({ tool_call_id: id, ok, result: clip(out || (ok ? '(no output)' : String(err))) });
        });
        // Defensive: ensure resolve fires even if cp.exec misbehaves.
        proc.on('error', (e) => resolve({ tool_call_id: id, ok: false, result: e.message }));
    });
}

// ── Harmony Creative service (port 8896) ────────────────────────────────
function getCreativeServiceUrl(): string {
    try {
        const cfg = vscode.workspace.getConfiguration('harmony');
        return cfg.get<string>('creativeServiceUrl') ?? 'http://127.0.0.1:8896';
    } catch {
        return 'http://127.0.0.1:8896';
    }
}

interface CreativeRequestResult extends CreativeInvokeResult {
    errorCode?: string;
}

function shouldAttemptCreativeStart(errorCode: string | undefined): boolean {
    if (!errorCode || !['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(errorCode)) {
        return false;
    }
    try {
        const host = creativeEndpoint('call').hostname.toLowerCase();
        return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
    } catch {
        return false;
    }
}

function shouldRetryCreativeAuth(errorCode: string | undefined): boolean {
    return errorCode === 'EAUTH';
}

export async function invokeCreativeService(
    toolName: string,
    callArgs: Record<string, unknown>,
    timeoutMs: number
): Promise<CreativeInvokeResult> {
    let token = await currentCreativeToken();
    const firstAttempt = await requestCreativeService(toolName, callArgs, timeoutMs, token);
    if (shouldRetryCreativeAuth(firstAttempt.errorCode)) {
        const refreshedToken = await refreshCreativeTokenFromFile(true);
        if (refreshedToken) {
            return requestCreativeService(toolName, callArgs, timeoutMs, refreshedToken);
        }
        return firstAttempt;
    }
    if (!shouldAttemptCreativeStart(firstAttempt.errorCode)) {
        return firstAttempt;
    }

    try {
        await startCreativeService();
    } catch (error) {
        return {
            ok: false,
            result: `${firstAttempt.result} Auto-start failed: ${(error as Error).message}`
        };
    }
    token = await currentCreativeToken();
    return requestCreativeService(toolName, callArgs, timeoutMs, token);
}

async function requestCreativeService(
    toolName: string,
    callArgs: Record<string, unknown>,
    timeoutMs: number,
    token: string | undefined
): Promise<CreativeRequestResult> {
    return new Promise((resolve) => {
        let endpoint: URL;
        try {
            endpoint = creativeEndpoint('call');
        } catch (error) {
            resolve({ ok: false, result: `invalid creative service URL: ${(error as Error).message}` });
            return;
        }
        const body = JSON.stringify({ tool: toolName, arguments: callArgs, client_id: 'harmony-extension' });
        const extraHeaders: Record<string, string> = token ? { 'x-harmony-creative-token': token } : {};
        const req = creativeTransport(endpoint).request(
            endpoint,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body, 'utf8'), ...extraHeaders }
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    const statusCode = res.statusCode ?? 0;
                    let parsed: Record<string, unknown> | undefined;
                    try {
                        parsed = data ? JSON.parse(data) as Record<string, unknown> : undefined;
                    } catch {
                        parsed = undefined;
                    }

                    if (statusCode < 200 || statusCode >= 300) {
                        const message = parsed?.error ? String(parsed.error) : clip(data || `HTTP ${statusCode}`);
                        const errorCode = statusCode === 401 || statusCode === 403 ? 'EAUTH' : `EHTTP_${statusCode}`;
                        resolve({ ok: false, result: `creative service HTTP ${statusCode}: ${message}`, errorCode });
                        return;
                    }

                    if (!parsed) {
                        resolve({ ok: false, result: clip(data || 'empty response from creative service') });
                    } else if (parsed.success) {
                        resolve({ ok: true, result: clip(JSON.stringify(parsed.result ?? {}, null, 2)) });
                    } else {
                        resolve({ ok: false, result: String(parsed.error ?? 'Creative service returned failure') });
                    }
                });
            }
        );
        req.setTimeout(timeoutMs, () => {
            req.destroy();
            resolve({ ok: false, result: `creative_service timed out after ${timeoutMs / 1000}s`, errorCode: 'ETIMEDOUT' });
        });
        req.on('error', (e: Error) => {
            const errorCode = (e as NodeJS.ErrnoException).code;
            const hint = errorCode === 'ECONNREFUSED'
                ? ' - Is Harmony Creative running? Use Harmony: Start Creative Service, or check harmony.creativeServicePath and harmony.creativeServiceUrl.'
                : '';
            resolve({ ok: false, result: `creative service unreachable: ${e.message}${hint}`, errorCode });
        });
        req.write(body, 'utf8');
        req.end();
    });
}

async function callCreativeService(
    id: string,
    toolName: string,
    callArgs: Record<string, unknown>,
    timeoutMs: number
): Promise<ToolResult> {
    const result = await invokeCreativeService(toolName, callArgs, timeoutMs);
    return { tool_call_id: id, ok: result.ok, result: result.result };
}

async function creativeHealthTool(args: any): Promise<ToolResult> {
    return callCreativeService(args._id, 'creative_health', {}, 10_000);
}

async function getImageInfoTool(args: any): Promise<ToolResult> {
    const { image_path } = args;
    if (!image_path) return { tool_call_id: args._id, ok: false, result: 'missing argument: image_path' };
    return callCreativeService(args._id, 'get_image_info', { image_path }, 10_000);
}

async function cropImageTool(args: any): Promise<ToolResult> {
    const { image_path, x, y, width, height, output_path } = args;
    if (!image_path || x === undefined || y === undefined || width === undefined || height === undefined) {
        return { tool_call_id: args._id, ok: false, result: 'missing arguments: image_path, x, y, width, height required' };
    }
    const ca: Record<string, unknown> = { image_path, x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
    if (output_path) ca.output_path = output_path;
    return callCreativeService(args._id, 'crop_image', ca, 30_000);
}

async function resizeImageTool(args: any): Promise<ToolResult> {
    const { image_path, width, height, mode, output_path } = args;
    if (!image_path || width === undefined || height === undefined) {
        return { tool_call_id: args._id, ok: false, result: 'missing arguments: image_path, width, height required' };
    }
    const ca: Record<string, unknown> = { image_path, width: Number(width), height: Number(height) };
    if (mode) ca.mode = mode;
    if (output_path) ca.output_path = output_path;
    return callCreativeService(args._id, 'resize_image', ca, 30_000);
}

async function removeBackgroundTool(args: any): Promise<ToolResult> {
    const { image_path, output_path } = args;
    if (!image_path) return { tool_call_id: args._id, ok: false, result: 'missing argument: image_path' };
    const ca: Record<string, unknown> = { image_path };
    if (output_path) ca.output_path = output_path;
    return callCreativeService(args._id, 'remove_background', ca, 60_000);
}

async function compositeLayerTool(args: any): Promise<ToolResult> {
    const { base_image, layer_image, x, y, opacity, output_path } = args;
    if (!base_image || !layer_image) {
        return { tool_call_id: args._id, ok: false, result: 'missing arguments: base_image and layer_image required' };
    }
    const ca: Record<string, unknown> = { base_image, layer_image };
    if (x !== undefined) ca.x = Number(x);
    if (y !== undefined) ca.y = Number(y);
    if (opacity !== undefined) ca.opacity = Number(opacity);
    if (output_path) ca.output_path = output_path;
    return callCreativeService(args._id, 'composite_layer', ca, 30_000);
}

async function drawTextTool(args: any): Promise<ToolResult> {
    const { image_path, text, x, y, size, color, font_path, output_path } = args;
    if (!image_path || !text || x === undefined || y === undefined) {
        return { tool_call_id: args._id, ok: false, result: 'missing arguments: image_path, text, x, y required' };
    }
    const ca: Record<string, unknown> = { image_path, text, x: Number(x), y: Number(y) };
    if (size !== undefined) ca.size = Number(size);
    if (color) ca.color = color;
    if (font_path) ca.font_path = font_path;
    if (output_path) ca.output_path = output_path;
    return callCreativeService(args._id, 'draw_text', ca, 30_000);
}

async function generateImageTool(args: any): Promise<ToolResult> {
    const { prompt, quality, aspect_ratio, member, seed, reference_images, preserve_likeness, likeness_name, use_member_lora } = args;
    if (!prompt) return { tool_call_id: args._id, ok: false, result: 'missing argument: prompt' };
    const ca: Record<string, unknown> = { prompt };
    if (quality) ca.quality = quality;
    if (aspect_ratio) ca.aspect_ratio = aspect_ratio;
    if (member) ca.member = member;
    if (seed !== undefined) ca.seed = Number(seed);
    if (reference_images !== undefined) ca.reference_images = reference_images;
    if (preserve_likeness !== undefined) ca.preserve_likeness = !!preserve_likeness;
    if (likeness_name) ca.likeness_name = likeness_name;
    if (use_member_lora !== undefined) ca.use_member_lora = !!use_member_lora;
    return callCreativeService(args._id, 'generate_image', ca, 300_000);
}

async function generateLayerSetTool(args: any): Promise<ToolResult> {
    const { set_name, layers, prompt, backend, mode, chain, topology, aspect_ratio, resolution, seed } = args;
    if (!set_name) return { tool_call_id: args._id, ok: false, result: 'missing argument: set_name' };
    const ca: Record<string, unknown> = { set_name };
    if (layers !== undefined) ca.layers = layers;
    if (prompt) ca.prompt = prompt;
    if (backend) ca.backend = backend;
    if (mode) ca.mode = mode;
    if (chain !== undefined) ca.chain = !!chain;
    if (topology) ca.topology = topology;
    if (aspect_ratio) ca.aspect_ratio = aspect_ratio;
    if (resolution) ca.resolution = resolution;
    if (seed !== undefined) ca.seed = Number(seed);
    return callCreativeService(args._id, 'generate_layer_set', ca, 300_000);
}

async function generateVideoTool(args: any): Promise<ToolResult> {
    const { prompt, image_path, audio_path, model, duration, aspect_ratio, member } = args;
    if (!prompt && !image_path && !audio_path) {
        return { tool_call_id: args._id, ok: false, result: 'provide prompt, image_path, or audio_path' };
    }
    const ca: Record<string, unknown> = {};
    if (prompt) ca.prompt = prompt;
    if (image_path) ca.image_path = image_path;
    if (audio_path) ca.audio_path = audio_path;
    if (model) ca.model = model;
    if (duration !== undefined) ca.duration = Number(duration);
    if (aspect_ratio) ca.aspect_ratio = aspect_ratio;
    if (member) ca.member = member;
    return callCreativeService(args._id, 'generate_video', ca, 300_000);
}

async function recallMemoryTool(args: any): Promise<ToolResult> {
    const { member, query, n_results } = args;
    if (!query) return { tool_call_id: args._id, ok: false, result: 'missing argument: query' };
    const ca: Record<string, unknown> = { query };
    if (member) ca.member = member;
    if (n_results !== undefined) ca.n_results = Number(n_results);
    return callCreativeService(args._id, 'recall_memory', ca, 60_000);
}

async function listLayerSetsTool(args: any): Promise<ToolResult> {
    const ca: Record<string, unknown> = {};
    if (args.limit !== undefined) ca.limit = Number(args.limit);
    return callCreativeService(args._id, 'list_layer_sets', ca, 30_000);
}

async function getGenerationStatusTool(args: any): Promise<ToolResult> {
    const { job_id } = args;
    if (!job_id) return { tool_call_id: args._id, ok: false, result: 'missing argument: job_id' };
    return callCreativeService(args._id, 'get_generation_status', { job_id }, 30_000);
}

async function saveToLikenessTool(args: any): Promise<ToolResult> {
    const { image_path, member_name } = args;
    if (!image_path || !member_name) {
        return { tool_call_id: args._id, ok: false, result: 'missing arguments: image_path and member_name required' };
    }
    return callCreativeService(args._id, 'save_to_likeness', { image_path, member_name }, 60_000);
}

async function compositePreviewTool(args: any): Promise<ToolResult> {
    const { layer_set_dir } = args;
    if (!layer_set_dir) return { tool_call_id: args._id, ok: false, result: 'missing argument: layer_set_dir' };
    return callCreativeService(args._id, 'composite_preview', { layer_set_dir }, 120_000);
}

const NON_INTERACTIVE_TOOLS: Record<string, (args: any) => Promise<ToolResult>> = {
    read_file: readFileTool,
    list_dir: listDirTool,
    grep: grepTool,
    write_file: writeFileTool,
    open_file: openFileTool,
    run_terminal: runTerminalTool,
    creative_health: creativeHealthTool,
    get_image_info: getImageInfoTool,
    crop_image: cropImageTool,
    resize_image: resizeImageTool,
    remove_background: removeBackgroundTool,
    composite_layer: compositeLayerTool,
    draw_text: drawTextTool,
    generate_image: generateImageTool,
    generate_layer_set: generateLayerSetTool,
    generate_video: generateVideoTool,
    recall_memory: recallMemoryTool,
    list_layer_sets: listLayerSetsTool,
    get_generation_status: getGenerationStatusTool,
    save_to_likeness: saveToLikenessTool,
    composite_preview: compositePreviewTool,
};

/**
 * Execute a non-interactive tool. Returns null if the tool name is unknown
 * OR if it's interactive (ask_question, final_answer) — those are handled
 * by the chat view directly.
 */
export async function executeTool(call: ToolCall): Promise<ToolResult | null> {
    const handler = NON_INTERACTIVE_TOOLS[call.name];
    if (!handler) return null;
    return await handler({ ...call.arguments, _id: call.id });
}

export function isInteractiveTool(name: string): boolean {
    return name === 'ask_question' || name === 'final_answer';
}
