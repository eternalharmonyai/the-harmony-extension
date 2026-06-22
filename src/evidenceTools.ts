import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as cp from 'child_process';

const MAX_RESULT_CHARS = 60000;
const LEDGER_PATH = '.harmony/source-ledger.json';

function clip(text: string): string {
    if (text.length <= MAX_RESULT_CHARS) return text;
    return text.slice(0, MAX_RESULT_CHARS) + `\n...[truncated, ${text.length - MAX_RESULT_CHARS} more chars]`;
}

function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(clip(text))]);
}

function workspaceFoldersByPriority(): readonly vscode.WorkspaceFolder[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const active = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
    if (!activeFolder) return folders;
    return [activeFolder, ...folders.filter(folder => folder.uri.toString() !== activeFolder.uri.toString())];
}

function workspaceRoot(): string | undefined {
    return workspaceFoldersByPriority()[0]?.uri.fsPath;
}

function resolveWorkspacePath(inputPath = '.'): string | undefined {
    const folders = workspaceFoldersByPriority();
    if (folders.length === 0) return undefined;
    for (const folder of folders) {
        const root = folder.uri.fsPath;
        const normalized = inputPath.replace(/\\/g, '/');
        const folderPrefix = `${folder.name}/`;
        const relativePath = normalized.startsWith(folderPrefix) ? normalized.slice(folderPrefix.length) : inputPath;
        const resolved = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(root, relativePath || '.');
        const rel = path.relative(root, resolved);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) return resolved;
    }
    return undefined;
}

function relPath(absPath: string): string {
    const root = workspaceRoot();
    return root ? path.relative(root, absPath).replace(/\\/g, '/') || '.' : absPath;
}

function normalizePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function section(title: string, body: string | string[]): string {
    return `## ${title}\n\n${Array.isArray(body) ? (body.length ? body.map(item => `- ${item}`).join('\n') : '- (none)') : body}`;
}

function stripHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function htmlTitle(raw: string): string | undefined {
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
    return match ? stripHtml(match[1]).slice(0, 180) : undefined;
}

function words(text: string): string[] {
    const stop = new Set(['about', 'after', 'again', 'also', 'because', 'before', 'between', 'could', 'from', 'have', 'into', 'should', 'their', 'there', 'these', 'this', 'that', 'with', 'would']);
    return Array.from(new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter(word => !stop.has(word))));
}

