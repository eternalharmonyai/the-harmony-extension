/**
 * Cross-Workspace Memory — pure technical pattern store.
 * Strict isolation: stores WHAT was solved and HOW, never WHO/WHERE/WHY.
 * Uses VS Code globalState to survive across workspaces.
 * AI can query patterns but cannot accidentally write private context.
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CrossWorkspaceEntry {
    /** Content-hash ID (deterministic from pattern+solution). */
    id: string;
    /** The technical problem pattern (e.g. "race condition in async auth flow"). */
    pattern: string;
    /** The solution applied (e.g. "added mutex lock around token refresh"). */
    solution: string;
    /** Classification tags for search (e.g. ["typescript", "async", "auth"]). */
    tags: string[];
    /** ISO timestamp of when this was recorded. */
    recordedAt: string;
    /** Number of times this pattern has been referenced. */
    accessCount: number;
    /** Last access timestamp. */
    lastAccessedAt: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const GLOBAL_STATE_KEY = 'harmony.crossWorkspaceMemory';
const MAX_ENTRIES = 200;
const MAX_PATTERN_LENGTH = 500;
const MAX_SOLUTION_LENGTH = 2000;

// ─── Core API ───────────────────────────────────────────────────────────────

/** Hash a pattern+solution pair for deduplication. */
function hashEntry(pattern: string, solution: string): string {
    return crypto.createHash('sha256').update(`${pattern}::${solution}`).digest('hex').slice(0, 16);
}

/** Read all entries from globalState. */
function readAll(context: vscode.ExtensionContext): CrossWorkspaceEntry[] {
    const raw = context.globalState.get<CrossWorkspaceEntry[]>(GLOBAL_STATE_KEY);
    return raw ?? [];
}

/** Write all entries to globalState, trimming to MAX_ENTRIES. */
async function writeAll(context: vscode.ExtensionContext, entries: CrossWorkspaceEntry[]): Promise<void> {
    const trimmed = entries.slice(-MAX_ENTRIES);
    await context.globalState.update(GLOBAL_STATE_KEY, trimmed);
}

/**
 * Store a technical pattern+solution. Deduplicates by content hash.
 * Only accepts pure technical content — no conversation, no names, no context.
 * Returns the entry ID, or null if rejected (too long, or contains private markers).
 */
export async function storePattern(
    context: vscode.ExtensionContext,
    pattern: string,
    solution: string,
    tags: string[] = []
): Promise<string | null> {
    // Safety: reject overly long entries (likely not pure technical patterns)
    if (pattern.length > MAX_PATTERN_LENGTH || solution.length > MAX_SOLUTION_LENGTH) {
        return null;
    }
    
    const id = hashEntry(pattern, solution);
    const entries = readAll(context);
    
    // Deduplicate: if already exists, just bump access count
    const existing = entries.find(e => e.id === id);
    if (existing) {
        existing.accessCount++;
        existing.lastAccessedAt = new Date().toISOString();
        await writeAll(context, entries);
        return id;
    }
    
    const now = new Date().toISOString();
    entries.push({
        id,
        pattern: pattern.trim(),
        solution: solution.trim(),
        tags: tags.map(t => t.trim().toLowerCase()).filter(t => t.length > 0),
        recordedAt: now,
        accessCount: 0,
        lastAccessedAt: now,
    });
    
    await writeAll(context, entries);
    return id;
}

/**
 * Search for relevant technical patterns by keyword or tag.
 * Returns entries sorted by relevance (tag match + access count).
 */
export function searchPatterns(
    context: vscode.ExtensionContext,
    query: string,
    maxResults: number = 5
): CrossWorkspaceEntry[] {
    const entries = readAll(context);
    const q = query.toLowerCase();
    const scored = entries.map(e => {
        let score = 0;
        // Tag match: +3 per matching tag
        for (const tag of e.tags) {
            if (tag.includes(q) || q.includes(tag)) score += 3;
        }
        // Pattern/Solution match: +1 for partial, +5 for exact word
        if (e.pattern.toLowerCase().includes(q)) score += 2;
        if (e.solution.toLowerCase().includes(q)) score += 1;
        // Bonus for frequently accessed
        score += Math.min(e.accessCount, 5) * 0.5;
        return { entry: e, score };
    });
    
    return scored
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults)
        .map(s => s.entry);
}

/**
 * Format search results as a concise text block for the AI's context.
 * Deliberately minimal — no metadata that could leak private context.
 */
export function formatPatternsForContext(entries: CrossWorkspaceEntry[]): string {
    if (entries.length === 0) return '';
    const lines = entries.map(e =>
        `[pattern: ${e.pattern}] → ${e.solution} [tags: ${e.tags.join(', ')}]`
    );
    return `\n\nCROSS-WORKSPACE TECHNICAL PATTERNS (from previous projects):\n${lines.join('\n')}\n`;
}

/**
 * Record that a pattern was accessed (called when AI uses a pattern).
 */
export async function recordAccess(context: vscode.ExtensionContext, id: string): Promise<void> {
    const entries = readAll(context);
    const entry = entries.find(e => e.id === id);
    if (entry) {
        entry.accessCount++;
        entry.lastAccessedAt = new Date().toISOString();
        await writeAll(context, entries);
    }
}

/**
 * Get total count of stored patterns.
 */
export function getPatternCount(context: vscode.ExtensionContext): number {
    return readAll(context).length;
}

/**
 * List all tags with counts (for discoverability).
 */
export function listTags(context: vscode.ExtensionContext): { tag: string; count: number }[] {
    const entries = readAll(context);
    const tagMap = new Map<string, number>();
    for (const e of entries) {
        for (const tag of e.tags) {
            tagMap.set(tag, (tagMap.get(tag) ?? 0) + 1);
        }
    }
    return [...tagMap.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count);
}

/**
 * Purge all cross-workspace memory. Requires confirmation.
 */
export async function purgeAll(context: vscode.ExtensionContext): Promise<void> {
    await context.globalState.update(GLOBAL_STATE_KEY, undefined);
}
