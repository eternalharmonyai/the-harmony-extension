/**
 * Headless VS Code Host Shim for Harmony tools.
 *
 * Allows Harmony's LanguageModelTool modules to load and execute outside the
 * VS Code extension host (CLI, MCP server, or other headless host)
 * without duplicating tool implementations.
 *
 * When running inside VS Code, native `vscode` is always used untouched.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as NodeModule from 'module';

export interface HeadlessToolInstance {
    invoke(options: { input: any; toolInvocationToken?: unknown }, token: HeadlessCancellationToken): Promise<any>;
    prepareInvocation?(options: { input: any }, token: HeadlessCancellationToken): Promise<any>;
}

export interface HeadlessCancellationToken {
    isCancellationRequested: boolean;
    onCancellationRequested: (listener: () => void) => { dispose(): void };
}

let activeWorkspaceRoot = process.env.HARMONY_WORKSPACE || process.cwd();
const registeredTools = new Map<string, HeadlessToolInstance>();
const registeredCommands = new Map<string, (...args: any[]) => any>();
let shimInstalled = false;
let toolsBootstrappedForRoot: string | undefined;

export function setHeadlessWorkspaceRoot(workspaceRoot: string): void {
    if (workspaceRoot && workspaceRoot.trim()) {
        activeWorkspaceRoot = path.resolve(workspaceRoot);
    }
}

export function getHeadlessWorkspaceRoot(): string {
    return activeWorkspaceRoot;
}

class HeadlessDisposable {
    constructor(private readonly fn?: () => void) {}
    static from(...items: Array<{ dispose(): any }>): HeadlessDisposable {
        return new HeadlessDisposable(() => {
            for (const item of items) {
                try { item?.dispose?.(); } catch { /* ignore */ }
            }
        });
    }
    dispose(): void {
        try { this.fn?.(); } catch { /* ignore */ }
    }
}

class HeadlessEventEmitter<T = any> {
    private readonly listeners = new Set<(e: T) => any>();
    readonly event = (listener: (e: T) => any): HeadlessDisposable => {
        this.listeners.add(listener);
        return new HeadlessDisposable(() => this.listeners.delete(listener));
    };
    fire(data: T): void {
        for (const listener of [...this.listeners]) {
            try { listener(data); } catch { /* ignore */ }
        }
    }
    dispose(): void {
        this.listeners.clear();
    }
}

export class HeadlessCancellationTokenSource {
    private cancelled = false;
    private readonly emitter = new HeadlessEventEmitter<void>();
    readonly token: HeadlessCancellationToken;
    constructor() {
        this.token = {
            get isCancellationRequested() { return this.cancelled; },
            onCancellationRequested: (listener: () => void) => this.emitter.event(listener),
        } as any;
        Object.defineProperty(this.token, 'isCancellationRequested', {
            get: () => this.cancelled,
            enumerable: true,
        });
    }
    cancel(): void {
        if (this.cancelled) return;
        this.cancelled = true;
        this.emitter.fire();
    }
    dispose(): void {
        this.emitter.dispose();
    }
}

class HeadlessPosition {
    constructor(public readonly line: number, public readonly character: number) {}
    compareTo(other: HeadlessPosition): number {
        return (this.line - other.line) || (this.character - other.character);
    }
    translate(lineDelta = 0, characterDelta = 0): HeadlessPosition {
        return new HeadlessPosition(this.line + lineDelta, this.character + characterDelta);
    }
    with(line?: number, character?: number): HeadlessPosition {
        return new HeadlessPosition(line ?? this.line, character ?? this.character);
    }
}

class HeadlessRange {
    readonly start: HeadlessPosition;
    readonly end: HeadlessPosition;
    constructor(a: HeadlessPosition | number, b: HeadlessPosition | number, c?: number, d?: number) {
        if (typeof a === 'number') {
            this.start = new HeadlessPosition(a, Number(b));
            this.end = new HeadlessPosition(Number(c ?? a), Number(d ?? b));
        } else {
            this.start = a;
            this.end = b as HeadlessPosition;
        }
    }
    get isEmpty(): boolean {
        return this.start.compareTo(this.end) === 0;
    }
}

