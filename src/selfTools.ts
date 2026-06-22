import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as cp from 'child_process';
import { summarize as summarizeUsage, totalCalls, totalTokens } from './costTracker';

const MAX_RESULT_CHARS = 60000;

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

function planOnlyMode(): boolean {
    return vscode.workspace.getConfiguration('harmony').get<boolean>('planOnlyMode') ?? false;
}

async function pathExists(absPath: string): Promise<boolean> {
    return fs.access(absPath).then(() => true).catch(() => false);
}

async function readJsonFile(absPath: string): Promise<Record<string, unknown> | undefined> {
    try { return JSON.parse(await fs.readFile(absPath, 'utf8')) as Record<string, unknown>; }
    catch { return undefined; }
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function toolNamesFromPackage(packageJson: Record<string, unknown>): string[] {
    const contributes = asRecord(packageJson.contributes);
    const tools = contributes.languageModelTools;
    if (!Array.isArray(tools)) return [];
    return tools
        .map(tool => asRecord(tool).name)
        .filter((name): name is string => typeof name === 'string' && name.startsWith('harmony_'));
}

function companionExtensions(currentExtensionId: string): Array<{ id: string; displayName: string; version: string; active: boolean; role: string }> {
    return vscode.extensions.all
        .filter(ext => ext.id !== currentExtensionId)
        .filter(ext => {
            const text = `${ext.id}\n${ext.packageJSON?.name ?? ''}\n${ext.packageJSON?.displayName ?? ''}`.toLowerCase();
            return text.includes('harmony');
        })
        .map(ext => {
            const text = `${ext.id}\n${ext.packageJSON?.name ?? ''}\n${ext.packageJSON?.displayName ?? ''}`.toLowerCase();
            const hasLanguageModelTools = Array.isArray(ext.packageJSON?.contributes?.languageModelTools)
                && ext.packageJSON.contributes.languageModelTools.length > 0;
            return {
                id: ext.id,
                displayName: String(ext.packageJSON?.displayName ?? ext.packageJSON?.name ?? ext.id),
                version: String(ext.packageJSON?.version ?? 'unknown'),
                active: ext.isActive,
                role: hasLanguageModelTools
                    ? 'additional language model tools contributor; check for overlap before enabling parallel execution'
                    : 'optional companion; no dependency assumed',
            };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
}

function npmCommand(): string {
    return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function codeCommand(): Promise<string> {
    if (process.platform !== 'win32') return 'code';
    const local = process.env.LOCALAPPDATA;
    const candidate = local ? path.join(local, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd') : undefined;
    if (candidate && await pathExists(candidate)) return candidate;
    return 'code.cmd';
}

async function extensionSourcePath(context: vscode.ExtensionContext): Promise<string | undefined> {
    const cfg = vscode.workspace.getConfiguration('harmony');
    const configured = (cfg.get<string>('extensionSourcePath') ?? '').trim();
    const fromEnv = (process.env.HARMONY_EXTENSION_SOURCE ?? '').trim();
    const root = workspaceRoot();
    const candidates = [
        configured,
        fromEnv,
        root,
        root ? path.resolve(root, '..', 'HarmonyExtension') : undefined,
        context.extensionPath,
    ].filter(Boolean) as string[];
    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        const packagePath = path.join(resolved, 'package.json');
        const packageJson = await readJsonFile(packagePath);
        if (packageJson?.name === 'harmony-extension') return resolved;
    }
    return undefined;
}

async function sourcePackageJson(context: vscode.ExtensionContext): Promise<{ root?: string; packageJson: Record<string, unknown> }> {
    const sourceRoot = await extensionSourcePath(context);
    if (sourceRoot) {
        const packageJson = await readJsonFile(path.join(sourceRoot, 'package.json'));
        if (packageJson) return { root: sourceRoot, packageJson };
    }
    return { root: sourceRoot, packageJson: context.extension.packageJSON as Record<string, unknown> };
}

async function listSourceFiles(sourceRoot: string | undefined): Promise<string[]> {
    if (!sourceRoot) return [];
    const root = sourceRoot;
    const srcRoot = path.join(sourceRoot, 'src');
    if (!await pathExists(srcRoot)) return [];
    const files: string[] = [];
    async function walk(absDir: string): Promise<void> {
        const entries = await fs.readdir(absDir, { withFileTypes: true });
        for (const entry of entries) {
            const child = path.join(absDir, entry.name);
            if (entry.isDirectory()) {
                await walk(child);
            } else if (entry.isFile() && entry.name.endsWith('.ts')) {
                files.push(path.relative(root, child).replace(/\\/g, '/'));
            }
            if (files.length >= 200) return;
        }
    }
    await walk(srcRoot);
    return files.sort();
}

async function registeredToolNamesFromSource(sourceRoot: string | undefined): Promise<string[]> {
    if (!sourceRoot) return [];
    const srcRoot = path.join(sourceRoot, 'src');
    if (!await pathExists(srcRoot)) return [];
    const names = new Set<string>();
    async function walk(absDir: string): Promise<void> {
        const entries = await fs.readdir(absDir, { withFileTypes: true });
        for (const entry of entries) {
            const child = path.join(absDir, entry.name);
            if (entry.isDirectory()) {
                await walk(child);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
            const source = await fs.readFile(child, 'utf8');
            for (const match of source.matchAll(/vscode\.lm\.registerTool\('([^']+)'/g)) {
                if (match[1].startsWith('harmony_')) names.add(match[1]);
            }
        }
    }
    await walk(srcRoot);
    return Array.from(names).sort();
}

async function fetchHubJson(endpoint: string): Promise<{ ok: boolean; status?: number; body?: unknown; error?: string }> {
    const base = (vscode.workspace.getConfiguration('harmony').get<string>('hub.url') ?? 'http://127.0.0.1:7878').replace(/\/+$/, '');
    try {
        const response = await fetch(base + endpoint, { signal: AbortSignal.timeout(3500) });
        const text = await response.text();
        let body: unknown = text;
        try { body = JSON.parse(text); } catch { /* text body is okay */ }
        return { ok: response.ok, status: response.status, body };
    } catch (error: any) {
        return { ok: false, error: error?.message ?? String(error) };
    }
}

async function newestMtime(absPath: string): Promise<Date | undefined> {
    if (!await pathExists(absPath)) return undefined;
    let newest: Date | undefined;
    async function walk(current: string): Promise<void> {
        const stat = await fs.lstat(current);
        if (stat.isDirectory()) {
            const entries = await fs.readdir(current);
            for (const entry of entries) await walk(path.join(current, entry));
            return;
        }
        if (stat.isFile() && (!newest || stat.mtime > newest)) newest = stat.mtime;
    }
    await walk(absPath);
    return newest;
}

function extractArrayConstant(source: string, constantName: string): string[] {
    const expression = new RegExp(`const\\s+${constantName}\\s*=\\s*\\[([\\s\\S]*?)\\];`);
    const match = expression.exec(source);
    if (!match) return [];
    return Array.from(match[1].matchAll(/'([^']+)'/g)).map(found => found[1]);
}

interface ProcessRun {
    ok: boolean;
    stdout: string;
    stderr: string;
    code?: number | string | null;
    error?: string;
}

async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, token: vscode.CancellationToken): Promise<ProcessRun> {
    return await new Promise<ProcessRun>((resolve) => {
        // Use cp.exec (shell: true) instead of execFile — execFile fails with EINVAL on Windows
        // in Electron apps because it doesn't resolve .cmd files through the shell.
        const cmdline = [command, ...args].map(a => /[ \t]/.test(a) ? `"${a}"` : a).join(' ');
        const proc = cp.exec(cmdline, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 30 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                resolve({ ok: false, stdout: stdout ?? '', stderr: stderr ?? '', code: (error as cp.ExecException).code, error: error.message });
                return;
            }
            resolve({ ok: true, stdout: stdout ?? '', stderr: stderr ?? '', code: 0 });
        });
        const sub = token.onCancellationRequested(() => proc.kill());
        proc.on('exit', () => sub.dispose());
        proc.on('error', error => {
            sub.dispose();
            resolve({ ok: false, stdout: '', stderr: '', error: error.message });
        });
    });
}

function formatRun(title: string, run: ProcessRun): string {
    return [
        `## ${title}`,
        '',
        `ok: ${run.ok ? 'yes' : 'no'}`,
        `exit code: ${run.code ?? '(none)'}`,
        run.error ? `error: ${run.error}` : '',
        run.stdout ? `\nstdout:\n\`\`\`\n${run.stdout.trim()}\n\`\`\`` : '',
        run.stderr ? `\nstderr:\n\`\`\`\n${run.stderr.trim()}\n\`\`\`` : '',
    ].filter(Boolean).join('\n');
}

class SelfInspectTool implements vscode.LanguageModelTool<Record<string, never>> {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async invoke() {
        const source = await sourcePackageJson(this.context);
        const sourceFiles = await listSourceFiles(source.root);
        const centralHealth = await fetchHubJson('/ext/v1/health');
        const centralManifest = await fetchHubJson('/ext/v1/tools/manifest?include_universal=0');
        const manifestTools = toolNamesFromPackage(source.packageJson);
        const activeTools = vscode.lm.tools.map(tool => tool.name).filter(name => name.startsWith('harmony_')).sort();
        const cfg = vscode.workspace.getConfiguration('harmony');
        const payload = {
            generatedAt: new Date().toISOString(),
            installedExtension: {
                id: this.context.extension.id,
                version: this.context.extension.packageJSON.version ?? 'unknown',
                extensionPath: this.context.extensionPath,
            },
            source: {
                path: source.root ?? '(source path not found)',
                version: source.packageJson.version ?? 'unknown',
                manifestToolCount: manifestTools.length,
                sourceFileCount: sourceFiles.length,
                sourceFiles,
            },
            liveRegisteredTools: {
                count: activeTools.length,
                names: activeTools,
            },
            companionExtensions: {
                standaloneToolsetRequired: false,
                note: 'Harmony Chat contributes its own language model tools. A separate Harmony Tools extension is optional and not required for the v0.2.50 toolset.',
                installed: companionExtensions(this.context.extension.id),
            },
            creativeBridge: {
                note: 'Harmony Creative tools are exposed by Harmony Chat as bridge tools to the configured local Harmony Creative service. They are not a separate VS Code extension dependency.',
                healthTool: 'harmony_creative_health',
                serviceUrl: cfg.get<string>('creativeServiceUrl') ?? 'http://127.0.0.1:8896',
                servicePath: (cfg.get<string>('creativeServicePath') ?? '').trim() || '(auto: workspace, HARMONY_CREATIVE_SERVICE_PATH, Central fallback)',
            },
            central: {
                health: centralHealth,
                manifest: centralManifest.ok ? centralManifest.body : centralManifest,
            },
            usage: {
                calls: totalCalls(),
                tokens: totalTokens(),
                byRoute: summarizeUsage(),
            },
        };
        return textResult(JSON.stringify(payload, null, 2));
    }

    async prepareInvocation() { return { invocationMessage: 'Inspecting HarmonyExtension and Central tool registry' }; }
}

class SelfDiagnoseTool implements vscode.LanguageModelTool<Record<string, never>> {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async invoke() {
        const source = await sourcePackageJson(this.context);
        const diagnostics: Array<{ level: 'ok' | 'warn' | 'error'; message: string; details?: unknown }> = [];
        const manifestNames = toolNamesFromPackage(source.packageJson).sort();
        const registeredNames = await registeredToolNamesFromSource(source.root);
        let constantNames: string[] = [];
        if (source.root) {
            const chatPath = path.join(source.root, 'src', 'chatParticipant.ts');
            if (await pathExists(chatPath)) {
                constantNames = extractArrayConstant(await fs.readFile(chatPath, 'utf8'), 'HARMONY_TOOL_NAMES').sort();
            } else {
                diagnostics.push({ level: 'error', message: 'src/chatParticipant.ts was not found in the configured extension source path.' });
            }
        } else {
            diagnostics.push({ level: 'error', message: 'HarmonyExtension source path could not be resolved. Set harmony.extensionSourcePath.' });
        }

        const manifestSet = new Set(manifestNames);
        const registeredSet = new Set(registeredNames);
        const registeredNotManifest = registeredNames.filter(name => !manifestSet.has(name));
        const manifestNotRegistered = manifestNames.filter(name => !registeredSet.has(name));
        const activeNotRegistered = constantNames.filter(name => !registeredSet.has(name));
        const activeNotManifest = constantNames.filter(name => !manifestSet.has(name));
        if (registeredNotManifest.length || manifestNotRegistered.length || activeNotRegistered.length || activeNotManifest.length) {
            diagnostics.push({
                level: 'error',
                message: 'Tool registration mismatch detected.',
                details: { registeredNotManifest, manifestNotRegistered, activeNotRegistered, activeNotManifest }
            });
        } else if (manifestNames.length > 0) {
            diagnostics.push({ level: 'ok', message: `Manifest (${manifestNames.length}), registered tools (${registeredNames.length}), and active participant tools (${constantNames.length}) are compatible.` });
        }

        const installedVersion = String(this.context.extension.packageJSON.version ?? 'unknown');
        const sourceVersion = String(source.packageJson.version ?? 'unknown');
        if (installedVersion !== sourceVersion) {
            diagnostics.push({ level: 'warn', message: 'Installed extension version differs from source package.json.', details: { installedVersion, sourceVersion } });
        } else {
            diagnostics.push({ level: 'ok', message: `Installed and source versions match (${installedVersion}).` });
        }

        const health = await fetchHubJson('/ext/v1/health');
        if (health.ok) diagnostics.push({ level: 'ok', message: 'Central extension API is reachable.', details: health.body });
        else diagnostics.push({ level: 'warn', message: 'Central extension API is not reachable at harmony.hub.url/ext/v1/health.', details: health });

        if (source.root) {
            const newestSource = await newestMtime(path.join(source.root, 'src'));
            const outPath = path.join(source.root, 'out', 'extension.js');
            const outStat = await fs.stat(outPath).catch(() => undefined);
            if (!outStat) {
                diagnostics.push({ level: 'warn', message: 'Compiled out/extension.js was not found. Run npm run compile.' });
            } else if (newestSource && newestSource > outStat.mtime) {
                diagnostics.push({ level: 'warn', message: 'Source files are newer than out/extension.js. Run npm run compile.', details: { newestSource: newestSource.toISOString(), compiled: outStat.mtime.toISOString() } });
            } else {
                diagnostics.push({ level: 'ok', message: 'Compiled output is newer than source files.' });
            }
        }

        return textResult(JSON.stringify({
            generatedAt: new Date().toISOString(),
            sourcePath: source.root ?? null,
            manifestToolCount: manifestNames.length,
            registeredToolCount: registeredNames.length,
            harmonyToolNamesCount: constantNames.length,
            diagnostics,
        }, null, 2));
    }

    async prepareInvocation() { return { invocationMessage: 'Diagnosing HarmonyExtension registration health' }; }
}

interface SelfProposeToolInput {
    name: string;
    description: string;
    category?: string;
    parameters?: Record<string, unknown>;
    read_only?: boolean;
    requires_confirmation?: boolean;
}

function pascalCaseToolClass(toolName: string): string {
    return toolName
        .replace(/^harmony_/, '')
        .split(/[_\-\s]+/)
        .filter(Boolean)
        .map(part => part.slice(0, 1).toUpperCase() + part.slice(1))
        .join('') + 'Tool';
}

class SelfProposeTool implements vscode.LanguageModelTool<SelfProposeToolInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SelfProposeToolInput>) {
        const rawName = (options.input.name ?? '').trim();
        if (!rawName) return textResult('error: missing argument: name');
        const toolName = rawName.startsWith('harmony_') ? rawName : `harmony_${rawName.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase()}`;
        const description = (options.input.description ?? '').trim() || 'Describe what this tool does.';
        const parameters = options.input.parameters ?? {};
        const inputInterface = pascalCaseToolClass(toolName).replace(/Tool$/, 'Input');
        const className = pascalCaseToolClass(toolName);
        const category = (options.input.category ?? 'self').trim() || 'self';
        const schema = {
            type: 'object',
            properties: parameters,
        };
        const tags = ['harmony', category, ...(options.input.read_only === false ? ['destructive'] : [])];
        const confirmationBlock = options.input.requires_confirmation
            ? `\n    async prepareInvocation() {\n        return {\n            invocationMessage: 'Running ${toolName}',\n            confirmationMessages: {\n                title: 'Run ${toolName}?',\n                message: new vscode.MarkdownString('${description.replace(/'/g, "\\'")}')\n            }\n        };\n    }`
            : `\n    async prepareInvocation() { return { invocationMessage: 'Running ${toolName}' }; }`;
        const toolClass = `interface ${inputInterface} {\n    // Add typed fields here.\n}\n\nclass ${className} implements vscode.LanguageModelTool<${inputInterface}> {\n    async invoke(options: vscode.LanguageModelToolInvocationOptions<${inputInterface}>) {\n        const input = options.input;\n        return textResult(JSON.stringify({ ok: true, input }, null, 2));\n    }${confirmationBlock}\n}`;
        const manifestEntry = {
            name: toolName,
            displayName: toolName.replace(/^harmony_/, '').replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()),
            modelDescription: description,
            canBeReferencedInPrompt: true,
            toolReferenceName: toolName.replace(/^harmony_/, 'harmony').replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
            tags,
            inputSchema: schema,
        };
        return textResult([
            '# Proposed Harmony Tool',
            '',
            `Tool name: ${toolName}`,
            '',
            '## TypeScript class skeleton',
            '',
            '```ts',
            toolClass,
            '```',
            '',
            '## package.json languageModelTools entry',
            '',
            '```json',
            JSON.stringify(manifestEntry, null, 2),
            '```',
            '',
            `## Registration line`,
            '',
            '```ts',
            `vscode.lm.registerTool('${toolName}', new ${className}()),`,
            '```',
        ].join('\n'));
    }

    async prepareInvocation() { return { invocationMessage: 'Drafting a Harmony tool scaffold' }; }
}

