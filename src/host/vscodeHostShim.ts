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

class HeadlessChatResponseMarkdownPart {
    readonly value: HeadlessMarkdownString;
    constructor(value: string | HeadlessMarkdownString) {
        this.value = typeof value === 'string' ? new HeadlessMarkdownString(value) : value;
    }
}

class HeadlessChatRequestTurn {
    constructor(
        public readonly prompt: string,
        public readonly command: string | undefined,
        public readonly references: readonly any[] = [],
        public readonly participant = 'harmony.chat',
        public readonly toolReferences: readonly any[] = []
    ) {}
}

class HeadlessChatResponseTurn {
    constructor(
        public readonly response: ReadonlyArray<HeadlessChatResponseMarkdownPart | unknown>,
        public readonly result: Record<string, any> = {},
        public readonly participant = 'harmony.chat'
    ) {}
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
    const g = globalThis as Record<string, any>;
    if (g.__harmonyVscodeShimSingleton) {
        return g.__harmonyVscodeShimSingleton;
    }
    const noopDisposable = () => new HeadlessDisposable();

    class HeadlessCodeActionKind {
        static readonly Empty = new HeadlessCodeActionKind('');
        static readonly QuickFix = new HeadlessCodeActionKind('quickfix');
        static readonly Refactor = new HeadlessCodeActionKind('refactor');
        static readonly RefactorExtract = new HeadlessCodeActionKind('refactor.extract');
        static readonly RefactorInline = new HeadlessCodeActionKind('refactor.inline');
        static readonly RefactorRewrite = new HeadlessCodeActionKind('refactor.rewrite');
        static readonly Source = new HeadlessCodeActionKind('source');
        static readonly SourceOrganizeImports = new HeadlessCodeActionKind('source.organizeImports');
        static readonly SourceFixAll = new HeadlessCodeActionKind('source.fixAll');
        constructor(public readonly value: string) {}
        append(parts: string): HeadlessCodeActionKind {
            return new HeadlessCodeActionKind(this.value ? `${this.value}.${parts}` : parts);
        }
        intersects(other: HeadlessCodeActionKind): boolean {
            return this.contains(other) || other.contains(this);
        }
        contains(other: HeadlessCodeActionKind): boolean {
            return this.value === other.value || other.value.startsWith(this.value + '.');
        }
    }

    class HeadlessDiagnostic {
        source?: string;
        code?: string | number;
        constructor(
            public readonly range: HeadlessRange,
            public readonly message: string,
            public readonly severity: number = 0
        ) {}
    }

    class HeadlessWorkspaceEdit {
        private readonly byUri = new Map<string, { uri: HeadlessUri; edits: Array<{ range: HeadlessRange; newText: string }> }>();

        private bucket(uri: HeadlessUri) {
            const key = path.resolve(uri.fsPath);
            let b = this.byUri.get(key);
            if (!b) {
                b = { uri: HeadlessUri.file(key), edits: [] };
                this.byUri.set(key, b);
            }
            return b;
        }

        replace(uri: HeadlessUri, range: HeadlessRange, newText: string): void {
            this.bucket(uri).edits.push({ range, newText });
        }

        insert(uri: HeadlessUri, position: HeadlessPosition, newText: string): void {
            this.bucket(uri).edits.push({ range: new HeadlessRange(position, position), newText });
        }

        delete(uri: HeadlessUri, range: HeadlessRange): void {
            this.bucket(uri).edits.push({ range, newText: '' });
        }

        set(uri: HeadlessUri, edits: Array<{ range: HeadlessRange; newText: string }>): void {
            this.bucket(uri).edits = [...(edits ?? [])];
        }

        get(uri: HeadlessUri): Array<{ range: HeadlessRange; newText: string }> {
            return this.byUri.get(path.resolve(uri.fsPath))?.edits ?? [];
        }

        has(uri: HeadlessUri): boolean {
            return this.byUri.has(path.resolve(uri.fsPath));
        }

        entries(): Array<[HeadlessUri, Array<{ range: HeadlessRange; newText: string }>]> {
            return [...this.byUri.values()].map(b => [b.uri, b.edits]);
        }

        get size(): number {
            return this.byUri.size;
        }
    }

    class HeadlessCodeAction {
        edit?: HeadlessWorkspaceEdit;
        diagnostics?: HeadlessDiagnostic[];
        command?: { title: string; command: string; arguments?: any[] };
        isPreferred?: boolean;
        disabled?: { reason: string };
        constructor(public readonly title: string, public readonly kind?: HeadlessCodeActionKind) {}
    }

