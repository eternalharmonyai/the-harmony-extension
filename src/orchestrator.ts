import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { loadRulesContext } from './rules';
import { ProviderId } from './providers';

export interface RepoPackOptions {
    includeGlobs?: string[];
    excludeGlob?: string;
    maxFiles?: number;
    maxChars?: number;
    includePrivateFiles?: boolean;
}

export interface RepoPackResult {
    text: string;
    files: string[];
    skipped: string[];
    chars: number;
    truncated: boolean;
}

const DEFAULT_INCLUDE_GLOBS = ['**/*.{ts,tsx,js,jsx,json,md,ps1,py,css,html}'];
const DEFAULT_EXCLUDE_GLOB = '{**/node_modules/**,**/out/**,**/dist/**,**/build/**,**/_extract_*/**,**/_temp_extract_*/**,**/_backups*/**,**/.git/**,**/.harmony/**,**/*.vsix}';
const MAX_FILE_CHARS = 20000;
const PRIVATE_PLANNING_EXT = `.${'fa'}${'mily'}.md`;
const LEGACY_INCLUDE_PRIVATE_SETTING = `orchestrator.include${'Fa'}${'mily'}Files`;

function cfg() {
    return vscode.workspace.getConfiguration('harmony');
}

function workspaceFolders(): readonly vscode.WorkspaceFolder[] {
    return vscode.workspace.workspaceFolders ?? [];
}

function relative(uri: vscode.Uri): string {
    return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
}

function languageFor(filePath: string): string {
    switch (path.extname(filePath).toLowerCase()) {
        case '.ts': return 'ts';
        case '.tsx': return 'tsx';
        case '.js': return 'js';
        case '.jsx': return 'jsx';
        case '.json': return 'json';
        case '.md': return 'md';
        case '.py': return 'py';
        case '.ps1': return 'powershell';
        case '.css': return 'css';
        case '.html': return 'html';
        default: return '';
    }
}

async function findRepoFiles(includeGlobs: string[], excludeGlob: string, maxFiles: number, includePrivateFiles: boolean): Promise<vscode.Uri[]> {
    const seen = new Map<string, vscode.Uri>();
    for (const folder of workspaceFolders()) {
        for (const glob of includeGlobs) {
            const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, glob), excludeGlob, maxFiles * 2);
            for (const uri of uris) {
                const rel = relative(uri);
                if (!includePrivateFiles && rel.toLowerCase().endsWith(PRIVATE_PLANNING_EXT)) continue;
                seen.set(rel, uri);
            }
        }
    }
    return [...seen.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, maxFiles)
        .map(([, uri]) => uri);
}

export async function createRepoPack(options: RepoPackOptions = {}): Promise<RepoPackResult> {
    const includeGlobs = options.includeGlobs?.length ? options.includeGlobs : DEFAULT_INCLUDE_GLOBS;
    const excludeGlob = options.excludeGlob ?? DEFAULT_EXCLUDE_GLOB;
    const maxFiles = Math.max(1, Math.min(500, options.maxFiles ?? cfg().get<number>('orchestrator.maxFiles') ?? 80));
    const maxChars = Math.max(5000, Math.min(1_500_000, options.maxChars ?? cfg().get<number>('orchestrator.maxContextChars') ?? 120000));
    const config = cfg();
    const includePrivateFiles = options.includePrivateFiles ?? config.get<boolean>('orchestrator.includePrivateFiles') ?? config.get<boolean>(LEGACY_INCLUDE_PRIVATE_SETTING) ?? false;

    const rules = await loadRulesContext();
    const files = await findRepoFiles(includeGlobs, excludeGlob, maxFiles, includePrivateFiles);
    const included: string[] = [];
    const skipped: string[] = [];
    const blocks: string[] = [];
    let chars = 0;
    let truncated = false;

    const addBlock = (block: string): boolean => {
        if (chars + block.length > maxChars) {
            truncated = true;
            return false;
        }
        blocks.push(block);
        chars += block.length;
        return true;
    };

    if (rules.trim()) {
        addBlock(`# Project Rules\n${rules.trim()}\n`);
    }

    for (const uri of files) {
        const rel = relative(uri);
        try {
            const raw = await fs.readFile(uri.fsPath, 'utf8');
            const body = raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + `\n...[file truncated ${raw.length - MAX_FILE_CHARS} chars]` : raw;
            const block = `\n## File: ${rel}\n\n\`\`\`${languageFor(rel)}\n${body}\n\`\`\`\n`;
            if (!addBlock(block)) {
                skipped.push(rel);
                break;
            }
            included.push(rel);
        } catch (error: any) {
            skipped.push(`${rel}: ${error?.message ?? String(error)}`);
        }
    }

    const header = [
        '# Harmony Codebase Orchestrator Pack',
        '',
        `Generated: ${new Date().toISOString()}`,
        `Workspace: ${vscode.workspace.name ?? '(unnamed workspace)'}`,
        `Included files: ${included.length}`,
        `Skipped files: ${skipped.length}`,
        `Character budget: ${maxChars}`,
        `Truncated: ${truncated ? 'yes' : 'no'}`,
        '',
        'Use this pack for repo-wide reasoning. The actual task/question appears after the pack so long-context models can retrieve relevant details before answering.',
        '',
        '## Included File List',
        included.length ? included.map(file => `- ${file}`).join('\n') : '_No files included._',
        skipped.length ? `\n## Skipped\n${skipped.map(file => `- ${file}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');

    return {
        text: `${header}\n\n${blocks.join('\n')}`,
        files: included,
        skipped,
        chars: header.length + chars,
        truncated,
    };
}

export function providerOrchestratorSystem(provider: ProviderId): string {
    const shared = 'You are a read-only codebase orchestrator for Harmony. Analyze the supplied repo pack and return a focused, practical result. Do not propose a broad rewrite. Prefer small verified slices, risks, impacted files, and test strategy. Never claim you edited files or ran commands.';
    switch (provider) {
        case 'gemini':
            return `${shared} Use your long-context strength to find cross-file relationships, forgotten helpers, duplicated concepts, and ripple effects.`;
        case 'deepseek':
            return `${shared} Use careful reasoning to produce an execution-ready coding plan with invariants and failure checks.`;
        case 'openai':
            return `${shared} Emphasize structured implementation slices, API contracts, tests, and migration safety.`;
        case 'claude':
            return `${shared} Emphasize maintainability, refactoring risk, naming clarity, and review findings.`;
        case 'openrouter':
            return `${shared} Be model-neutral and concise; identify assumptions clearly.`;
        default:
            return shared;
    }
}