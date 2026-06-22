import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as cp from 'child_process';
import * as os from 'os';
import * as crypto from 'crypto';
import { withOperationLock } from './operationLocks';

const MAX_RESULT_CHARS = 60000;
const DEFAULT_SCAN_EXCLUDES = [
    '.git',
    'node_modules',
    'out',
    'dist',
    'build',
    '.venv',
    'venv',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    '.vscode-test',
    '*.vsix',
    '*.log',
    '*.tmp',
];
const DEFAULT_BACKUP_EXCLUDES = [
    ...DEFAULT_SCAN_EXCLUDES,
    'bin',
    '*.exe',
    '*.dll',
    '*.pdb',
    '.harmony/screenshots',
    '.harmony/assets',
];

function clip(text: string): string {
    if (text.length <= MAX_RESULT_CHARS) return text;
    return text.slice(0, MAX_RESULT_CHARS) + `\n...[truncated, ${text.length - MAX_RESULT_CHARS} more chars]`;
}

function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(clip(text))]);
}

function workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function timestampSlug(): string {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function normalizePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function resolveAnyPath(inputPath?: string): string | undefined {
    const raw = (inputPath ?? '').trim();
    if (!raw) return workspaceRoot();
    if (path.isAbsolute(raw)) return path.resolve(raw);
    const root = workspaceRoot();
    return root ? path.resolve(root, raw) : path.resolve(raw);
}

function workspaceOutputPath(relOrAbs: string): string | undefined {
    if (path.isAbsolute(relOrAbs)) return path.resolve(relOrAbs);
    const root = workspaceRoot();
    return root ? path.resolve(root, relOrAbs) : undefined;
}

function planOnlyMode(): boolean {
    return vscode.workspace.getConfiguration('harmony').get<boolean>('planOnlyMode') ?? false;
}

function isLikelySystemRoot(root: string): boolean {
    const lower = normalizePath(path.resolve(root)).toLowerCase();
    const systemRoots = [
        normalizePath(process.env.SystemRoot ?? 'C:/Windows').toLowerCase(),
        'c:/program files',
        'c:/program files (x86)',
    ];
    return systemRoots.some(systemRoot => lower === systemRoot || lower.startsWith(systemRoot + '/'));
}

function matchesPattern(relPath: string, name: string, pattern: string): boolean {
    const rel = normalizePath(relPath).toLowerCase();
    const pat = normalizePath(pattern).toLowerCase().replace(/^\/+/, '');
    const base = name.toLowerCase();
    if (pat.startsWith('*.')) return base.endsWith(pat.slice(1));
    if (pat.endsWith('/**')) return rel === pat.slice(0, -3) || rel.startsWith(pat.slice(0, -3) + '/');
    return base === pat || rel === pat || rel.includes('/' + pat + '/') || rel.endsWith('/' + pat);
}

function shouldExclude(relPath: string, name: string, excludes: string[]): boolean {
    return excludes.some(pattern => matchesPattern(relPath, name, pattern));
}

async function pathExists(absPath: string): Promise<boolean> {
    return fs.access(absPath).then(() => true).catch(() => false);
}

async function sha256File(absPath: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    const buffer = await fs.readFile(absPath);
    hash.update(buffer);
    return hash.digest('hex');
}

interface ToolLedgerInput {
    category?: string;
    format?: 'markdown' | 'json';
    include_schemas?: boolean;
    include_commands?: boolean;
}

interface LedgerTool {
    name: string;
    displayName: string;
    description: string;
    tags: string[];
    destructive: boolean;
    registered: boolean;
    inputSchema?: unknown;
}

function extensionPackageJson(): any {
    return vscode.extensions.getExtension('harmony.harmony-extension')?.packageJSON
        ?? vscode.extensions.all.find(ext => ext.packageJSON?.name === 'harmony-extension')?.packageJSON
        ?? {};
}

export function formatHarmonyToolLedger(input: ToolLedgerInput = {}): string {
    const pkg = extensionPackageJson();
    const manifestTools: any[] = pkg?.contributes?.languageModelTools ?? [];
    const activeNames = new Set(vscode.lm.tools.map(tool => tool.name));
    const category = input.category?.trim().toLowerCase();
    const tools: LedgerTool[] = manifestTools
        .map(tool => {
            const tags = Array.isArray(tool.tags) ? tool.tags.map(String) : [];
            return {
                name: String(tool.name ?? ''),
                displayName: String(tool.displayName ?? tool.name ?? ''),
                description: String(tool.modelDescription ?? tool.description ?? ''),
                tags,
                destructive: tags.includes('destructive'),
                registered: activeNames.has(String(tool.name ?? '')),
                inputSchema: input.include_schemas ? tool.inputSchema : undefined,
            };
        })
        .filter(tool => tool.name.startsWith('harmony_'))
        .filter(tool => !category || tool.tags.some((tag: string) => tag.toLowerCase() === category) || tool.name.toLowerCase().includes(category));

    const commands: any[] = input.include_commands === false ? [] : (pkg?.contributes?.chatParticipants?.[0]?.commands ?? []);
    if (input.format === 'json') {
        return JSON.stringify({
            generatedAt: new Date().toISOString(),
            extensionVersion: pkg.version ?? 'unknown',
            toolCount: tools.length,
            tools,
            commands,
        }, null, 2);
    }

    const rows = tools.map(tool => `| ${tool.name} | ${tool.displayName} | ${tool.tags.join(', ') || 'uncategorized'} | ${tool.destructive ? 'yes' : 'no'} | ${tool.registered ? 'yes' : 'no'} |`);
    const commandRows = commands.map(cmd => `- /${cmd.name}: ${cmd.description ?? ''}`);
    return [
        '# Harmony Tool Ledger',
        '',
        `Generated: ${new Date().toISOString()}`,
        `Extension version: ${pkg.version ?? 'unknown'}`,
        `Tools shown: ${tools.length}`,
        category ? `Filter: ${category}` : '',
        '',
        '| Tool | Display | Tags | Writes / Runs | Registered |',
        '|---|---|---|---|---|',
        ...rows,
        '',
        commandRows.length ? '## Chat Slash Commands' : '',
        commandRows.length ? commandRows.join('\n') : '',
        '',
        'This ledger is generated from the installed extension manifest and live registered VS Code LM tools, so it does not go stale like a handwritten list.'
    ].filter(Boolean).join('\n');
}

class ToolLedgerTool implements vscode.LanguageModelTool<ToolLedgerInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ToolLedgerInput>) {
        return textResult(formatHarmonyToolLedger(options.input ?? {}));
    }
    async prepareInvocation() { return { invocationMessage: 'Generating live Harmony tool ledger' }; }
}

