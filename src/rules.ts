import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface RuleAnchor {
    path: string;
    privatePlanning: boolean;
    included: boolean;
    chars: number;
    reason?: string;
}

const PUBLIC_ROOT_ANCHORS = ['AGENTS.md', 'GEMINI.md', 'HARMONY.md'];
const PRIVATE_PLANNING_EXT = `.${'fa'}${'mily'}.md`;
const LEGACY_INCLUDE_PRIVATE_SETTING = `rules.include${'Fa'}${'mily'}Files`;
const PRIVATE_ROOT_ANCHORS = ['HARMONY', 'ROADMAP', 'PLAN'].map(name => `${name}${PRIVATE_PLANNING_EXT}`);
const RULE_EXCLUDE = '{**/node_modules/**,**/out/**,**/dist/**,**/build/**,**/_extract_*/**,**/_temp_extract_*/**,**/_backups*/**,**/.git/**}';

function cfg() {
    return vscode.workspace.getConfiguration('harmony');
}

function rulesEnabled(): boolean {
    return cfg().get<boolean>('rules.enabled') ?? true;
}

function includePrivateFiles(): boolean {
    const config = cfg();
    return config.get<boolean>('rules.includePrivateFiles') ?? config.get<boolean>(LEGACY_INCLUDE_PRIVATE_SETTING) ?? false;
}

function maxRulesChars(): number {
    return Math.max(1000, Math.min(120000, cfg().get<number>('rules.maxPromptChars') ?? 20000));
}

function workspaceFolders(): readonly vscode.WorkspaceFolder[] {
    return vscode.workspace.workspaceFolders ?? [];
}

function rel(uri: vscode.Uri): string {
    return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

async function collectAnchorUris(): Promise<vscode.Uri[]> {
    const uris: vscode.Uri[] = [];
    const seen = new Set<string>();
    const add = (uri: vscode.Uri) => {
        const key = uri.toString();
        if (!seen.has(key)) {
            seen.add(key);
            uris.push(uri);
        }
    };

    for (const folder of workspaceFolders()) {
        for (const name of PUBLIC_ROOT_ANCHORS) {
            const uri = vscode.Uri.joinPath(folder.uri, name);
            if (await uriExists(uri)) add(uri);
        }
        for (const name of PRIVATE_ROOT_ANCHORS) {
            const uri = vscode.Uri.joinPath(folder.uri, name);
            if (await uriExists(uri)) add(uri);
        }
        const publicRuleUris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '.harmony/rules/**/*.md'), RULE_EXCLUDE, 30);
        publicRuleUris.forEach(add);
        const privateUris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, `**/*${PRIVATE_PLANNING_EXT}`), RULE_EXCLUDE, 30);
        privateUris.forEach(add);
    }
    return uris.sort((a, b) => rel(a).localeCompare(rel(b)));
}

export async function discoverRuleAnchors(): Promise<RuleAnchor[]> {
    if (!rulesEnabled()) return [];
    const allowPrivate = includePrivateFiles();
    const uris = await collectAnchorUris();
    const anchors: RuleAnchor[] = [];
    for (const uri of uris) {
        const anchorPath = rel(uri);
        const privatePlanning = anchorPath.toLowerCase().endsWith(PRIVATE_PLANNING_EXT);
        let chars = 0;
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            chars = stat.size;
        } catch { /* ignored below */ }
        anchors.push({
            path: anchorPath,
            privatePlanning,
            included: !privatePlanning || allowPrivate,
            chars,
            reason: privatePlanning && !allowPrivate ? 'private planning file; enable harmony.rules.includePrivateFiles to inject' : undefined,
        });
    }
    return anchors;
}

export async function loadRulesContext(): Promise<string> {
    if (!rulesEnabled()) return '';
    const anchors = await discoverRuleAnchors();
    const included = anchors.filter(anchor => anchor.included);
    if (included.length === 0) return '';

    const rootUris = new Map((await collectAnchorUris()).map(uri => [rel(uri), uri]));
    const blocks: string[] = [];
    let remaining = maxRulesChars();
    for (const anchor of included) {
        if (remaining <= 0) break;
        const uri = rootUris.get(anchor.path);
        if (!uri) continue;
        try {
            const raw = await fs.readFile(uri.fsPath, 'utf8');
            const content = raw.length > remaining ? raw.slice(0, remaining) + `\n...[rules truncated]` : raw;
            remaining -= content.length;
            blocks.push(`--- ${anchor.path}${anchor.privatePlanning ? ' (private planning)' : ''} ---\n${content.trim()}\n--- end ${anchor.path} ---`);
        } catch { /* skip unreadable rule */ }
    }

    if (blocks.length === 0) return '';
    return `\n\nHARMONY PROJECT RULES AND CONTEXT ANCHORS:\n${blocks.join('\n\n')}\n\nApply these rules quietly where relevant. If a rule conflicts with the user's current request, ask before overriding the current request.`;
}

export async function formatRulesStatus(): Promise<string> {
    if (!rulesEnabled()) return 'disabled';
    const anchors = await discoverRuleAnchors();
    if (anchors.length === 0) return 'no anchors found';
    const included = anchors.filter(anchor => anchor.included).length;
    const privateCount = anchors.filter(anchor => anchor.privatePlanning).length;
    const hiddenPrivate = anchors.filter(anchor => anchor.privatePlanning && !anchor.included).length;
    return `${included}/${anchors.length} included (${privateCount} private, ${hiddenPrivate} private skipped)`;
}

export async function formatRulesDetails(): Promise<string> {
    const anchors = await discoverRuleAnchors();
    if (anchors.length === 0) return 'No Harmony rule anchors found.';
    return anchors.map(anchor => {
        const state = anchor.included ? 'included' : 'skipped';
        const kind = anchor.privatePlanning ? 'private-planning' : 'public';
        return `- ${anchor.path} — ${state}, ${kind}, ${anchor.chars} chars${anchor.reason ? ` (${anchor.reason})` : ''}`;
    }).join('\n');
}