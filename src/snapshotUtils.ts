import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

// Shared pre-action snapshot machinery. This was previously duplicated (and had
// drifted) across toolExecutor.ts and lmTools.ts; keeping it here makes that
// divergence class impossible.

// Whole-segment excludes: matched at ANY depth in the path.
export const PRE_ACTION_SNAPSHOT_EXCLUDED_PARTS = new Set([
    '.git', 'node_modules', 'out', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.next', '.cache',
]);

// Root-anchored prefix excludes. `.harmony` is deliberately NOT excluded wholesale: our own notes,
// plans and handoffs live there and must have a real undo path. Listing only the subtrees that must
// never be copied keeps the safe failure direction — a new .harmony subdirectory is snapshotted by
// default (an extra copy, bounded by the size cap) rather than silently losing its undo path.
// The three reasons a subtree belongs here: recursive snapshot stores, generated media, private
// material, and live-written machine state that AGENTS.md rule 2 says must not be touched in place.
export const PRE_ACTION_SNAPSHOT_EXCLUDED_PREFIXES = [
    '.harmony/snapshots',
    '.harmony/pre_edit',
    '.harmony/backups',
    '.harmony/assets',
    '.harmony/screenshots',
    '.harmony/raster',
    '.harmony/canvas',
    '.harmony/private',
    '.harmony/continuity',
    '.harmony/processes',
    '.harmony/locks',
    '.harmony/supervisor',
    '.harmony/operations',
    '.harmony/swarm',
    '.harmony/release',
    '.harmony/inbox',
    '.harmony/todo.json',
    '.harmony/todos-archive.json',
    '.harmony/diagnostics',
    '.harmony/source-ledger.json',
    '.harmony/memory.jsonl',
    // Measured 2026-11-20: these subtrees are LARGER than the ones we deliberately include, so
    // leaving them walkable would burn the CLI's 200-file budget on machine output instead of source.
    '.harmony/hygiene',          // 29 MB  — bundled executables
    '.harmony/history',          // 3.1 MB — chat ledgers
    '.harmony/memory-preserved', // 2.1 MB
    '.harmony/provider-usage',   // 1.7 MB — usage ledger
    '.harmony/smoke',            // 1.5 MB — smoke receipts
    '.harmony/staging',          // 467 KB
    '.harmony/nls',              // 49 KB  — generated strings
    '.harmony/consensus',        // 59 KB
    '.harmony/tavily-archive',   // 35 KB
    '.harmony/ask-answers',      // append-only Ask answer receipts
];

export const PRE_ACTION_SNAPSHOT_TEXT_EXTS = new Set([
    // '' covers extensionless files: dotfiles (.gitattributes, .gitignore,
    // .editorconfig), LICENSE, Makefile, Dockerfile, etc.
    '', '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.txt', '.yml', '.yaml', '.toml', '.ps1', '.css', '.html', '.rs', '.py', '.cs', '.go', '.java', '.xml',
]);

export interface PreActionSnapshotRecord {
    path: string;
    size?: number;
    mtime?: string;
    copied: boolean;
    copyPath?: string;
    /** True when the source file was a non-text/binary file copied as raw bytes. */
    binary?: boolean;
    reason?: string;
}

export interface PreActionSnapshotResult {
    id: string;
    manifestPath: string;
    restoreCommand: string;
    copied: number;
    skipped: number;
}

export function normalizeSnapshotPath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