interface ScanEntry { path: string; bytes: number; kind: 'file' | 'dir'; }
interface ScanSummary {
    root: string;
    exists: boolean;
    bytes: number;
    files: number;
    dirs: number;
    skipped: number;
    errors: string[];
    largestFiles: ScanEntry[];
    largestDirs: ScanEntry[];
}

interface ScanOptions {
    excludes: string[];
    maxDepth: number;
    maxFiles: number;
    top: number;
    followSymlinks: boolean;
}

async function scanRoot(root: string, options: ScanOptions): Promise<ScanSummary> {
    const summary: ScanSummary = {
        root,
        exists: await pathExists(root),
        bytes: 0,
        files: 0,
        dirs: 0,
        skipped: 0,
        errors: [],
        largestFiles: [],
        largestDirs: [],
    };
    if (!summary.exists) return summary;

    async function addLargest(entry: ScanEntry, target: ScanEntry[]): Promise<void> {
        target.push(entry);
        target.sort((a, b) => b.bytes - a.bytes);
        if (target.length > options.top) target.length = options.top;
    }

    async function walk(absPath: string, relPath: string, depth: number): Promise<number> {
        if (summary.files >= options.maxFiles) {
            summary.skipped++;
            return 0;
        }
        let stat;
        try { stat = options.followSymlinks ? await fs.stat(absPath) : await fs.lstat(absPath); }
        catch (error: any) { summary.errors.push(`${relPath}: ${error?.message ?? String(error)}`); return 0; }
        const name = path.basename(absPath);
        if (relPath !== '.' && shouldExclude(relPath, name, options.excludes)) {
            summary.skipped++;
            return 0;
        }
        if (stat.isSymbolicLink() && !options.followSymlinks) {
            summary.skipped++;
            return 0;
        }
        if (stat.isFile()) {
            summary.files++;
            summary.bytes += stat.size;
            await addLargest({ path: normalizePath(relPath), bytes: stat.size, kind: 'file' }, summary.largestFiles);
            return stat.size;
        }
        if (!stat.isDirectory()) return 0;
        summary.dirs++;
        if (depth >= options.maxDepth) {
            summary.skipped++;
            return 0;
        }
        let entries: string[] = [];
        try { entries = await fs.readdir(absPath); }
        catch (error: any) { summary.errors.push(`${relPath}: ${error?.message ?? String(error)}`); return 0; }
        let total = 0;
        for (const entry of entries) {
            const childAbs = path.join(absPath, entry);
            const childRel = relPath === '.' ? entry : path.join(relPath, entry);
            total += await walk(childAbs, childRel, depth + 1);
        }
        if (relPath !== '.') await addLargest({ path: normalizePath(relPath), bytes: total, kind: 'dir' }, summary.largestDirs);
        return total;
    }

    await walk(root, '.', 0);
    return summary;
}

function defaultHarmonyExtensionPath(): string | undefined {
    const cfg = vscode.workspace.getConfiguration('harmony');
    const configured = (cfg.get<string>('extensionSourcePath') ?? '').trim();
    const fromEnv = (process.env.HARMONY_EXTENSION_SOURCE ?? '').trim();
    const root = workspaceRoot();
    const candidates = [
        configured,
        fromEnv,
        root ? path.resolve(root, '..', 'HarmonyExtension') : undefined,
    ].filter(Boolean) as string[];
    return candidates.find(candidate => require('fs').existsSync(path.join(candidate, 'package.json')));
}

interface BackupAdvisorInput {
    roots?: string[];
    max_depth?: number;
    max_files?: number;
}

class BackupAdvisorTool implements vscode.LanguageModelTool<BackupAdvisorInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<BackupAdvisorInput>) {
        const roots = (options.input.roots?.length ? options.input.roots : [defaultHarmonyExtensionPath(), workspaceRoot()].filter(Boolean) as string[])
            .map(root => resolveAnyPath(root))
            .filter(Boolean) as string[];
        if (roots.length === 0) return textResult('error: no roots available to analyze');
        const summaries = [] as ScanSummary[];
        for (const root of roots) {
            summaries.push(await scanRoot(root, {
                excludes: DEFAULT_SCAN_EXCLUDES,
                maxDepth: Math.max(1, Math.min(10, Number(options.input.max_depth) || 4)),
                maxFiles: Math.max(100, Math.min(200000, Number(options.input.max_files) || 25000)),
                top: 8,
                followSymlinks: false,
            }));
        }
        const lines = ['# Backup Advisor', '', `Generated: ${new Date().toISOString()}`, ''];
        for (const summary of summaries) {
            lines.push(`## ${summary.root}`);
            if (!summary.exists) {
                lines.push('', 'Path does not exist.', '');
                continue;
            }
            lines.push('', `Scanned size: ${formatBytes(summary.bytes)} (${summary.files} files, ${summary.dirs} dirs, ${summary.skipped} skipped)`, '');
            lines.push('Largest directories:');
            lines.push(...(summary.largestDirs.length ? summary.largestDirs.map(entry => `- ${entry.path}: ${formatBytes(entry.bytes)}`) : ['- (none)']));
            lines.push('', 'Largest files:');
            lines.push(...(summary.largestFiles.length ? summary.largestFiles.map(entry => `- ${entry.path}: ${formatBytes(entry.bytes)}`) : ['- (none)']));
            if (summary.errors.length) lines.push('', 'Scan warnings:', ...summary.errors.slice(0, 8).map(error => `- ${error}`));
            lines.push('');
        }
        lines.push('## Recommended Strategy');
        lines.push('- Back up HarmonyExtension separately from any central/private workspaces because it is small, high-value source code and changes often.');
        lines.push('- Keep source snapshots lean: include src, package.json, package-lock.json, tsconfig.json, media, scripts, README/LICENSE, and the latest VSIX.');
        lines.push('- Exclude node_modules, out, .git, bin, large generated assets, screenshots, logs, and rebuildable binaries from routine snapshots.');
        lines.push('- Use a dated manifest for each snapshot so we know exactly what was preserved and when.');
        return textResult(lines.join('\n'));
    }
    async prepareInvocation() { return { invocationMessage: 'Analyzing backup scope' }; }
}

interface ManifestFile {
    path: string;
    bytes: number;
    mtime: string;
    sha256?: string;
}
interface BackupManifestInput {
    roots?: string[];
    output_path?: string;
    include_hashes?: boolean;
    max_files?: number;
    excludes?: string[];
}