function snippetsFor(query: string, text: string, maxSnippets: number): string[] {
    const terms = words(query).slice(0, 12);
    const chunks = text
        .split(/(?<=[.!?])\s+|\n{2,}/)
        .map(chunk => chunk.trim())
        .filter(chunk => chunk.length >= 60);
    const scored = chunks.map(chunk => {
        const lower = chunk.toLowerCase();
        const score = terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
        return { chunk, score };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.chunk.length - a.chunk.length);
    const picked = (scored.length ? scored.map(item => item.chunk) : chunks).slice(0, maxSnippets);
    return picked.map(chunk => chunk.length > 700 ? chunk.slice(0, 700) + '...' : chunk);
}

async function readJsonFile<T>(absPath: string): Promise<T | undefined> {
    try { return JSON.parse(await fs.readFile(absPath, 'utf8')) as T; } catch { return undefined; }
}

async function pathExists(absPath: string): Promise<boolean> {
    return fs.access(absPath).then(() => true).catch(() => false);
}

interface ProcessRun {
    ok: boolean;
    stdout: string;
    stderr: string;
    code?: number | string | null;
    error?: string;
}

function npmCommand(): string {
    return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function execFile(command: string, args: string[], cwd: string, timeoutMs: number): Promise<ProcessRun> {
    return new Promise(resolve => {
        cp.execFile(command, args, {
            cwd,
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 20 * 1024 * 1024,
        }, (err, stdout, stderr) => {
            resolve({
                ok: !err,
                stdout: stdout ?? '',
                stderr: stderr ?? '',
                code: err ? (err as cp.ExecFileException).code : 0,
                error: err ? err.message : undefined,
            });
        }).on('error', error => resolve({ ok: false, stdout: '', stderr: '', error: error.message }));
    });
}

async function runGit(args: string[], timeoutMs = 60000): Promise<ProcessRun> {
    const root = workspaceRoot();
    if (!root) return { ok: false, stdout: '', stderr: '', error: 'no workspace folder is open' };
    return execFile('git', args, root, timeoutMs);
}

interface SourceFetch {
    url: string;
    finalUrl: string;
    fetchedAt: string;
    ok: boolean;
    status: number;
    contentType: string;
    lastModified?: string;
    title?: string;
    text: string;
    sha256: string;
    error?: string;
}

async function fetchSource(url: string, maxChars: number, timeoutMs: number): Promise<SourceFetch> {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error(`invalid URL: ${url}`); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`only http(s) URLs are allowed: ${url}`);
    const fetchedAt = new Date().toISOString();
    try {
        const response = await fetch(parsed.toString(), {
            headers: { 'User-Agent': 'Harmony-Evidence-Tools/0.2.45' },
            signal: AbortSignal.timeout(timeoutMs),
        });
        const raw = await response.text();
        const contentType = response.headers.get('content-type') ?? '';
        const text = contentType.includes('html') ? stripHtml(raw) : raw.replace(/\s+/g, ' ').trim();
        const clipped = text.length > maxChars ? text.slice(0, maxChars) + `\n...[source clipped at ${maxChars} chars]` : text;
        return {
            url,
            finalUrl: response.url || url,
            fetchedAt,
            ok: response.ok,
            status: response.status,
            contentType,
            lastModified: response.headers.get('last-modified') ?? undefined,
            title: contentType.includes('html') ? htmlTitle(raw) : undefined,
            text: clipped,
            sha256: crypto.createHash('sha256').update(text).digest('hex'),
            error: response.ok ? undefined : `HTTP ${response.status}`,
        };
    } catch (error: any) {
        return {
            url,
            finalUrl: url,
            fetchedAt,
            ok: false,
            status: 0,
            contentType: '',
            text: '',
            sha256: crypto.createHash('sha256').update('').digest('hex'),
            error: error?.message ?? String(error),
        };
    }
}

interface SourceLedgerEntry {
    id: string;
    query: string;
    mode: string;
    url: string;
    finalUrl: string;
    title?: string;
    fetchedAt: string;
    lastModified?: string;
    contentType: string;
    status: number;
    ok: boolean;
    sha256: string;
    note?: string;
}

interface SourceLedgerFile {
    version: 1;
    updatedAt: string;
    entries: SourceLedgerEntry[];
}

async function ledgerAbsPath(): Promise<string> {
    const abs = resolveWorkspacePath(LEDGER_PATH);
    if (!abs) throw new Error('no workspace folder is open');
    return abs;
}

async function readLedger(): Promise<SourceLedgerFile> {
    const abs = await ledgerAbsPath();
    return (await readJsonFile<SourceLedgerFile>(abs)) ?? { version: 1, updatedAt: new Date().toISOString(), entries: [] };
}

async function writeLedger(ledger: SourceLedgerFile): Promise<void> {
    const abs = await ledgerAbsPath();
    await fs.mkdir(path.dirname(abs), { recursive: true });
    ledger.updatedAt = new Date().toISOString();
    ledger.entries = ledger.entries.slice(-1000);
    await fs.writeFile(abs, JSON.stringify(ledger, null, 2), 'utf8');
}

function planOnlyMode(): boolean {
    return vscode.workspace.getConfiguration('harmony').get<boolean>('planOnlyMode') ?? false;
}

interface CurrentResearchInput {
    query: string;
    source_urls?: string[];
    mode?: 'brief' | 'dossier';
    max_chars_per_source?: number;
    write_ledger?: boolean;
}

class CurrentResearchTool implements vscode.LanguageModelTool<CurrentResearchInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<CurrentResearchInput>) {
        const query = options.input.query?.trim();
        if (!query) return textResult('error: missing argument: query');
        const urls = Array.from(new Set((options.input.source_urls ?? []).map(url => url.trim()).filter(Boolean))).slice(0, 12);
        const mode = options.input.mode ?? 'brief';
        if (urls.length === 0) {
            return textResult([
                '# Current Research Needs Sources',
                '',
                `Query: ${query}`,
                '',
                'This tool is source-backed. Provide `source_urls` from current pages, docs, papers, changelogs, pricing pages, or official announcements.',
                '',
                section('Recommended Source Mix', [
                    'Official documentation or pricing page for factual API/product claims.',
                    'Release notes or changelog for current feature availability.',
                    'Independent benchmark or review when comparing quality claims.',
                    'Primary source first, commentary second.',
                ])
            ].join('\n'));
        }

        const maxChars = Math.max(2000, Math.min(60000, Number(options.input.max_chars_per_source) || (mode === 'dossier' ? 30000 : 12000)));
        const fetched = [] as SourceFetch[];
        for (const url of urls) fetched.push(await fetchSource(url, maxChars, 20000));

        const shouldWriteLedger = options.input.write_ledger !== false && !planOnlyMode();
        let ledgerNote = planOnlyMode() && options.input.write_ledger !== false ? 'Plan-only mode is enabled; source ledger write was skipped.' : 'Source ledger write disabled.';
        if (shouldWriteLedger) {
            const ledger = await readLedger();
            for (const source of fetched) {
                ledger.entries.push({
                    id: crypto.randomUUID(),
                    query,
                    mode,
                    url: source.url,
                    finalUrl: source.finalUrl,
                    title: source.title,
                    fetchedAt: source.fetchedAt,
                    lastModified: source.lastModified,
                    contentType: source.contentType,
                    status: source.status,
                    ok: source.ok,
                    sha256: source.sha256,
                    note: source.error,
                });
            }
            await writeLedger(ledger);
            ledgerNote = `Source ledger updated: ${LEDGER_PATH}`;
        }

        const rows = fetched.map((source, index) => `| ${index + 1} | ${source.ok ? 'ok' : 'error'} | ${source.status || ''} | ${source.title ?? '(untitled)'} | ${source.lastModified ?? '(not provided)'} | ${source.finalUrl.replace(/\|/g, '/')} |`);
        const sourceNotes = fetched.map((source, index) => {
            if (!source.ok) return `### Source ${index + 1}: ${source.url}\n\nFetch failed: ${source.error ?? 'unknown error'}`;
            const snippets = snippetsFor(query, source.text, mode === 'dossier' ? 6 : 3);
            return [`### Source ${index + 1}: ${source.title ?? source.finalUrl}`,
                '',
                `URL: ${source.finalUrl}`,
                `Fetched: ${source.fetchedAt}`,
                `Last-Modified: ${source.lastModified ?? 'not provided'}`,
                `Content-Type: ${source.contentType || 'not provided'}`,
                `SHA256: ${source.sha256.slice(0, 16)}`,
                '',
                snippets.map(snippet => `> ${snippet.replace(/\n/g, ' ')}`).join('\n\n') || '(no matching snippets extracted)'
            ].join('\n');
        });

