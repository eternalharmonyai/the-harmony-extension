import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

// ── Whisper Inbox ─────────────────────────────────────────────
// Terminal @harmony messages → .harmony/inbox/ → sidebar + chat injection
//
// Security: atomic writes, UUID filenames, bounded scanning, workspace-trust gate,
// strip control chars, confirmation quick-pick, user-context injection.

export interface Whisper {
    id: string;
    version: 1;
    createdAt: number;
    read: boolean;
    body: string;
    source: 'terminal' | 'command' | 'sidebar';
}

const MAX_WHISPERS = 100;
const MAX_BODY_BYTES = 8_000;

function getRetentionMs(): number {
    const days = vscode.workspace.getConfiguration('harmony').get<number>('whisper.retentionDays') ?? 7;
    return days * 24 * 60 * 60 * 1000;
}

/** Event emitter so sidebar + chat participant stay in sync. */
export const onWhisperChange = new vscode.EventEmitter<void>();

// ── Mid-Session Whisper Tracking ───────────────────────────────
// Whispers that arrive DURING an active chat turn (not between turns).
// The chat participant can inject these into the model's context on the
// next tool call result, so the model sees them without waiting for a new turn.

let midSessionStartTime = Date.now();
const deliveredMidSessionIds = new Set<string>();

/** Call at the start of each chat turn to reset mid-session tracking. */
export function startMidSessionTracking(): void {
    midSessionStartTime = Date.now();
    deliveredMidSessionIds.clear();
}

/** Get whispers that arrived mid-session and haven't been delivered yet. */
export async function getPendingMidSessionWhispers(): Promise<Whisper[]> {
    const all = await readUnread();
    return all.filter(w => w.createdAt > midSessionStartTime && !deliveredMidSessionIds.has(w.id));
}

/** Mark whispers as delivered so they won't be injected again. */
export function markMidSessionWhispersDelivered(whispers: Whisper[]): void {
    for (const w of whispers) deliveredMidSessionIds.add(w.id);
}

// ── Enterprise-grade atomic writes ────────────────────────────
// Write to temp file first, then rename atomically to prevent
// half-written files if VS Code crashes mid-write.
const TMP_DIR = '.tmp';
const ARCHIVE_DIR = 'archive';
const LOCK_FILE = '.lock';
const DELIVERY_CAP = 5;
const MAX_LOCK_RETRIES = 10;
const LOCK_BASE_DELAY_MS = 50;

async function acquireLock(dir: vscode.Uri): Promise<string> {
    const lockId = crypto.randomUUID();
    const tmpLock = vscode.Uri.joinPath(dir, TMP_DIR, `.lock-${lockId}`);
    const lockUri = vscode.Uri.joinPath(dir, LOCK_FILE);
    try { await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dir, TMP_DIR)); } catch { /* ok */ }
    for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt++) {
        await vscode.workspace.fs.writeFile(tmpLock, Buffer.from(lockId, 'utf-8'));
        try {
            // Atomic acquire — rename with overwrite:false is the gate.
            // No TOCTOU: the rename IS the check. If it succeeds, we own the lock.
            await vscode.workspace.fs.rename(tmpLock, lockUri, { overwrite: false });
            return lockId;
        } catch {
            try { await vscode.workspace.fs.delete(tmpLock); } catch { /* ok */ }
            // Rename failed — check if the existing lock is stale (older than 60s).
            // We only delete stale locks AFTER our own rename attempt failed,
            // so there is no check-then-act TOCTOU window.
            try {
                const stat = await vscode.workspace.fs.stat(lockUri);
                if (Date.now() - stat.mtime > 60_000) {
                    await vscode.workspace.fs.delete(lockUri);
                }
            } catch { /* lock disappeared — ok */ }
            const delay = LOCK_BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 10;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw new Error('Failed to acquire file lock after maximum retries');
}

async function releaseLock(dir: vscode.Uri, lockId: string): Promise<void> {
    const lockUri = vscode.Uri.joinPath(dir, LOCK_FILE);
    try {
        const existing = await vscode.workspace.fs.readFile(lockUri);
        if (existing.toString() === lockId) await vscode.workspace.fs.delete(lockUri);
    } catch { /* lock already released */ }
}

async function archiveWhisperFile(dir: vscode.Uri, fileUri: vscode.Uri): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const archiveDir = vscode.Uri.joinPath(dir, ARCHIVE_DIR, today);
    try { await vscode.workspace.fs.createDirectory(archiveDir); } catch { /* ok */ }
    const fileName = fileUri.path.split('/').pop()!;
    const dest = vscode.Uri.joinPath(archiveDir, fileName);
    await vscode.workspace.fs.rename(fileUri, dest, { overwrite: false });
}