async function collectManifestFiles(root: string, excludes: string[], maxFiles: number, includeHashes: boolean): Promise<{ files: ManifestFile[]; skipped: number; errors: string[] }> {
    const files: ManifestFile[] = [];
    const errors: string[] = [];
    let skipped = 0;
    async function walk(absPath: string, relPath: string): Promise<void> {
        if (files.length >= maxFiles) { skipped++; return; }
        let stat;
        try { stat = await fs.lstat(absPath); }
        catch (error: any) { errors.push(`${relPath}: ${error?.message ?? String(error)}`); return; }
        const name = path.basename(absPath);
        if (relPath !== '.' && shouldExclude(relPath, name, excludes)) { skipped++; return; }
        if (stat.isSymbolicLink()) { skipped++; return; }
        if (stat.isFile()) {
            const item: ManifestFile = { path: normalizePath(relPath), bytes: stat.size, mtime: stat.mtime.toISOString() };
            if (includeHashes) {
                try { item.sha256 = await sha256File(absPath); } catch (error: any) { errors.push(`${relPath}: hash failed: ${error?.message ?? String(error)}`); }
            }
            files.push(item);
            return;
        }
        if (!stat.isDirectory()) return;
        let entries: string[] = [];
        try { entries = await fs.readdir(absPath); }
        catch (error: any) { errors.push(`${relPath}: ${error?.message ?? String(error)}`); return; }
        for (const entry of entries) await walk(path.join(absPath, entry), relPath === '.' ? entry : path.join(relPath, entry));
    }
    await walk(root, '.');
    return { files, skipped, errors };
}

class BackupManifestTool implements vscode.LanguageModelTool<BackupManifestInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<BackupManifestInput>) {
        const roots = (options.input.roots?.length ? options.input.roots : [defaultHarmonyExtensionPath() ?? workspaceRoot()].filter(Boolean) as string[])
            .map(root => resolveAnyPath(root))
            .filter(Boolean) as string[];
        if (roots.length === 0) return textResult('error: no roots available for manifest');
        const output = workspaceOutputPath(options.input.output_path?.trim() || path.join('.harmony', 'backups', `backup-manifest-${timestampSlug()}.json`));
        if (!output) return textResult('error: no workspace folder is open for output_path');
        const excludes = [...DEFAULT_BACKUP_EXCLUDES, ...(options.input.excludes ?? [])];
        const maxFiles = Math.max(100, Math.min(300000, Number(options.input.max_files) || 50000));
        const rootsManifest = [];
        for (const root of roots) {
            if (!await pathExists(root)) {
                rootsManifest.push({ root, exists: false, files: [], skipped: 0, errors: ['path does not exist'] });
                continue;
            }
            const collected = await collectManifestFiles(root, excludes, maxFiles, !!options.input.include_hashes);
            rootsManifest.push({ root, exists: true, ...collected });
        }
        const manifest = {
            kind: 'harmony-backup-manifest',
            generatedAt: new Date().toISOString(),
            extensionVersion: extensionPackageJson().version ?? 'unknown',
            roots: rootsManifest,
            excludes,
        };
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, JSON.stringify(manifest, null, 2), 'utf8');
        const totalFiles = rootsManifest.reduce((sum, root: any) => sum + (root.files?.length ?? 0), 0);
        return textResult(`Backup manifest written: ${output}\nRoots: ${rootsManifest.length}\nFiles recorded: ${totalFiles}\nHashes: ${options.input.include_hashes ? 'yes' : 'no'}`);
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<BackupManifestInput>) {
        const output = options.input.output_path || '.harmony/backups/backup-manifest-*.json';
        return {
            invocationMessage: 'Writing backup manifest',
            confirmationMessages: {
                title: 'Write backup manifest?',
                message: new vscode.MarkdownString(`Harmony wants to create a dated backup manifest at \`${output}\`.`)
            }
        };
    }
}

interface BackupSnapshotInput {
    source_roots?: string[];
    destination?: string;
    include_vsix?: boolean;
    include_hashes?: boolean;
    max_files?: number;
    excludes?: string[];
}

class BackupSnapshotTool implements vscode.LanguageModelTool<BackupSnapshotInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<BackupSnapshotInput>) {
        const sources = (options.input.source_roots?.length ? options.input.source_roots : [defaultHarmonyExtensionPath() ?? workspaceRoot()].filter(Boolean) as string[])
            .map(root => resolveAnyPath(root))
            .filter(Boolean) as string[];
        if (sources.length === 0) return textResult('error: no source roots available for backup snapshot');
        for (const source of sources) {
            if (isLikelySystemRoot(source)) return textResult(`error: refusing to snapshot likely system folder: ${source}`);
        }
        const destination = resolveAnyPath(options.input.destination || path.join('C:\\Documents\\HarmonyBackups', `harmony-backup-${timestampSlug()}`));
        if (!destination) return textResult('error: invalid destination');
        const excludes = [...DEFAULT_BACKUP_EXCLUDES, ...(options.input.excludes ?? [])];
        const maxFiles = Math.max(10, Math.min(100000, Number(options.input.max_files) || 25000));
        const manifestRoots = [];
        await fs.mkdir(destination, { recursive: true });
        for (const source of sources) {
            if (!await pathExists(source)) {
                manifestRoots.push({ root: source, exists: false, files: [], copied: 0, skipped: 0, errors: ['path does not exist'] });
                continue;
            }
            const collected = await collectManifestFiles(source, excludes, maxFiles, !!options.input.include_hashes);
            let copied = 0;
            const baseName = path.basename(source.replace(/[\\/]$/, '')) || 'root';
            for (const file of collected.files) {
                const src = path.join(source, file.path);
                const dst = path.join(destination, baseName, file.path);
                await fs.mkdir(path.dirname(dst), { recursive: true });
                await fs.copyFile(src, dst);
                copied++;
            }
            if (options.input.include_vsix ?? true) {
                const vsixPath = path.join(source, 'harmony-extension.vsix');
                if (await pathExists(vsixPath)) {
                    const dst = path.join(destination, baseName, 'harmony-extension.vsix');
                    await fs.copyFile(vsixPath, dst);
                    copied++;
                }
            }
            manifestRoots.push({ root: source, exists: true, copied, ...collected });
        }
        const manifestPath = path.join(destination, `snapshot-manifest-${timestampSlug()}.json`);
        await fs.writeFile(manifestPath, JSON.stringify({
            kind: 'harmony-backup-snapshot',
            generatedAt: new Date().toISOString(),
            destination,
            excludes,
            roots: manifestRoots,
        }, null, 2), 'utf8');
        const copied = manifestRoots.reduce((sum: number, root: any) => sum + (root.copied ?? 0), 0);
        return textResult(`Backup snapshot written: ${destination}\nFiles copied: ${copied}\nManifest: ${manifestPath}`);
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<BackupSnapshotInput>) {
        const destination = options.input.destination || 'C:\\Documents\\HarmonyBackups\\harmony-backup-*';
        return {
            invocationMessage: 'Creating backup snapshot',
            confirmationMessages: {
                title: 'Create backup snapshot?',
                message: new vscode.MarkdownString(`Harmony wants to copy source files into backup destination \`${destination}\`.`)
            }
        };
    }
}

