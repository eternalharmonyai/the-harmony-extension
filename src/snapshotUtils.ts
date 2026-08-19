import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

// Shared pre-action snapshot machinery. This was previously duplicated (and had
// drifted) across toolExecutor.ts and lmTools.ts; keeping it here makes that
// divergence class impossible.

export const PRE_ACTION_SNAPSHOT_EXCLUDED_PARTS = new Set([
    '.git', '.harmony', 'node_modules', 'out', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.next', '.cache',
]);

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
    const parts = normalizeSnapshotPath(relativePath).split('/').filter(Boolean).map(part => part.toLowerCase());
    return parts.some(part => PRE_ACTION_SNAPSHOT_EXCLUDED_PARTS.has(part) || part.includes('secret') || part.includes('credential') || part.includes('key'));
}

export function snapshotCopyName(relativePath: string): string {
    const normalized = normalizeSnapshotPath(relativePath);
    const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
    return `${hash}-${path.basename(normalized).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'file'}`;
}

export function restoreCommandForSnapshot(root: string, id: string): string {
    return `node bin/harmony-cli.js --workspace "${root.replace(/"/g, '\\"')}" snapshot restore --id ${id} --all --confirm`;
}

export function formatSnapshotNote(snapshot?: PreActionSnapshotResult): string {
    if (!snapshot) return '';
    return `\npre-action snapshot: ${snapshot.manifestPath}\nrestore command: ${snapshot.restoreCommand}`;
}

export async function createRequiredPreActionSnapshot(root: string, relativePaths: string[], reason: string, source: 'chat' | 'vscode' = 'chat'): Promise<{ ok: true; snapshot?: PreActionSnapshotResult } | { ok: false; message: string }> {
    const uniquePaths = Array.from(new Set(relativePaths.map(normalizeSnapshotPath).filter(Boolean))).sort();
    if (uniquePaths.length === 0) return { ok: true };

    const id = `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${source}`;
    const snapshotDir = path.join(root, '.harmony', 'snapshots', id);
    const filesDir = path.join(snapshotDir, 'files');
    // Configurable max file size for pre-action snapshots (default 2MB)
    const snapshotMaxBytes = vscode.workspace.getConfiguration('harmony').get<number>('snapshotMaxBytes') ?? (2 * 1024 * 1024);
    const maxBytes = Math.max(256 * 1024, snapshotMaxBytes);
    const records: PreActionSnapshotRecord[] = [];
    const failures: string[] = [];

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
            record.reason = 'path is excluded from snapshot restore policy';
            failures.push(`${normalized}: ${record.reason}`);
            records.push(record);
            continue;
        }
        if (stat.size > maxBytes) {
            record.reason = `file exceeds ${maxBytes} byte pre-action snapshot limit — skipped (edit proceeds without snapshot)`;
            records.push(record);
            continue;
        }
        if (!PRE_ACTION_SNAPSHOT_TEXT_EXTS.has(path.extname(normalized).toLowerCase())) {
            record.reason = 'not a supported text-file snapshot extension';
            failures.push(`${normalized}: ${record.reason}`);
            records.push(record);
            continue;
        }
        const copyPath = path.join(filesDir, snapshotCopyName(normalized));
        await fs.mkdir(filesDir, { recursive: true });
        try {
            await fs.copyFile(targetPath, copyPath);
            record.copied = true;
            record.copyPath = normalizeSnapshotPath(path.relative(snapshotDir, copyPath));
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
    if (copied === 0) return { ok: true };

    const manifest = {
        version: 1,
        id,
        createdAt: new Date().toISOString(),
        workspace: root,
        mode: 'small-text-copy',
        note: reason,
        limits: { maxFiles: uniquePaths.length, maxBytes },
        excludes: Array.from(PRE_ACTION_SNAPSHOT_EXCLUDED_PARTS),
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