class HeadlessLocation {
    readonly range: HeadlessRange;
    constructor(public readonly uri: HeadlessUri, rangeOrPos: HeadlessRange | HeadlessPosition) {
        this.range = rangeOrPos instanceof HeadlessPosition
            ? new HeadlessRange(rangeOrPos, rangeOrPos)
            : rangeOrPos;
    }
}

class HeadlessUri {
    constructor(
        public readonly scheme: string,
        public readonly authority: string,
        public readonly path: string,
        public readonly query = '',
        public readonly fragment = '',
        private readonly _fsPath?: string
    ) {}

    static file(filePath: string): HeadlessUri {
        const resolved = path.resolve(filePath);
        const normalized = resolved.replace(/\\/g, '/');
        const uriPath = normalized.startsWith('/') ? normalized : `/${normalized}`;
        return new HeadlessUri('file', '', uriPath, '', '', resolved);
    }

    static parse(value: string): HeadlessUri {
        try {
            const u = new URL(value);
            if (u.protocol === 'file:') {
                return HeadlessUri.file(decodeURIComponent(u.pathname.replace(/^\/([A-Za-z]:)/, '$1')));
            }
            return new HeadlessUri(
                u.protocol.replace(/:$/, ''),
                u.host,
                u.pathname,
                u.search.replace(/^\?/, ''),
                u.hash.replace(/^#/, '')
            );
        } catch {
            return HeadlessUri.file(value);
        }
    }

    static joinPath(base: HeadlessUri, ...segments: string[]): HeadlessUri {
        if (base.scheme === 'file') {
            return HeadlessUri.file(path.join(base.fsPath, ...segments));
        }
        return new HeadlessUri(base.scheme, base.authority, path.posix.join(base.path, ...segments), base.query, base.fragment);
    }

    get fsPath(): string {
        if (this._fsPath) return this._fsPath;
        if (this.scheme === 'file') {
            const raw = this.path.replace(/^\/([A-Za-z]:)/, '$1');
            return process.platform === 'win32' ? raw.replace(/\//g, '\\') : raw;
        }
        return this.path;
    }

    toString(): string {
        if (this.scheme === 'file') {
            return `file://${this.path}`;
        }
        const auth = this.authority ? `//${this.authority}` : '';
        const q = this.query ? `?${this.query}` : '';
        const f = this.fragment ? `#${this.fragment}` : '';
        return `${this.scheme}:${auth}${this.path}${q}${f}`;
    }
}

class HeadlessMarkdownString {
    value: string;
    isTrusted = false;
    supportThemeIcons = false;
    constructor(value = '', supportThemeIcons = false) {
        this.value = value;
        this.supportThemeIcons = supportThemeIcons;
    }
    appendText(text: string): this {
        this.value += text;
        return this;
    }
    appendMarkdown(md: string): this {
        this.value += md;
        return this;
    }
    appendCodeblock(code: string, language = ''): this {
        this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
        return this;
    }
}

class HeadlessLanguageModelTextPart {
    constructor(public readonly value: string) {}
}

class HeadlessLanguageModelToolCallPart {
    constructor(public readonly callId: string, public readonly name: string, public readonly input: object) {}
}

class HeadlessLanguageModelToolResultPart {
    constructor(public readonly callId: string, public readonly content: Array<HeadlessLanguageModelTextPart | unknown>) {}
}

class HeadlessLanguageModelToolResult {
    constructor(public readonly content: Array<HeadlessLanguageModelTextPart | unknown>) {}
}

class HeadlessLanguageModelChatMessage {
    static User(content: string | any[], name?: string): any {
        return { role: 1, content, name };
    }
    static Assistant(content: string | any[], name?: string): any {
        return { role: 2, content, name };
    }
    constructor(public readonly role: number, public readonly content: string | any[], public readonly name?: string) {}
}

function readJsonFileSync(filePath: string): Record<string, any> {
    try {
        if (!fs.existsSync(filePath)) return {};
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, any>;
    } catch {
        return {};
    }
}

function writeJsonFileSync(filePath: string, data: Record<string, any>): void {
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch {
        /* best-effort in headless mode */
    }
}

function getHarmonyConfiguration(section?: string) {
    const settingsPath = path.join(activeWorkspaceRoot, '.harmony', 'settings.json');
    const localSettings = readJsonFileSync(settingsPath);
    const prefix = section ? `${section}.` : '';
    return {
        get<T>(key: string, defaultValue?: T): T | undefined {
            const fullKey = `${prefix}${key}`;
            const envKey = 'HARMONY_CFG_' + fullKey.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
            if (process.env[envKey] !== undefined) {
                const raw = process.env[envKey]!;
                if (raw === 'true') return true as unknown as T;
                if (raw === 'false') return false as unknown as T;
                if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw) as unknown as T;
                return raw as unknown as T;
            }
            if (Object.prototype.hasOwnProperty.call(localSettings, fullKey)) {
                return localSettings[fullKey] as T;
            }
            if (Object.prototype.hasOwnProperty.call(localSettings, key)) {
                return localSettings[key] as T;
            }
            return defaultValue;
        },
        has(key: string): boolean {
            const fullKey = `${prefix}${key}`;
            return Object.prototype.hasOwnProperty.call(localSettings, fullKey)
                || Object.prototype.hasOwnProperty.call(localSettings, key);
        },
        inspect(): undefined {
            return undefined;
        },
        async update(key: string, value: any): Promise<void> {
            const fullKey = `${prefix}${key}`;
            localSettings[fullKey] = value;
            writeJsonFileSync(settingsPath, localSettings);
        },
    };
}

function globToRegExp(glob: string): RegExp {
    const normalized = glob.replace(/\\/g, '/');
    let re = '^';
    for (let i = 0; i < normalized.length; i++) {
        const ch = normalized[i];
        if (ch === '*') {
            if (normalized[i + 1] === '*') {
                if (normalized[i + 2] === '/') {
                    re += '(?:.*/)?';
                    i += 2;
                } else {
                    re += '.*';
                    i += 1;
                }
            } else {
                re += '[^/]*';
            }
        } else if (ch === '?') {
            re += '[^/]';
        } else if ('+()^$.[]{}|\\'.includes(ch)) {
            re += '\\' + ch;
        } else {
            re += ch;
        }
    }
    re += '$';
    return new RegExp(re, process.platform === 'win32' ? 'i' : '');
}

async function headlessFindFiles(includePattern: any, excludePattern?: any, maxResults = 2000): Promise<HeadlessUri[]> {
    const includeStr = typeof includePattern === 'string'
        ? includePattern
        : typeof includePattern?.pattern === 'string'
            ? includePattern.pattern
            : '**/*';
    const excludeStr = typeof excludePattern === 'string' ? excludePattern : '';
    const incRe = globToRegExp(includeStr);
    const excRe = excludeStr ? globToRegExp(excludeStr) : null;
    const out: HeadlessUri[] = [];
    const skipDirs = new Set(['.git', 'node_modules', '.harmony', 'out', 'dist', 'build', 'target']);

    async function walk(dir: string): Promise<void> {
        if (out.length >= maxResults) return;
        let entries: fs.Dirent[];
        try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (out.length >= maxResults) return;
            const full = path.join(dir, entry.name);
            const rel = path.relative(activeWorkspaceRoot, full).replace(/\\/g, '/');
            if (entry.isDirectory()) {
                if (skipDirs.has(entry.name)) continue;
                await walk(full);
            } else if (entry.isFile()) {
                if (excRe && excRe.test(rel)) continue;
                if (incRe.test(rel) || incRe.test(entry.name)) {
                    out.push(HeadlessUri.file(full));
                }
            }
        }
    }

