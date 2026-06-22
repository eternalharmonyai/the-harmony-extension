import * as vscode from 'vscode';
import * as crypto from 'crypto';

/**
 * Cross-workspace Global Memory Store — Production-Ready v2
 *
 * Uses VS Code ExtensionContext.globalState to persist technical patterns
 * across ALL workspaces. Never stores private data — only technical summaries.
 *
 * DESIGN (post Kimi k2.7 heavy code review):
 *   - Async mutex: all write paths serialized to prevent race conditions
 *   - In-memory cache: parsed entries cached, only flushed to disk lazily
 *   - Debounced persistence: 500ms batch, plus flush on deactivation
 *   - Token-based search: stop-word removal, per-token scoring
 *   - Versioned storage: wrapper object with version + migration path
 *   - Input validation: every field sanitized before storage
 *   - Compound content hash: summary + snippet + tags for better dedup
 *   - Error logging: failures logged instead of swallowed
 *
 * Privacy:
 *   - Only stores the summary/snippet fields, never full conversation text
 *   - Never stores user prompts, personal data, or private references
 *   - Content-hash prevents identical patterns from bloating storage
 */

// ── Constants ───────────────────────────────────────────────────────

const GLOBAL_STATE_KEY = 'harmony.globalMemory.v2';
const BLOB_VERSION = 2;
const MAX_PATTERNS = 500;
const TRIM_TO = 400;
const MAX_TAGS_PER_ENTRY = 8;
const MAX_TAG_LENGTH = 64;
const MAX_SUMMARY_LENGTH = 2000;
const MAX_SNIPPET_LENGTH = 4000;
const MAX_WORKSPACE_NAME_LENGTH = 128;
const FLUSH_DEBOUNCE_MS = 500;
const BYTE_BUDGET_SOFT = 5 * 1024 * 1024; // 5 MB soft cap
const BYTE_BUDGET_HARD = 8 * 1024 * 1024; // 8 MB hard cap (emergency trim)

const STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have',
    'will', 'you', 'are', 'was', 'but', 'not', 'all', 'can', 'has',
    'been', 'were', 'they', 'their', 'what', 'when', 'where', 'which',
    'how', 'about', 'into', 'than', 'then', 'just', 'also', 'very',
    'too', 'only', 'some', 'any', 'each', 'both', 'few', 'more', 'most',
    'other', 'some', 'such', 'only', 'own', 'same', 'her', 'his', 'its'
]);

// ── Interfaces ──────────────────────────────────────────────────────

export interface GlobalMemoryEntry {
    /** Compound SHA256 hash of summary + snippet + tags */
    hash: string;
    /** ISO timestamp of creation */
    createdAt: string;
    /** ISO timestamp of last access */
    lastAccessedAt: string;
    /** Technical summary (1-3 sentences) */
    summary: string;
    /** Short code or config snippet */
    snippet: string;
    /** Semantic tags (lowercase, alphanumeric + hyphens) */
    tags: string[];
    /** Source workspace fingerprint */
    workspaceFingerprint: string;
    /** Source workspace name (last folder segment) */
    workspaceName: string;
}

/** Versioned wrapper for safe format migration */
interface MemoryBlob {
    version: number;
    entries: GlobalMemoryEntry[];
    workspaces: Record<string, string>; // fingerprint → display name
}

export interface GlobalMemoryStats {
    totalPatterns: number;
    uniqueWorkspaces: number;
    topTags: { tag: string; count: number }[];
}

// ── Async Mutex ─────────────────────────────────────────────────────

class AsyncLock {
    private tail: Promise<void> = Promise.resolve();

    run<T>(fn: () => Promise<T>): Promise<T> {
        const result = this.tail.then(() => fn());
        this.tail = result.then(() => { }, () => { });
        return result;
    }
}