        const dossierSections = mode === 'dossier' ? [
            '',
            section('Dossier Review Checklist', [
                'Separate what each source directly says from interpretation.',
                'Check publication or last-modified dates before calling anything current.',
                'Look for contradictions across sources before writing recommendations.',
                'Prefer official docs for pricing, API availability, and deprecation claims.',
                'Name any missing source type before making a confident conclusion.',
            ]),
            '',
            section('Contradiction Watch', fetched.length >= 2 ? 'Compare source snippets above. This tool does not silently resolve conflicts; the model must cite the exact source that supports each claim.' : 'Only one source was provided, so contradictions cannot be checked yet.'),
        ] : [];

        return textResult([
            `# Current Research ${mode === 'dossier' ? 'Dossier' : 'Brief'}`,
            '',
            `Generated: ${new Date().toISOString()}`,
            `Query: ${query}`,
            `Currentness rule: claims are only as current as the fetched source timestamps below.`,
            `Ledger: ${ledgerNote}`,
            '',
            '| # | Fetch | Status | Title | Last Modified | URL |',
            '|---:|---|---:|---|---|---|',
            ...rows,
            '',
            section('How To Use This Output', [
                'Use the source table for citations and freshness checks.',
                'Use snippets as evidence candidates, not as proof by themselves.',
                'Do not invent missing pricing, dates, features, or benchmarks.',
            ]),
            '',
            '## Source Notes',
            '',
            sourceNotes.join('\n\n'),
            ...dossierSections,
        ].join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<CurrentResearchInput>) {
        return { invocationMessage: `Building source-backed research ${options.input.mode ?? 'brief'}` };
    }
}

interface ResearchDossierInput extends Omit<CurrentResearchInput, 'mode'> {
    focus?: string;
}

class ResearchDossierTool implements vscode.LanguageModelTool<ResearchDossierInput> {
    private readonly currentResearch = new CurrentResearchTool();

    async invoke(options: vscode.LanguageModelToolInvocationOptions<ResearchDossierInput>) {
        const query = options.input.focus?.trim()
            ? `${options.input.query}\n\nDossier focus: ${options.input.focus.trim()}`
            : options.input.query;
        return this.currentResearch.invoke({
            ...options,
            input: {
                ...options.input,
                query,
                mode: 'dossier',
                max_chars_per_source: options.input.max_chars_per_source ?? 30000,
            },
        } as vscode.LanguageModelToolInvocationOptions<CurrentResearchInput>);
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ResearchDossierInput>) {
        return { invocationMessage: `Building research dossier for ${(options.input.query ?? '').slice(0, 60)}` };
    }
}

interface SourceLedgerInput {
    action?: 'list' | 'read' | 'append';
    query?: string;
    url?: string;
    title?: string;
    note?: string;
    limit?: number;
    format?: 'markdown' | 'json';
}

class SourceLedgerTool implements vscode.LanguageModelTool<SourceLedgerInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SourceLedgerInput>) {
        const action = options.input.action ?? 'list';
        if (action === 'append') {
            if (planOnlyMode()) return textResult('error: plan-only mode is enabled; source ledger append is not allowed.');
            const url = options.input.url?.trim();
            if (!url) return textResult('error: append requires url');
            const ledger = await readLedger();
            ledger.entries.push({
                id: crypto.randomUUID(),
                query: options.input.query?.trim() || 'manual source',
                mode: 'manual',
                url,
                finalUrl: url,
                title: options.input.title?.trim() || undefined,
                fetchedAt: new Date().toISOString(),
                contentType: 'manual',
                status: 0,
                ok: true,
                sha256: crypto.createHash('sha256').update(`${url}\n${options.input.note ?? ''}`).digest('hex'),
                note: options.input.note,
            });
            await writeLedger(ledger);
            return textResult(`Source ledger appended: ${LEDGER_PATH}`);
        }

        const ledger = await readLedger();
        const limit = Math.max(1, Math.min(200, Number(options.input.limit) || 25));
        const query = options.input.query?.trim().toLowerCase();
        const entries = ledger.entries
            .filter(entry => !query || entry.query.toLowerCase().includes(query) || entry.url.toLowerCase().includes(query) || (entry.title ?? '').toLowerCase().includes(query))
            .slice(-limit)
            .reverse();
        if (options.input.format === 'json' || action === 'read') {
            return textResult(JSON.stringify({ path: LEDGER_PATH, updatedAt: ledger.updatedAt, count: ledger.entries.length, entries }, null, 2));
        }
        const rows = entries.map(entry => `| ${entry.fetchedAt} | ${entry.ok ? 'ok' : 'error'} | ${entry.query.replace(/\|/g, '/')} | ${entry.title ?? ''} | ${entry.finalUrl.replace(/\|/g, '/')} |`);
        return textResult([
            '# Harmony Source Ledger',
            '',
            `Path: ${LEDGER_PATH}`,
            `Updated: ${ledger.updatedAt}`,
            `Total entries: ${ledger.entries.length}`,
            query ? `Filter: ${query}` : '',
            '',
            '| Fetched | Status | Query | Title | URL |',
            '|---|---|---|---|---|',
            ...(rows.length ? rows : ['| (none) |  |  |  |  |']),
        ].filter(Boolean).join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SourceLedgerInput>) {
        return { invocationMessage: options.input.action === 'append' ? 'Appending source ledger entry' : 'Reading source ledger' };
    }
}