    await walk(activeWorkspaceRoot);
    return out;
}

export function createVscodeShimModule(): Record<string, any> {
    const noopDisposable = () => new HeadlessDisposable();

    return {
        Position: HeadlessPosition,
        Range: HeadlessRange,
        Location: HeadlessLocation,
        Uri: HeadlessUri,
        MarkdownString: HeadlessMarkdownString,
        Disposable: HeadlessDisposable,
        EventEmitter: HeadlessEventEmitter,
        CancellationTokenSource: HeadlessCancellationTokenSource,
        LanguageModelTextPart: HeadlessLanguageModelTextPart,
        LanguageModelToolCallPart: HeadlessLanguageModelToolCallPart,
        LanguageModelToolResultPart: HeadlessLanguageModelToolResultPart,
        LanguageModelToolResult: HeadlessLanguageModelToolResult,
        LanguageModelChatMessage: HeadlessLanguageModelChatMessage,
        LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
        StatusBarAlignment: { Left: 1, Right: 2 },
        ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
        WorkspaceEdit: class {
            private readonly edits: Array<{ uri: HeadlessUri; range: HeadlessRange; newText: string }> = [];
            replace(uri: HeadlessUri, range: HeadlessRange, newText: string): void {
                this.edits.push({ uri, range, newText });
            }
        },
        workspace: {
            get workspaceFolders() {
                return [{
                    uri: HeadlessUri.file(activeWorkspaceRoot),
                    name: path.basename(activeWorkspaceRoot),
                    index: 0,
                }];
            },
            get rootPath() {
                return activeWorkspaceRoot;
            },
            getWorkspaceFolder(uri: HeadlessUri) {
                return {
                    uri: HeadlessUri.file(activeWorkspaceRoot),
                    name: path.basename(activeWorkspaceRoot),
                    index: 0,
                };
            },
            asRelativePath(pathOrUri: string | HeadlessUri): string {
                const fsPath = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
                return path.relative(activeWorkspaceRoot, fsPath).replace(/\\/g, '/');
            },
            getConfiguration(section?: string) {
                return getHarmonyConfiguration(section);
            },
            findFiles: headlessFindFiles,
            async openTextDocument(uriOrPath: string | HeadlessUri) {
                const fsPath = typeof uriOrPath === 'string' ? uriOrPath : uriOrPath.fsPath;
                const text = await fsp.readFile(fsPath, 'utf8');
                const lines = text.split(/\r?\n/);
                return {
                    uri: HeadlessUri.file(fsPath),
                    fileName: fsPath,
                    languageId: path.extname(fsPath).replace(/^\./, '') || 'plaintext',
                    lineCount: lines.length,
                    getText: () => text,
                    lineAt: (line: number) => ({
                        lineNumber: line,
                        text: lines[line] ?? '',
                        range: new HeadlessRange(line, 0, line, (lines[line] ?? '').length),
                    }),
                };
            },
            async applyEdit(): Promise<boolean> {
                return false;
            },
            onDidChangeConfiguration: noopDisposable,
            onDidChangeWorkspaceFolders: noopDisposable,
            onDidSaveTextDocument: noopDisposable,
            fs: {
                async readFile(uri: HeadlessUri): Promise<Uint8Array> {
                    return await fsp.readFile(uri.fsPath);
                },
                async writeFile(uri: HeadlessUri, content: Uint8Array): Promise<void> {
                    await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
                    await fsp.writeFile(uri.fsPath, Buffer.from(content));
                },
                async stat(uri: HeadlessUri) {
                    const st = await fsp.stat(uri.fsPath);
                    return {
                        type: st.isDirectory() ? 2 : 1,
                        ctime: st.ctimeMs,
                        mtime: st.mtimeMs,
                        size: st.size,
                    };
                },
            },
        },
        window: {
            activeTextEditor: undefined,
            visibleTextEditors: [],
            async showInformationMessage(): Promise<undefined> { return undefined; },
            async showWarningMessage(): Promise<undefined> { return undefined; },
            async showErrorMessage(): Promise<undefined> { return undefined; },
            async showQuickPick(): Promise<undefined> { return undefined; },
            async showInputBox(): Promise<undefined> { return undefined; },
            async showTextDocument(doc: any) { return { document: doc }; },
            createOutputChannel(name: string) {
                return {
                    name,
                    append() {},
                    appendLine() {},
                    clear() {},
                    show() {},
                    hide() {},
                    dispose() {},
                };
            },
            createStatusBarItem() {
                return {
                    text: '',
                    tooltip: '',
                    command: undefined,
                    show() {},
                    hide() {},
                    dispose() {},
                };
            },
            registerWebviewViewProvider: noopDisposable,
            registerTreeDataProvider: noopDisposable,
        },
        commands: {
            registerCommand(id: string, handler: (...args: any[]) => any) {
                registeredCommands.set(id, handler);
                return new HeadlessDisposable(() => registeredCommands.delete(id));
            },
            async executeCommand(id: string, ...args: any[]) {
                const handler = registeredCommands.get(id);
                if (handler) return await handler(...args);
                return undefined;
            },
            async getCommands(): Promise<string[]> {
                return [...registeredCommands.keys()];
            },
        },
        extensions: {
            all: [],
            getExtension() { return undefined; },
        },
        env: {
            appName: 'Harmony Headless Host',
            appHost: 'cli',
            language: process.env.HARMONY_LOCALE || 'en',
            machineId: 'harmony-headless-machine',
            sessionId: `harmony-headless-${process.pid}`,
            clipboard: {
                text: '',
                async readText() { return this.text; },
                async writeText(val: string) { this.text = val; },
            },
            async openExternal(): Promise<boolean> { return false; },
        },
        lm: {
            get tools() {
                return [...registeredTools.keys()].map(name => ({ name, description: '', inputSchema: {} }));
            },
            registerTool(name: string, tool: HeadlessToolInstance) {
                registeredTools.set(name, tool);
                return new HeadlessDisposable(() => registeredTools.delete(name));
            },
            registerLanguageModelChatProvider: noopDisposable,
            async selectChatModels() { return []; },
            async invokeTool(name: string, options: { input: any }, token?: HeadlessCancellationToken) {
                const tool = registeredTools.get(name);
                if (!tool) throw new Error(`Tool not registered in headless host: ${name}`);
                return await tool.invoke(options, token ?? new HeadlessCancellationTokenSource().token);
            },
        },
        languages: {
            getDiagnostics() { return []; },
            createDiagnosticCollection(name: string) {
                return { name, set() {}, delete() {}, clear() {}, dispose() {} };
            },
        },
        chat: {
            createChatParticipant() {
                return { iconPath: undefined, followupProvider: undefined, dispose() {} };
            },
        },
    };
}