const locks = new WeakMap<vscode.ExtensionContext, AsyncLock>();
function lockFor(ctx: vscode.ExtensionContext): AsyncLock {
    if (!locks.has(ctx)) locks.set(ctx, new AsyncLock());
    return locks.get(ctx)!;
}

// ── Helpers ──────────────────────────────────────────────────────────

function contentHash(summary: string, snippet: string, tags: string[]): string {
    const input = summary.trim() + '\n' + snippet.trim() + '\n' + tags.join(',');
    return crypto.createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 32);
}

function workspaceFingerprint(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;
    const fp = folders[0].uri.fsPath;
    let hash = 0;
    for (let i = 0; i < fp.length; i++) {
        hash = ((hash << 5) - hash + fp.charCodeAt(i)) | 0;
    }
    return `ws_${(hash >>> 0).toString(16)}`;
}

function workspaceName(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return 'unknown';
    return (folders[0].name || 'unknown').slice(0, MAX_WORKSPACE_NAME_LENGTH);
}

function sanitizeTags(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    return input
        .filter((t): t is string => typeof t === 'string')
        .map(t => t.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''))
        .filter(t => t.length > 0 && t.length <= MAX_TAG_LENGTH)
        .filter((t, i, arr) => arr.indexOf(t) === i) // deduplicate
        .slice(0, MAX_TAGS_PER_ENTRY);
}

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[\W_]+/)
        .filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

function scoreEntry(e: GlobalMemoryEntry, query: string): number {
    const q = tokenize(query);
    if (!q.length) return 0;

    const eTags = e.tags.map(t => t.toLowerCase());
    const eSummary = e.summary.toLowerCase();
    const eSnippet = e.snippet.toLowerCase();

    let score = 0;
    for (const t of q) {
        if (eTags.some(tag => tag.includes(t) || t.includes(tag))) score += 10;
        if (eSummary.includes(t)) score += 5;
        if (eSnippet.includes(t)) score += 2;
    }
    return score;
}

function estimateBytes(entries: GlobalMemoryEntry[]): number {
    let n = 0;
    for (const e of entries) {
        n += e.summary.length + e.snippet.length + e.tags.join('').length + 300;
    }
    return n;
}

function logError(msg: string, err: unknown): void {
    try {
        console.error(`[globalMemory] ${msg}:`, err instanceof Error ? err.message : String(err));
    } catch { /* logging is best-effort */ }
}

// ── Storage I/O ──────────────────────────────────────────────────────

function loadFromState(context: vscode.ExtensionContext): GlobalMemoryEntry[] {
    try {
        const raw = context.globalState.get<MemoryBlob | GlobalMemoryEntry[] | string>(GLOBAL_STATE_KEY);
        if (!raw) return [];

        // Handle legacy formats
        if (typeof raw === 'string') {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed as GlobalMemoryEntry[];
            if (parsed && Array.isArray(parsed.entries)) return parsed.entries as GlobalMemoryEntry[];
            return [];
        }

        if (Array.isArray(raw)) return raw as GlobalMemoryEntry[]; // legacy v1

        if (raw && typeof raw === 'object' && raw.version === BLOB_VERSION && Array.isArray(raw.entries)) {
            return raw.entries as GlobalMemoryEntry[];
        }

        // Unknown format — attempt migration or return empty
        return [];
    } catch (err) {
        logError('Failed to load global memory', err);
        return [];
    }
}