interface RepoMapInput { max_files?: number; max_depth?: number; include_hidden?: boolean; include_routes?: boolean; }

const WALK_EXCLUDES = new Set(['.git', '.harmony', 'node_modules', 'out', 'dist', 'build', 'coverage', '.venv', 'venv', '__pycache__', '_extract_0.2.12', '_extract_0.2.13', '_extract_0.2.14', '_extract_0.2.15', '_extract_0.2.17', '_extract_0.2.18']);

interface FileEntry { path: string; depth: number; }

async function walkWorkspace(root: string, maxFiles: number, maxDepth: number, includeHidden: boolean): Promise<FileEntry[]> {
    const files: FileEntry[] = [];
    async function walk(absDir: string, depth: number): Promise<void> {
        if (depth > maxDepth || files.length >= maxFiles) return;
        let entries: import('fs').Dirent[];
        try { entries = await fs.readdir(absDir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (files.length >= maxFiles) return;
            if (!includeHidden && entry.name.startsWith('.')) continue;
            if (WALK_EXCLUDES.has(entry.name)) continue;
            const abs = path.join(absDir, entry.name);
            const rel = normalizePath(path.relative(root, abs));
            if (entry.isDirectory()) {
                await walk(abs, depth + 1);
            } else if (entry.isFile()) {
                files.push({ path: rel, depth });
            }
        }
    }
    await walk(root, 0);
    return files;
}

function dependencyNames(pkg: any): string[] {
    return Object.keys({ ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}), ...(pkg?.peerDependencies ?? {}) });
}

function detectFrameworks(pkg: any, files: string[]): string[] {
    const deps = new Set(dependencyNames(pkg).map(dep => dep.toLowerCase()));
    const signals = [
        deps.has('react') ? 'React' : undefined,
        deps.has('next') || files.some(file => file === 'next.config.js' || file === 'next.config.ts') ? 'Next.js' : undefined,
        deps.has('vue') ? 'Vue' : undefined,
        deps.has('svelte') || deps.has('@sveltejs/kit') ? 'Svelte/SvelteKit' : undefined,
        deps.has('@angular/core') ? 'Angular' : undefined,
        deps.has('vite') || files.some(file => file.startsWith('vite.config.')) ? 'Vite' : undefined,
        deps.has('express') ? 'Express' : undefined,
        deps.has('fastify') ? 'Fastify' : undefined,
        deps.has('typescript') || files.includes('tsconfig.json') ? 'TypeScript' : undefined,
        deps.has('tailwindcss') || files.some(file => file.includes('tailwind.config')) ? 'Tailwind CSS' : undefined,
        deps.has('@playwright/test') || files.some(file => file.includes('playwright.config')) ? 'Playwright' : undefined,
        deps.has('vitest') ? 'Vitest' : undefined,
        deps.has('jest') ? 'Jest' : undefined,
        deps.has('vscode') || pkg?.engines?.vscode ? 'VS Code extension' : undefined,
    ];
    return signals.filter(Boolean) as string[];
}

class RepoMapTool implements vscode.LanguageModelTool<RepoMapInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<RepoMapInput>) {
        const root = workspaceRoot();
        if (!root) return textResult('error: no workspace folder is open');
        const maxFiles = Math.max(100, Math.min(5000, Number(options.input.max_files) || 1200));
        const maxDepth = Math.max(1, Math.min(12, Number(options.input.max_depth) || 5));
        const files = await walkWorkspace(root, maxFiles, maxDepth, options.input.include_hidden === true);
        const filePaths = files.map(file => file.path).sort();
        const pkg = await readJsonFile<any>(path.join(root, 'package.json'));
        const scripts = Object.keys(pkg?.scripts ?? {});
        const frameworks = detectFrameworks(pkg, filePaths);
        const entrySignals = [pkg?.main ? `package main: ${pkg.main}` : undefined,
            ...filePaths.filter(file => /(^src\/(main|index|app|extension)\.(t|j)sx?$)|(^app\/(page|layout)\.(t|j)sx?$)|(^pages\/index\.(t|j)sx?$)/i.test(file)).slice(0, 20)
        ].filter(Boolean) as string[];
        const routeFiles = options.input.include_routes === false ? [] : filePaths
            .filter(file => /(^|\/)(pages|app|routes)\//.test(file) && /\.(t|j)sx?$/.test(file))
            .slice(0, 60);
        const configFiles = filePaths.filter(file => /(^|\/)(package.json|tsconfig.json|vite.config|next.config|svelte.config|angular.json|playwright.config|vitest.config|jest.config|tailwind.config|eslint.config|\.eslintrc|pyproject.toml|requirements.txt|Cargo.toml|go.mod)/.test(file)).slice(0, 80);
        const testFiles = filePaths.filter(file => /(test|spec)\.(t|j)sx?$|__tests__|playwright/.test(file)).slice(0, 60);
        return textResult([
            '# Harmony Repo Map',
            '',
            `Workspace: ${path.basename(root)}`,
            `Root: ${root}`,
            `Files scanned: ${filePaths.length}${filePaths.length >= maxFiles ? ` (hit cap ${maxFiles})` : ''}`,
            `Generated: ${new Date().toISOString()}`,
            '',
            section('Detected Stack', frameworks.length ? frameworks : ['No strong framework signals found yet.']),
            '',
            section('Scripts', scripts.length ? scripts.map(script => `${script}: ${pkg.scripts[script]}`) : ['No package scripts found.']),
            '',
            section('Likely Entry Points', entrySignals.length ? entrySignals : ['No common entry points detected in scan depth.']),
            '',
            section('Route/Page Signals', routeFiles.length ? routeFiles : ['No route/page files detected or route scan disabled.']),
            '',
            section('Configuration Files', configFiles.length ? configFiles : ['No common config files detected.']),
            '',
            section('Test Signals', testFiles.length ? testFiles : ['No test files detected in scan depth.']),
            '',
            section('Suggested Next Project-Diving Steps', [
                'Read the likely entry point and nearest route/component before editing.',
                'Run dependency audit before installing packages or changing framework config.',
                'Use repo health scan or diagnostics before broad refactors.',
            ])
        ].join('\n'));
    }