/**
 * Install the `Module._load` hook so `require('vscode')` resolves to our headless
 * shim whenever the real VS Code extension host is not present.
 */
export function installVscodeHostShim(workspaceRoot?: string): void {
    if (workspaceRoot) setHeadlessWorkspaceRoot(workspaceRoot);
    if (shimInstalled) return;
    shimInstalled = true;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const modAny = require('module') as any;
    const origLoad = modAny._load;
    let shimInstance: Record<string, any> | undefined;

    modAny._load = function patchedLoad(request: string, parent: any, isMain: boolean) {
        if (request === 'vscode') {
            try {
                return origLoad.apply(this, arguments);
            } catch {
                if (!shimInstance) shimInstance = createVscodeShimModule();
                return shimInstance;
            }
        }
        return origLoad.apply(this, arguments);
    };
}

const SECRET_ENV_ALIASES: Record<string, string[]> = {
    'harmony.deepseekApiKey': ['DEEPSEEK_API_KEY', 'HARMONY_DEEPSEEK_API_KEY'],
    'harmony.geminiApiKey': ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'HARMONY_GEMINI_API_KEY'],
    'harmony.openai.apiKey': ['OPENAI_API_KEY', 'HARMONY_OPENAI_API_KEY'],
    'harmony.claude.apiKey': ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'HARMONY_CLAUDE_API_KEY'],
    'harmony.openrouter.apiKey': ['OPENROUTER_API_KEY', 'HARMONY_OPENROUTER_API_KEY'],
    'harmony.alibaba.apiKey': ['DASHSCOPE_API_KEY', 'ALIBABA_API_KEY', 'QWEN_API_KEY'],
    'harmony.moonshot.apiKey': ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    'harmony.kimiCode.apiKey': ['KIMI_CODE_API_KEY', 'MOONSHOT_API_KEY'],
    'harmony.tencent.apiKey': ['TENCENT_API_KEY', 'HUNYUAN_API_KEY'],
    'harmony.zhipu.apiKey': ['ZHIPU_API_KEY', 'GLM_API_KEY'],
    'harmony.stepfun.apiKey': ['STEPFUN_API_KEY'],
    'harmony.doubao.apiKey': ['ARK_API_KEY', 'DOUBAO_API_KEY'],
    'harmony.byteplus.apiKey': ['BYTEPLUS_API_KEY', 'ARK_API_KEY'],
};