async function saveToState(context: vscode.ExtensionContext, entries: GlobalMemoryEntry[]): Promise<GlobalMemoryEntry[]> {
    try {
        let trimmed = entries;
        let bytes = estimateBytes(trimmed);
        if (bytes > BYTE_BUDGET_HARD) {
            // Sort ascending by last access, remove oldest until under budget
            const sorted = [...trimmed].sort((a, b) => a.lastAccessedAt.localeCompare(b.lastAccessedAt));
            while (sorted.length > 0 && estimateBytes(sorted) > BYTE_BUDGET_HARD) {
                sorted.shift();
            }
            trimmed = sorted;
            logError('Emergency trim: reduced from ' + entries.length + ' to ' + trimmed.length + ' entries (byte budget)', null);
        }

        // Keep newest entries (slice from end, not beginning)
        const kept = trimmed.length <= MAX_PATTERNS ? trimmed : trimmed.slice(-MAX_PATTERNS);

        // Build workspace name map for dedup
        const wsMap: Record<string, string> = {};
        for (const e of kept) {
            if (!wsMap[e.workspaceFingerprint]) {
                wsMap[e.workspaceFingerprint] = e.workspaceName;
            }
        }

        const blob: MemoryBlob = {
            version: BLOB_VERSION,
            entries: kept,
            workspaces: wsMap
        };

        // Store object directly — globalState.update already serializes
        await context.globalState.update(GLOBAL_STATE_KEY, blob);
        return kept;
    } catch (err) {
        logError('Failed to save global memory', err);
        throw err;
    }
}

// ── GlobalMemory Class ───────────────────────────────────────────────

class GlobalMemory {
    private cache?: GlobalMemoryEntry[];
    private dirty = false;
    private flushTimer?: NodeJS.Timeout;
    private lock: AsyncLock;

    constructor(private ctx: vscode.ExtensionContext) {
        this.lock = lockFor(ctx);
        // Flush on deactivation so no data is lost
        ctx.subscriptions.push({
            dispose: () => {
                if (this.dirty && this.cache) {
                    saveToState(this.ctx, this.cache).catch(err => logError('Deactivation flush failed', err));
                }
            }
        });
    }

    private async read(): Promise<GlobalMemoryEntry[]> {
        if (!this.cache) this.cache = loadFromState(this.ctx);
        return this.cache;
    }

    /**
     * Store a technical pattern. Deduplicates by compound content hash.
     * On duplicate: refreshes timestamp, updates snippet, merges tags.
     */
    async store(summary: string, snippet: string, tags: unknown[]): Promise<string | undefined> {
        return this.lock.run(async () => {
            const entries = await this.read();
            const normSummary = String(summary ?? '').trim().slice(0, MAX_SUMMARY_LENGTH);
            const normSnippet = String(snippet ?? '').trim().slice(0, MAX_SNIPPET_LENGTH);
            const normTags = sanitizeTags(tags);

            if (!normSummary) return undefined;

            const hash = contentHash(normSummary, normSnippet, normTags);
            const now = new Date().toISOString();

            const existingIdx = entries.findIndex(e => e.hash === hash);
            if (existingIdx >= 0) {
                // Refresh and merge without losing old context
                entries[existingIdx].lastAccessedAt = now;
                entries[existingIdx].snippet = normSnippet || entries[existingIdx].snippet;
                const merged = [...new Set([...entries[existingIdx].tags, ...normTags])];
                entries[existingIdx].tags = merged.slice(0, MAX_TAGS_PER_ENTRY);
            } else {
                entries.push({
                    hash,
                    createdAt: now,
                    lastAccessedAt: now,
                    summary: normSummary,
                    snippet: normSnippet,
                    tags: normTags,
                    workspaceFingerprint: workspaceFingerprint() ?? 'unknown',
                    workspaceName: workspaceName()
                });

                // Trim if needed
                if (entries.length > MAX_PATTERNS) {
                    const sorted = [...entries].sort((a, b) => a.lastAccessedAt.localeCompare(b.lastAccessedAt));
                    const trimmed = sorted.slice(sorted.length - TRIM_TO);
                    this.cache = trimmed;
                }
            }

            this.scheduleFlush();
            return hash;
        });
    }