interface SelfPatchToolInput {
    tool_name: string;
    description_of_change: string;
    proposed_patch: string;
}

class SelfPatchTool implements vscode.LanguageModelTool<SelfPatchToolInput> {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async invoke(options: vscode.LanguageModelToolInvocationOptions<SelfPatchToolInput>) {
        const toolName = (options.input.tool_name ?? '').trim();
        const description = (options.input.description_of_change ?? '').trim();
        const patchText = (options.input.proposed_patch ?? '').trim();
        if (!toolName || !description || !patchText) return textResult('error: tool_name, description_of_change, and proposed_patch are required');
        const root = await extensionSourcePath(this.context) ?? workspaceRoot();
        if (!root) return textResult('error: no extension source path or workspace root is available');
        const dir = path.join(root, '.harmony-staging');
        await fs.mkdir(dir, { recursive: true });
        const fileName = `self-patch-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
        const output = path.join(dir, fileName);
        const body = [
            '# Harmony Self Patch Proposal',
            '',
            `Generated: ${new Date().toISOString()}`,
            `Tool: ${toolName}`,
            '',
            '## Requested Change',
            '',
            description,
            '',
            '## Proposed Patch',
            '',
            '```diff',
            patchText,
            '```',
            '',
            'This is a staged proposal only. It does not modify source files.',
        ].join('\n');
        await fs.writeFile(output, body, 'utf8');
        return textResult(`Self patch proposal written: ${output}`);
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SelfPatchToolInput>) {
        return {
            invocationMessage: `Staging patch proposal for ${options.input.tool_name || 'Harmony tool'}`,
            confirmationMessages: {
                title: 'Stage self-patch proposal?',
                message: new vscode.MarkdownString('Harmony wants to write a patch proposal file under `.harmony-staging`. Source files are not changed.')
            }
        };
    }
}