    async prepareInvocation() { return { invocationMessage: 'Mapping active workspace' }; }
}

interface RouteMapInput {
    max_files?: number;
    max_depth?: number;
    max_routes?: number;
    include_components?: boolean;
}

function appRouteFromFile(file: string): string | undefined {
    const normalized = normalizePath(file);
    let route: string | undefined;
    const appMatch = /^(?:src\/)?app\/(.*)\/(page|layout|route)\.(t|j)sx?$/.exec(normalized);
    if (appMatch) route = appMatch[1];
    const pagesMatch = /^(?:src\/)?pages\/(.*)\.(t|j)sx?$/.exec(normalized);
    if (pagesMatch) route = pagesMatch[1].replace(/\/index$/, '');
    const routeMatch = /^(?:src\/)?routes\/(.*)\.(t|j)sx?$/.exec(normalized);
    if (routeMatch) route = routeMatch[1].replace(/\/index$/, '');
    if (route === undefined) return undefined;
    const parts = route.split('/').filter(part => part && !part.startsWith('(') && !part.startsWith('@'));
    const mapped = parts.map(part => {
        if (/^\[\.\.\.(.+)\]$/.test(part)) return `*${part.slice(4, -1)}`;
        if (/^\[(.+)\]$/.test(part)) return `:${part.slice(1, -1)}`;
        return part;
    });
    return '/' + mapped.join('/');
}