interface StorageAnalyzerInput { path?: string; max_depth?: number; max_files?: number; top?: number; excludes?: string[]; }

class StorageAnalyzerTool implements vscode.LanguageModelTool<StorageAnalyzerInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<StorageAnalyzerInput>) {
        const root = resolveAnyPath(options.input.path);
        if (!root) return textResult('error: no path or workspace root available');
        const summary = await scanRoot(root, {
            excludes: [...DEFAULT_SCAN_EXCLUDES, ...(options.input.excludes ?? [])],
            maxDepth: Math.max(1, Math.min(12, Number(options.input.max_depth) || 5)),
            maxFiles: Math.max(100, Math.min(300000, Number(options.input.max_files) || 50000)),
            top: Math.max(3, Math.min(50, Number(options.input.top) || 15)),
            followSymlinks: false,
        });
        return textResult([
            '# Storage Analyzer',
            '',
            `Path: ${summary.root}`,
            `Exists: ${summary.exists ? 'yes' : 'no'}`,
            `Scanned size: ${formatBytes(summary.bytes)}`,
            `Files: ${summary.files}`,
            `Directories: ${summary.dirs}`,
            `Skipped: ${summary.skipped}`,
            '',
            '## Largest Directories',
            ...(summary.largestDirs.length ? summary.largestDirs.map(entry => `- ${entry.path}: ${formatBytes(entry.bytes)}`) : ['- (none)']),
            '',
            '## Largest Files',
            ...(summary.largestFiles.length ? summary.largestFiles.map(entry => `- ${entry.path}: ${formatBytes(entry.bytes)}`) : ['- (none)']),
            summary.errors.length ? '\n## Warnings\n' + summary.errors.slice(0, 20).map(error => `- ${error}`).join('\n') : ''
        ].filter(Boolean).join('\n'));
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<StorageAnalyzerInput>) {
        return { invocationMessage: `Analyzing storage for ${options.input.path || 'workspace'}` };
    }
}

function powershellCommand(): string {
    return process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
}

async function runPowerShell(script: string, timeoutMs = 20000): Promise<string> {
    return await new Promise(resolve => {
        cp.execFile(powershellCommand(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
            windowsHide: true,
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
        }, (error, stdout, stderr) => {
            resolve([stdout, stderr ? `[stderr]\n${stderr}` : '', error ? `[error]\n${error.message}` : ''].filter(Boolean).join('\n'));
        });
    });
}

interface SystemSnapshotInput { include_network?: boolean; include_registry?: boolean; include_processes?: boolean; }

class SystemSnapshotTool implements vscode.LanguageModelTool<SystemSnapshotInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SystemSnapshotInput>) {
        const lines = [
            '# System Snapshot',
            '',
            `Generated: ${new Date().toISOString()}`,
            `Platform: ${os.platform()} ${os.release()} ${os.arch()}`,
            `Hostname: ${os.hostname()}`,
            `Uptime: ${Math.round(os.uptime() / 60)} minutes`,
            `CPUs: ${os.cpus().length}`,
            `Memory: ${formatBytes(os.totalmem() - os.freemem())} used / ${formatBytes(os.totalmem())}`,
            `Workspace: ${workspaceRoot() ?? '(none)'}`,
            ''
        ];
        if (options.input.include_network ?? true) {
            lines.push('## Network / VPN Indicators');
            lines.push(await runPowerShell(`
$ErrorActionPreference='SilentlyContinue'
$adapters = Get-NetAdapter | Select-Object Name,Status,LinkSpeed,InterfaceDescription,MacAddress
$ip = Get-NetIPConfiguration | Select-Object InterfaceAlias,InterfaceDescription,@{n='IPv4';e={$_.IPv4Address.IPAddress -join ','}},@{n='DNS';e={$_.DNSServer.ServerAddresses -join ','}}
$vpn = Get-NetAdapter | Where-Object { $_.Name -match 'vpn|wireguard|tailscale|zerotier|nord|openvpn|tunnel|wintun' -or $_.InterfaceDescription -match 'vpn|wireguard|tailscale|zerotier|nord|openvpn|tunnel|wintun' } | Select-Object Name,Status,InterfaceDescription
$proxy = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' | Select-Object ProxyEnable,ProxyServer,AutoConfigURL
[pscustomobject]@{Adapters=$adapters; IP=$ip; VpnIndicators=$vpn; Proxy=$proxy} | ConvertTo-Json -Depth 5
`));
        }
        if (options.input.include_processes) {
            lines.push('', '## Top Processes');
            lines.push(await runPowerShell(`Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 20 ProcessName,Id,@{n='WorkingSetMB';e={[math]::Round($_.WorkingSet64/1MB,1)}},CPU | ConvertTo-Json -Depth 3`));
        }
        if (options.input.include_registry) {
            lines.push('', '## Registry Startup Snapshot');
            lines.push(await registrySnapshotText(undefined, true));
        }
        return textResult(lines.join('\n'));
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SystemSnapshotInput>) {
        if (!options.input.include_registry && !options.input.include_processes) return { invocationMessage: 'Collecting system snapshot' };
        return {
            invocationMessage: 'Collecting detailed system snapshot',
            confirmationMessages: {
                title: 'Collect detailed system snapshot?',
                message: new vscode.MarkdownString('Harmony wants to read process and/or registry metadata. Values are intended for troubleshooting only.')
            }
        };
    }
}

interface NetworkSnapshotInput { include_routes?: boolean; include_dns_cache?: boolean; }

