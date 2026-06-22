import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

export class OperationLockError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OperationLockError';
    }
}

interface OperationLockRecord {
    id: string;
    resource: string;
    operation: string;
    owner: string;
    pid: number;
    createdAt: string;
    expiresAt: string;
    details?: Record<string, unknown>;
}

function safeLockName(resource: string): string {
    return resource.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'resource';
}

async function readExistingLock(filePath: string): Promise<OperationLockRecord | undefined> {
    try {
        const text = await fs.readFile(filePath, 'utf8');
        return JSON.parse(text) as OperationLockRecord;
    } catch {
        return undefined;
    }
}

async function releaseOperationLock(filePath: string, id: string): Promise<void> {
    const existing = await readExistingLock(filePath);
    if (existing?.id === id) {
        await fs.rm(filePath, { force: true });
    }
}

export async function withOperationLock<T>(
    workspaceRoot: string,
    resource: string,
    operation: string,
    details: Record<string, unknown>,
    fn: () => Promise<T>,
    ttlMs = 10 * 60 * 1000
): Promise<T> {
    const dir = path.join(workspaceRoot, '.harmony', 'locks');
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${safeLockName(resource)}.lock.json`);
    const now = Date.now();
    const record: OperationLockRecord = {
        id: crypto.randomUUID(),
        resource,
        operation,
        owner: 'harmony-extension',
        pid: process.pid,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
        details
    };

    try {
        await fs.writeFile(filePath, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' });
    } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await readExistingLock(filePath);
        const expired = existing?.expiresAt ? Date.parse(existing.expiresAt) < Date.now() : false;
        if (expired) {
            await fs.rm(filePath, { force: true });
            await fs.writeFile(filePath, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' });
        } else {
            const holder = existing
                ? `${existing.operation} since ${existing.createdAt}, expires ${existing.expiresAt}`
                : 'unknown operation';
            throw new OperationLockError(`resource is already locked: ${resource} (${holder}). Retry after the current operation finishes, or inspect .harmony/locks if this looks stale.`);
        }
    }

    try {
        return await fn();
    } finally {
        await releaseOperationLock(filePath, record.id).catch(() => undefined);
    }
}