export function shouldSkipPreActionSnapshotPath(relativePath: string): boolean {
    const normalized = normalizeSnapshotPath(relativePath).toLowerCase();
    const parts = normalized.split('/').filter(Boolean);
    if (parts.some(part => PRE_ACTION_SNAPSHOT_EXCLUDED_PARTS.has(part))) return true;
    if (parts.some(part => part.includes('secret') || part.includes('credential') || part.includes('key'))) return true;
    return PRE_ACTION_SNAPSHOT_EXCLUDED_PREFIXES.some(prefix => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

export function snapshotCopyName(relativePath: string): string {
    const normalized = normalizeSnapshotPath(relativePath);
    const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
    return `${hash}-${path.basename(normalized).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'file'}`;
}

export function restoreCommandForSnapshot(root: string, id: string): string {
    return `node bin/harmony-cli.js --workspace "${root.replace(/"/g, '\\"')}" snapshot restore --id ${id} --all --confirm`;
}

export function formatSnapshotNote(snapshot?: PreActionSnapshotResult, warnings?: string[]): string {
    // A skip that nobody can see is a silent failure (AGENTS.md rule 6). When a path is
    // deliberately not copied we still say so, every time, on the surface the caller reads.
    const warningBlock = (warnings && warnings.length > 0)
        ? `\n⚠️ no pre-action snapshot for ${warnings.length} path(s) — these changes have NO automatic undo:\n${warnings.map(item => `- ${item}`).join('\n')}`
        : '';
    if (!snapshot) return warningBlock;
    return `${warningBlock}\npre-action snapshot: ${snapshot.manifestPath}\nrestore command: ${snapshot.restoreCommand}`;
}

export async function createRequiredPreActionSnapshot(root: string, relativePaths: string[], reason: string, source: 'chat' | 'vscode' = 'chat'): Promise<{ ok: true; snapshot?: PreActionSnapshotResult; warnings: string[] } | { ok: false; message: string }> {
    const uniquePaths = Array.from(new Set(relativePaths.map(normalizeSnapshotPath).filter(Boolean))).sort();
    if (uniquePaths.length === 0) return { ok: true, warnings: [] };

    const id = `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${source}`;
    const snapshotDir = path.join(root, '.harmony', 'snapshots', id);
    const filesDir = path.join(snapshotDir, 'files');
    // Configurable max file size for pre-action snapshots (default 2MB)
    const snapshotMaxBytes = vscode.workspace.getConfiguration('harmony').get<number>('snapshotMaxBytes') ?? (2 * 1024 * 1024);
    const maxBytes = Math.max(256 * 1024, snapshotMaxBytes);
    const records: PreActionSnapshotRecord[] = [];
    const failures: string[] = [];
    // Non-fatal skips: the action proceeds, but the omission must be disclosed to the caller.
    const warnings: string[] = [];

    for (const relativePath of uniquePaths) {
        const normalized = normalizeSnapshotPath(relativePath);
        const targetPath = path.resolve(root, normalized);
        const targetRel = path.relative(root, targetPath);
        if (!targetRel || targetRel.startsWith('..') || path.isAbsolute(targetRel)) {
            failures.push(`${normalized}: target resolves outside workspace`);
            continue;
        }
        const record: PreActionSnapshotRecord = { path: normalized, copied: false };
        const stat = await fs.stat(targetPath).catch(() => undefined);
        if (!stat) {
            record.reason = 'missing before action';
            records.push(record);
            continue;
        }
        record.size = stat.size;
        record.mtime = stat.mtime.toISOString();
        if (!stat.isFile()) {
            record.reason = 'not a regular file';
            failures.push(`${normalized}: ${record.reason}`);
            records.push(record);
            continue;
        }
        if (shouldSkipPreActionSnapshotPath(normalized)) {
            // A "do not COPY this" policy must not become a "you may not EDIT this" policy.
            // This branch used to push to `failures`, which aborts the whole snapshot and makes
            // every caller refuse the action — so an EXISTING file under .harmony/ (our own notes,
            // plans, handoffs) was uneditable, while a NEW file in the same directory edited fine
            // (a missing file took the 'missing before action' branch, which never failed).
            // Skipping a copy is now a disclosed non-failure, exactly like the size-cap branch below.
            record.reason = 'path is excluded from snapshot copy policy — action proceeds without snapshot';
            warnings.push(`${normalized}: excluded from snapshot copy policy — no automatic undo for this path`);
            records.push(record);
            continue;
        }
        if (stat.size > maxBytes) {
            record.reason = `file exceeds ${maxBytes} byte pre-action snapshot limit — skipped (edit proceeds without snapshot)`;
            warnings.push(`${normalized}: exceeds the ${maxBytes} byte snapshot limit (${stat.size} bytes) — no automatic undo for this path`);
            records.push(record);
            continue;
        }
        // Binary / non-text files are snapshotted too — as raw byte copies. Previously a
        // non-text extension was pushed to `failures`, which failed the whole snapshot and
        // refused the edit (e.g. a PNG icon could not be edited at all). `copyFile` and the
        // restore path are both byte-exact for text and binary alike, so the extension
        // whitelist was never a safety boundary — the size cap above is what bounds us.
        const isText = PRE_ACTION_SNAPSHOT_TEXT_EXTS.has(path.extname(normalized).toLowerCase());
        const copyPath = path.join(filesDir, snapshotCopyName(normalized));
        await fs.mkdir(filesDir, { recursive: true });
        try {
            await fs.copyFile(targetPath, copyPath);
            record.copied = true;
            record.copyPath = normalizeSnapshotPath(path.relative(snapshotDir, copyPath));
            if (!isText) record.binary = true;
        } catch (error: any) {
            record.reason = error?.message ?? String(error);
            failures.push(`${normalized}: ${record.reason}`);
        }
        records.push(record);
    }

    if (failures.length > 0) {
        await fs.rm(snapshotDir, { recursive: true, force: true }).catch(() => undefined);
        return { ok: false, message: `error: pre-action snapshot failed; no changes were made.\n${failures.map(item => `- ${item}`).join('\n')}` };
    }

    const copied = records.filter(record => record.copied).length;
    if (copied === 0) return { ok: true, warnings };

    const manifest = {
        version: 1,
        id,
        createdAt: new Date().toISOString(),
        workspace: root,
        mode: 'small-text-copy',
        note: reason,
        limits: { maxFiles: uniquePaths.length, maxBytes },
        excludes: [...Array.from(PRE_ACTION_SNAPSHOT_EXCLUDED_PARTS), ...PRE_ACTION_SNAPSHOT_EXCLUDED_PREFIXES],
        files: records,
    };
    const manifestPath = path.join(snapshotDir, 'manifest.json');
    await fs.mkdir(snapshotDir, { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return {
        ok: true,
        snapshot: {
            id,
            manifestPath,
            restoreCommand: restoreCommandForSnapshot(root, id),
            copied,
            skipped: records.length - copied,
        },
        warnings,
    };
}

export interface SnapshotRestoreResult {
    restored: string[];
    skipped: string[];
    missing: string[];
}

export async function restoreSnapshotFiles(root: string, snapshotId: string): Promise<SnapshotRestoreResult> {
    const snapshotDir = path.join(root, '.harmony', 'snapshots', snapshotId);
    const manifestPath = path.join(snapshotDir, 'manifest.json');
    let manifest: { files?: Array<{ path: string; copied?: boolean; copyPath?: string; reason?: string }> };
    try {
        manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch {
        throw new Error(`snapshot not found: ${snapshotId}`);
    }
    const restored: string[] = [];
    const skipped: string[] = [];
    const missing: string[] = [];
    for (const record of manifest.files ?? []) {
        const rel = normalizeSnapshotPath(record.path ?? '');
        if (!rel) { skipped.push('(unknown)'); continue; }
        const target = path.resolve(root, rel);
        const targetRel = path.relative(root, target);
        if (!targetRel || targetRel.startsWith('..') || path.isAbsolute(targetRel)) { skipped.push(rel); continue; }
        // File was created by the original action — its inverse is deletion.
        if (!record.copied && record.reason === 'missing before action') {
            await fs.rm(target, { force: true }).catch(() => undefined);
            restored.push(`${rel} (deleted)`);
            continue;
        }
        if (!record.copied || !record.copyPath) { skipped.push(rel); continue; }
        const source = path.join(snapshotDir, record.copyPath);
        if (!(await fs.stat(source).catch(() => undefined))) { missing.push(rel); continue; }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(source, target);
        restored.push(rel);
    }
    return { restored, skipped, missing };
}