export function createHeadlessExtensionContext(workspaceRoot = activeWorkspaceRoot): any {
    const extRoot = process.env.HARMONY_EXTENSION_PATH || path.resolve(__dirname, '..', '..');
    const secretsFile = path.join(workspaceRoot, '.harmony', 'secrets.json');
    const wsStateFile = path.join(workspaceRoot, '.harmony', 'workspaceState.json');
    const globalStateFile = path.join(os.homedir(), '.harmony', 'globalState.json');
    const secretEmitter = new HeadlessEventEmitter<{ key: string }>();

    const makeMemento = (filePath: string) => ({
        keys(): readonly string[] {
            return Object.keys(readJsonFileSync(filePath));
        },
        get<T>(key: string, defaultValue?: T): T | undefined {
            const data = readJsonFileSync(filePath);
            return Object.prototype.hasOwnProperty.call(data, key) ? (data[key] as T) : defaultValue;
        },
        async update(key: string, value: any): Promise<void> {
            const data = readJsonFileSync(filePath);
            if (value === undefined) delete data[key];
            else data[key] = value;
            writeJsonFileSync(filePath, data);
        },
        setKeysForSync(): void {},
    });

    return {
        subscriptions: [] as Array<{ dispose(): any }>,
        extensionPath: extRoot,
        extensionUri: HeadlessUri.file(extRoot),
        storageUri: HeadlessUri.file(path.join(workspaceRoot, '.harmony', 'storage')),
        globalStorageUri: HeadlessUri.file(path.join(os.homedir(), '.harmony', 'globalStorage')),
        logUri: HeadlessUri.file(path.join(workspaceRoot, '.harmony', 'logs')),
        extensionMode: 1,
        asAbsolutePath(rel: string): string {
            return path.resolve(extRoot, rel);
        },
        workspaceState: makeMemento(wsStateFile),
        globalState: makeMemento(globalStateFile),
        secrets: {
            onDidChange: secretEmitter.event,
            async get(key: string): Promise<string | undefined> {
                const aliases = SECRET_ENV_ALIASES[key] ?? [];
                const genericEnv = 'HARMONY_SECRET_' + key.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
                for (const envName of [genericEnv, ...aliases]) {
                    const val = process.env[envName];
                    if (val && val.trim()) return val.trim();
                }
                const stored = readJsonFileSync(secretsFile);
                if (typeof stored[key] === 'string' && stored[key].trim()) {
                    return stored[key].trim();
                }
                return undefined;
            },
            async store(key: string, value: string): Promise<void> {
                const stored = readJsonFileSync(secretsFile);
                stored[key] = value;
                writeJsonFileSync(secretsFile, stored);
                secretEmitter.fire({ key });
            },
            async delete(key: string): Promise<void> {
                const stored = readJsonFileSync(secretsFile);
                delete stored[key];
                writeJsonFileSync(secretsFile, stored);
                secretEmitter.fire({ key });
            },
        },
    };
}

