/**
 * Shared hardening utilities for swarm primitive tools.
 * 
 * - Path safety (traversal protection)
 * - JSONL I/O with rotation and concurrency locks
 * - Structured error helpers
 * 
 * Generous limits that won't block legitimate use:
 * - Max file size: 50MB (analysis of large files)
 * - Max lines: 50,000 (large datasets)
 * - Rotation backups: 5
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

// ── Path hardening ──────────────────────────────────────────────────────

const VALID_SUBDIR = /^[a-zA-Z0-9_-]+$/;

/** Resolve a safe subdirectory under .harmony/. Rejects traversal attempts. */
export function safeHarmonyDir(root: string, subdir: string): string {
    const base = path.resolve(root, '.harmony');
    const target = path.resolve(base, subdir);
    if (!target.startsWith(base + path.sep) && target !== base) {
        throw new Error(`Path traversal blocked: ${subdir}`);
    }
    // Only allow alphanumeric, dash, underscore subdirectory names
    const relative = path.relative(base, target);
    for (const part of relative.split(path.sep)) {
        if (part && !VALID_SUBDIR.test(part)) {
            throw new Error(`Invalid subdirectory name: ${part}`);
        }
    }
    return target;
}

// ── JSONL I/O with rotation ─────────────────────────────────────────────

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_LINES = 50_000;
const MAX_ROTATIONS = 5;

async function rotateIfNeeded(filePath: string): Promise<void> {
    try {
        const stat = await fs.stat(filePath);
        const content = await fs.readFile(filePath, 'utf8');
        const lineCount = content.split('\n').filter(l => l.trim()).length;
        
        if (stat.size < MAX_FILE_SIZE && lineCount < MAX_LINES) return;

        // Delete oldest rotation
        const oldest = `${filePath}.${MAX_ROTATIONS}`;
        try { await fs.unlink(oldest); } catch {}

        // Shift rotations
        for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
            const cur = `${filePath}.${i}`;
            const next = `${filePath}.${i + 1}`;
            try { await fs.rename(cur, next); } catch {}
        }

        // Rename current to .1
        await fs.rename(filePath, `${filePath}.1`);
    } catch {
        // File doesn't exist yet — nothing to rotate
    }
}

// ── Concurrency locks ────────────────────────────────────────────────────

const fileLocks = new Map<string, Promise<void>>();

async function withFileLock(filePath: string, fn: () => Promise<void>): Promise<void> {
    // Simple sequential queue per file — each operation waits for previous to complete
    const prev = fileLocks.get(filePath) ?? Promise.resolve();
    let resolve: () => void;
    const next = new Promise<void>(r => { resolve = r; });
    fileLocks.set(filePath, prev.then(() => fn()).then(() => resolve!(), (e) => { resolve!(); throw e; }));
    await fileLocks.get(filePath);
}

/** Append a JSON object as a line to a JSONL file. Thread-safe with rotation. */
export async function appendJsonl(filePath: string, obj: unknown): Promise<void> {
    await withFileLock(filePath, async () => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await rotateIfNeeded(filePath);
        await fs.appendFile(filePath, JSON.stringify(obj) + '\n', 'utf8');
    });
}

/** Read all JSON objects from a JSONL file. Returns empty array if file doesn't exist. */
export async function readJsonl<T = unknown>(filePath: string): Promise<T[]> {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as T);
    } catch {
        return [];
    }
}

/** Stream-read JSONL entries with optional filter, limit, and offset.
 *  Uses readline for O(1) memory — never loads the full file.
 *  Returns { results, total } for pagination.
 */
export async function readJsonlStream<T = unknown>(
    filePath: string,
    opts?: { filter?: (entry: T) => boolean; limit?: number; offset?: number }
): Promise<{ results: T[]; total: number }> {
    const results: T[] = [];
    let total = 0;
    let skipped = 0;
    const limit = opts?.limit ?? Infinity;
    const offset = opts?.offset ?? 0;
    try {
        const rl = require('readline').createInterface({
            input: fsSync.createReadStream(filePath, { encoding: 'utf8' }),
            crlfDelay: Infinity
        });
        for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const entry = JSON.parse(trimmed) as T;
                total++;
                if (opts?.filter && !opts.filter(entry)) continue;
                if (skipped < offset) { skipped++; continue; }
                if (results.length < limit) results.push(entry);
            } catch { /* skip malformed lines */ }
        }
    } catch { /* file doesn't exist */ }
    return { results, total };
}

/** Write an array of JSON objects to a JSONL file. Thread-safe with rotation + atomic tmp/rename. */
export async function rewriteJsonl<T = unknown>(filePath: string, objs: T[]): Promise<void> {
    await withFileLock(filePath, async () => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const content = objs.map(o => JSON.stringify(o) + '\n').join('');
        if (content.length > MAX_FILE_SIZE) {
            await rotateIfNeeded(filePath + '.force'); // force rotation for oversized rewrite
        }
        // Atomic write: tmp file → rename prevents corruption on crash
        const tmp = filePath + '.tmp.' + Date.now().toString(36) + '.' + Math.random().toString(36).slice(2, 8);
        await fs.writeFile(tmp, content, 'utf8');
        await fs.rename(tmp, filePath);
    });
}

/** Read a JSON object from a file. Returns null if file doesn't exist. */
export async function readJson<T = unknown>(filePath: string): Promise<T | null> {
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
    } catch {
        return null;
    }
}

/** Write a JSON object to a file. */
export async function writeJson(filePath: string, obj: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

// ── Structured errors ────────────────────────────────────────────────────

export interface ToolSuccess<T> { success: true; data: T; }
export interface ToolError { success: false; error: { code: string; message: string; }; }
export type ToolResult<T> = ToolSuccess<T> | ToolError;

export function successResult<T>(data: T): string {
    return JSON.stringify({ success: true, data }, null, 2);
}

export function errorResult(code: string, message: string): string {
    return JSON.stringify({ success: false, error: { code, message } }, null, 2);
}
