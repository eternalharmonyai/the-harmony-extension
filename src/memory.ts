import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Harmony cross-session memory.
 *
 * Stores per-workspace conversation snippets in `.harmony/memory.jsonl`.
 * Each line is JSON: { ts, profile, prompt, response, summary? }.
 * On chat start we surface the most recent N entries as recall context.
 *
 * Privacy: kept inside the workspace, gitignored by the user's local exclude.
 * The active file is compacted when it grows too large. Older raw entries are
 * preserved under `.harmony/memory-preserved/` before the active file is rewritten.
 */

const MEMORY_DIR = '.harmony';
const MEMORY_FILE = 'memory.jsonl';
const MEMORY_PRESERVED_DIR = 'memory-preserved';
const MAX_ACTIVE_LINES = 200;
const COMPACT_KEEP_LINES = 160;
const RECALL_LINES = 10;
const DETAILED_RECALL_LINES = 3;

export interface MemoryEntry {
    ts: string;
    profile: string;
    prompt: string;
    response: string;
    summary?: string;
    workspace?: string;
}

export interface MemoryStats {
    activeEntries: number;
    preservedFiles: number;
    lastPreservedPath?: string;
}

function workspaceFingerprint(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;
    // Stable, low-entropy fingerprint from the workspace folder path.
    // Not cryptographic \u2014 just used to detect cross-workspace contamination.
    const fp = folders[0].uri.fsPath;
    let hash = 0;
    for (let i = 0; i < fp.length; i++) {
        hash = ((hash << 5) - hash + fp.charCodeAt(i)) | 0;
    }
    return `ws_${(hash >>> 0).toString(16)}`;
}

export function currentWorkspaceFingerprint(): string | undefined {
    return workspaceFingerprint();
}

function memoryPath(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;
    return path.join(folders[0].uri.fsPath, MEMORY_DIR, MEMORY_FILE);
}

function workspaceRootPath(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;
    return folders[0].uri.fsPath;
}

function harmonyDirPath(): string | undefined {
    const root = workspaceRootPath();
    if (!root) return undefined;
    return path.join(root, MEMORY_DIR);
}

function preservedMemoryDirPath(): string | undefined {
    const root = workspaceRootPath();
    if (!root) return undefined;
    return path.join(root, MEMORY_DIR, MEMORY_PRESERVED_DIR);
}

function summarizeEntry(prompt: string, response: string): string {
    const promptLine = prompt.trim().split(/\r?\n/).find(Boolean) ?? '';
    const responseLines = response.trim().split(/\r?\n/).filter(Boolean).slice(0, 3);
    const responseSummary = responseLines.join(' ').replace(/\s+/g, ' ').slice(0, 700);
    return `User asked: ${promptLine.slice(0, 300)}\nOutcome: ${responseSummary}`.trim();
}

async function ensureMemoryIgnored(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;
    const excludePath = path.join(folders[0].uri.fsPath, '.git', 'info', 'exclude');
    try {
        const existing = await fs.readFile(excludePath, 'utf8');
        if (!existing.split(/\r?\n/).some(line => line.trim() === '.harmony/' || line.trim() === '.harmony/**')) {
            await fs.appendFile(excludePath, `${existing.endsWith('\n') ? '' : '\n'}.harmony/\n`, 'utf8');
        }
    } catch { /* not a git repo or exclude unavailable */ }
}

function compactStamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function summarizePreservedLines(lines: string[], preservedPath: string): MemoryEntry {
    const parsed: MemoryEntry[] = [];
    for (const line of lines) {
        try {
            parsed.push(JSON.parse(line) as MemoryEntry);
        } catch { /* skip malformed preserved line for summary only */ }
    }
    const first = parsed[0]?.ts ?? 'unknown start';
    const last = parsed[parsed.length - 1]?.ts ?? 'unknown end';
    const samples = parsed
        .map(entry => entry.summary ?? summarizeEntry(entry.prompt ?? '', entry.response ?? ''))
        .filter(Boolean)
        .slice(-6);
    const sampleText = samples.length > 0 ? samples.map((sample, i) => `${i + 1}. ${sample.slice(0, 500)}`).join('\n') : 'No summary samples were available.';
    const response = [
        `Preserved ${lines.length} older workspace memory entries in ${preservedPath}.`,
        `Range: ${first} through ${last}.`,
        '',
        'Recent summaries from the preserved detail set:',
        sampleText,
        '',
        'The original JSONL entries remain local on disk. This compact pointer keeps @harmony oriented without deleting older continuity.'
    ].join('\n');
    return {
        ts: new Date().toISOString(),
        profile: 'memory-compaction',
        prompt: 'Workspace memory grew past the active context limit; preserve older entries and keep a compact pointer.',
        response,
        summary: `Preserved ${lines.length} older memory entries in ${preservedPath}; active memory now keeps recent entries plus this compact pointer.`,
        workspace: workspaceFingerprint()
    };
}

async function preserveMemoryLines(lines: string[]): Promise<string | undefined> {
    if (lines.length === 0) return undefined;
    const dir = preservedMemoryDirPath();
    const root = workspaceRootPath();
    if (!dir || !root) return undefined;
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `memory-preserved-${compactStamp()}.jsonl`);
    await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf8');
    return path.relative(root, filePath).replace(/\\/g, '/');
}

async function compactMemoryIfNeeded(fp: string): Promise<void> {
    const all = (await fs.readFile(fp, 'utf8')).split('\n').filter(Boolean);
    if (all.length <= MAX_ACTIVE_LINES) return;
    const keepCount = Math.min(COMPACT_KEEP_LINES, Math.max(1, MAX_ACTIVE_LINES - 1));
    const preserved = all.slice(0, all.length - keepCount);
    const kept = all.slice(-keepCount);
    const preservedPath = await preserveMemoryLines(preserved);
    if (!preservedPath) return;
    const compactEntry = summarizePreservedLines(preserved, preservedPath);
    await fs.writeFile(fp, [JSON.stringify(compactEntry), ...kept].join('\n') + '\n', 'utf8');
}

export async function appendMemory(entry: MemoryEntry): Promise<void> {
    const fp = memoryPath();
    if (!fp) return;
    try {
        await ensureMemoryIgnored();
        await fs.mkdir(path.dirname(fp), { recursive: true });
        const compact: MemoryEntry = {
            ts: entry.ts,
            profile: entry.profile,
            prompt: entry.prompt.slice(0, 2000),
            response: entry.response.slice(0, 4000),
            summary: entry.summary ?? summarizeEntry(entry.prompt, entry.response),
            workspace: workspaceFingerprint()
        };
        await fs.appendFile(fp, JSON.stringify(compact) + '\n', 'utf8');
        try {
            await compactMemoryIfNeeded(fp);
        } catch { /* ignore cap errors */ }
    } catch { /* memory is best-effort */ }
}

export async function recallMemory(limit: number = RECALL_LINES): Promise<MemoryEntry[]> {
    const fp = memoryPath();
    if (!fp) return [];
    const expected = workspaceFingerprint();
    try {
        const buf = await fs.readFile(fp, 'utf8');
        const lines = buf.split('\n').filter(Boolean);
        const out: MemoryEntry[] = [];
        // Walk from newest to oldest, keep only matching workspace fingerprint.
        for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
            try {
                const e = JSON.parse(lines[i]) as MemoryEntry;
                // Defense-in-depth: legacy entries without a fingerprint are accepted
                // (they were written by this same workspace pre-fingerprint), but
                // entries with a DIFFERENT fingerprint are rejected outright.
                if (e.workspace && expected && e.workspace !== expected) continue;
                out.push(e);
            } catch { /* skip bad line */ }
        }
        return out.reverse();
    } catch {
        return [];
    }
}