/**
 * Register all Harmony LanguageModelTools into the headless registry so they can
 * be invoked from CLI, MCP, or other headless hosts.
 */
export function ensureHeadlessHarmonyToolsRegistered(workspaceRoot = activeWorkspaceRoot): number {
    installVscodeHostShim(workspaceRoot);
    if (toolsBootstrappedForRoot === activeWorkspaceRoot && registeredTools.size > 0) {
        return registeredTools.size;
    }
    toolsBootstrappedForRoot = activeWorkspaceRoot;
    const context = createHeadlessExtensionContext(activeWorkspaceRoot);

    const registrars: Array<() => void> = [
        () => require('../lmTools').registerHarmonyTools(context),
        () => require('../visualTools').registerVisualTools(context),
        () => require('../companyTools').registerCompanyTools(context),
        () => require('../opsTools').registerOpsTools(context),
        () => require('../selfTools').registerSelfTools(context),
        () => require('../cognitionTools').registerCognitionTools(context),
        () => require('../repairRestore').registerRepairRestore(context),
        () => require('../evidenceTools').registerEvidenceTools(context),
        () => require('../researchTools').registerResearchUpgradeTools(context),
        () => require('../providerRegistryTools').registerProviderRegistryTools(context),
        () => require('../swarmTools').registerSwarmTools(context),
        () => require('../exoskeleton/exoskeletonTools').registerExoskeletonTools(context),
        () => require('../deepOrchestrate').registerDeepOrchestrate(context),
        () => require('../symbolTools').registerSymbolTools(context),
        () => require('../webSearch').registerWebSearchTools(context),
        () => require('../provenanceTools').registerProvenanceTools(context),
        () => require('../consensusTools').registerConsensusTools(context),
        () => require('../chatRecall').registerChatRecallTool(context),
        () => require('../itNetworkTools').registerItNetworkTools(context),
        () => require('../wpHostingTools').registerWpHostingTools(context),
        () => require('../cloudConnectorTools').registerCloudConnectorTools(context),
    ];

    for (const register of registrars) {
        try { register(); } catch { /* ignore individual optional registrar errors in headless mode */ }
    }
    return registeredTools.size;
}

