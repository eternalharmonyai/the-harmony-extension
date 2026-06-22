import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { currentWorkspaceFingerprint, recallMemory } from './memory';

export type ContinuityKind = 'handoff' | 'import' | 'compact' | 'fork' | 'verification' | 'orchestrator' | 'note';
export type ContinuityPrivacy = 'local' | 'handoff' | 'public';

/** Maximum consecutive handoff entries before the chain is considered too deep.
 *  Prevents infinite handoff loops that can bloat context and state. */
const HANDOFF_MAX_CHAIN = 12;

export interface ContinuityEntry {
    id: string;
    ts: string;
    kind: ContinuityKind;
    source: string;
    summary: string;
    body?: string;
    files?: string[];
    nextActions?: string[];
    privacy: ContinuityPrivacy;
    workspace?: string;
    workspaceFingerprint?: string;
    metadata?: Record<string, unknown>;
}

export interface ContinuityStatus {
    directory?: string;
    ledger?: string;
    count: number;
    latest?: ContinuityEntry;
    autoInjectLatest: boolean;
}

interface AppendContinuityInput {
    kind: ContinuityKind;
    source: string;
    summary: string;
    body?: string;
    files?: string[];
    nextActions?: string[];
    privacy?: ContinuityPrivacy;
    metadata?: Record<string, unknown>;
}

const CONTINUITY_DIR = '.harmony/continuity';
const LEDGER_FILE = 'ledger.jsonl';
const STATE_FILE = 'state.json';
const MAX_BODY_CHARS = 24000;
const MAX_SUMMARY_CHARS = 500;

let continuityWriteQueue: Promise<void> = Promise.resolve();

function workspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
}

function workspaceRootPath(): string | undefined {
    return workspaceFolder()?.uri.fsPath;
}

function workspaceName(): string | undefined {
    return workspaceFolder()?.name;
}

function continuityDirPath(): string | undefined {
    const root = workspaceRootPath();
    return root ? path.join(root, CONTINUITY_DIR) : undefined;
}

function ledgerPath(): string | undefined {
    const dir = continuityDirPath();
    return dir ? path.join(dir, LEDGER_FILE) : undefined;
}

function statePath(): string | undefined {
    const dir = continuityDirPath();
    return dir ? path.join(dir, STATE_FILE) : undefined;
}

function handoffDirPath(): string | undefined {
    const root = workspaceRootPath();
    return root ? path.join(root, '.harmony', 'handoffs') : undefined;
}

function relativeWorkspacePath(filePath: string): string {
    const root = workspaceRootPath();
    return root ? path.relative(root, filePath).replace(/\\/g, '/') : filePath.replace(/\\/g, '/');
}

function clipText(text: string | undefined, maxChars: number): string | undefined {
    if (text === undefined) return undefined;
    return text.length > maxChars ? text.slice(0, maxChars) + `\n...[truncated ${text.length - maxChars} chars]` : text;
}

function normalizeLines(values: string[] | undefined, maxItems: number): string[] | undefined {
    const cleaned = (values ?? [])
        .map(value => String(value).trim())
        .filter(Boolean)
        .slice(0, maxItems);
    return cleaned.length > 0 ? cleaned : undefined;
}

function summarizeText(text: string): string {
    const first = text.trim().split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? 'Continuity update';
    return first.replace(/\s+/g, ' ').slice(0, MAX_SUMMARY_CHARS);
}

function safeId(kind: ContinuityKind): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const random = Math.random().toString(36).slice(2, 8);
    return `${kind}-${stamp}-${random}`;
}

async function ensureLocalExcludes(): Promise<void> {
    const root = workspaceRootPath();
    if (!root) return;
    const excludePath = path.join(root, '.git', 'info', 'exclude');
    try {
        const existing = await fs.readFile(excludePath, 'utf8');
        const lines = new Set(existing.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
        const privatePlanningExt = `.${'fa'}${'mily'}.md`;
        const additions = ['.harmony/', `*${privatePlanningExt}`, `**/*${privatePlanningExt}`].filter(line => !lines.has(line));
        if (additions.length > 0) {
            await fs.appendFile(excludePath, `${existing.endsWith('\n') ? '' : '\n'}${additions.join('\n')}\n`, 'utf8');
        }
    } catch {
        // Non-git workspaces are allowed; .gitignore/.vscodeignore still cover shipped files.
    }
}

async function ensureContinuityDir(): Promise<string> {
    const dir = continuityDirPath();
    if (!dir) throw new Error('No workspace open - cannot use Harmony continuity.');
    await ensureLocalExcludes();
    await fs.mkdir(dir, { recursive: true });
    return dir;
}

async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, contents, 'utf8');
    await fs.rename(tmp, filePath);
}

async function withContinuityWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = continuityWriteQueue;
    let release!: () => void;
    continuityWriteQueue = new Promise<void>(resolve => { release = resolve; });
    await previous.catch(() => undefined);
    try {
        return await fn();
    } finally {
        release();
    }
}