class NetworkSnapshotTool implements vscode.LanguageModelTool<NetworkSnapshotInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<NetworkSnapshotInput>) {
        const routes = options.input.include_routes === false ? '$routes = @()' : "$routes = Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Select-Object InterfaceAlias,NextHop,RouteMetric,PolicyStore";
        const dnsCache = options.input.include_dns_cache ? "$dnsCache = Get-DnsClientCache | Select-Object -First 50 Entry,Data,Type,TimeToLive" : '$dnsCache = @()';
        const output = await runPowerShell(`
$ErrorActionPreference='SilentlyContinue'
$ip = Get-NetIPConfiguration | Select-Object InterfaceAlias,InterfaceDescription,@{n='IPv4';e={$_.IPv4Address.IPAddress -join ','}},@{n='IPv6';e={$_.IPv6Address.IPAddress -join ','}},@{n='DNS';e={$_.DNSServer.ServerAddresses -join ','}}
$dns = Get-DnsClientServerAddress | Select-Object InterfaceAlias,AddressFamily,ServerAddresses
${routes}
${dnsCache}
$proxy = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' | Select-Object ProxyEnable,ProxyServer,AutoConfigURL
$vpn = Get-NetAdapter | Where-Object { $_.Name -match 'vpn|wireguard|tailscale|zerotier|nord|openvpn|tunnel|wintun' -or $_.InterfaceDescription -match 'vpn|wireguard|tailscale|zerotier|nord|openvpn|tunnel|wintun' } | Select-Object Name,Status,InterfaceDescription,LinkSpeed
[pscustomobject]@{IP=$ip; DNS=$dns; Routes=$routes; DnsCache=$dnsCache; Proxy=$proxy; VpnIndicators=$vpn} | ConvertTo-Json -Depth 5
`);
        return textResult(`# Network Snapshot\n\nGenerated: ${new Date().toISOString()}\n\n\`\`\`json\n${output.trim()}\n\`\`\``);
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<NetworkSnapshotInput>) {
        if (!options.input.include_dns_cache) return { invocationMessage: 'Collecting network snapshot' };
        return {
            invocationMessage: 'Collecting network and DNS cache snapshot',
            confirmationMessages: {
                title: 'Read DNS cache?',
                message: new vscode.MarkdownString('Harmony wants to read recent DNS cache entries for troubleshooting. This may reveal recently contacted domains.')
            }
        };
    }
}

interface RegistrySnapshotInput { keys?: string[]; redact_values?: boolean; max_values?: number; }

async function registrySnapshotText(input?: RegistrySnapshotInput, forceRedact = false): Promise<string> {
    const keys = input?.keys?.length ? input.keys : [
        'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    ];
    const redact = forceRedact || input?.redact_values !== false;
    const maxValues = Math.max(1, Math.min(200, Number(input?.max_values) || 40));
        const encodedKeys = Buffer.from(JSON.stringify(keys), 'utf8').toString('base64');
    return await runPowerShell(`
$ErrorActionPreference='SilentlyContinue'
$keysJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedKeys}'))
$keys = $keysJson | ConvertFrom-Json
$out = foreach ($key in $keys) {
  if (Test-Path $key) {
    $item = Get-Item -Path $key
    $props = @($item.Property | Select-Object -First ${maxValues})
    $values = foreach ($name in $props) {
      $raw = Get-ItemPropertyValue -Path $key -Name $name
            $typeName = if ($null -eq $raw) { 'Null' } else { $raw.GetType().Name }
            [pscustomobject]@{Name=$name; Type=$typeName; Value=$(if (${redact ? '$true' : '$false'}) {'[redacted]'} else {[string]$raw})}
    }
    [pscustomobject]@{Key=$key; Exists=$true; Values=$values}
  } else {
    [pscustomobject]@{Key=$key; Exists=$false; Values=@()}
  }
}
$out | ConvertTo-Json -Depth 5
`);
}

class RegistrySnapshotTool implements vscode.LanguageModelTool<RegistrySnapshotInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<RegistrySnapshotInput>) {
        if (process.platform !== 'win32') return textResult('error: registry snapshot is only available on Windows');
        const output = await registrySnapshotText(options.input ?? {});
        return textResult(`# Registry Snapshot\n\nGenerated: ${new Date().toISOString()}\nValues redacted: ${(options.input.redact_values !== false) ? 'yes' : 'no'}\n\n\`\`\`json\n${output.trim()}\n\`\`\``);
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<RegistrySnapshotInput>) {
        return {
            invocationMessage: 'Reading selected registry keys',
            confirmationMessages: {
                title: 'Read registry metadata?',
                message: new vscode.MarkdownString(`Harmony wants to read selected Windows registry keys. Values are ${options.input.redact_values === false ? 'not redacted' : 'redacted'} by default.`)
            }
        };
    }
}

interface FolderDateSyncInput {
    folder_path: string;
    dry_run?: boolean;
}

class FolderDateSyncTool implements vscode.LanguageModelTool<FolderDateSyncInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<FolderDateSyncInput>) {
        if (process.platform !== 'win32') return textResult('error: folder date sync is only available on Windows');
        const folder = resolveAnyPath(options.input.folder_path);
        if (!folder) return textResult('error: folder_path is required');
        const dryRun = options.input.dry_run ?? false;
        const encodedFolder = Buffer.from(folder, 'utf8').toString('base64');
        const output = await runPowerShell(`
$ErrorActionPreference='Stop'
$folder = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedFolder}'))
if (!(Test-Path -LiteralPath $folder -PathType Container)) { throw "Folder not found: $folder" }
$folderItem = Get-Item -LiteralPath $folder
$newest = Get-ChildItem -LiteralPath $folder -File -Recurse -Force -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($null -eq $newest) {
  [pscustomobject]@{ok=$false; folder=$folder; dry_run=${dryRun ? '$true' : '$false'}; error='No files found inside folder.'} | ConvertTo-Json -Depth 4
  exit 0
}
$previous = $folderItem.LastWriteTime
if (-not ${dryRun ? '$true' : '$false'}) {
  $folderItem.LastWriteTime = $newest.LastWriteTime
}
$after = (Get-Item -LiteralPath $folder).LastWriteTime
[pscustomobject]@{
  ok=$true
  folder=$folder
  dry_run=${dryRun ? '$true' : '$false'}
  newest_file=$newest.FullName
  newest_file_last_write_time=$newest.LastWriteTime.ToString('o')
  previous_folder_last_write_time=$previous.ToString('o')
  resulting_folder_last_write_time=$after.ToString('o')
} | ConvertTo-Json -Depth 5
`, 60000);
        return textResult(`# Folder Date Sync\n\n${output.trim()}`);
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<FolderDateSyncInput>) {
        if (options.input.dry_run ?? false) return { invocationMessage: 'Dry-running folder date sync' };
        return {
            invocationMessage: 'Syncing folder LastWriteTime metadata',
            confirmationMessages: {
                title: 'Sync folder date metadata?',
                message: new vscode.MarkdownString(`Harmony wants to set the folder LastWriteTime for \`${options.input.folder_path}\` to match the newest file inside it. File contents are not changed.`)
            }
        };
    }
}

