/**
 * Error Pattern Learning — layered on CareBloom.
 *
 * When tools fail, this module fingerprints the errors, matches them against
 * a micro-lesson index built from resolved CareBloom sprouts, and surfaces
 * relevant past fixes so the AI can learn from experience.
 *
 * Design:
 *  - Error fingerprinting strips dynamic data (line numbers, paths, UUIDs)
 *    before hashing, so "one character off" bugs match across files.
 *  - Substring matching against a compiled index — no vector DB, no embeddings.
 *  - Zero-token idle state: matching only runs on tool failure.
 *  - Hard limit of 2 matches to prevent context bloat.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { createHash } from 'crypto';

// ── Types ──────────────────────────────────────────────────────────────────

export interface MicroLesson {
    /** Unique id from the source sprout file */
    id: string;
    /** Normalized error substrings that trigger this lesson */
    triggers: string[];
    /** File patterns (glob-like) that provide additional context */
    fileTargets: string[];
    /** Distilled fix in English */
    lessonEn: string;
    /** Distilled fix in Chinese */
    lessonZh: string;
}

export interface MatchResult {
    lesson: MicroLesson;
    /** Which trigger substring matched */
    matchedTrigger: string;
}

// ── State ──────────────────────────────────────────────────────────────────

let enabled = false;
let indexCache: MicroLesson[] | null = null;
const INDEX_PATH = '.carebloom/troubleshooting_index.json';

// ── Config ─────────────────────────────────────────────────────────────────

export function setErrorLearningEnabled(on: boolean): void {
    enabled = on;
    if (!on) indexCache = null;
}

export function isErrorLearningEnabled(): boolean {
    return enabled;
}

// ── Error Normalization & Fingerprinting ────────────────────────────────────

/**
 * Strip dynamic data from an error string so similar errors match across
 * files, languages, and sessions. Returns the normalized TEXT — not a hash —
 * so substring matching can catch near-misses ("one character off" bugs).
 *
 * Removes: line numbers, hex addresses, UUIDs, file paths, memory sizes,
 * timestamps, email addresses, IPs, and potential PII tokens.
 */
function normalizeError(raw: string): string {
    let cleaned = raw;
    // Email addresses (PII)
    cleaned = cleaned.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, 'EMAIL');
    // IP addresses (PII)
    cleaned = cleaned.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, 'IP');
    // API key patterns (PII)
    cleaned = cleaned.replace(/\b(sk|pk|api[_-]?key|token|secret|bearer)[=: ]+[a-zA-Z0-9_\-]{16,}/gi, 'APIKEY_REDACTED');
    // Line numbers: :42, line 42, (line 42)
    cleaned = cleaned.replace(/:\d+(:\d+)?/g, ':N');
    cleaned = cleaned.replace(/line \d+/gi, 'line N');
    // Hex addresses: 0x7fff...
    cleaned = cleaned.replace(/0x[0-9a-fA-F]{4,}/g, '0xADDR');
    // UUIDs
    cleaned = cleaned.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID');
    // File paths (Windows and Unix)
    cleaned = cleaned.replace(/[A-Za-z]:\\[^\s]+/g, 'PATH');
    cleaned = cleaned.replace(/\/[^\s]+\.[a-z]+/g, '/PATH');
    // Memory sizes: 123456 bytes, 1.5MB
    cleaned = cleaned.replace(/\d+[,.]?\d*\s*(bytes?|KB|MB|GB)/gi, 'SIZE');
    // Timestamps
    cleaned = cleaned.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g, 'TS');
    // Collapse whitespace and lowercase
    return cleaned.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Create a compact fingerprint hash from a normalized error string.
 * Used for deduplication and exact-match lookups.
 */