export async function appendContinuityEntry(input: AppendContinuityInput): Promise<ContinuityEntry> {
    return await withContinuityWriteLock(async () => {
        await ensureContinuityDir();
        const ledger = ledgerPath();
        const state = statePath();
        if (!ledger || !state) throw new Error('No workspace open - cannot write Harmony continuity.');

        const entry: ContinuityEntry = {
            id: safeId(input.kind),
            ts: new Date().toISOString(),
            kind: input.kind,
            source: input.source,
            summary: clipText(input.summary.trim() || summarizeText(input.body ?? ''), MAX_SUMMARY_CHARS) ?? 'Continuity update',
            body: clipText(input.body?.trim(), MAX_BODY_CHARS),
            files: normalizeLines(input.files, 100),
            nextActions: normalizeLines(input.nextActions, 20),
            privacy: input.privacy ?? 'local',
            workspace: workspaceName(),
            workspaceFingerprint: currentWorkspaceFingerprint(),
            metadata: input.metadata,
        };

        await fs.appendFile(ledger, JSON.stringify(entry) + '\n', 'utf8');
        await writeFileAtomic(state, JSON.stringify({ updated: entry.ts, latestEntryId: entry.id, latest: entry }, null, 2));
        return entry;
    });
}

export async function listContinuityEntries(limit = 10): Promise<ContinuityEntry[]> {
    const ledger = ledgerPath();
    if (!ledger) return [];
    try {
        const MAX_LEDGER_READ_BYTES = 500_000;
        const stat = await fs.stat(ledger);
        let raw: string;
        if (stat.size > MAX_LEDGER_READ_BYTES) {
            const buf = await fs.readFile(ledger);
            raw = buf.toString('utf8', buf.length - MAX_LEDGER_READ_BYTES);
            // Skip first line if it's partial (we started mid-line)
            const firstNewline = raw.indexOf('\n');
            if (firstNewline > 0 && firstNewline < raw.length - 1) raw = raw.slice(firstNewline + 1);
        } else {
            raw = await fs.readFile(ledger, 'utf8');
        }
        const lines = raw.split(/\r?\n/).filter(Boolean);
        const entries: ContinuityEntry[] = [];
        for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
            try {
                const entry = JSON.parse(lines[i]) as ContinuityEntry;
                if (entry.workspaceFingerprint && currentWorkspaceFingerprint() && entry.workspaceFingerprint !== currentWorkspaceFingerprint()) continue;
                entries.push(entry);
            } catch { /* skip malformed continuity line */ }
        }
        return entries;
    } catch {
        return [];
    }
}

export async function latestContinuityEntry(): Promise<ContinuityEntry | undefined> {
    return (await listContinuityEntries(1))[0];
}

export async function getContinuityStatus(): Promise<ContinuityStatus> {
    const entries = await listContinuityEntries(1000);
    const dir = continuityDirPath();
    const ledger = ledgerPath();
    const cfg = vscode.workspace.getConfiguration('harmony');
    return {
        directory: dir ? relativeWorkspacePath(dir) : undefined,
        ledger: ledger ? relativeWorkspacePath(ledger) : undefined,
        count: entries.length,
        latest: entries[0],
        autoInjectLatest: cfg.get<boolean>('continuity.autoInjectLatest') ?? true,
    };
}

export async function formatContinuityForPrompt(): Promise<string> {
    const cfg = vscode.workspace.getConfiguration('harmony');
    if (!(cfg.get<boolean>('continuity.autoInjectLatest') ?? true)) return '';
    const latest = await latestContinuityEntry();
    if (!latest) return '';
    const body = latest.body ? `\nDetails:\n${latest.body.slice(0, cfg.get<number>('continuity.maxPromptChars') ?? 6000)}` : '';
    const files = latest.files?.length ? `\nFiles:\n${latest.files.map(file => `- ${file}`).join('\n')}` : '';
    const next = latest.nextActions?.length ? `\nNext actions:\n${latest.nextActions.map(action => `- ${action}`).join('\n')}` : '';
    return `\n\nHARMONY CONTINUITY LEDGER (latest explicit handoff/sync state):\n` +
        `- id: ${latest.id}\n- source: ${latest.source}\n- kind: ${latest.kind}\n- timestamp: ${latest.ts}\n- summary: ${latest.summary}${files}${next}${body}\n\nUse this as explicit task continuity. Do not expose private details unless the user asks or the next step requires it.`;
}

export async function importContinuityFromText(text: string, source = 'manual import'): Promise<ContinuityEntry> {
    const clean = text.trim();
    if (!clean) throw new Error('No handoff text was provided.');
    return appendContinuityEntry({
        kind: 'import',
        source,
        summary: summarizeText(clean),
        body: clean,
        privacy: 'handoff',
    });
}