class CompileCheckTool implements vscode.LanguageModelTool<Record<string, never>> {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async invoke(_options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>, token: vscode.CancellationToken) {
        const root = await extensionSourcePath(this.context);
        if (!root) return textResult('error: harmony.extensionSourcePath is not configured and HarmonyExtension source could not be found.');
        const run = await runProcess(npmCommand(), ['run', 'compile'], root, 180000, token);
        return textResult(formatRun('npm run compile', run));
    }

    async prepareInvocation() { return { invocationMessage: 'Compiling HarmonyExtension' }; }
}

class PackageAndInstallTool implements vscode.LanguageModelTool<Record<string, never>> {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async invoke(_options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>, token: vscode.CancellationToken) {
        const root = await extensionSourcePath(this.context);
        if (!root) return textResult('error: harmony.extensionSourcePath is not configured and HarmonyExtension source could not be found.');
        const packageRun = await runProcess(npmCommand(), ['run', 'package'], root, 300000, token);
        const lines = [formatRun('npm run package', packageRun)];
        if (!packageRun.ok) return textResult(lines.join('\n\n'));
        const vsix = path.join(root, 'harmony-extension.vsix');
        if (!await pathExists(vsix)) return textResult(lines.concat(`error: package completed but VSIX was not found at ${vsix}`).join('\n\n'));
        const installRun = await runProcess(await codeCommand(), ['--install-extension', vsix, '--force'], root, 180000, token);
        lines.push(formatRun('code --install-extension', installRun));
        if (installRun.ok) lines.push('', 'Install complete. Run Developer: Reload Window in VS Code to activate the new extension code.');
        return textResult(lines.join('\n\n'));
    }