interface ProcessRegistryInput {
    action?: 'list' | 'snapshot' | 'read';
    pid?: number;
    limit?: number;
    write_snapshot?: boolean;
    format?: 'markdown' | 'json';
}

interface ManagedProcessRecord {
    version: number;
    kind: string;
    pid: number;
    command?: string;
    cwd?: string;
    startedAt?: string;
    requestedPort?: number | null;
    actualPort?: number | null;
    portConflictStrategy?: string | null;
    notes?: string | null;
    stdoutLog?: string;
    stderrLog?: string;
    owner?: string;
    status?: 'running' | 'stale';
}

function processLooksAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: any) {
        return error?.code === 'EPERM';
    }
}

async function readManagedProcessRecords(root: string): Promise<ManagedProcessRecord[]> {
    const dir = path.join(root, '.harmony', 'processes', 'managed');
    const names = (await fs.readdir(dir).catch(() => [])).filter(name => /^process-\d+\.json$/i.test(name));
    const records: ManagedProcessRecord[] = [];
    for (const name of names.slice(-200)) {
        try {
            const record = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as ManagedProcessRecord;
            record.status = processLooksAlive(Number(record.pid)) ? 'running' : 'stale';
            records.push(record);
        } catch {
            // Ignore malformed managed process records; snapshots should remain readable.
        }
    }
    return records.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
}

async function processSnapshot(limit: number): Promise<any[]> {
    if (process.platform === 'win32') {
        const output = await runPowerShell(`
$ErrorActionPreference='SilentlyContinue'
Get-Process | Select-Object -First ${limit} Id,ProcessName,Path,StartTime,CPU,WorkingSet64 | ConvertTo-Json -Depth 4
`, 60000);
        try { return JSON.parse(output || '[]'); } catch { return [{ error: 'could not parse process snapshot', raw: output.slice(0, 2000) }]; }
    }
    return await new Promise(resolve => {
        cp.execFile('ps', ['-axo', 'pid,comm,rss,etime,args'], { timeout: 60000, windowsHide: true, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) resolve([{ error: stderr || err.message }]);
            else resolve(stdout.split(/\r?\n/).slice(1, limit + 1).filter(Boolean).map(line => ({ raw: line.trim() })));
        }).on('error', error => resolve([{ error: error.message }]));
    }) as any[];
}

async function writeProcessSnapshot(payload: any): Promise<string | undefined> {
    const root = workspaceRoot();
    if (!root) return undefined;
    const dir = path.join(root, '.harmony', 'processes');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `process-snapshot-${timestampSlug()}.json`);
    const text = JSON.stringify(payload, null, 2);
    await fs.writeFile(file, text, 'utf8');
    await fs.writeFile(path.join(dir, 'latest.json'), text, 'utf8');
    return normalizePath(path.relative(root, file));
}

class ProcessRegistryTool implements vscode.LanguageModelTool<ProcessRegistryInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ProcessRegistryInput>) {
        const action = options.input.action ?? 'list';
        const root = workspaceRoot();
        if (!root) return textResult('error: no workspace folder is open');
        if (action === 'read') {
            const latest = path.join(root, '.harmony', 'processes', 'latest.json');
            const text = await fs.readFile(latest, 'utf8').catch(() => '');
            return textResult(text || 'No process registry snapshot found yet.');
        }
        const limit = Math.max(5, Math.min(500, Math.floor(Number(options.input.limit) || 100)));
        const processes = await processSnapshot(limit);
        const filtered = options.input.pid ? processes.filter((item: any) => Number(item.Id ?? item.pid) === Number(options.input.pid)) : processes;
        const managedProcesses = (await readManagedProcessRecords(root)).filter(item => !options.input.pid || Number(item.pid) === Number(options.input.pid));
        const payload = {
            version: 1,
            generatedAt: new Date().toISOString(),
            workspace: root,
            pidFilter: options.input.pid ?? null,
            processes: filtered,
            managedProcesses,
            note: 'Process registry snapshot is observational. Managed Harmony background processes are shared through .harmony/processes/managed for VS Code, terminal, and future floating UI coordination.',
        };
        let writtenPath: string | undefined;
        let skippedWrite: string | undefined;
        if (action === 'snapshot' && options.input.write_snapshot !== false && !planOnlyMode()) {
            writtenPath = await withOperationLock(root, 'process-registry', 'process registry snapshot', { limit, pid: options.input.pid ?? null }, () => writeProcessSnapshot(payload), 60_000);
        } else if (action === 'snapshot') {
            skippedWrite = planOnlyMode() && options.input.write_snapshot !== false ? 'Plan-only mode is enabled; process snapshot write was skipped.' : 'Process snapshot write disabled.';
        }
        if (options.input.format === 'json') return textResult(JSON.stringify({ ...payload, writtenPath, skippedWrite }, null, 2));
        const rows = filtered.slice(0, 60).map((item: any) => `- ${item.Id ?? item.pid ?? '?'} ${item.ProcessName ?? item.comm ?? item.raw ?? '(unknown)'} ${item.Path ? `- ${item.Path}` : ''}`);
        const managedRows = managedProcesses.slice(0, 25).map(item => `- ${item.pid} ${item.status ?? 'unknown'} ${item.actualPort ? `(port ${item.actualPort}) ` : ''}${item.command ?? '(unknown command)'}${item.stdoutLog ? ` | log: ${item.stdoutLog}` : ''}`);
        return textResult([
            '# Harmony Process Registry',
            '',
            `Generated: ${payload.generatedAt}`,
            writtenPath ? `Snapshot written: ${writtenPath}` : (skippedWrite ?? 'Snapshot not written.'),
            '',
            '## Managed Harmony Background Processes',
            managedRows.length ? managedRows.join('\n') : '- No managed Harmony background processes recorded yet.',
            '',
            '## OS Process Sample',
            rows.length ? rows.join('\n') : '- No process rows found.',
            '',
            payload.note,
        ].join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ProcessRegistryInput>) {
        return { invocationMessage: `${options.input.action ?? 'list'} process registry` };
    }
}

interface OperationLedgerInput {
    action?: 'list' | 'append' | 'snapshot';
    label?: string;
    kind?: string;
    status?: string;
    notes?: string;
    limit?: number;
    format?: 'markdown' | 'json';
}