export async function memoryStats(): Promise<MemoryStats> {
    const stats: MemoryStats = { activeEntries: 0, preservedFiles: 0 };
    const fp = memoryPath();
    if (fp) {
        try {
            stats.activeEntries = (await fs.readFile(fp, 'utf8')).split('\n').filter(Boolean).length;
        } catch { /* no active memory yet */ }
    }
    const dir = preservedMemoryDirPath();
    const root = workspaceRootPath();
    if (dir && root) {
        try {
            const files = (await fs.readdir(dir))
                .filter(name => name.startsWith('memory-preserved-') && name.endsWith('.jsonl'))
                .sort();
            stats.preservedFiles = files.length;
            if (files.length > 0) {
                stats.lastPreservedPath = path.relative(root, path.join(dir, files[files.length - 1])).replace(/\\/g, '/');
            }
        } catch { /* no preserved memory yet */ }
    }
    return stats;
}

export function formatRecallForPrompt(entries: MemoryEntry[]): string {
    if (entries.length === 0) return '';
    const items = entries.map((e, i) => {
        const date = e.ts.slice(0, 10);
        const detailed = i >= Math.max(0, entries.length - DETAILED_RECALL_LINES);
        if (!detailed) {
            return `${i + 1}. [${date}] ${e.summary ?? summarizeEntry(e.prompt, e.response)}`;
        }
        const promptText = e.prompt.trim().slice(0, 900);
        const responseText = e.response.trim().slice(0, 1400);
        return `${i + 1}. [${date}]\nUser:\n${promptText}\n\nAssistant:\n${responseText}`;
    }).join('\n');
    let result = `\n\nPERSISTED HARMONY CONTINUITY FOR THIS WORKSPACE (oldest first, newest last):\n${items}\n\nUse this as real continuity when the user references earlier work, reloads VS Code, or moves to a new thread. Do not recite it back unless asked; quietly use it to stay oriented.`;
    // Hard output cap: prevent oversized recall from bloating the system message
    const MAX_RECALL_CHARS = 25000;
    if (result.length > MAX_RECALL_CHARS) {
        const lines = result.split("\n");
        while (lines.length > 2 && result.length > MAX_RECALL_CHARS) {
            lines.splice(1, 1);
            result = lines.join("\n");
        }
        if (result.length > MAX_RECALL_CHARS) {
            result = result.slice(0, MAX_RECALL_CHARS) + "\n\n[Recall trimmed to prevent context overflow]";
        }
    }
    return result;
}

export async function createHandoffPacket(notes = ''): Promise<string> {
    const dir = harmonyDirPath();
    if (!dir) throw new Error('No workspace open - cannot create a handoff packet.');
    await ensureMemoryIgnored();
    const recent = await recallMemory(20);
    const handoffDir = path.join(dir, 'handoffs');
    await fs.mkdir(handoffDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(handoffDir, `handoff-${stamp}.md`);
    const workspace = vscode.workspace.workspaceFolders?.[0]?.name ?? '(no workspace)';
    const body = [
        '# Harmony Handoff Packet',
        '',
        `Created: ${new Date().toISOString()}`,
        `Workspace: ${workspace}`,
        `Workspace fingerprint: ${workspaceFingerprint() ?? '(none)'}`,
        '',
        notes.trim() ? `Notes:\n${notes.trim()}\n` : '',
        '## Recent Continuity',
        '',
        recent.length === 0 ? '_No persisted memory yet._' : recent.map((entry, i) => {
            const summary = entry.summary ?? summarizeEntry(entry.prompt, entry.response);
            return `### ${i + 1}. ${entry.ts}\n\n${summary}\n\nUser:\n${entry.prompt.trim().slice(0, 1200)}\n\nAssistant:\n${entry.response.trim().slice(0, 1800)}`;
        }).join('\n\n'),
        '',
        '## How To Resume',
        '',
        'Paste this packet into a fresh Harmony turn, then ask Harmony to continue from it. It contains summaries and recent turn excerpts only; no API keys or hidden reasoning traces are stored here.',
        ''
    ].filter(Boolean).join('\n');
    await fs.writeFile(filePath, body, 'utf8');
    return path.relative(vscode.workspace.workspaceFolders![0].uri.fsPath, filePath).replace(/\\/g, '/');
}