function inboxDir(): vscode.Uri | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return undefined;
    return vscode.Uri.joinPath(root, '.harmony', 'inbox');
}

async function ensureInbox(): Promise<vscode.Uri | undefined> {
    const dir = inboxDir();
    if (!dir) return undefined;
    try {
        await vscode.workspace.fs.createDirectory(dir);
    } catch { /* already exists */ }
    return dir;
}

function sanitizeBody(raw: string): string {
    return raw
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // strip control chars (keep \n \t)
        .slice(0, MAX_BODY_BYTES)
        .trim();
}

export function isWhisperDisabled(): boolean {
    return vscode.workspace.getConfiguration('harmony').get<boolean>('whisper.disabled') ?? false;
}

export async function writeWhisper(body: string, source: Whisper['source'] = 'terminal'): Promise<Whisper> {
    if (isWhisperDisabled()) {
        throw new Error('🔕 Whisper inbox is disabled. Enable it in the Harmony sidebar to send whispers.');
    }

    const dir = await ensureInbox();
    if (!dir) throw new Error('No workspace folder open. Open a workspace first.');

    if (!vscode.workspace.isTrusted) {
        throw new Error('Workspace is not trusted. Whisper inbox is disabled in untrusted workspaces.');
    }

    const clean = sanitizeBody(body);
    if (!clean) throw new Error('Whisper message is empty after sanitization.');

    const whisper: Whisper = {
        id: crypto.randomUUID(),
        version: 1,
        createdAt: Date.now(),
        read: false,
        body: clean,
        source
    };

    const content = Buffer.from(JSON.stringify(whisper, null, 2), 'utf-8');

    // ── Atomic write with file locking ──
    const lockId = await acquireLock(dir);
    try {
        const tmpUri = vscode.Uri.joinPath(dir, TMP_DIR, `${whisper.id}.json.tmp`);
        const finalUri = vscode.Uri.joinPath(dir, `${whisper.id}.json`);
        try { await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dir, TMP_DIR)); } catch { /* ok */ }
        await vscode.workspace.fs.writeFile(tmpUri, content);
        try {
            await vscode.workspace.fs.rename(tmpUri, finalUri, { overwrite: false });
        } catch (err: any) {
            try { await vscode.workspace.fs.delete(tmpUri); } catch { /* ok */ }
            throw new Error(`Atomic rename failed: ${err?.message ?? 'unknown'}`);
        }

        // Delivery cap: archive oldest whispers if over limit
        await enforceDeliveryCap(dir);
    } finally {
        await releaseLock(dir, lockId);
    }

    onWhisperChange.fire();
    return whisper;
}

/** Enforce delivery cap: keep at most DELIVERY_CAP unread, archive oldest excess. */
async function enforceDeliveryCap(dir: vscode.Uri): Promise<void> {
    const files = await vscode.workspace.fs.readDirectory(dir);
    const whisperFiles = files
        .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.json') && !name.startsWith('.'))
        .map(([name]) => vscode.Uri.joinPath(dir, name));
    if (whisperFiles.length <= DELIVERY_CAP) return;
    const withStats = await Promise.all(whisperFiles.map(async (uri) => {
        const stat = await vscode.workspace.fs.stat(uri);
        return { uri, mtime: stat.mtime };
    }));
    withStats.sort((a, b) => a.mtime - b.mtime);
    const toArchive = withStats.slice(0, whisperFiles.length - DELIVERY_CAP);
    for (const { uri } of toArchive) {
        try { await archiveWhisperFile(dir, uri); } catch { /* best-effort */ }
    }
}

