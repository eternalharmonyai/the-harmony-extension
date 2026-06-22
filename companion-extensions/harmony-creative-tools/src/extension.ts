import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';

type JsonRecord = Record<string, unknown>;
type CreativeSettingKey = 'imageQuality' | 'layerBackend' | 'videoModel';

interface CreativeTreeNode {
    id: string;
    label: string;
    description?: string;
    contextValue: string;
    icon: string;
    command?: vscode.Command;
}

interface CandidateDir {
    source: string;
    dir: string;
}

interface ServiceDir {
    source: string;
    dir: string;
    script: string;
}

interface HttpJsonResult {
    ok: boolean;
    status?: number;
    body?: JsonRecord;
    error?: string;
}

interface SettingPick extends vscode.QuickPickItem {
    key: CreativeSettingKey;
}

interface ValuePick extends vscode.QuickPickItem {
    value: string;
}

const output = vscode.window.createOutputChannel('Harmony Creative Tools');
const EXTENSION_ID = 'eternal-harmony.harmony-creative-tools';
const MCP_LABEL = 'Harmony Creative';
const COMPANION_VERSION = '0.1.6';

const DEFAULT_CENTRAL_HUB_CANDIDATES = [
    path.join(os.homedir(), 'Documents', 'HarmonyCentral'),
];

const IMAGE_QUALITIES: ValuePick[] = [
    { label: 'draft', value: 'draft', description: 'Fastest, lowest cost.' },
    { label: 'standard', value: 'standard', description: 'Balanced default.' },
    { label: 'standard+', value: 'standard+', description: 'Better detail without premium routing.' },
    { label: 'pro', value: 'pro', description: 'Higher quality cloud generation.' },
    { label: 'premium', value: 'premium', description: 'Highest quality routing; confirm cost before heavy use.' },
];

const LAYER_BACKENDS: ValuePick[] = [
    { label: 'fast', value: 'fast', description: 'Faster layer-set generation.' },
    { label: 'pro', value: 'pro', description: 'Balanced layer-set default.' },
    { label: 'bfl:flux-kontext-pro', value: 'bfl:flux-kontext-pro', description: 'BFL Flux Kontext Pro backend.' },
];

const VIDEO_MODELS: ValuePick[] = [
    { label: 'kling-pro', value: 'kling-pro', description: 'Motion video default.' },
    { label: 'omnihuman', value: 'omnihuman', description: 'Talking-head video when supported.' },
];

let statusBar: vscode.StatusBarItem | undefined;
let mcpDidChange: vscode.EventEmitter<void> | undefined;
let treeProvider: CreativeTreeProvider | undefined;
let healthPollTimer: NodeJS.Timeout | undefined;

// Cached state refreshed by background poll (so the tree can render synchronously).
let lastHealth: { ok: boolean; checkedAt: number; error?: string } = { ok: false, checkedAt: 0 };
let lastProviderKeys: { source: 'health' | 'env' | 'none'; providers: Array<{ id: string; wired: boolean }>; checkedAt: number } = { source: 'none', providers: [], checkedAt: 0 };