function fingerprintError(normalized: string): string {
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

// ── Index Management ───────────────────────────────────────────────────────

async function loadIndex(workspaceRoot: string): Promise<MicroLesson[]> {
    if (indexCache) return indexCache;
    try {
        const raw = await fs.readFile(path.join(workspaceRoot, INDEX_PATH), 'utf-8');
        const data = JSON.parse(raw);
        indexCache = (data.lessons || []) as MicroLesson[];
    } catch {
        indexCache = [];
    }
    return indexCache;
}

/**
 * Compile a resolved CareBloom sprout into the micro-lesson index.
 * Called by scanResolvedSprouts when it finds newly resolved sprouts.
 */
export async function compileSprout(
    workspaceRoot: string,
    sproutPath: string,
    frontmatter: any
): Promise<void> {
    if (!frontmatter?.resolved) return;

    const indexPath = path.join(workspaceRoot, INDEX_PATH);
    const existing = await loadIndex(workspaceRoot);

    // Extract triggers from invocation history errors.
    // Store NORMALIZED TEXT (not hashes) so substring matching works.
    const triggers: string[] = [];
    const history = frontmatter.invocationHistory || [];
    for (const entry of history) {
        if (!entry.success && entry.outcome) {
            const norm = normalizeError(entry.outcome);
            if (norm.length > 4 && !triggers.includes(norm)) {
                triggers.push(norm);
            }
        }
    }

    // Extract file targets from the sprout
    const fileTargets: string[] = [];
    if (frontmatter.target && frontmatter.target !== 'the workspace') {
        fileTargets.push(path.basename(frontmatter.target));
    }

    // Extract lessons from resolved reflection body
    // (The LLM fills in the reflection after the frontmatter)
    let lessonEn = frontmatter.lesson_en || '';
    let lessonZh = frontmatter.lesson_zh || '';

    const lesson: MicroLesson = {
        id: path.basename(sproutPath, '.md'),
        triggers,
        fileTargets,
        lessonEn,
        lessonZh,
    };

    // Deduplicate by id
    const filtered = existing.filter(l => l.id !== lesson.id);
    filtered.push(lesson);

    // Cap at MAX_LESSONS, evicting oldest (front of array) by insertion order
    const MAX_LESSONS = 200;
    while (filtered.length > MAX_LESSONS) {
        filtered.shift();
    }

    // Atomic write: write to .tmp first, then rename to prevent corruption
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    const tmpPath = indexPath + '.tmp';
    const payload = JSON.stringify({ version: '1.0', lessons: filtered }, null, 2);
    await fs.writeFile(tmpPath, payload, 'utf-8');
    await fs.rename(tmpPath, indexPath);
    indexCache = filtered;
}

// ── Matching Engine ────────────────────────────────────────────────────────

/**
 * Match a tool failure against the micro-lesson index.
 * Only runs when errorLearning is enabled.
 * Returns up to 2 matches, sorted by trigger specificity.
 */
export async function matchError(
    workspaceRoot: string,
    errorOutput: string,
    activeFilePath?: string
): Promise<MatchResult[]> {
    if (!enabled) return [];

    const lessons = await loadIndex(workspaceRoot);
    if (!lessons.length) return [];

    const normalizedError = errorOutput.toLowerCase();
    const activeFile = activeFilePath ? path.basename(activeFilePath).toLowerCase() : undefined;

    const matches = lessons.flatMap(lesson => {
        // Match by normalized error text substring (catches "one char off" near-misses)
        for (const trigger of lesson.triggers) {
            // High threshold: require at least 20 chars of overlap to avoid false positives
            if (trigger.length >= 20 && normalizedError.includes(trigger)) {
                return [{ lesson, matchedTrigger: trigger.slice(0, 60) }];
            }
        }
        // Match by file context
        if (activeFile && lesson.fileTargets.some(f => activeFile.includes(f.toLowerCase()))) {
            return [{ lesson, matchedTrigger: `file:${activeFile}` }];
        }
        return [];
    });

    // Deduplicate by lesson id, take top 2
    const seen = new Set<string>();
    return matches.filter(m => {
        if (seen.has(m.lesson.id)) return false;
        seen.add(m.lesson.id);
        return true;
    }).slice(0, 2);
}

// ── Warning Formatting ─────────────────────────────────────────────────────

/**
 * Format a match result as a compact system instruction in the requested language.
 */
export function formatWarning(match: MatchResult, lang: 'en' | 'zh'): string {
    if (lang === 'zh') {
        return match.lesson.lessonZh
            ? `[排错提示] ${match.lesson.lessonZh}`
            : `[排错提示] 检测到与过去已解决的错误相似的模式。`;
    }
    return match.lesson.lessonEn
        ? `[Troubleshooting] ${match.lesson.lessonEn}`
        : `[Troubleshooting] A similar error pattern was detected and resolved before.`;
}