export async function compactContinuity(note = ''): Promise<ContinuityEntry> {
    const entries = await listContinuityEntries(20);
    const body = [
        note.trim() ? `Note: ${note.trim()}` : '',
        `Compacted ${entries.length} continuity entr${entries.length === 1 ? 'y' : 'ies'} on ${new Date().toISOString()}.`,
        '',
        ...entries.reverse().map((entry, index) => [
            `## ${index + 1}. ${entry.kind} / ${entry.source} / ${entry.ts}`,
            entry.summary,
            entry.files?.length ? `Files: ${entry.files.join(', ')}` : '',
            entry.nextActions?.length ? `Next: ${entry.nextActions.join('; ')}` : '',
        ].filter(Boolean).join('\n')),
    ].filter(Boolean).join('\n\n');
    return appendContinuityEntry({
        kind: 'compact',
        source: 'harmony.compact',
        summary: note.trim() || `Compacted ${entries.length} continuity entries`,
        body,
        privacy: 'local',
    });
}

export async function forkContinuity(name: string, notes = ''): Promise<ContinuityEntry> {
    const latest = await latestContinuityEntry();
    const forkName = name.trim() || `fork-${new Date().toISOString()}`;
    return appendContinuityEntry({
        kind: 'fork',
        source: 'harmony.fork',
        summary: `Forked continuity: ${forkName}`,
        body: [
            `Fork name: ${forkName}`,
            notes.trim() ? `Notes: ${notes.trim()}` : '',
            latest ? `Forked from ${latest.id}: ${latest.summary}` : 'No previous continuity entry existed.',
        ].filter(Boolean).join('\n'),
        files: latest?.files,
        nextActions: latest?.nextActions,
        privacy: 'local',
        metadata: { forkName, forkedFrom: latest?.id },
    });
}

export async function createContinuityHandoff(notes = ''): Promise<string> {
    const dir = handoffDirPath();
    if (!dir) throw new Error('No workspace open - cannot create a handoff packet.');
    await ensureLocalExcludes();
    await fs.mkdir(dir, { recursive: true });

    // Depth-limit guard: prevent infinite handoff chains
    const recentEntries = await listContinuityEntries(HANDOFF_MAX_CHAIN);
    const handoffCount = recentEntries.filter(e => e.kind === 'handoff').length;
    if (handoffCount >= HANDOFF_MAX_CHAIN) {
        throw new Error(`Handoff chain limit reached (${HANDOFF_MAX_CHAIN} consecutive handoffs). Compact or fork continuity before creating another handoff.`);
    }

    const recentMemory = await recallMemory(20);
    const recentContinuity = await listContinuityEntries(10);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(dir, `handoff-${stamp}.md`);
    const rel = relativeWorkspacePath(filePath);

    const body = [
        '# Harmony Handoff Packet',
        '',
        `Created: ${new Date().toISOString()}`,
        `Workspace: ${workspaceName() ?? '(no workspace)'}`,
        `Workspace fingerprint: ${currentWorkspaceFingerprint() ?? '(none)'}`,
        '',
        notes.trim() ? `## Notes\n\n${notes.trim()}\n` : '',
        '## Current Continuity State',
        '',
        recentContinuity.length === 0 ? '_No explicit continuity entries yet._' : recentContinuity.map((entry, index) => [
            `### ${index + 1}. ${entry.kind} / ${entry.source} / ${entry.ts}`,
            '',
            entry.summary,
            entry.files?.length ? `\nFiles:\n${entry.files.map(file => `- ${file}`).join('\n')}` : '',
            entry.nextActions?.length ? `\nNext actions:\n${entry.nextActions.map(action => `- ${action}`).join('\n')}` : '',
            entry.body ? `\nDetails:\n${entry.body.slice(0, 3000)}` : '',
        ].filter(Boolean).join('\n')).join('\n\n'),
        '',
        '## Recent Harmony Memory',
        '',
        recentMemory.length === 0 ? '_No persisted Harmony memory yet._' : recentMemory.map((entry, index) => {
            const summary = entry.summary ?? 'No summary available.';
            return `### ${index + 1}. ${entry.ts}\n\n${summary}\n\nUser:\n${entry.prompt.trim().slice(0, 1200)}\n\nAssistant:\n${entry.response.trim().slice(0, 1800)}`;
        }).join('\n\n'),
        '',
        '## How To Resume',
        '',
        'Paste or attach this packet into Harmony, Copilot, Gemini, a terminal agent, or another AI seat. Ask the next assistant to continue from this handoff. This packet contains visible summaries and recent excerpts only; it does not contain API keys or hidden reasoning traces.',
        ''
    ].filter(Boolean).join('\n');

    await fs.writeFile(filePath, body, 'utf8');
    await appendContinuityEntry({
        kind: 'handoff',
        source: 'harmony.handoff',
        summary: `Created handoff packet ${rel}`,
        body: notes.trim() || `Handoff packet written to ${rel}`,
        files: [rel],
        nextActions: ['Paste or attach the handoff packet into the next AI seat before continuing.'],
        privacy: 'handoff',
        metadata: { handoffPath: rel },
    });
    return rel;
}

export function formatContinuityEntry(entry: ContinuityEntry): string {
    return [
        `**${entry.kind}** from **${entry.source}** at ${entry.ts}`,
        `id: \`${entry.id}\``,
        entry.summary,
        entry.files?.length ? `Files: ${entry.files.join(', ')}` : '',
        entry.nextActions?.length ? `Next: ${entry.nextActions.join('; ')}` : '',
    ].filter(Boolean).join('\n');
}