export function activate(context: vscode.ExtensionContext): void {
    const mcpEmitter = new vscode.EventEmitter<void>();
    mcpDidChange = mcpEmitter;
    treeProvider = new CreativeTreeProvider();

    statusBar = vscode.window.createStatusBarItem('harmonyCreative.defaults', vscode.StatusBarAlignment.Right, 95);
    statusBar.command = 'harmonyCreative.statusBarClick';

    context.subscriptions.push(
        output,
        mcpEmitter,
        statusBar,
        vscode.window.registerTreeDataProvider('harmonyCreative.panel', treeProvider),
        registerMcpProvider(mcpEmitter),
        vscode.commands.registerCommand('harmonyCreative.startMcpServer', startMcpServerCommand),
        vscode.commands.registerCommand('harmonyCreative.health', showHealth),
        vscode.commands.registerCommand('harmonyCreative.start', startCommand),
        vscode.commands.registerCommand('harmonyCreative.selectDefaults', selectDefaults),
        vscode.commands.registerCommand('harmonyCreative.statusBarClick', statusBarClick),
        vscode.commands.registerCommand('harmonyCreative.revealPanel', revealPanel),
        vscode.commands.registerCommand('harmonyCreative.selectImageQuality', () => selectSetting('imageQuality')),
        vscode.commands.registerCommand('harmonyCreative.selectLayerBackend', () => selectSetting('layerBackend')),
        vscode.commands.registerCommand('harmonyCreative.selectVideoModel', () => selectSetting('videoModel')),
        vscode.commands.registerCommand('harmonyCreative.openServiceFolder', openServiceFolder),
        vscode.commands.registerCommand('harmonyCreative.openGeneratedMedia', openGeneratedMedia),
        vscode.commands.registerCommand('harmonyCreative.openHealthEndpoint', openHealthEndpoint),
        vscode.commands.registerCommand('harmonyCreative.showStatus', showStatus),
        vscode.commands.registerCommand('harmonyCreative.showProviderKeys', showProviderKeys),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('harmonyCreative')) {
                updateStatusBar();
                treeProvider?.refresh();
                mcpDidChange?.fire();
                void updateAvailabilityContext();
            }
        }),
    );

    updateStatusBar();
    treeProvider.refresh();
    void updateAvailabilityContext();
    void pollHealthAndKeys();
    healthPollTimer = setInterval(() => { void pollHealthAndKeys(); }, 15000);
    context.subscriptions.push({ dispose: () => { if (healthPollTimer) clearInterval(healthPollTimer); } });
}

export function deactivate(): void {}

function cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('harmonyCreative');
}

function configured(name: string): string {
    return (cfg().get<string>(name) ?? '').trim();
}

function configuredBool(name: string, fallback: boolean): boolean {
    return cfg().get<boolean>(name) ?? fallback;
}

function currentDefaults(): Record<CreativeSettingKey, string> {
    return {
        imageQuality: configured('imageQuality') || 'standard',
        layerBackend: configured('layerBackend') || 'pro',
        videoModel: configured('videoModel') || 'kling-pro',
    };
}

class CreativeTreeProvider implements vscode.TreeDataProvider<CreativeTreeNode> {
    private readonly didChangeTreeData = new vscode.EventEmitter<CreativeTreeNode | undefined>();
    readonly onDidChangeTreeData = this.didChangeTreeData.event;

    refresh(): void {
        this.didChangeTreeData.fire(undefined);
    }

    getTreeItem(element: CreativeTreeNode): vscode.TreeItem {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.id = element.id;
        item.description = element.description;
        item.contextValue = element.contextValue;
        item.iconPath = new vscode.ThemeIcon(element.icon);
        item.command = element.command;
        return item;
    }