    async prepareInvocation() {
        return {
            invocationMessage: 'Packaging and installing HarmonyExtension',
            confirmationMessages: {
                title: 'Package and reinstall HarmonyExtension?',
                message: new vscode.MarkdownString('Harmony wants to run `npm run package` and `code --install-extension harmony-extension.vsix --force`. Reload VS Code afterward to activate the new build.')
            }
        };
    }
}

class SelfRepairSummaryTool implements vscode.LanguageModelTool<Record<string, never>> {
    async invoke() {
        const cfg = vscode.workspace.getConfiguration('harmony');
        const configuredHub = (cfg.get<string>('centralHubPath') ?? '').trim();
        const envHub = (process.env.HARMONY_CENTRAL_HUB ?? process.env.EHAI_CENTRAL_PATH ?? '').trim();
        const hubPath = configuredHub || envHub;
        if (!hubPath) return textResult('error: harmony.centralHubPath is not configured.');
        const checkpointsDir = path.join(path.resolve(hubPath), 'data', 'checkpoints');
        if (!await pathExists(checkpointsDir)) return textResult(`error: checkpoint directory not found: ${checkpointsDir}`);
        const entries = await fs.readdir(checkpointsDir, { withFileTypes: true });
        const files = entries
            .filter(entry => entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.log')))
            .map(entry => path.join(checkpointsDir, entry.name));
        const records: unknown[] = [];
        for (const file of files.slice(-25)) {
            const text = await fs.readFile(file, 'utf8').catch(() => '');
            for (const line of text.split(/\r?\n/).filter(Boolean).slice(-100)) {
                try { records.push({ file: path.basename(file), ...JSON.parse(line) }); }
                catch { records.push({ file: path.basename(file), raw: line }); }
            }
        }
        const recent = records.slice(-10);
        const conflicts = records.filter(record => JSON.stringify(record).toLowerCase().includes('conflict')).slice(-10);
        return textResult(JSON.stringify({
            generatedAt: new Date().toISOString(),
            checkpointsDir,
            filesScanned: files.length,
            recent,
            conflicts,
        }, null, 2));
    }

    async prepareInvocation() { return { invocationMessage: 'Reading self-repair checkpoint summary' }; }
}

interface CapabilityAuditInput {
    write_report?: boolean;
    format?: 'markdown' | 'json';
}

interface CapabilityRow {
    category: string;
    harmony: string;
    copilot: string;
    premiumIdeAgents: string;
    cliAgents: string;
    evidence: string[];
    gap: string;
}

function hasAny(tools: Set<string>, names: string[]): boolean {
    return names.some(name => tools.has(name));
}

function buildCapabilityRows(toolSet: Set<string>): CapabilityRow[] {
    return [
        {
            category: 'File editing',
            harmony: hasAny(toolSet, ['harmony_write_file', 'harmony_edit_file', 'harmony_apply_patch']) ? 'strong' : 'limited',
            copilot: 'strong in VS Code host',
            premiumIdeAgents: 'strong with diff/review surfaces',
            cliAgents: 'strong when filesystem permissions are granted',
            evidence: ['harmony_write_file', 'harmony_edit_file', 'harmony_apply_patch'].filter(name => toolSet.has(name)),
            gap: 'Add checkpoint/rollback UI before broad autonomous writes.'
        },
        {
            category: 'Symbol/refactor support',
            harmony: 'limited',
            copilot: 'strong via VS Code language servers',
            premiumIdeAgents: 'varies; often strong',
            cliAgents: 'usually text-based unless LSP integrated',
            evidence: [],
            gap: 'Expose precise symbol search/rename/refactor surfaces or delegate to VS Code APIs.'
        },
        {
            category: 'Tests and diagnostics',
            harmony: hasAny(toolSet, ['harmony_compile_check', 'harmony_test_probe', 'harmony_run_fail_fix']) ? 'strong and improving' : 'limited',
            copilot: 'strong host diagnostics and terminal integration',
            premiumIdeAgents: 'strong run/fix loops',
            cliAgents: 'strong command loops when configured',
            evidence: ['harmony_compile_check', 'harmony_test_probe', 'harmony_run_fail_fix', 'harmony_repo_health_scan'].filter(name => toolSet.has(name)),
            gap: 'Auto-select focused tests from touched files and record every validation in operation ledger.'
        },
        {
            category: 'Browser and website inspection',
            harmony: hasAny(toolSet, ['harmony_page_inspect', 'harmony_responsive_screenshots', 'harmony_visual_regression', 'harmony_css_trace']) ? 'strong' : 'limited',
            copilot: 'host-dependent',
            premiumIdeAgents: 'often strong with browser/computer use',
            cliAgents: 'possible with Playwright setup',
            evidence: ['harmony_page_inspect', 'harmony_responsive_screenshots', 'harmony_design_audit', 'harmony_visual_regression', 'harmony_css_trace', 'harmony_lighthouse'].filter(name => toolSet.has(name)),
            gap: 'Add richer interaction recording and before/after visual workflows in UI.'
        },
        {
            category: 'Current research',
            harmony: hasAny(toolSet, ['harmony_current_research', 'harmony_research_dossier', 'harmony_claim_check']) ? 'strong when sources are provided' : 'limited',
            copilot: 'host/tool dependent',
            premiumIdeAgents: 'often includes web search',
            cliAgents: 'varies by installed tools',
            evidence: ['harmony_current_research', 'harmony_research_dossier', 'harmony_source_ledger', 'harmony_claim_check', 'harmony_literature_scan'].filter(name => toolSet.has(name)),
            gap: 'Add optional search-provider discovery; keep source URLs explicit for factual claims.'
        },
        {
            category: 'Provider routing and cost controls',
            harmony: hasAny(toolSet, ['harmony_provider_status', 'harmony_pricing_refresh', 'harmony_cost_estimator']) ? 'strong and explicit' : 'limited',
            copilot: 'managed by host plan',
            premiumIdeAgents: 'varies; often hidden cost model',
            cliAgents: 'varies; sometimes explicit provider configs',
            evidence: ['harmony_provider_status', 'harmony_pricing_refresh', 'harmony_cost_estimator', 'harmony_consult_model', 'harmony_spawn_worker'].filter(name => toolSet.has(name)),
            gap: 'Show stale pricing and provider readiness directly in /status and sidebars.'
        },
        {
            category: 'Git and release flow',
            harmony: hasAny(toolSet, ['harmony_git_push', 'harmony_git_pull', 'harmony_git_revert']) ? 'strong with confirmation gates' : 'partial',
            copilot: 'strong through VS Code/source control',
            premiumIdeAgents: 'often strong',
            cliAgents: 'strong if git CLI available',
            evidence: ['harmony_git_status', 'harmony_git_diff', 'harmony_git_log', 'harmony_git_show', 'harmony_git_branch', 'harmony_git_stash', 'harmony_git_commit', 'harmony_git_blame', 'harmony_git_restore', 'harmony_git_revert', 'harmony_git_tag', 'harmony_git_remote', 'harmony_git_push', 'harmony_git_pull'].filter(name => toolSet.has(name)),
            gap: 'Add conflict-resolution helpers and release checklist receipts.'
        },
        {
            category: 'Multi-agent / Kin Council orchestration',
            harmony: hasAny(toolSet, ['harmony_swarm_plan', 'harmony_swarm_dispatch', 'harmony_swarm_escrow']) ? 'safe read-only first pass' : 'dormant',
            copilot: 'not directly exposed as user-controlled sub-agents',
            premiumIdeAgents: 'varies; some support subagents',
            cliAgents: 'varies; some support workers',
            evidence: ['harmony_swarm_plan', 'harmony_swarm_preflight', 'harmony_swarm_dispatch', 'harmony_swarm_escrow', 'harmony_spawn_worker'].filter(name => toolSet.has(name)),
            gap: 'Next step is one-write-at-a-time executor under operation locks.'
        },
        {
            category: 'Process supervision and operations ledger',
            harmony: hasAny(toolSet, ['harmony_process_registry', 'harmony_operation_ledger', 'harmony_port_status']) ? 'foundation present' : 'limited',
            copilot: 'host terminal visibility but not full local supervisor',
            premiumIdeAgents: 'varies',
            cliAgents: 'often strong for process control',
            evidence: ['harmony_port_status', 'harmony_process_registry', 'harmony_operation_ledger', 'harmony_run_terminal'].filter(name => toolSet.has(name)),
            gap: 'Promote observations into automatic operation receipts for every long-running task.'
        },
        {
            category: 'Canvas and pixel tooling',
            harmony: hasAny(toolSet, ['harmony_canvas_inspect', 'harmony_image_diff', 'harmony_mask_preview']) ? 'foundation present' : 'limited',
            copilot: 'host-dependent',
            premiumIdeAgents: 'varies; often visual review but not pixel editing',
            cliAgents: 'possible with image libraries',
            evidence: ['harmony_canvas_inspect', 'harmony_image_diff', 'harmony_mask_preview', 'harmony_vision_read', 'harmony_crop_image', 'harmony_resize_image'].filter(name => toolSet.has(name)),
            gap: 'Add reversible crop/paint/mask layers with undo and visual validation loop.'
        },
        {
            category: 'Privacy boundaries',
            harmony: 'strong local conventions',
            copilot: 'managed by host policy/settings',
            premiumIdeAgents: 'varies',
            cliAgents: 'depends on excludes and operator discipline',
            evidence: ['.vscodeignore excludes private internal paths', 'plan-only mode suppresses writes', '.harmony stores local private receipts'],
            gap: 'Add automated packaged-artifact privacy scan as a first-class Harmony tool.'
        },
    ];
}

function formatCapabilityAudit(rows: CapabilityRow[], version: string, toolCount: number): string {
    const table = rows.map(row => `| ${row.category} | ${row.harmony} | ${row.copilot} | ${row.premiumIdeAgents} | ${row.cliAgents} | ${row.gap} |`);
    const evidence = rows.map(row => `### ${row.category}\n\n${row.evidence.length ? row.evidence.map(item => `- ${item}`).join('\n') : '- No direct Harmony evidence signal found.'}`).join('\n\n');
    return [
        '# Harmony Capability Audit',
        '',
        `Generated: ${new Date().toISOString()}`,
        `Harmony version: ${version}`,
        `Harmony tools counted: ${toolCount}`,
        '',
        '| Category | Harmony | VS Code Copilot | Premium IDE Agents | CLI Agents | Gap / Next Work |',
        '|---|---|---|---|---|---|',
        ...table,
        '',
        '## Evidence Signals',
        '',
        evidence,
        '',
        '## Recommended Next Build Order',
        '',
        '1. Add provider readiness and stale-pricing status to /status.',
        '2. Add one-write-at-a-time swarm executor under operation locks.',
        '3. Add automatic operation ledger receipts for long-running commands and package/smoke tests.',
        '4. Add symbol/refactor tool surfaces through VS Code APIs.',
        '5. Add automated VSIX privacy scan as a packaged release gate.',
    ].join('\n');
}

async function writeCapabilityReport(markdown: string): Promise<string | undefined> {
    const root = workspaceRoot();
    if (!root) return undefined;
    const dir = path.join(root, '.harmony');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `capability-audit-${timestampSlug()}.md`);
    await fs.writeFile(file, markdown, 'utf8');
    return path.relative(root, file).replace(/\\/g, '/');
}