    function extractWordAtPosition(lineText: string, character: number): { word: string; startCol: number; endCol: number } | null {
        const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(lineText)) !== null) {
            const start = m.index;
            const end = start + m[0].length;
            if (character >= start && character <= end) {
                return { word: m[0], startCol: start, endCol: end };
            }
        }
        return null;
    }

    function escapeRegexLiteral(s: string): string {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    async function resolveHeadlessSymbolAt(uri: HeadlessUri, pos: HeadlessPosition): Promise<{ word: string; fsPath: string; lines: string[] } | null> {
        try {
            const fsPath = uri.fsPath;
            const raw = await fsp.readFile(fsPath, 'utf8');
            const lines = raw.split(/\r?\n/);
            const lineText = lines[pos.line] ?? '';
            const hit = extractWordAtPosition(lineText, pos.character);
            if (!hit) return null;
            return { word: hit.word, fsPath, lines };
        } catch {
            return null;
        }
    }

    async function findHeadlessSymbolLocations(
        uri: HeadlessUri,
        pos: HeadlessPosition,
        mode: 'definition' | 'references',
        includeDeclaration = true
    ): Promise<HeadlessLocation[]> {
        const sym = await resolveHeadlessSymbolAt(uri, pos);
        if (!sym) return [];
        const escaped = escapeRegexLiteral(sym.word);
        const defRe = new RegExp(
            `(?:\\b(?:function|class|interface|type|enum|const|let|var|def|fn|struct|trait)\\s+(${escaped})\\b|^\\s*(?:export\\s+)?(?:public\\s+|private\\s+|protected\\s+|static\\s+|readonly\\s+|async\\s+)*(${escaped})\\s*(?:\\(|=|:))`
        );
        const wordRe = new RegExp(`\\b${escaped}\\b`, 'g');

        const candidateUris = await headlessFindFiles('**/*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go}', undefined, 500);
        const orderedUris = [
            HeadlessUri.file(sym.fsPath),
            ...candidateUris.filter(u => path.resolve(u.fsPath) !== path.resolve(sym.fsPath)),
        ];

        const definitions: HeadlessLocation[] = [];
        const references: HeadlessLocation[] = [];

        for (const fileUri of orderedUris) {
            let content: string;
            try {
                content = await fsp.readFile(fileUri.fsPath, 'utf8');
            } catch {
                continue;
            }
            if (!content.includes(sym.word)) continue;
            const fileLines = content.split(/\r?\n/);
            for (let lineIdx = 0; lineIdx < fileLines.length; lineIdx++) {
                const lineStr = fileLines[lineIdx];
                if (!lineStr.includes(sym.word)) continue;
                const isDefLine = defRe.test(lineStr);
                wordRe.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = wordRe.exec(lineStr)) !== null) {
                    const loc = new HeadlessLocation(
                        fileUri,
                        new HeadlessRange(lineIdx, m.index, lineIdx, m.index + sym.word.length)
                    );
                    if (isDefLine) {
                        definitions.push(loc);
                        if (includeDeclaration) references.push(loc);
                    } else {
                        references.push(loc);
                    }
                }
            }
        }

        if (mode === 'definition') {
            return definitions.length > 0 ? definitions : references.slice(0, 5);
        }
        return references;
    }

    function computeFileDiagnosticsSync(fsPath: string): HeadlessDiagnostic[] {
        try {
            if (!fs.existsSync(fsPath)) return [];
            const ext = path.extname(fsPath).toLowerCase();
            const text = fs.readFileSync(fsPath, 'utf8');
            if (ext === '.json') {
                try {
                    JSON.parse(text);
                    return [];
                } catch (err: any) {
                    return [new HeadlessDiagnostic(new HeadlessRange(0, 0, 0, 1), err?.message ?? String(err), 0)];
                }
            }
            if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
                try {
                    // eslint-disable-next-line @typescript-eslint/no-var-requires
                    const ts = require('typescript') as typeof import('typescript');
                    const res = ts.transpileModule(text, {
                        fileName: fsPath,
                        reportDiagnostics: true,
                        compilerOptions: {
                            target: ts.ScriptTarget.ES2022,
                            module: ts.ModuleKind.CommonJS,
                            jsx: ext.endsWith('x') ? ts.JsxEmit.React : undefined,
                        },
                    });
                    const out: HeadlessDiagnostic[] = [];
                    for (const d of res.diagnostics ?? []) {
                        const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
                        let line = 0;
                        let character = 0;
                        if (d.file && typeof d.start === 'number') {
                            const lc = d.file.getLineAndCharacterOfPosition(d.start);
                            line = lc.line;
                            character = lc.character;
                        }
                        const sev = d.category === ts.DiagnosticCategory.Error ? 0
                            : d.category === ts.DiagnosticCategory.Warning ? 1 : 2;
                        out.push(new HeadlessDiagnostic(
                            new HeadlessRange(line, character, line, character + Math.max(1, d.length ?? 1)),
                            msg,
                            sev
                        ));
                    }
                    return out;
                } catch {
                    return [];
                }
            }
            return [];
        } catch {
            return [];
        }
    }

    const customDiagnostics = new Map<string, Map<string, { uri: HeadlessUri; diags: HeadlessDiagnostic[] }>>();

    const shim = {
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
        ChatResponseMarkdownPart: HeadlessChatResponseMarkdownPart,
        ChatRequestTurn: HeadlessChatRequestTurn,
        ChatResponseTurn: HeadlessChatResponseTurn,
        LanguageModelChatMessage: HeadlessLanguageModelChatMessage,
        LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
        StatusBarAlignment: { Left: 1, Right: 2 },
        ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
        CodeActionKind: HeadlessCodeActionKind,
        CodeAction: HeadlessCodeAction,
        Diagnostic: HeadlessDiagnostic,
        WorkspaceEdit: HeadlessWorkspaceEdit,
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
            isTrusted: true,
            onDidGrantWorkspaceTrust: noopDisposable,
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
            async applyEdit(edit: HeadlessWorkspaceEdit): Promise<boolean> {
                if (!edit || typeof edit.entries !== 'function') return false;
                try {
                    for (const [uri, edits] of edit.entries()) {
                        if (!edits || edits.length === 0) continue;
                        const fsPath = uri.fsPath;
                        const raw = await fsp.readFile(fsPath, 'utf8');
                        const eol = raw.includes('\r\n') ? '\r\n' : '\n';
                        const lines = raw.split(/\r?\n/);
                        const lineStarts: number[] = [];
                        let acc = 0;
                        for (let i = 0; i < lines.length; i++) {
                            lineStarts.push(acc);
                            acc += lines[i].length + eol.length;
                        }
                        const toOffset = (pos: HeadlessPosition): number => {
                            const l = Math.max(0, Math.min(pos.line, lines.length - 1));
                            const c = Math.max(0, Math.min(pos.character, (lines[l] ?? '').length));
                            return (lineStarts[l] ?? 0) + c;
                        };
                        const resolvedEdits = edits
                            .map(e => ({
                                start: toOffset(e.range.start),
                                end: toOffset(e.range.end),
                                newText: e.newText,
                            }))
                            .sort((a, b) => (b.start - a.start) || (b.end - a.end));
                        let updated = raw;
                        for (const item of resolvedEdits) {
                            updated = updated.slice(0, item.start) + item.newText + updated.slice(item.end);
                        }
                        await fsp.writeFile(fsPath, updated, 'utf8');
                    }
                    return true;
                } catch {
                    return false;
                }
            },
            onDidChangeConfiguration: noopDisposable,
            onDidChangeWorkspaceFolders: noopDisposable,
            onDidSaveTextDocument: noopDisposable,
            fs: {
                async createDirectory(uri: HeadlessUri): Promise<void> {
                    await fsp.mkdir(uri.fsPath, { recursive: true });
                },
                async readDirectory(uri: HeadlessUri): Promise<Array<[string, number]>> {
                    const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
                    return entries.map(e => [e.name, e.isDirectory() ? 2 : (e.isSymbolicLink() ? 64 : 1)]);
                },
                async readFile(uri: HeadlessUri): Promise<Uint8Array> {
                    return await fsp.readFile(uri.fsPath);
                },
                async writeFile(uri: HeadlessUri, content: Uint8Array): Promise<void> {
                    await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
                    await fsp.writeFile(uri.fsPath, Buffer.from(content));
                },
                async delete(uri: HeadlessUri, options?: { recursive?: boolean }): Promise<void> {
                    await fsp.rm(uri.fsPath, { recursive: !!options?.recursive, force: true });
                },
                async rename(source: HeadlessUri, target: HeadlessUri, options?: { overwrite?: boolean }): Promise<void> {
                    if (options?.overwrite === false && fs.existsSync(target.fsPath)) {
                        throw new Error(`Target already exists: ${target.fsPath}`);
                    }
                    await fsp.mkdir(path.dirname(target.fsPath), { recursive: true });
                    await fsp.rename(source.fsPath, target.fsPath);
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
            activeTextEditor: undefined as any,
            visibleTextEditors: [] as any[],
            async showInformationMessage(): Promise<undefined> { return undefined; },
            async showWarningMessage(): Promise<undefined> { return undefined; },
            async showErrorMessage(): Promise<undefined> { return undefined; },
            async showQuickPick(): Promise<undefined> { return undefined; },
            async showInputBox(): Promise<undefined> { return undefined; },
            async showTextDocument(docOrUri: any) {
                const doc = docOrUri && typeof docOrUri.getText === 'function'
                    ? docOrUri
                    : await shim.workspace.openTextDocument(docOrUri);
                const editor = { document: doc };
                shim.window.activeTextEditor = editor;
                return editor;
            },
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
                if (
                    id === 'vscode.executeDefinitionProvider' ||
                    id === 'vscode.executeTypeDefinitionProvider' ||
                    id === 'vscode.executeImplementationProvider'
                ) {
                    const [uri, pos] = args as [HeadlessUri, HeadlessPosition];
                    if (!uri || !pos) return [];
                    return await findHeadlessSymbolLocations(uri, pos, 'definition', true);
                }
                if (id === 'vscode.executeReferenceProvider') {
                    const [uri, pos, includeDecl] = args as [HeadlessUri, HeadlessPosition, boolean | undefined];
                    if (!uri || !pos) return [];
                    return await findHeadlessSymbolLocations(uri, pos, 'references', includeDecl ?? true);
                }
                if (id === 'vscode.executeDocumentRenameProvider') {
                    const [uri, pos, newName] = args as [HeadlessUri, HeadlessPosition, string];
                    if (!uri || !pos || !newName) return undefined;
                    const locations = await findHeadlessSymbolLocations(uri, pos, 'references', true);
                    const wsEdit = new HeadlessWorkspaceEdit();
                    for (const loc of locations) {
                        wsEdit.replace(loc.uri, loc.range, String(newName));
                    }
                    return wsEdit;
                }
                if (id === 'vscode.executeCodeActionProvider') {
                    const [uri, range] = args as [HeadlessUri, HeadlessRange];
                    if (!uri || !range) return [];
                    const actions: HeadlessCodeAction[] = [];
                    try {
                        const doc = await shim.workspace.openTextDocument(uri);
                        const lineObj = doc.lineAt(range.start.line);
                        const trimmedRight = lineObj.text.replace(/[ \t]+$/, '');
                        if (trimmedRight.length < lineObj.text.length) {
                            const action = new HeadlessCodeAction('Trim trailing whitespace on line', HeadlessCodeActionKind.QuickFix);
                            action.isPreferred = true;
                            const edit = new HeadlessWorkspaceEdit();
                            edit.replace(uri, new HeadlessRange(range.start.line, 0, range.start.line, lineObj.text.length), trimmedRight);
                            action.edit = edit;
                            actions.push(action);
                        }
                        if (/\bvar\s+[A-Za-z_$]/.test(lineObj.text)) {
                            const action = new HeadlessCodeAction('Convert var to const', HeadlessCodeActionKind.RefactorRewrite);
                            action.isPreferred = true;
                            const edit = new HeadlessWorkspaceEdit();
                            edit.replace(
                                uri,
                                new HeadlessRange(range.start.line, 0, range.start.line, lineObj.text.length),
                                lineObj.text.replace(/\bvar\s+/, 'const ')
                            );
                            action.edit = edit;
                            actions.push(action);
                        }
                    } catch {
                        /* ignore */
                    }
                    return actions;
                }
                if (id === 'workbench.action.reloadWindow' || id === 'typescript.restartTsServer' || id === 'notifications.clearAll') {
                    return { ok: true, mode: 'headless-noop', command: id };
                }
                return undefined;
            },
            async getCommands(): Promise<string[]> {
                return [
                    ...registeredCommands.keys(),
                    'vscode.executeDefinitionProvider',
                    'vscode.executeTypeDefinitionProvider',
                    'vscode.executeImplementationProvider',
                    'vscode.executeReferenceProvider',
                    'vscode.executeDocumentRenameProvider',
                    'vscode.executeCodeActionProvider',
                ];
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
            getDiagnostics(resource?: HeadlessUri): any {
                if (resource) {
                    const key = path.resolve(resource.fsPath);
                    const collected: HeadlessDiagnostic[] = [...computeFileDiagnosticsSync(key)];
                    for (const col of customDiagnostics.values()) {
                        const hit = col.get(key);
                        if (hit) collected.push(...hit.diags);
                    }
                    return collected;
                }
                const byFile = new Map<string, [HeadlessUri, HeadlessDiagnostic[]]>();
                for (const col of customDiagnostics.values()) {
                    for (const [k, v] of col.entries()) {
                        const prev = byFile.get(k);
                        if (prev) prev[1].push(...v.diags);
                        else byFile.set(k, [v.uri, [...v.diags]]);
                    }
                }
                return [...byFile.values()];
            },
            createDiagnosticCollection(name: string) {
                let store = customDiagnostics.get(name);
                if (!store) {
                    store = new Map();
                    customDiagnostics.set(name, store);
                }
                return {
                    name,
                    set(uri: HeadlessUri, diags: HeadlessDiagnostic[] | undefined) {
                        const key = path.resolve(uri.fsPath);
                        if (!diags || diags.length === 0) store!.delete(key);
                        else store!.set(key, { uri: HeadlessUri.file(key), diags: [...diags] });
                    },
                    delete(uri: HeadlessUri) {
                        store!.delete(path.resolve(uri.fsPath));
                    },
                    clear() {
                        store!.clear();
                    },
                    dispose() {
                        customDiagnostics.delete(name);
                    },
                };
            },
        },
        chat: {
            createChatParticipant() {
                return { iconPath: undefined, followupProvider: undefined, dispose() {} };
            },
        },
    };
    g.__harmonyVscodeShimSingleton = shim;
    return shim;
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

export function isRunningInRealVscodeHost(): boolean {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const vsc = require('vscode');
        const g = globalThis as Record<string, any>;
        return Boolean(
            vsc &&
            vsc !== g.__harmonyVscodeShimSingleton &&
            vsc.env?.appName !== 'Harmony Headless Host'
        );
    } catch {
        return false;
    }
}