    getChildren(): CreativeTreeNode[] {
        const defaults = currentDefaults();
        const nodes: CreativeTreeNode[] = [
            {
                id: 'mcp',
                label: 'MCP Server',
                description: MCP_LABEL,
                contextValue: 'harmonyCreative.mcp',
                icon: 'server-process',
                command: { title: 'Start MCP Server', command: 'harmonyCreative.startMcpServer' },
            },
            {
                id: 'service',
                label: 'Creative Service',
                description: lastHealth.checkedAt === 0
                    ? 'Checking…'
                    : (lastHealth.ok ? `Running ✓  (${serviceUrl()})` : `Stopped ✗  (${lastHealth.error ?? 'no response'})`),
                contextValue: 'harmonyCreative.service',
                icon: lastHealth.ok ? 'pass-filled' : 'circle-slash',
                command: { title: lastHealth.ok ? 'Show Health' : 'Start Creative Service', command: lastHealth.ok ? 'harmonyCreative.health' : 'harmonyCreative.start' },
            },
            {
                id: 'default-image',
                label: 'Image Quality',
                description: defaults.imageQuality,
                contextValue: 'harmonyCreative.default.image',
                icon: 'symbol-color',
                command: { title: 'Change Image Quality', command: 'harmonyCreative.selectImageQuality' },
            },
            {
                id: 'default-layer',
                label: 'Layer Backend',
                description: defaults.layerBackend,
                contextValue: 'harmonyCreative.default.layer',
                icon: 'layers',
                command: { title: 'Change Layer Backend', command: 'harmonyCreative.selectLayerBackend' },
            },
            {
                id: 'default-video',
                label: 'Video Model',
                description: defaults.videoModel,
                contextValue: 'harmonyCreative.default.video',
                icon: 'device-camera-video',
                command: { title: 'Change Video Model', command: 'harmonyCreative.selectVideoModel' },
            },
            {
                id: 'rest',
                label: 'REST Endpoint',
                description: serviceUrl(),
                contextValue: 'harmonyCreative.rest',
                icon: 'pulse',
                command: { title: 'Show Health', command: 'harmonyCreative.health' },
            },
            {
                id: 'media',
                label: 'Generated Media',
                description: 'Open folder',
                contextValue: 'harmonyCreative.media',
                icon: 'folder-library',
                command: { title: 'Open Generated Media', command: 'harmonyCreative.openGeneratedMedia' },
            },
        ];

        if (lastProviderKeys.source !== 'none' && lastProviderKeys.providers.length > 0) {
            const wired = lastProviderKeys.providers.filter(p => p.wired).map(p => p.id);
            const missing = lastProviderKeys.providers.filter(p => !p.wired).map(p => p.id);
            const sourceTag = lastProviderKeys.source === 'health' ? '(live)' : '(.env)';
            nodes.push({
                id: 'keys-summary',
                label: 'Provider Keys',
                description: `${wired.length}/${lastProviderKeys.providers.length} wired ${sourceTag}`,
                contextValue: 'harmonyCreative.keys',
                icon: 'key',
                command: { title: 'Show Provider Keys', command: 'harmonyCreative.showProviderKeys' },
            });
            for (const p of lastProviderKeys.providers) {
                nodes.push({
                    id: `key-${p.id}`,
                    label: `  ${p.id}`,
                    description: p.wired ? 'wired ✓' : 'not set ✗',
                    contextValue: 'harmonyCreative.key',
                    icon: p.wired ? 'check' : 'circle-slash',
                    command: { title: 'Show Provider Keys', command: 'harmonyCreative.showProviderKeys' },
                });
            }
        } else if (lastHealth.checkedAt > 0) {
            nodes.push({
                id: 'keys-summary',
                label: 'Provider Keys',
                description: 'Unknown (no .env / no /health data)',
                contextValue: 'harmonyCreative.keys',
                icon: 'key',
                command: { title: 'Show Provider Keys', command: 'harmonyCreative.showProviderKeys' },
            });
        }

        return nodes;
    }
}

function serviceUrl(): string {
    return configured('serviceUrl') || 'http://127.0.0.1:8896';
}

function endpoint(endpointPath: string): URL {
    const raw = serviceUrl();
    const base = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    const href = base.href.endsWith('/') ? base.href : `${base.href}/`;
    return new URL(endpointPath.replace(/^\/+/, ''), href);
}

function transport(url: URL): typeof http | typeof https {
    return url.protocol === 'https:' ? https : http;
}

function asRecord(value: unknown): JsonRecord {
    return value && typeof value === 'object' ? value as JsonRecord : {};
}

async function pathExists(filePath: string): Promise<boolean> {
    return fs.access(filePath).then(() => true).catch(() => false);
}

function candidateDirsFromBase(source: string, basePath: string): CandidateDir[] {
    const resolved = path.resolve(basePath);
    return [
        { source, dir: resolved },
        { source: `${source}/harmony-creative`, dir: path.join(resolved, 'harmony-creative') },
        { source: `${source}/mcp-servers/harmony-creative`, dir: path.join(resolved, 'mcp-servers', 'harmony-creative') },
    ];
}

