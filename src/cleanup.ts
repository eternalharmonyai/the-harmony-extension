import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { compactContinuity } from './continuity';

export interface CleanupReport {
    beforeBytes: number;
    afterBytes: number;
    /** Context-relevant size excluding safety dirs (snapshots, pre_edit, archive). */
    contextHealthBytes: number;
    actions: string[];
    error?: string;
}

const MAX_HANDOFF_AGE_DAYS = 30;
const MAX_SNAPSHOT_AGE_DAYS = 7;
const MAX_PREEDIT_AGE_DAYS = 7;
const MAX_LEDGER_BYTES = 500_000;
const MAX_SUPERVISOR_BYTES = 500_000;
const MAX_HISTORY_BYTES = 500_000;
const MAX_RECENT_SNAPSHOTS = 10;
const MAX_ARCHIVE_AGE_DAYS = 7;

async function getHarmonyDir(workspaceRoot?: string): Promise<string | undefined> {
    const root = workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return undefined;
    const dir = path.join(root, '.harmony');
    try { await fs.access(dir); return dir; } catch { return undefined; }
}

async function dirSize(dirPath: string): Promise<number> {
    let size = 0;
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const e of entries) {
            const full = path.join(dirPath, e.name);
            if (e.isDirectory()) {
                size += await dirSize(full);
            } else {
                try { size += (await fs.stat(full)).size; } catch { /* skip */ }
            }
        }
    } catch { /* skip */ }
    return size;
}

export async function getHarmonyFolderSize(workspaceRoot?: string): Promise<number> {
    const dir = await getHarmonyDir(workspaceRoot);
    if (!dir) return 0;
    return dirSize(dir);
}

// Safety directories managed by cleanup — excluded from context health to avoid
// false-positives during long sessions where checkpoint snapshots accumulate.
// tool-cache excluded: Playwright browser binaries (~5 MB) are a system dependency,
// not context data — they skew context health without being cleanable.
const SAFETY_DIRS = new Set(['snapshots', 'snapshot-archive', 'pre_edit', 'tool-cache']);

async function dirSizeExcluding(dirPath: string, exclude: Set<string>): Promise<number> {
    let size = 0;
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const e of entries) {
            if (exclude.has(e.name)) continue;
            const full = path.join(dirPath, e.name);
            if (e.isDirectory()) {
                size += await dirSizeExcluding(full, exclude);
            } else {
                try { size += (await fs.stat(full)).size; } catch { /* skip */ }
            }
        }
    } catch { /* skip */ }
    return size;
}

/** Folder size excluding safety dirs (snapshots, pre_edit, archive) — used for context health. */
export async function getContextHealthSize(workspaceRoot?: string): Promise<number> {
    const dir = await getHarmonyDir(workspaceRoot);
    if (!dir) return 0;
    return dirSizeExcluding(dir, SAFETY_DIRS);
}