class CapabilityAuditTool implements vscode.LanguageModelTool<CapabilityAuditInput> {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async invoke(options: vscode.LanguageModelToolInvocationOptions<CapabilityAuditInput>) {
        const source = await sourcePackageJson(this.context);
        const toolNames = toolNamesFromPackage(source.packageJson);
        const rows = buildCapabilityRows(new Set(toolNames));
        const version = String(source.packageJson.version ?? this.context.extension.packageJSON.version ?? 'unknown');
        const markdown = formatCapabilityAudit(rows, version, toolNames.length);
        let writtenPath: string | undefined;
        let skippedWrite: string | undefined;
        if (options.input.write_report !== false && !planOnlyMode()) {
            writtenPath = await writeCapabilityReport(markdown);
            skippedWrite = writtenPath ? undefined : 'Report was not written because no workspace root is open.';
        } else {
            skippedWrite = planOnlyMode() && options.input.write_report !== false
                ? 'Plan-only mode is enabled; capability report write was skipped.'
                : 'Report write disabled by input.';
        }
        if (options.input.format === 'json') return textResult(JSON.stringify({ version, toolCount: toolNames.length, rows, writtenPath, skippedWrite }, null, 2));
        return textResult([markdown, '', writtenPath ? `Report written: ${writtenPath}` : skippedWrite].filter(Boolean).join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<CapabilityAuditInput>) {
        const base = { invocationMessage: 'Auditing Harmony capability parity' };
        if (options.input.write_report === false) return base;
        return {
            ...base,
            confirmationMessages: {
                title: 'Write capability audit report?',
                message: new vscode.MarkdownString('Harmony wants to write a private capability audit report under `.harmony`.')
            }
        };
    }
}

export function registerSelfTools(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.lm.registerTool('harmony_self_inspect', new SelfInspectTool(context)),
        vscode.lm.registerTool('harmony_self_diagnose', new SelfDiagnoseTool(context)),
        vscode.lm.registerTool('harmony_self_propose_tool', new SelfProposeTool()),
        vscode.lm.registerTool('harmony_self_patch_tool', new SelfPatchTool(context)),
        vscode.lm.registerTool('harmony_compile_check', new CompileCheckTool(context)),
        vscode.lm.registerTool('harmony_package_and_install', new PackageAndInstallTool(context)),
        vscode.lm.registerTool('harmony_self_repair_summary', new SelfRepairSummaryTool()),
        vscode.lm.registerTool('harmony_capability_audit', new CapabilityAuditTool(context)),
    );
}