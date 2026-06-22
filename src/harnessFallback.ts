import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { readFileSync } from 'fs';

const SNAPSHOT_DIR = '.harmony/snapshots';
const CHECKPOINT_DIR = '.harmony/checkpoints';

interface FallbackCheckpoint {
    id: string;
    timestamp: string;
    task: string;
    step: string;
    status: string;
    file: string;
    note: string;
}

interface FallbackSnapshot {
    id: string;
    timestamp: string;
    source: string;
    file: string;
    before_sha256: string;
    after_sha256?: string;
    status: 'in-progress' | 'completed' | 'failed';
}

interface FallbackPatchResult {
    ok: boolean;
    before_sha256: string;
    after_sha256: string;
    snapshot?: FallbackSnapshot;
    checkpoint?: FallbackCheckpoint;
    error?: string;
    warnings?: string[];
}

function sha256Buffer(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(filePath: string): string {
    const buffer = readFileSync(filePath);
    return sha256Buffer(buffer);
}

async function ensureDir(dirPath: string): Promise<void> {
    try {
        await fsPromises.mkdir(dirPath, { recursive: true });
    } catch (e: any) {
        if (e.code !== 'EEXIST') throw e;
    }
}

async function writeCheckpoint(root: string, checkpoint: FallbackCheckpoint): Promise<void> {
    const dir = path.join(root, CHECKPOINT_DIR);
    await ensureDir(dir);
    const filePath = path.join(dir, `${checkpoint.id}.json`);
    await fsPromises.writeFile(filePath, JSON.stringify(checkpoint, null, 2), 'utf8');
}

async function writeSnapshot(root: string, snapshot: FallbackSnapshot): Promise<void> {
    const dir = path.join(root, SNAPSHOT_DIR);
    await ensureDir(dir);
    const filePath = path.join(dir, `${snapshot.id}.json`);
    await fsPromises.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
}

export async function fallbackPatchSafe(
    label: string,
    resolvedPath: string,
    originalBuffer: Buffer,
    original: string,
    updated: string
): Promise<FallbackPatchResult> {
    const root = path.resolve(resolvedPath, '..', '..'); // workspace root
    const beforeHash = sha256Buffer(originalBuffer);
    const checkpointId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();

    try {
        // 1. Write checkpoint (like Python harness)
        const checkpoint: FallbackCheckpoint = {
            id: checkpointId,
            timestamp: new Date().toISOString(),
            task: 'Harmony Fallback Patch',
            step: `Before editing ${label}`,
            status: 'in-progress',
            file: resolvedPath,
            note: 'Fallback harness checkpoint (Python harness not available)',
        };
        await writeCheckpoint(root, checkpoint);

        // 2. Verify file hasn't changed (SHA256 conflict check)
        const currentBuffer = await fsPromises.readFile(resolvedPath);
        const currentHash = sha256Buffer(currentBuffer);
        
        if (currentHash !== beforeHash) {
            return {
                ok: false,
                before_sha256: beforeHash,
                after_sha256: currentHash,
                error: `Conflict: file changed during edit. Expected ${beforeHash}, got ${currentHash}`,
                warnings: ['fallback harness: SHA256 conflict detected'],
            };
        }

        // 3. Write snapshot receipt
        const snapshot: FallbackSnapshot = {
            id: snapshotId,
            timestamp: new Date().toISOString(),
            source: root,
            file: resolvedPath,
            before_sha256: beforeHash,
            status: 'in-progress',
        };
        await writeSnapshot(root, snapshot);

        // 4. Atomic write (rename for atomicity)
        const tempPath = resolvedPath + '.tmp';
        await fsPromises.writeFile(tempPath, updated, 'utf8');
        await fsPromises.rename(tempPath, resolvedPath);

        // 5. Verify write
        const afterBuffer = await fsPromises.readFile(resolvedPath);
        const afterHash = sha256Buffer(afterBuffer);
        
        if (afterBuffer.toString('utf8') !== updated) {
            return {
                ok: false,
                before_sha256: beforeHash,
                after_sha256: afterHash,
                error: 'Verification failed: file content mismatch after write',
                warnings: ['fallback harness: write verification failed'],
            };
        }

        // 6. Update snapshot to completed
        snapshot.after_sha256 = afterHash;
        snapshot.status = 'completed';
        await writeSnapshot(root, snapshot);

        // 7. Update checkpoint to completed
        checkpoint.status = 'completed';
        await writeCheckpoint(root, checkpoint);

        const delta = updated.length - original.length;
        return {
            ok: true,
            before_sha256: beforeHash,
            after_sha256: afterHash,
            snapshot,
            checkpoint,
            warnings: [`Fallback harness used (Python not available). Δ ${delta >= 0 ? '+' : ''}${delta} chars`],
        };

    } catch (e: any) {
        return {
            ok: false,
            before_sha256: beforeHash,
            after_sha256: '',
            error: `Fallback harness error: ${e?.message ?? String(e)}`,
            warnings: ['fallback harness: exception during patch'],
        };
    }
}

export function formatFallbackResult(result: FallbackPatchResult, label: string): string {
    if (!result.ok) {
        return [
            `error: fallback patch-safe rejected the edit for ${label}.`,
            `conflict:`,
            `expected ${result.before_sha256}`,
            `current  ${result.after_sha256}`,
            `action: no file changes were made`,
            result.error ? `details: ${result.error}` : '',
        ].filter(Boolean).join('\n');
    }

    const delta = result.after_sha256 && result.before_sha256 
        ? Buffer.from(result.after_sha256, 'hex').length - Buffer.from(result.before_sha256, 'hex').length 
        : 0;
    
    return [
        `verified fallback patch-safe edit [${label}](${label})`,
        `(Δ ${delta >= 0 ? '+' : ''}${delta} chars, sha256 ${result.before_sha256.slice(0, 12)} -> ${result.after_sha256?.slice(0, 12) ?? 'unknown'})`,
        result.snapshot ? `snapshot: .harmony/snapshots/${result.snapshot.id}.json` : '',
        result.checkpoint ? `checkpoint: .harmony/checkpoints/${result.checkpoint.id}.json` : '',
        result.warnings?.length ? `\nwarnings:\n${result.warnings.join('\n')}` : '',
        '',
        'Python harness unavailable; used TypeScript fallback with checkpoint/snapshot.',
    ].filter(Boolean).join('\n');
}