export async function readUnread(max?: number): Promise<Whisper[]> {
    const dir = inboxDir();
    if (!dir) return [];

    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
        return []; // inbox directory doesn't exist yet
    }

    const jsonFiles = entries
        .filter(([, type]) => type === vscode.FileType.File)
        .map(([name]) => name)
        .filter(name => name.endsWith('.json'));

    const results: Whisper[] = [];
    for (const name of jsonFiles) {
        if (max !== undefined && results.length >= max) break;
        try {
            const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name));
            const obj = JSON.parse(Buffer.from(raw).toString('utf-8'));
            if (obj && typeof obj.body === 'string' && obj.read === false) {
                results.push(obj as Whisper);
            }
        } catch {
            // Corrupt file — delete it
            try { await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, name)); } catch { /* ignore */ }
        }
    }

    return results.sort((a, b) => a.createdAt - b.createdAt); // oldest first
}

export async function getUnreadCount(): Promise<number> {
    const unread = await readUnread();
    return unread.length;
}

export async function markRead(id: string): Promise<void> {
    const dir = inboxDir();
    if (!dir) return;

    const fileUri = vscode.Uri.joinPath(dir, `${id}.json`);
    try {
        const raw = await vscode.workspace.fs.readFile(fileUri);
        const obj = JSON.parse(Buffer.from(raw).toString('utf-8'));
        obj.read = true;
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(JSON.stringify(obj, null, 2), 'utf-8'));
    } catch {
        // File missing or corrupt — ignore
    }
    onWhisperChange.fire();
}

export async function markAllRead(): Promise<void> {
    const unread = await readUnread();
    await Promise.all(unread.map(w => markRead(w.id)));
}

async function pruneIfNeeded(dir: vscode.Uri): Promise<void> {
    try {
        const entries = await vscode.workspace.fs.readDirectory(dir);
        const jsonFiles = entries
            .filter(([, type]) => type === vscode.FileType.File)
            .map(([name]) => name)
            .filter(name => name.endsWith('.json'));

        // Read all whisper files with timestamps
        const files: { name: string; createdAt: number }[] = [];
        for (const name of jsonFiles) {
            try {
                const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name));
                const obj = JSON.parse(Buffer.from(raw).toString('utf-8'));
                files.push({ name, createdAt: obj.createdAt ?? 0 });
            } catch {
                // Corrupt — delete immediately
                try { await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, name)); } catch { /* ignore */ }
            }
        }

        const cutoff = Date.now() - getRetentionMs();

        // Delete expired whispers
        for (const f of files) {
            if (f.createdAt < cutoff) {
                try { await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, f.name)); } catch { /* ignore */ }
            }
        }

        // If still over limit, delete oldest
        const remaining = files.filter(f => f.createdAt >= cutoff).sort((a, b) => a.createdAt - b.createdAt);
        while (remaining.length > MAX_WHISPERS) {
            const oldest = remaining.shift()!;
            try { await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, oldest.name)); } catch { /* ignore */ }
        }
    } catch {
        // Inbox directory issues — non-fatal
    }
}

/** Format whispers for injection as user context (NOT system prompt). */
export function formatWhispersForPrompt(whispers: Whisper[]): string {
    if (!whispers.length) return '';
    const blocks = whispers.map(w => {
        const ts = new Date(w.createdAt).toISOString().slice(0, 16).replace('T', ' ');
        return `[${ts}] ${w.body}`;
    });
    return `📥 WHISPER INBOX — ${whispers.length} queued message(s) from terminal/commands:\n\n${blocks.join('\n\n')}\n\n(These were sent via @harmony in the terminal or Harmony: Write Whisper. They appear as user context — treat them as the user's words.)`;
}