interface OperationLedgerEntry {
    id: string;
    timestamp: string;
    label: string;
    kind: string;
    status: string;
    notes?: string;
    activeLocks?: string[];
    terminalLogs?: string[];
}

interface OperationLedgerFile { version: 1; updatedAt: string; entries: OperationLedgerEntry[]; }

async function operationLedgerPath(): Promise<string> {
    const root = workspaceRoot();
    if (!root) throw new Error('no workspace folder is open');
    return path.join(root, '.harmony', 'operations', 'ledger.json');
}

async function readOperationLedger(): Promise<OperationLedgerFile> {
    const file = await operationLedgerPath();
    try { return JSON.parse(await fs.readFile(file, 'utf8')) as OperationLedgerFile; }
    catch { return { version: 1, updatedAt: new Date().toISOString(), entries: [] }; }
}

async function writeOperationLedger(ledger: OperationLedgerFile): Promise<string> {
    const file = await operationLedgerPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    ledger.updatedAt = new Date().toISOString();
    ledger.entries = ledger.entries.slice(-1000);
    await fs.writeFile(file, JSON.stringify(ledger, null, 2), 'utf8');
    const root = workspaceRoot();
    return root ? normalizePath(path.relative(root, file)) : file;
}

async function currentOperationSignals(): Promise<{ activeLocks: string[]; terminalLogs: string[] }> {
    const root = workspaceRoot();
    if (!root) return { activeLocks: [], terminalLogs: [] };
    const lockDir = path.join(root, '.harmony', 'locks');
    const terminalDir = path.join(root, '.harmony', 'terminals');
    const activeLocks = (await fs.readdir(lockDir).catch(() => [])).filter(name => name.endsWith('.json')).slice(0, 50);
    const terminalLogs = (await fs.readdir(terminalDir).catch(() => [])).filter(name => name.endsWith('.log') || name.endsWith('.json')).slice(-50);
    return { activeLocks, terminalLogs };
}

class OperationLedgerTool implements vscode.LanguageModelTool<OperationLedgerInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<OperationLedgerInput>) {
        const action = options.input.action ?? 'list';
        let ledger = await readOperationLedger();
        let writtenPath: string | undefined;
        let skippedWrite: string | undefined;
        if (action === 'append' || action === 'snapshot') {
            if (planOnlyMode()) {
                skippedWrite = 'Plan-only mode is enabled; operation ledger write was skipped.';
            } else {
                const root = workspaceRoot();
                if (!root) return textResult('error: no workspace folder is open');
                writtenPath = await withOperationLock(root, 'operation-ledger', `${action} operation ledger`, { label: options.input.label ?? null, kind: options.input.kind ?? action }, async () => {
                    ledger = await readOperationLedger();
                    const signals = action === 'snapshot' ? await currentOperationSignals() : { activeLocks: undefined, terminalLogs: undefined };
                    ledger.entries.push({
                        id: crypto.randomUUID(),
                        timestamp: new Date().toISOString(),
                        label: options.input.label?.trim() || (action === 'snapshot' ? 'operation snapshot' : 'manual operation entry'),
                        kind: options.input.kind?.trim() || action,
                        status: options.input.status?.trim() || 'observed',
                        notes: options.input.notes?.trim() || undefined,
                        activeLocks: signals.activeLocks,
                        terminalLogs: signals.terminalLogs,
                    });
                    return await writeOperationLedger(ledger);
                }, 60_000);
            }
        }
        const limit = Math.max(1, Math.min(200, Math.floor(Number(options.input.limit) || 25)));
        const entries = ledger.entries.slice(-limit).reverse();
        if (options.input.format === 'json') return textResult(JSON.stringify({ path: '.harmony/operations/ledger.json', writtenPath, skippedWrite, entries }, null, 2));
        return textResult([
            '# Harmony Operation Ledger',
            '',
            `Updated: ${ledger.updatedAt}`,
            writtenPath ? `Ledger written: ${writtenPath}` : (skippedWrite ?? 'Ledger not written in this call.'),
            '',
            entries.length ? entries.map(entry => `- ${entry.timestamp} | ${entry.status} | ${entry.kind} | ${entry.label}${entry.notes ? ` - ${entry.notes}` : ''}`).join('\n') : '- No operation ledger entries yet.',
        ].join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<OperationLedgerInput>) {
        const action = options.input.action ?? 'list';
        if (action === 'list') return { invocationMessage: 'Reading operation ledger' };
        return {
            invocationMessage: `${action} operation ledger`,
            confirmationMessages: {
                title: `${action === 'append' ? 'Append to' : 'Snapshot'} operation ledger?`,
                message: new vscode.MarkdownString('Harmony wants to write a local private operation ledger entry under `.harmony/operations`.')
            }
        };
    }
}

interface SupervisorStateInput {
    action?: 'status' | 'heartbeat' | 'event';
    surface?: 'vscode' | 'terminal' | 'floating' | 'other';
    label?: string;
    event_kind?: string;
    notes?: string;
    format?: 'markdown' | 'json';
}

interface SupervisorHeartbeat {
    version: 1;
    surface: string;
    label: string;
    pid: number;
    workspace: string;
    updatedAt: string;
    staleAfterMs: number;
}

async function supervisorDir(root: string): Promise<string> {
    const dir = path.join(root, '.harmony', 'supervisor');
    await fs.mkdir(dir, { recursive: true });
    return dir;
}

async function readSupervisorHeartbeats(root: string): Promise<Array<SupervisorHeartbeat & { status: 'active' | 'stale'; ageMs: number }>> {
    const dir = path.join(root, '.harmony', 'supervisor', 'heartbeats');
    const names = (await fs.readdir(dir).catch(() => [])).filter(name => name.endsWith('.json'));
    const now = Date.now();
    const heartbeats: Array<SupervisorHeartbeat & { status: 'active' | 'stale'; ageMs: number }> = [];
    for (const name of names.slice(-100)) {
        try {
            const heartbeat = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as SupervisorHeartbeat;
            const ageMs = now - Date.parse(heartbeat.updatedAt);
            heartbeats.push({ ...heartbeat, ageMs, status: ageMs <= heartbeat.staleAfterMs ? 'active' : 'stale' });
        } catch {
            // Ignore malformed heartbeat records; status should stay readable.
        }
    }
    return heartbeats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function readOperationLockRecords(root: string): Promise<any[]> {
    const dir = path.join(root, '.harmony', 'locks');
    const names = (await fs.readdir(dir).catch(() => [])).filter(name => name.endsWith('.json'));
    const records: any[] = [];
    for (const name of names.slice(-100)) {
        try { records.push({ file: name, ...JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) }); }
        catch { records.push({ file: name, malformed: true }); }
    }
    return records;
}