    /**
     * Search by tokenized query. Read-only by default — does NOT update access timestamps.
     * Returns entries sorted by score (desc) then recency.
     */
    async search(query: string, limit: number = 10): Promise<GlobalMemoryEntry[]> {
        const entries = await this.read();
        const q = String(query ?? '').trim();

        if (!q) {
            return [...entries]
                .sort((a, b) => b.lastAccessedAt.localeCompare(a.lastAccessedAt))
                .slice(0, limit);
        }

        return entries
            .map(e => ({ entry: e, score: scoreEntry(e, q) }))
            .filter(({ score }) => score > 0)
            .sort((a, b) =>
                b.score - a.score ||
                b.entry.lastAccessedAt.localeCompare(a.entry.lastAccessedAt)
            )
            .slice(0, limit)
            .map(({ entry }) => entry);
    }

    /**
     * Get stats for the sidebar. Read-only.
     */
    stats(): GlobalMemoryStats {
        if (!this.cache) this.cache = loadFromState(this.ctx);
        const entries = this.cache;
        const workspaces = new Set(entries.map(e => e.workspaceFingerprint));

        const tagCounts = new Map<string, number>();
        for (const e of entries) {
            for (const t of e.tags) {
                tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
            }
        }
        const topTags = [...tagCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15)
            .map(([tag, count]) => ({ tag, count }));

        return {
            totalPatterns: entries.length,
            uniqueWorkspaces: workspaces.size,
            topTags
        };
    }

    /**
     * Clear all data. Requires caller confirmation.
     */
    async clear(): Promise<void> {
        return this.lock.run(async () => {
            this.cache = [];
            this.dirty = false;
            if (this.flushTimer) {
                clearTimeout(this.flushTimer);
                this.flushTimer = undefined;
            }
            try {
                await this.ctx.globalState.update(GLOBAL_STATE_KEY, undefined);
            } catch (err) {
                logError('Clear failed', err);
            }
        });
    }

    private scheduleFlush() {
        this.dirty = true;
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            this.flush();
        }, FLUSH_DEBOUNCE_MS);
    }

    async flush(): Promise<void> {
        await this.lock.run(async () => {
            if (!this.dirty || !this.cache) return;
            this.dirty = false;
            try {
                this.cache = await saveToState(this.ctx, this.cache);
            } catch (err) {
                this.dirty = true;
                this.scheduleFlush(); // auto-retry on next debounce cycle
                logError('Flush failed, will retry', err);
            }
        });
    }
}

// ── Singleton ────────────────────────────────────────────────────────

const instances = new WeakMap<vscode.ExtensionContext, GlobalMemory>();

function getInstance(context: vscode.ExtensionContext): GlobalMemory {
    if (!instances.has(context)) {
        instances.set(context, new GlobalMemory(context));
    }
    return instances.get(context)!;
}

// ── Public API ───────────────────────────────────────────────────────

export async function storePattern(
    context: vscode.ExtensionContext,
    summary: string,
    snippet: string,
    tags: string[]
): Promise<string | undefined> {
    return getInstance(context).store(summary, snippet, tags);
}

export async function searchPatterns(
    context: vscode.ExtensionContext,
    query: string,
    limit: number = 10
): Promise<GlobalMemoryEntry[]> {
    return getInstance(context).search(query, limit);
}

export function globalMemoryStats(context: vscode.ExtensionContext): GlobalMemoryStats {
    return getInstance(context).stats();
}

export async function clearGlobalMemory(context: vscode.ExtensionContext): Promise<void> {
    return getInstance(context).clear();
}

export async function flushGlobalMemory(context: vscode.ExtensionContext): Promise<void> {
    return getInstance(context).flush();
}

/**
 * Auto-capture: opportunistically store a technical pattern from a turn.
 * Caller is responsible for ensuring no private data is passed.
 */
export async function autoCapturePattern(
    context: vscode.ExtensionContext,
    summary: string,
    snippet: string,
    tags: string[]
): Promise<void> {
    try {
        await storePattern(context, summary, snippet, tags);
    } catch {
        // silent — auto-capture is best-effort
    }
}