export async function harmonySelfCleanup(workspaceRoot?: string): Promise<CleanupReport> {
    const actions: string[] = [];
    const dir = await getHarmonyDir(workspaceRoot);
    if (!dir) return { beforeBytes: 0, afterBytes: 0, contextHealthBytes: 0, actions: ['No .harmony folder found.'] };

    const beforeBytes = await dirSize(dir);

    // 1. Trim old handoffs (>30 days)
    try {
        const handoffsDir = path.join(dir, 'handoffs');
        const files = await fs.readdir(handoffsDir).catch(() => [] as string[]);
        const cutoff = Date.now() - MAX_HANDOFF_AGE_DAYS * 86400000;
        let removedHandoffs = 0;
        for (const file of files) {
            if (!file.endsWith('.md') && !file.endsWith('.json')) continue;
            const fp = path.join(handoffsDir, file);
            try {
                const stat = await fs.stat(fp);
                if (stat.mtimeMs < cutoff) {
                    await fs.unlink(fp);
                    removedHandoffs++;
                }
            } catch { /* skip */ }
        }
        if (removedHandoffs > 0) actions.push(`Removed ${removedHandoffs} handoff(s) older than ${MAX_HANDOFF_AGE_DAYS} days.`);
    } catch { /* handoffs dir may not exist */ }

    // 2. Compact continuity (replaces many entries with one compact entry)
    try {
        const compacted = await compactContinuity('Auto-compacted by self-cleanup');
        actions.push(`Compacted continuity into entry ${compacted.id}.`);
    } catch (e: any) {
        actions.push(`Continuity compact skipped: ${e?.message || 'unknown error'}`);
    }

    // 3. Truncate large supervisor events file
    try {
        const supervisorPath = path.join(dir, 'supervisor', 'events.jsonl');
        const stat = await fs.stat(supervisorPath).catch(() => null);
        if (stat && stat.size > MAX_SUPERVISOR_BYTES) {
            const buf = await fs.readFile(supervisorPath, 'utf8');
            const lines = buf.split(/\r?\n/).filter(Boolean);
            const keepLines = Math.max(50, Math.floor(lines.length * (MAX_SUPERVISOR_BYTES / stat.size)));
            const trimmed = lines.slice(-keepLines).join('\n') + '\n';
            await fs.writeFile(supervisorPath, trimmed, 'utf8');
            actions.push(`Trimmed supervisor events from ${lines.length} to ${keepLines} lines.`);
        }
    } catch { /* skip */ }

    // 4. Truncate large chat history ledger
    try {
        const historyPath = path.join(dir, 'history', 'chat_ledger.jsonl');
        const stat = await fs.stat(historyPath).catch(() => null);
        if (stat && stat.size > MAX_HISTORY_BYTES) {
            const buf = await fs.readFile(historyPath, 'utf8');
            const lines = buf.split(/\r?\n/).filter(Boolean);
            const keepLines = Math.max(100, Math.floor(lines.length * (MAX_HISTORY_BYTES / stat.size)));
            const trimmed = lines.slice(-keepLines).join('\n') + '\n';
            await fs.writeFile(historyPath, trimmed, 'utf8');
            actions.push(`Trimmed chat history from ${lines.length} to ${keepLines} lines.`);
        }
    } catch { /* skip */ }

    // 5. Clean old Central Self-Healing Harness snapshots (>7 days)
    try {
        const snapshotsDir = path.join(dir, 'snapshots');
        const files = await fs.readdir(snapshotsDir).catch(() => [] as string[]);
        const cutoff = Date.now() - MAX_SNAPSHOT_AGE_DAYS * 86400000;
        let removedSnapshots = 0;
        for (const file of files) {
            const fp = path.join(snapshotsDir, file);
            try {
                const stat = await fs.stat(fp);
                if (stat.mtimeMs < cutoff) {
                    await fs.rm(fp, { recursive: true, force: true });
                    removedSnapshots++;
                }
            } catch { /* skip */ }
        }
        if (removedSnapshots > 0) actions.push(`Removed ${removedSnapshots} stale snapshot(s) older than ${MAX_SNAPSHOT_AGE_DAYS} days.`);

        // Archive excess recent snapshots (keep N most recent, move rest to archive)
        const remainingFiles = await fs.readdir(snapshotsDir).catch(() => [] as string[]);
        const snapshotEntries: { name: string; mtimeMs: number }[] = [];
        for (const file of remainingFiles) {
            const fp = path.join(snapshotsDir, file);
            try {
                const stat = await fs.stat(fp);
                if (stat.isDirectory()) {
                    snapshotEntries.push({ name: file, mtimeMs: stat.mtimeMs });
                }
            } catch { /* skip */ }
        }
        if (snapshotEntries.length > MAX_RECENT_SNAPSHOTS) {
            snapshotEntries.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
            const toArchive = snapshotEntries.slice(MAX_RECENT_SNAPSHOTS); // oldest excess
            const archiveDir = path.join(dir, 'snapshot-archive');
            await fs.mkdir(archiveDir, { recursive: true });
            for (const entry of toArchive) {
                const src = path.join(snapshotsDir, entry.name);
                const dst = path.join(archiveDir, entry.name);
                try {
                    await fs.rename(src, dst);
                } catch { /* skip if rename fails */ }
            }
            actions.push(`Archived ${toArchive.length} excess snapshot(s) to snapshot-archive/ (kept ${MAX_RECENT_SNAPSHOTS} most recent).`);
        }

        // Clean stale archive entries (older than ARCHIVE_RETENTION days)
        try {
            const archiveDir = path.join(dir, 'snapshot-archive');
            const archiveFiles = await fs.readdir(archiveDir).catch(() => [] as string[]);
            const archiveCutoff = Date.now() - MAX_ARCHIVE_AGE_DAYS * 86400000;
            let removedArchived = 0;
            for (const file of archiveFiles) {
                const fp = path.join(archiveDir, file);
                try {
                    const stat = await fs.stat(fp);
                    if (stat.mtimeMs < archiveCutoff) {
                        await fs.rm(fp, { recursive: true, force: true });
                        removedArchived++;
                    }
                } catch { /* skip */ }
            }
            if (removedArchived > 0) actions.push(`Cleaned ${removedArchived} archived snapshot(s) older than ${MAX_ARCHIVE_AGE_DAYS} days.`);
        } catch { /* archive dir may not exist */ }
    } catch { /* snapshots dir may not exist */ }

    // 6. Clean old Central Self-Healing Harness pre-edits (>7 days)
    try {
        const preeditDir = path.join(dir, 'pre_edit');
        const files = await fs.readdir(preeditDir).catch(() => [] as string[]);
        const cutoff = Date.now() - MAX_PREEDIT_AGE_DAYS * 86400000;
        let removedPreedits = 0;
        for (const file of files) {
            const fp = path.join(preeditDir, file);
            try {
                const stat = await fs.stat(fp);
                if (stat.mtimeMs < cutoff) {
                    await fs.rm(fp, { recursive: true, force: true });
                    removedPreedits++;
                }
            } catch { /* skip */ }
        }
        if (removedPreedits > 0) actions.push(`Removed ${removedPreedits} stale pre-edit checkpoint(s) older than ${MAX_PREEDIT_AGE_DAYS} days.`);
    } catch { /* pre_edit dir may not exist */ }

    const afterBytes = await dirSize(dir);
    const contextHealthBytes = await dirSizeExcluding(dir, SAFETY_DIRS);
    if (actions.filter(a => a.includes('Removed') || a.includes('Trimmed') || a.includes('Compacted')).length === 0) {
        actions.push('No cleanup needed — .harmony is within healthy limits. Snapshot and checkpoint files from the last 7 days are preserved for safety.');
    }
    actions.push(`.harmony size: ${formatBytes(beforeBytes)} → ${formatBytes(afterBytes)} (context: ${formatBytes(contextHealthBytes)})`);

    return { beforeBytes, afterBytes, contextHealthBytes, actions };
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