async function importSignals(root: string, file: string): Promise<string[]> {
    try {
        const text = await fs.readFile(path.join(root, file), 'utf8');
        return Array.from(text.matchAll(/import\s+(?:[^'\"]+\s+from\s+)?['\"]([^'\"]+)['\"]/g))
            .map(match => String(match[1]))
            .filter(value => value.startsWith('.') || value.startsWith('@/'))
            .slice(0, 8);
    } catch {
        return [];
    }
}

class RouteMapTool implements vscode.LanguageModelTool<RouteMapInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<RouteMapInput>) {
        const root = workspaceRoot();
        if (!root) return textResult('error: no workspace folder is open');
        const maxFiles = Math.max(100, Math.min(5000, Number(options.input.max_files) || 2000));
        const maxDepth = Math.max(1, Math.min(12, Number(options.input.max_depth) || 8));
        const maxRoutes = Math.max(10, Math.min(300, Number(options.input.max_routes) || 120));
        const files = (await walkWorkspace(root, maxFiles, maxDepth, false)).map(file => file.path).sort();
        const routes = files
            .map(file => ({ file, route: appRouteFromFile(file) }))
            .filter((item): item is { file: string; route: string } => !!item.route)
            .slice(0, maxRoutes);
        const components = options.input.include_components === false ? [] : files
            .filter(file => /(^|\/)(components|ui|views|layouts)\//.test(file) && /\.(t|j)sx?$/.test(file))
            .slice(0, 80);
        const routeRows: string[] = [];
        for (const item of routes) {
            const imports = await importSignals(root, item.file);
            routeRows.push(`| ${item.route.replace(/\|/g, '/')} | ${item.file} | ${imports.join(', ') || '(no local imports sampled)'} |`);
        }
        return textResult([
            '# Harmony Route Map',
            '',
            `Workspace: ${path.basename(root)}`,
            `Generated: ${new Date().toISOString()}`,
            `Files scanned: ${files.length}${files.length >= maxFiles ? ` (hit cap ${maxFiles})` : ''}`,
            '',
            '| Route | File | Local Import Signals |',
            '|---|---|---|',
            ...(routeRows.length ? routeRows : ['| (none detected) |  |  |']),
            '',
            section('Component/Layout Signals', components.length ? components : ['No common component/layout folders detected in scan depth.']),
            '',
            section('Next Checks', [
                'Read the route file and nearest imported component before editing UI behavior.',
                'Use harmony_page_inspect or responsive screenshots once a route is running locally.',
                'For non-file-based routers, grep for router creation/useRoutes/createBrowserRouter next.',
            ])
        ].join('\n'));
    }

    async prepareInvocation() { return { invocationMessage: 'Mapping app routes and page components' }; }
}

interface DependencyAuditInput { include_dev?: boolean; include_scripts?: boolean; top?: number; }

class DependencyAuditTool implements vscode.LanguageModelTool<DependencyAuditInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<DependencyAuditInput>) {
        const root = workspaceRoot();
        if (!root) return textResult('error: no workspace folder is open');
        const pkgPath = path.join(root, 'package.json');
        const pkg = await readJsonFile<any>(pkgPath);
        if (!pkg) return textResult('error: no package.json found at workspace root');
        const top = Math.max(5, Math.min(100, Number(options.input.top) || 40));
        const deps = Object.entries(pkg.dependencies ?? {}) as Array<[string, string]>;
        const devDeps = Object.entries(pkg.devDependencies ?? {}) as Array<[string, string]>;
        const optionalDeps = Object.entries(pkg.optionalDependencies ?? {}) as Array<[string, string]>;
        const peerDeps = Object.entries(pkg.peerDependencies ?? {}) as Array<[string, string]>;
        const scripts = Object.entries(pkg.scripts ?? {}) as Array<[string, string]>;
        const packageManagers = [
            await pathExists(path.join(root, 'package-lock.json')) ? 'package-lock.json' : undefined,
            await pathExists(path.join(root, 'pnpm-lock.yaml')) ? 'pnpm-lock.yaml' : undefined,
            await pathExists(path.join(root, 'yarn.lock')) ? 'yarn.lock' : undefined,
            pkg.packageManager ? `packageManager: ${pkg.packageManager}` : undefined,
        ].filter(Boolean) as string[];
        const allDeps = [...deps, ...(options.input.include_dev === false ? [] : devDeps), ...optionalDeps, ...peerDeps];
        const broadRanges = allDeps.filter(([, version]) => /^[*xX]$|latest|next/.test(String(version))).map(([name, version]) => `${name}@${version}`).slice(0, top);
        const workspaceProtocols = allDeps.filter(([, version]) => String(version).startsWith('workspace:') || String(version).startsWith('file:')).map(([name, version]) => `${name}@${version}`).slice(0, top);
        const installScripts = scripts.filter(([name]) => /preinstall|install|postinstall|prepare/.test(name)).map(([name, script]) => `${name}: ${script}`);
        const directRows = deps.slice(0, top).map(([name, version]) => `${name}@${version}`);
        const devRows = devDeps.slice(0, top).map(([name, version]) => `${name}@${version}`);
        return textResult([
            '# Harmony Dependency Audit',
            '',
            `Workspace: ${path.basename(root)}`,
            `Package: ${pkg.name ?? '(unnamed)'} ${pkg.version ?? ''}`.trim(),
            `Private: ${pkg.private === true ? 'yes' : 'no'}`,
            `License: ${pkg.license ?? '(not specified)'}`,
            `Generated: ${new Date().toISOString()}`,
            '',
            section('Package Manager / Lockfiles', packageManagers.length ? packageManagers : ['No lockfile or packageManager field detected.']),
            '',
            section('Dependency Counts', [
                `dependencies: ${deps.length}`,
                `devDependencies: ${devDeps.length}`,
                `optionalDependencies: ${optionalDeps.length}`,
                `peerDependencies: ${peerDeps.length}`,
            ]),
            '',
            section('Direct Dependencies', directRows.length ? directRows : ['No dependencies listed.']),
            '',
            options.input.include_dev === false ? '' : section('Dev Dependencies', devRows.length ? devRows : ['No devDependencies listed.']),
            '',
            section('Scripts Of Interest', options.input.include_scripts === false ? ['Script scan disabled.'] : (scripts.length ? scripts.map(([name, script]) => `${name}: ${script}`).slice(0, top) : ['No scripts listed.'])),
            '',
            section('Install-Time Script Warning', installScripts.length ? installScripts : ['No install/preinstall/postinstall/prepare scripts found.']),
            '',
            section('Version Range Watch', broadRanges.length ? broadRanges : ['No latest/*/x version ranges found in scanned dependencies.']),
            '',
            section('Local/Workspace Dependency Watch', workspaceProtocols.length ? workspaceProtocols : ['No workspace:/file: dependency ranges found.']),
            '',
            section('Limits Of This Audit', [
                'This first pass is local-only and does not query npm registry or vulnerability databases.',
                'Use the package manager audit/outdated command separately when network checks are desired.',
                'Treat install scripts and lockfile changes as higher-risk review points.',
            ])
        ].filter(Boolean).join('\n'));
    }

    async prepareInvocation() { return { invocationMessage: 'Auditing local dependency metadata' }; }
}

interface TestProbeInput {
    changed_files?: string[];
    focus?: string;
    run?: boolean;
    command?: string;
    timeout_sec?: number;
}

interface TestCandidate {
    script: string;
    command: string;
    reason: string;
}

function selectTestCandidates(pkg: any, changedFiles: string[], focus?: string): TestCandidate[] {
    const scripts = Object.keys(pkg?.scripts ?? {});
    const candidates: TestCandidate[] = [];
    const add = (script: string, reason: string) => {
        if (scripts.includes(script) && !candidates.some(item => item.script === script)) {
            candidates.push({ script, command: `npm run ${script}`, reason });
        }
    };
    const joined = `${changedFiles.join('\n')}\n${focus ?? ''}`.toLowerCase();
    if (/\.tsx?$|tsconfig|package/.test(joined)) add('compile', 'TypeScript/package change; compile is the cheapest broad contract check.');
    if (/test|spec|__tests__/.test(joined)) add('test', 'Touched test-like paths; run the project test script.');
    if (/\.tsx?$|\.jsx?$|eslint|lint/.test(joined)) add('lint', 'Code or lint config changed; lint may catch style/static issues.');
    for (const name of scripts) {
        if (/^(typecheck|check|test:unit|unit|vitest|jest|compile|test|lint)$/.test(name)) add(name, `Script '${name}' is a common cheap validation target.`);
    }
    if (scripts.includes('test') && !candidates.some(item => item.script === 'test')) {
        candidates.push({ script: 'test', command: 'npm test', reason: 'Fallback default test script.' });
    }
    return candidates.slice(0, 8);
}

class TestProbeTool implements vscode.LanguageModelTool<TestProbeInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<TestProbeInput>) {
        const root = workspaceRoot();
        if (!root) return textResult('error: no workspace folder is open');
        const pkg = await readJsonFile<any>(path.join(root, 'package.json'));
        if (!pkg) return textResult('error: no package.json found at workspace root');
        const changedFiles = Array.isArray(options.input.changed_files) ? options.input.changed_files.map(String) : [];
        const candidates = selectTestCandidates(pkg, changedFiles, options.input.focus);
        const requested = options.input.command?.trim()
            .replace(/^npm\s+run\s+/i, '')
            .replace(/^npm\s+test$/i, 'test')
            .replace(/^npm\s+/i, '')
            .trim();
        const selected = requested
            ? candidates.find(candidate => candidate.script === requested) ?? (pkg.scripts?.[requested] ? { script: requested, command: `npm run ${requested}`, reason: 'Explicit script requested.' } : undefined)
            : candidates[0];
        const lines = [
            '# Harmony Test Probe',
            '',
            `Workspace: ${path.basename(root)}`,
            `Generated: ${new Date().toISOString()}`,
            '',
            section('Candidate Checks', candidates.length ? candidates.map(candidate => `${candidate.command} - ${candidate.reason}`) : ['No obvious npm test/compile/lint scripts were found.']),
        ];
        if (!options.input.run) {
            lines.push('', section('Recommended Next Step', selected ? [`Run ${selected.command} when execution is allowed.`] : ['Add or identify a focused validation command before editing.']));
            return textResult(lines.join('\n'));
        }
        if (planOnlyMode()) return textResult('error: plan-only mode is enabled; test_probe can recommend checks but cannot run package scripts.');
        if (!selected) return textResult(`${lines.join('\n')}\n\nerror: no runnable package script selected.`);
        const timeoutMs = Math.max(5000, Math.min(1800000, Math.floor(Number(options.input.timeout_sec) || 120) * 1000));
        const result = await execFile(npmCommand(), selected.script === 'test' ? ['test'] : ['run', selected.script], root, timeoutMs);
        lines.push('', section('Executed Check', [`${selected.command} - ${selected.reason}`, `exit_code: ${result.code ?? (result.ok ? 0 : 'unknown')}`]));
        lines.push('', '## Output', '', [result.stdout.trim(), result.stderr.trim(), result.error].filter(Boolean).join('\n\n') || '(no output)');
        return textResult(lines.join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<TestProbeInput>) {
        const base = { invocationMessage: options.input.run ? 'Running focused test probe' : 'Finding cheapest relevant test probe' };
        if (!options.input.run) return base;
        return {
            ...base,
            confirmationMessages: {
                title: 'Run package validation script?',
                message: new vscode.MarkdownString(`Harmony wants to run a package script selected by test_probe${options.input.command ? `: **${options.input.command}**` : ''}.`)
            }
        };
    }
}