function readPackageManifestToolNames(): string[] {
    try {
        const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
        const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const lmTools: any[] = raw?.contributes?.languageModelTools ?? [];
        return lmTools
            .map(e => (e && typeof e.name === 'string' ? e.name : ''))
            .filter(name => name.startsWith('harmony_'))
            .sort();
    } catch {
        return [];
    }
}

/**
 * Register all Harmony LanguageModelTools into the headless registry so they can
 * be invoked from CLI, MCP, or other headless hosts.
 * When called inside the real VS Code extension host, returns the registered
 * Harmony tool count without re-registering tools or touching SecretStorage.
 */
export function ensureHeadlessHarmonyToolsRegistered(workspaceRoot = activeWorkspaceRoot): number {
    if (workspaceRoot) setHeadlessWorkspaceRoot(workspaceRoot);
    if (isRunningInRealVscodeHost()) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const vsc = require('vscode') as typeof import('vscode');
        const liveHarmonyTools = (vsc.lm?.tools ?? []).filter(t => t.name.startsWith('harmony_'));
        return liveHarmonyTools.length > 0 ? liveHarmonyTools.length : readPackageManifestToolNames().length;
    }
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
    if (isRunningInRealVscodeHost()) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const vsc = require('vscode') as typeof import('vscode');
        const liveNames = (vsc.lm?.tools ?? [])
            .map(t => t.name)
            .filter(name => name.startsWith('harmony_'))
            .sort();
        return liveNames.length > 0 ? liveNames : readPackageManifestToolNames();
    }
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
    const normalized = toolName.startsWith('harmony_') ? toolName : `harmony_${toolName}`;
    if (isRunningInRealVscodeHost()) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const vsc = require('vscode') as typeof import('vscode');
        const cts = new vsc.CancellationTokenSource();
        const timer = setTimeout(() => cts.cancel(), Math.max(1000, timeoutMs));
        try {
            const raw = await vsc.lm.invokeTool(normalized, { input, toolInvocationToken: undefined }, cts.token);
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

    ensureHeadlessHarmonyToolsRegistered(workspaceRoot);
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