function centralHubCandidates(): string[] {
    const candidates: string[] = [];
    const configuredHub = configured('centralHubPath');
    if (configuredHub) candidates.push(configuredHub);
    if (process.env.HARMONY_CENTRAL_HUB) candidates.push(process.env.HARMONY_CENTRAL_HUB);
    if (process.env.EHAI_CENTRAL_PATH) candidates.push(process.env.EHAI_CENTRAL_PATH);
    candidates.push(...DEFAULT_CENTRAL_HUB_CANDIDATES);
    const seen = new Set<string>();
    return candidates.filter(candidate => {
        const key = path.resolve(candidate).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function centralHubPath(): string {
    return centralHubCandidates()[0] ?? path.join(os.homedir(), 'Documents', 'HarmonyCentral');
}

function candidateDirs(): CandidateDir[] {
    const candidates: CandidateDir[] = [];
    const servicePath = configured('servicePath');
    if (servicePath) {
        candidates.push(...candidateDirsFromBase('harmonyCreative.servicePath', servicePath));
    }

    const envServicePath = (process.env.HARMONY_CREATIVE_SERVICE_PATH || process.env.HARMONY_CREATIVE_ROOT || '').trim();
    if (envServicePath) {
        candidates.push(...candidateDirsFromBase('HARMONY_CREATIVE_SERVICE_PATH', envServicePath));
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        candidates.push(...candidateDirsFromBase(`workspace:${folder.name}`, folder.uri.fsPath));
    }

    for (const hub of centralHubCandidates()) {
        candidates.push({ source: `central:${hub}`, dir: path.join(hub, 'mcp-servers', 'harmony-creative') });
        candidates.push({ source: `central:${hub}/harmony-creative`, dir: path.join(hub, 'harmony-creative') });
    }

    const seen = new Set<string>();
    return candidates.filter(candidate => {
        const key = path.resolve(candidate.dir).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function resolveServiceDir(): Promise<ServiceDir> {
    const checked: string[] = [];
    for (const candidate of candidateDirs()) {
        const script = path.join(candidate.dir, 'rest_api.py');
        checked.push(script);
        if (await pathExists(script)) {
            return { ...candidate, script };
        }
    }
    throw new Error(`Harmony Creative rest_api.py was not found. Checked: ${checked.join('; ')}`);
}

async function updateAvailabilityContext(): Promise<void> {
    const available = await resolveServiceDir().then(() => true).catch(() => false);
    await vscode.commands.executeCommand('setContext', 'harmonyCreative.available', available);
}

function ownerRoot(serviceDir: string): string {
    const parent = path.dirname(serviceDir);
    return path.basename(parent).toLowerCase() === 'mcp-servers' ? path.dirname(parent) : parent;
}

async function resolvePython(serviceDir: string): Promise<string> {
    const configuredPython = configured('pythonPath');
    if (configuredPython) return configuredPython;

    const serviceVenvPython = process.platform === 'win32'
        ? path.join(serviceDir, '.venv', 'Scripts', 'python.exe')
        : path.join(serviceDir, '.venv', 'bin', 'python');
    if (await pathExists(serviceVenvPython)) return serviceVenvPython;

    const rootVenvPython = process.platform === 'win32'
        ? path.join(ownerRoot(serviceDir), '.venv', 'Scripts', 'python.exe')
        : path.join(ownerRoot(serviceDir), '.venv', 'bin', 'python');
    if (await pathExists(rootVenvPython)) return rootVenvPython;

    return 'python';
}

function tokenFilePath(): string {
    return configured('tokenFile')
        || process.env.HARMONY_CREATIVE_TOKEN_FILE
        || path.join(process.env.HARMONY_CREATIVE_HOME || path.join(os.homedir(), '.eternal_harmony', 'creative'), 'local_service.token');
}

async function readToken(): Promise<string | undefined> {
    try {
        const token = (await fs.readFile(tokenFilePath(), 'utf8')).trim();
        return token || undefined;
    } catch {
        return undefined;
    }
}

async function requestJson(endpointPath: string, timeoutMs: number): Promise<HttpJsonResult> {
    let url: URL;
    try {
        url = endpoint(endpointPath);
    } catch (error) {
        return { ok: false, error: `Invalid Harmony Creative URL: ${(error as Error).message}` };
    }

    const token = await readToken();
    return new Promise<HttpJsonResult>((resolve) => {
        const req = transport(url).request(url, {
            method: 'GET',
            headers: token ? { 'x-harmony-creative-token': token } : {},
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                const status = res.statusCode ?? 0;
                let body: JsonRecord | undefined;
                try {
                    body = data ? JSON.parse(data) as JsonRecord : undefined;
                } catch {
                    body = undefined;
                }
                resolve({ ok: status >= 200 && status < 400, status, body, error: body ? undefined : data });
            });
        });
        req.setTimeout(timeoutMs, () => {
            req.destroy();
            resolve({ ok: false, error: `Timed out after ${timeoutMs / 1000}s` });
        });
        req.on('error', (error: Error) => resolve({ ok: false, error: error.message }));
        req.end();
    });
}

async function health(timeoutMs = 3000): Promise<HttpJsonResult> {
    return requestJson('health', timeoutMs);
}

function creativeHealthOk(result: HttpJsonResult): boolean {
    if (!result.ok) return false;
    const body = asRecord(result.body);
    const serviceResult = asRecord(body.result);
    return body.success !== false && serviceResult.ok !== false;
}

function outputRootFromHealth(result: HttpJsonResult): string | undefined {
    const serviceResult = asRecord(asRecord(result.body).result);
    const outputRoot = serviceResult.output_root;
    return typeof outputRoot === 'string' && outputRoot.trim() ? outputRoot : undefined;
}

function updateStatusBar(): void {
    if (!statusBar) return;
    if (!configuredBool('showStatusBar', true)) {
        statusBar.hide();
        return;
    }

    const defaults = currentDefaults();
    const serviceSummary = lastHealth.checkedAt === 0
        ? 'Creative service: Checking'
        : `Creative service: ${lastHealth.ok ? 'Running' : `Stopped (${lastHealth.error ?? 'no response'})`}`;
    const providerSummary = lastProviderKeys.source === 'none'
        ? 'Provider keys: Unknown (check the Harmony Creative panel)'
        : `Provider keys: ${lastProviderKeys.providers.filter(p => p.wired).length}/${lastProviderKeys.providers.length} wired (${lastProviderKeys.source === 'health' ? 'live health' : '.env fallback'})`;
    statusBar.text = `$(sparkle) Creative: ${defaults.imageQuality}`;
    statusBar.tooltip = new vscode.MarkdownString([
        '**Harmony Creative defaults**',
        `Image quality: ${defaults.imageQuality}`,
        `Layer backend: ${defaults.layerBackend}`,
        `Video model: ${defaults.videoModel}`,
        serviceSummary,
        providerSummary,
        '',
        'This selector is separate from the main VS Code/Copilot/Harmony chat model dropdown.',
    ].join('\n\n'));
    statusBar.show();
}

async function updateCreativeSetting(key: CreativeSettingKey, value: string): Promise<void> {
    await cfg().update(key, value, vscode.ConfigurationTarget.Global);
    updateStatusBar();
    treeProvider?.refresh();
}

function pickItemsFor(key: CreativeSettingKey): ValuePick[] {
    if (key === 'imageQuality') return IMAGE_QUALITIES;
    if (key === 'layerBackend') return LAYER_BACKENDS;
    return VIDEO_MODELS;
}

function settingLabel(key: CreativeSettingKey): string {
    if (key === 'imageQuality') return 'image quality';
    if (key === 'layerBackend') return 'layer backend';
    return 'video model';
}

async function selectSetting(key: CreativeSettingKey): Promise<void> {
    const current = currentDefaults()[key];
    const picked = await vscode.window.showQuickPick(
        pickItemsFor(key).map(item => ({ ...item, picked: item.value === current })),
        { title: `Harmony Creative: Select ${settingLabel(key)}`, placeHolder: `Current: ${current}` }
    );
    if (!picked) return;

    await updateCreativeSetting(key, picked.value);
    vscode.window.showInformationMessage(`Harmony Creative ${settingLabel(key)} set to ${picked.value}.`);
}

async function revealPanel(): Promise<void> {
    try {
        await vscode.commands.executeCommand('workbench.view.explorer');
        await vscode.commands.executeCommand('harmonyCreative.panel.focus');
    } catch {
        // best effort; view may not be registered yet
    }
}

async function statusBarClick(): Promise<void> {
    // Just reveal the panel — user sees current Image Quality / Layer Backend / Video Model
    // and Creative Service health at a glance and can click any row to change it.
    await revealPanel();
}

async function selectDefaults(): Promise<void> {
    const defaults = currentDefaults();
    const picked = await vscode.window.showQuickPick<SettingPick>([
        { label: 'Image quality', description: defaults.imageQuality, detail: 'Controls generate_image quality.', key: 'imageQuality' },
        { label: 'Layer backend', description: defaults.layerBackend, detail: 'Controls generate_layer_set backend.', key: 'layerBackend' },
        { label: 'Video model', description: defaults.videoModel, detail: 'Controls generate_video model.', key: 'videoModel' },
    ], {
        title: 'Harmony Creative: Model defaults',
        placeHolder: 'Choose which Creative default to change',
    });
    if (!picked) return;
    await selectSetting(picked.key);
}

async function buildMcpDefinition(): Promise<vscode.McpStdioServerDefinition | undefined> {
    const service = await resolveServiceDir();
    const script = path.join(service.dir, 'server.py');
    if (!await pathExists(script)) {
        output.appendLine(`[${new Date().toISOString()}] Harmony Creative MCP server.py was not found at ${script}`);
        return undefined;
    }

    const python = await resolvePython(service.dir);
    const definition = new vscode.McpStdioServerDefinition(
        MCP_LABEL,
        python,
        [script],
        { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        COMPANION_VERSION,
    );
    definition.cwd = vscode.Uri.file(service.dir);
    return definition;
}

function registerMcpProvider(emitter: vscode.EventEmitter<void>): vscode.Disposable {
    const registerProvider = vscode.lm.registerMcpServerDefinitionProvider;
    if (typeof registerProvider !== 'function') {
        output.appendLine(`[${new Date().toISOString()}] VS Code MCP server definition provider API is not available in this editor build.`);
        return new vscode.Disposable(() => {});
    }

    return registerProvider.call(vscode.lm, 'harmonyCreative', {
        onDidChangeMcpServerDefinitions: emitter.event,
        provideMcpServerDefinitions: async (token) => {
            if (token.isCancellationRequested) return [];
            try {
                const definition = await buildMcpDefinition();
                return definition ? [definition] : [];
            } catch (error) {
                output.appendLine(`[${new Date().toISOString()}] Could not provide Harmony Creative MCP definition: ${(error as Error).message}`);
                return [];
            }
        },
        resolveMcpServerDefinition: async (_server, token) => {
            if (token.isCancellationRequested) return undefined;
            return buildMcpDefinition();
        },
    });
}

async function startMcpServerCommand(): Promise<void> {
    const definition = await buildMcpDefinition();
    if (!definition) {
        vscode.window.showWarningMessage('Harmony Creative MCP server.py was not found. Check Harmony Creative service path settings.');
        return;
    }

    output.appendLine(`[${new Date().toISOString()}] Harmony Creative MCP server is registered with VS Code.`);
    output.appendLine(`Label: ${definition.label}`);
    output.appendLine(`Command: ${definition.command}`);
    output.appendLine(`Args: ${definition.args.join(' ')}`);
    output.appendLine(`Cwd: ${definition.cwd?.fsPath ?? '(none)'}`);
    output.show(true);

    const action = await vscode.window.showInformationMessage(
        'Harmony Creative MCP is registered with VS Code. Use the MCP Servers view to start/stop it; this command shows the exact server definition.',
        'Show Output',
        'Open Service Folder',
        'Start REST Service'
    );
    if (action === 'Open Service Folder') await openServiceFolder();
    if (action === 'Start REST Service') await startCommand();
}

// ─── Health + provider keys background poll ───────────────────────────────────
// Provider IDs we look for in the central workspace conventions.
const PROVIDER_ENV_KEYS: Record<string, string[]> = {
    openai: ['OPENAI_API_KEY'],
    anthropic: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
    gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    deepseek: ['DEEPSEEK_API_KEY'],
    openrouter: ['OPENROUTER_API_KEY'],
    moonshot: ['MOONSHOT_API_KEY'],
    alibaba: ['ALIBABA_API_KEY', 'DASHSCOPE_API_KEY'],
    bfl: ['BFL_API_KEY', 'BLACK_FOREST_LABS_API_KEY'],
    runway: ['RUNWAY_API_KEY', 'RUNWAYML_API_KEY'],
    kling: ['KLING_API_KEY'],
    elevenlabs: ['ELEVENLABS_API_KEY', 'ELEVEN_API_KEY'],
};

async function pollHealthAndKeys(): Promise<void> {
    const result = await health(3000);
    const ok = creativeHealthOk(result);
    lastHealth = { ok, checkedAt: Date.now(), error: ok ? undefined : (result.error ?? `HTTP ${result.status ?? '?'}`) };

    let providers: Array<{ id: string; wired: boolean }> = [];
    let source: 'health' | 'env' | 'none' = 'none';

    // 1) Try live /health first.
    if (ok) {
        const healthProviders = extractProvidersFromHealth(result.body);
        if (healthProviders.length > 0) {
            providers = healthProviders;
            source = 'health';
        }
    }
    // 2) Fall back to scanning the central workspace .env.
    if (providers.length === 0) {
        const envProviders = await readProvidersFromEnv();
        if (envProviders.length > 0) {
            providers = envProviders;
            source = 'env';
        }
    }
    lastProviderKeys = { source, providers, checkedAt: Date.now() };
    updateStatusBar();
    treeProvider?.refresh();
}

function extractProvidersFromHealth(body: unknown): Array<{ id: string; wired: boolean }> {
    const record = asRecord(body);
    const inner = asRecord(record.result);
    // Look for fields named providers / api_keys / keys / configured at either top level or inside .result.
    const candidates = [inner.providers, inner.api_keys, inner.keys, record.providers, record.api_keys, record.keys];
    for (const candidate of candidates) {
        if (!candidate) continue;
        if (Array.isArray(candidate)) {
            const out: Array<{ id: string; wired: boolean }> = [];
            for (const entry of candidate) {
                if (typeof entry === 'string') out.push({ id: entry.toLowerCase(), wired: true });
                else if (entry && typeof entry === 'object') {
                    const rec = entry as Record<string, unknown>;
                    const id = String(rec.id ?? rec.name ?? rec.provider ?? '').toLowerCase();
                    if (!id) continue;
                    const wired = rec.wired !== false && rec.configured !== false && rec.has_key !== false && rec.available !== false;
                    out.push({ id, wired });
                }
            }
            if (out.length > 0) return out;
        } else if (typeof candidate === 'object') {
            const rec = candidate as Record<string, unknown>;
            return Object.entries(rec).map(([id, val]) => ({ id: id.toLowerCase(), wired: Boolean(val) }));
        }
    }
    return [];
}

async function readProvidersFromEnv(): Promise<Array<{ id: string; wired: boolean }>> {
    const envPaths: string[] = [];
    for (const candidate of candidateDirs()) {
        envPaths.push(path.join(candidate.dir, '.env'));
        envPaths.push(path.join(candidate.dir, 'mcp-servers', 'harmony-creative', '.env'));
    }
    const seen = new Set<string>();
    let envText = '';
    for (const envPath of envPaths) {
        if (seen.has(envPath)) continue;
        seen.add(envPath);
        try {
            const text = await fs.readFile(envPath, 'utf8');
            envText += '\n' + text;
        } catch {
            // missing is fine
        }
    }
    if (!envText.trim()) return [];

    const parsed: Record<string, string> = {};
    for (const rawLine of envText.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        parsed[key] = val;
    }

    return Object.entries(PROVIDER_ENV_KEYS).map(([id, envKeys]) => {
        const wired = envKeys.some(k => {
            const v = parsed[k];
            return typeof v === 'string' && v.length > 0 && !v.toLowerCase().includes('your_') && !v.toLowerCase().includes('changeme');
        });
        return { id, wired };
    });
}

async function showProviderKeys(): Promise<void> {
    await pollHealthAndKeys();
    output.appendLine(`[${new Date().toISOString()}] Harmony Creative provider keys (source: ${lastProviderKeys.source})`);
    if (lastProviderKeys.providers.length === 0) {
        output.appendLine('  No provider information available. Service may be stopped and no .env found.');
    } else {
        for (const p of lastProviderKeys.providers) {
            output.appendLine(`  ${p.wired ? '✓' : '✗'}  ${p.id}`);
        }
    }
    output.show(true);
    const wired = lastProviderKeys.providers.filter(p => p.wired).map(p => p.id).join(', ') || '(none)';
    const missing = lastProviderKeys.providers.filter(p => !p.wired).map(p => p.id).join(', ') || '(none)';
    vscode.window.showInformationMessage(
        `Harmony Creative keys [${lastProviderKeys.source}]\nWired: ${wired}\nMissing: ${missing}`,
        { modal: false }
    );
}

async function showHealth(): Promise<void> {
    const result = await health(5000);
    output.appendLine(`[${new Date().toISOString()}] Harmony Creative health`);
    output.appendLine(JSON.stringify(result, null, 2));
    output.show(true);

    if (creativeHealthOk(result)) {
        vscode.window.showInformationMessage('Harmony Creative is healthy.');
    } else {
        vscode.window.showWarningMessage(`Harmony Creative is not healthy: ${result.error ?? `HTTP ${result.status ?? 'unknown'}`}`);
    }
}

async function startCommand(): Promise<void> {
    const current = await health(2000);
    if (creativeHealthOk(current)) {
        vscode.window.showInformationMessage('Harmony Creative REST service is already running.');
        return;
    }

    const service = await resolveServiceDir();
    const python = await resolvePython(service.dir);
    output.appendLine(`[${new Date().toISOString()}] Starting Harmony Creative REST service from ${service.dir} (${service.source})`);
    output.appendLine(`Python: ${python}`);
    output.show(true);

    const child = cp.spawn(python, [service.script], {
        cwd: service.dir,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 750);
        child.once('spawn', () => {
            clearTimeout(timer);
            resolve();
        });
        child.once('error', error => {
            clearTimeout(timer);
            reject(error);
        });
    });
    child.unref();

    for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 800));
        const started = await health(1500);
        if (creativeHealthOk(started)) {
            vscode.window.showInformationMessage('Harmony Creative REST service is running.');
            return;
        }
    }

    vscode.window.showWarningMessage(`Harmony Creative did not become healthy at ${serviceUrl()}. See Harmony Creative Tools output.`);
}

async function openServiceFolder(): Promise<void> {
    const service = await resolveServiceDir();
    await vscode.env.openExternal(vscode.Uri.file(service.dir));
}

async function openGeneratedMedia(): Promise<void> {
    const result = await health(5000);
    const outputRoot = outputRootFromHealth(result) || path.join(centralHubPath(), 'media', 'generated');
    if (!await pathExists(outputRoot)) {
        vscode.window.showWarningMessage(`Generated media folder was not found: ${outputRoot}`);
        return;
    }
    await vscode.env.openExternal(vscode.Uri.file(outputRoot));
}

async function openHealthEndpoint(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(endpoint('health').toString()));
}

async function showStatus(): Promise<void> {
    const service = await resolveServiceDir().catch(error => ({ error: (error as Error).message }));
    const mcp = await buildMcpDefinition().then(definition => definition ? {
        label: definition.label,
        command: definition.command,
        args: definition.args,
        cwd: definition.cwd?.fsPath,
    } : undefined).catch(error => ({ error: (error as Error).message }));
    const result = await health(5000);
    const status = {
        extension: EXTENSION_ID,
        version: COMPANION_VERSION,
        serviceUrl: serviceUrl(),
        creativeDefaults: currentDefaults(),
        service,
        mcp,
        healthy: creativeHealthOk(result),
        health: result,
    };
    output.appendLine(`[${new Date().toISOString()}] Harmony Creative companion status`);
    output.appendLine(JSON.stringify(status, null, 2));
    output.show(true);
}