interface ChangeSummaryInput {
    include_diff_stat?: boolean;
    include_names?: boolean;
    max_files?: number;
    format?: 'markdown' | 'json';
}

class ChangeSummaryTool implements vscode.LanguageModelTool<ChangeSummaryInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ChangeSummaryInput>) {
        const status = await runGit(['status', '--short', '--branch']);
        const stat = options.input.include_diff_stat === false ? undefined : await runGit(['diff', '--stat']);
        const stagedStat = options.input.include_diff_stat === false ? undefined : await runGit(['diff', '--staged', '--stat']);
        const names = options.input.include_names === false ? undefined : await runGit(['diff', '--name-status']);
        const stagedNames = options.input.include_names === false ? undefined : await runGit(['diff', '--staged', '--name-status']);
        const maxFiles = Math.max(5, Math.min(200, Number(options.input.max_files) || 60));
        const allNameLines = `${names?.stdout ?? ''}\n${stagedNames?.stdout ?? ''}`.split(/\r?\n/).filter(Boolean).slice(0, maxFiles);
        const risky = allNameLines.filter(line => /package-lock\.json|package\.json|tsconfig|\.vscodeignore|src\/(providers|extension|lmTools|toolExecutor|operationLocks)\.ts/i.test(line));
        const riskLevel = risky.length > 0 || allNameLines.length > 20 ? 'medium' : (allNameLines.length > 0 ? 'low' : 'none');
        const payload = {
            generatedAt: new Date().toISOString(),
            riskLevel,
            riskyFiles: risky,
            status: status.stdout.trim(),
            diffStat: stat?.stdout.trim(),
            stagedDiffStat: stagedStat?.stdout.trim(),
            changedNames: allNameLines,
            nextSuggestedValidation: risky.length > 0 ? 'Run compile plus a focused smoke test for touched tool/provider/manifest surfaces.' : 'Run the cheapest focused test or compile check for the touched slice.',
        };
        if (options.input.format === 'json') return textResult(JSON.stringify(payload, null, 2));
        return textResult([
            '# Harmony Change Summary',
            '',
            `Generated: ${payload.generatedAt}`,
            `Risk level: ${riskLevel}`,
            '',
            section('Git Status', payload.status || 'working tree clean'),
            '',
            section('Changed Files', allNameLines.length ? allNameLines : ['No unstaged/staged diff names found.']),
            '',
            section('Risk Signals', risky.length ? risky : ['No high-signal package/provider/manifest/tool-core files detected in current diff.']),
            '',
            section('Diff Stat', [payload.diffStat || '(no unstaged diff stat)', payload.stagedDiffStat || '(no staged diff stat)']),
            '',
            section('Next Suggested Validation', [payload.nextSuggestedValidation]),
        ].join('\n'));
    }

    async prepareInvocation() { return { invocationMessage: 'Summarizing current workspace changes' }; }
}