export function listHeadlessHarmonyTools(workspaceRoot = activeWorkspaceRoot): string[] {
    ensureHeadlessHarmonyToolsRegistered(workspaceRoot);
    return [...registeredTools.keys()].sort();
}

export function extractToolResultText(result: any): string {
    if (result === null || result === undefined) return '';
    if (typeof result === 'string') return result;
    if (Array.isArray(result.content)) {
        return result.content
            .map((part: any) => {
                if (typeof part === 'string') return part;
                if (part && typeof part.value === 'string') return part.value;
                return JSON.stringify(part);
            })
            .filter(Boolean)
            .join('\n');
    }
    return typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
}

export async function invokeHeadlessHarmonyTool(
    toolName: string,
    input: Record<string, unknown> = {},
    workspaceRoot = activeWorkspaceRoot,
    timeoutMs = 120_000
): Promise<{ ok: boolean; tool: string; result: string }> {
    ensureHeadlessHarmonyToolsRegistered(workspaceRoot);
    const normalized = toolName.startsWith('harmony_') ? toolName : `harmony_${toolName}`;
    const tool = registeredTools.get(normalized) ?? registeredTools.get(toolName);
    if (!tool) {
        return {
            ok: false,
            tool: normalized,
            result: `Unknown Harmony tool: ${toolName} (registered headless tools: ${registeredTools.size})`,
        };
    }

    const cts = new HeadlessCancellationTokenSource();
    const timer = setTimeout(() => cts.cancel(), Math.max(1000, timeoutMs));
    try {
        const raw = await tool.invoke({ input }, cts.token);
        const text = extractToolResultText(raw);
        return {
            ok: !/^error:/i.test(text.trim()),
            tool: normalized,
            result: text,
        };
    } catch (err: any) {
        return {
            ok: false,
            tool: normalized,
            result: `error: ${err?.message ?? String(err)}`,
        };
    } finally {
        clearTimeout(timer);
        cts.dispose();
    }
}