async function appendSupervisorEvent(root: string, payload: Record<string, unknown>): Promise<string> {
    const dir = await supervisorDir(root);
    const file = path.join(dir, 'events.jsonl');
    await fs.appendFile(file, JSON.stringify(payload) + os.EOL, 'utf8');
    return normalizePath(path.relative(root, file));
}

async function writeSupervisorHeartbeat(root: string, input: SupervisorStateInput): Promise<string> {
    const dir = path.join(await supervisorDir(root), 'heartbeats');
    await fs.mkdir(dir, { recursive: true });
    const surface = input.surface ?? 'vscode';
    const heartbeat: SupervisorHeartbeat = {
        version: 1,
        surface,
        label: input.label?.trim() || 'Harmony VS Code extension',
        pid: process.pid,
        workspace: root,
        updatedAt: new Date().toISOString(),
        staleAfterMs: 2 * 60 * 1000,
    };
    const file = path.join(dir, `${surface}-${process.pid}.json`);
    const text = JSON.stringify(heartbeat, null, 2);
    await fs.writeFile(file, text, 'utf8');
    await fs.writeFile(path.join(await supervisorDir(root), 'latest-heartbeat.json'), text, 'utf8');
    await appendSupervisorEvent(root, { timestamp: heartbeat.updatedAt, kind: 'heartbeat', surface, pid: process.pid, label: heartbeat.label });
    return normalizePath(path.relative(root, file));
}

class SupervisorStateTool implements vscode.LanguageModelTool<SupervisorStateInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SupervisorStateInput>) {
        const action = options.input.action ?? 'status';
        const root = workspaceRoot();
        if (!root) return textResult('error: no workspace folder is open');
        let writtenPath: string | undefined;
        if (action === 'heartbeat' || action === 'event') {
            if (planOnlyMode()) return textResult(`error: plan-only mode is enabled; supervisor ${action} writes are not allowed.`);
            writtenPath = await withOperationLock(root, 'supervisor-state', `supervisor ${action}`, { surface: options.input.surface ?? 'vscode' }, async () => {
                if (action === 'heartbeat') return await writeSupervisorHeartbeat(root, options.input);
                return await appendSupervisorEvent(root, {
                    timestamp: new Date().toISOString(),
                    kind: options.input.event_kind?.trim() || 'manual-event',
                    surface: options.input.surface ?? 'vscode',
                    pid: process.pid,
                    label: options.input.label?.trim() || undefined,
                    notes: options.input.notes?.trim() || undefined,
                });
            }, 60_000);
        }
        const [heartbeats, locks, managedProcesses, ledger] = await Promise.all([
            readSupervisorHeartbeats(root),
            readOperationLockRecords(root),
            readManagedProcessRecords(root),
            readOperationLedger(),
        ]);
        const payload = {
            version: 1,
            generatedAt: new Date().toISOString(),
            workspace: root,
            currentSurface: { surface: 'vscode', pid: process.pid, extensionHost: true },
            writtenPath,
            heartbeats,
            activeLocks: locks,
            managedProcesses: managedProcesses.slice(0, 50),
            recentOperationEntries: ledger.entries.slice(-20).reverse(),
            coordinationFiles: {
                supervisor: '.harmony/supervisor',
                locks: '.harmony/locks',
                operations: '.harmony/operations/ledger.json',
                managedProcesses: '.harmony/processes/managed',
            },
            note: 'Wave 12 Phase 1 coordination core: VS Code, terminal CLI, and future floating UI can share heartbeats, events, locks, process records, and operation ledger state through these local files.',
        };
        if (options.input.format === 'json') return textResult(JSON.stringify(payload, null, 2));
        return textResult([
            '# Harmony Supervisor State',
            '',
            `Generated: ${payload.generatedAt}`,
            writtenPath ? `Written: ${writtenPath}` : 'Written: no',
            `Heartbeats: ${heartbeats.length}`,
            `Active/stale surfaces: ${heartbeats.filter(item => item.status === 'active').length}/${heartbeats.filter(item => item.status === 'stale').length}`,
            `Locks: ${locks.length}`,
            `Managed processes: ${managedProcesses.length}`,
            '',
            '## Surfaces',
            heartbeats.length ? heartbeats.map(item => `- ${item.surface} pid=${item.pid} ${item.status} ageMs=${item.ageMs} label=${item.label}`).join('\n') : '- No heartbeats found yet.',
            '',
            '## Locks',
            locks.length ? locks.map(item => `- ${item.resource ?? item.file}: ${item.operation ?? 'unknown'} expires=${item.expiresAt ?? '?'}`).join('\n') : '- No active lock files found.',
            '',
            payload.note,
        ].join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SupervisorStateInput>) {
        const action = options.input.action ?? 'status';
        if (action === 'status') return { invocationMessage: 'Reading supervisor state' };
        return {
            invocationMessage: `Writing supervisor ${action}`,
            confirmationMessages: {
                title: `Write supervisor ${action}?`,
                message: new vscode.MarkdownString('Harmony wants to write local coordination state under `.harmony/supervisor`.')
            }
        };
    }
}

export function registerOpsTools(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.lm.registerTool('harmony_tool_ledger', new ToolLedgerTool()),
        vscode.lm.registerTool('harmony_backup_advisor', new BackupAdvisorTool()),
        vscode.lm.registerTool('harmony_backup_manifest', new BackupManifestTool()),
        vscode.lm.registerTool('harmony_backup_snapshot', new BackupSnapshotTool()),
        vscode.lm.registerTool('harmony_storage_analyzer', new StorageAnalyzerTool()),
        vscode.lm.registerTool('harmony_system_snapshot', new SystemSnapshotTool()),
        vscode.lm.registerTool('harmony_network_snapshot', new NetworkSnapshotTool()),
        vscode.lm.registerTool('harmony_registry_snapshot', new RegistrySnapshotTool()),
        vscode.lm.registerTool('harmony_folder_date_sync', new FolderDateSyncTool()),
        vscode.lm.registerTool('harmony_process_registry', new ProcessRegistryTool()),
        vscode.lm.registerTool('harmony_operation_ledger', new OperationLedgerTool()),
        vscode.lm.registerTool('harmony_supervisor_state', new SupervisorStateTool()),
    );
}