interface ClaimCheckInput {
    claim: string;
    source_urls?: string[];
    max_chars_per_source?: number;
    write_ledger?: boolean;
}

class ClaimCheckTool implements vscode.LanguageModelTool<ClaimCheckInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ClaimCheckInput>) {
        const claim = options.input.claim?.trim();
        if (!claim) return textResult('error: missing argument: claim');
        const urls = Array.from(new Set((options.input.source_urls ?? []).map(url => url.trim()).filter(Boolean))).slice(0, 12);
        if (urls.length === 0) {
            return textResult([
                '# Claim Check Needs Sources',
                '',
                `Claim: ${claim}`,
                '',
                'Provide `source_urls` from official docs, current pages, papers, changelogs, pricing pages, or other primary sources. This tool does not search the web by itself.'
            ].join('\n'));
        }
        const maxChars = Math.max(2000, Math.min(60000, Number(options.input.max_chars_per_source) || 16000));
        const fetched: SourceFetch[] = [];
        for (const url of urls) fetched.push(await fetchSource(url, maxChars, 20000));
        const shouldWriteLedger = options.input.write_ledger !== false && !planOnlyMode();
        let ledgerNote = planOnlyMode() && options.input.write_ledger !== false ? 'Plan-only mode is enabled; source ledger write was skipped.' : 'Source ledger write disabled.';
        if (shouldWriteLedger) {
            const ledger = await readLedger();
            for (const source of fetched) {
                ledger.entries.push({
                    id: crypto.randomUUID(),
                    query: claim,
                    mode: 'claim_check',
                    url: source.url,
                    finalUrl: source.finalUrl,
                    title: source.title,
                    fetchedAt: source.fetchedAt,
                    lastModified: source.lastModified,
                    contentType: source.contentType,
                    status: source.status,
                    ok: source.ok,
                    sha256: source.sha256,
                    note: source.error,
                });
            }
            await writeLedger(ledger);
            ledgerNote = `Source ledger updated: ${LEDGER_PATH}`;
        }
        const terms = words(claim).slice(0, 14);
        const rows = fetched.map((source, index) => {
            const snippets = source.ok ? snippetsFor(claim, source.text, 3) : [];
            const score = snippets.length;
            return `| ${index + 1} | ${source.ok ? 'ok' : 'error'} | ${score > 0 ? 'candidate evidence' : 'no direct snippet'} | ${source.lastModified ?? '(not provided)'} | ${source.finalUrl.replace(/\|/g, '/')} |`;
        });
        const notes = fetched.map((source, index) => {
            if (!source.ok) return `### Source ${index + 1}: ${source.url}\n\nFetch failed: ${source.error ?? 'unknown error'}`;
            const snippets = snippetsFor(claim, source.text, 4);
            return [`### Source ${index + 1}: ${source.title ?? source.finalUrl}`,
                '',
                `URL: ${source.finalUrl}`,
                `Fetched: ${source.fetchedAt}`,
                `Last-Modified: ${source.lastModified ?? 'not provided'}`,
                `Matched terms: ${terms.filter(term => source.text.toLowerCase().includes(term)).join(', ') || '(none)'}`,
                '',
                snippets.map(snippet => `> ${snippet.replace(/\n/g, ' ')}`).join('\n\n') || '(no direct snippets extracted)'
            ].join('\n');
        });
        return textResult([
            '# Harmony Claim Check',
            '',
            `Generated: ${new Date().toISOString()}`,
            `Claim: ${claim}`,
            `Ledger: ${ledgerNote}`,
            '',
            '| # | Fetch | Evidence Signal | Last Modified | URL |',
            '|---:|---|---|---|---|',
            ...rows,
            '',
            section('Interpretation Rule', [
                'A candidate snippet is not a verdict; the model or human reviewer must decide whether it supports, contradicts, or is irrelevant to the exact claim.',
                'If source dates are missing or stale, say that before presenting the claim as current.',
                'Use official sources first for pricing, API capability, legal, medical, or safety-sensitive claims.',
            ]),
            '',
            '## Source Notes',
            '',
            notes.join('\n\n'),
        ].join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ClaimCheckInput>) {
        return { invocationMessage: `Checking claim: ${(options.input.claim ?? '').slice(0, 60)}` };
    }
}

export function registerEvidenceTools(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.lm.registerTool('harmony_current_research', new CurrentResearchTool()),
        vscode.lm.registerTool('harmony_research_dossier', new ResearchDossierTool()),
        vscode.lm.registerTool('harmony_source_ledger', new SourceLedgerTool()),
        vscode.lm.registerTool('harmony_repo_map', new RepoMapTool()),
        vscode.lm.registerTool('harmony_route_map', new RouteMapTool()),
        vscode.lm.registerTool('harmony_test_probe', new TestProbeTool()),
        vscode.lm.registerTool('harmony_change_summary', new ChangeSummaryTool()),
        vscode.lm.registerTool('harmony_claim_check', new ClaimCheckTool()),
        vscode.lm.registerTool('harmony_dependency_audit', new DependencyAuditTool()),
    );
}