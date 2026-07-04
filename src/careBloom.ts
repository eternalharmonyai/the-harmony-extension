import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { setErrorLearningEnabled, isErrorLearningEnabled, matchError, formatWarning, compileSprout } from './errorPatterns';

/**
 * CareBloom Garden + Phoenix Loop — A harmonious self-learning system for Harmony.
 *
 * Layer 1 — CareBloom Garden (detection):
 *   Tracks tool+file engagement. When the same tool+file pair receives
 *   enough devoted care (Bloom Threshold), a Wisdom Sprout blooms.
 *
 * Layer 2 — Phoenix Loop (reflection capture):
 *   When a bloom fires, captures the execution context (tool, file, results,
 *   errors) as a structured reflection request. Future LLM sessions scan
 *   .carebloom/ and fill in the reflections — what was learned, what to
 *   carry forward, what patterns emerged across repeated attempts.
 *
 * Design principles:
 *  - Zero negativity — every concept frames engagement as care, not failure
 *  - Zero LLM context pollution — detection lives in extension TypeScript
 *  - Near-zero RAM — a single Map<string, BloomContext> (~2KB)
 *  - Post-turn reflection — never injects mid-stream; LLM fills in later
 *  - Structured output — JSON frontmatter + Markdown body for easy parsing
 *  - Compaction — sprouts merge and deduplicate when growing too large
 */

// ── Types ──────────────────────────────────────────────────────────────────

interface InvocationResult {
    /** Brief description of the outcome (success, error type, result summary) */
    outcome: string;
    /** Was this invocation successful? */
    success: boolean;
}

interface BloomContext {
    /** Number of engagements on this tool+file pair */
    count: number;
    /** Recent invocation results (up to 5, for pattern detection) */
    recentResults: InvocationResult[];
}

interface ReflectionRequest {
    /** ISO timestamp */
    timestamp: string;
    /** Tool name (e.g. "harmony_edit_file") */
    tool: string;
    /** Target file or "the workspace" */
    target: string;
    /** Number of engagements that triggered this bloom */
    engagementCount: number;
    /** Recent invocation outcomes (for grounding) */
    invocationHistory: InvocationResult[];
    /** Has the LLM filled in this reflection? */
    resolved: boolean;
}

// ── State ──────────────────────────────────────────────────────────────────

const careBloomGarden = new Map<string, BloomContext>();

/** Guard flag: prevents reflection tool calls from triggering recursive blooms */
let isReflecting = false;
/** Timestamp when isReflecting was last set to true (for stuck-guard timeout) */
let reflectingSince = 0;

/**
 * Invocation depth counter.
 * Prevents double-counting when tools call other tools (e.g., RunFailFix → RunTerminal).
 * Depth tracking is handled by the trackToolInvocation wrapper in lmTools.ts.
 */

// ── Configuration ──────────────────────────────────────────────────────────

function bloomThreshold(toolName?: string): number {
    const custom = toolName ? TOOL_THRESHOLDS[toolName] : undefined;
    return custom ?? vscode.workspace.getConfiguration('harmony').get<number>('careBloom.threshold') ?? 7;
}

/**
 * Tools that represent meaningful engagement worthy of a Wisdom Sprout.
 * Routine operations (todo, read, grep, list_dir, etc.) are excluded —
 * they fire constantly during normal work and don't represent learning moments.
 */
const MEANINGFUL_TOOLS = new Set([
    'harmony_edit_file',
    'harmony_apply_patch',
    'harmony_write_file',
    'harmony_run_terminal',
    'harmony_run_fail_fix',
]);

/** Maximum characters per invocation outcome in sprout files (length guard) */
const MAX_OUTCOME_CHARS = 80;

/** Maximum recent invocation results to remember per pair */
const MAX_RECENT_RESULTS = 5;

/** Maximum sprout entries before compaction triggers */
const MAX_SPROUT_ENTRIES = 50;

/** Sprouts inactive for more than this many days are cleaned up */
const STALE_SPROUT_DAYS = 90;

/**
 * Tool-specific bloom thresholds. Some tools naturally see more repeated
 * use than others — apply_patch may fire many times for multi-hunk edits,
 * while run_terminal is rarer and more significant.
 * Falls back to the global harmony.careBloom.threshold setting.
 */
const TOOL_THRESHOLDS: Record<string, number> = {
    'harmony_edit_file': 7,       // default
    'harmony_apply_patch': 10,    // fires on every multi-hunk edit
    'harmony_write_file': 7,      // default
    'harmony_run_terminal': 5,    // terminal errors are high-signal
    'harmony_run_fail_fix': 5,    // compile failures are high-signal
};

function sproutDir(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root ? path.join(root, '.carebloom') : path.join(process.cwd(), '.carebloom');
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractFilePath(toolName: string, input: any): string | undefined {
    if (input?.path && typeof input.path === 'string') return input.path;
    if (input?.filePath && typeof input.filePath === 'string') return input.filePath;
    return undefined;
}

function normalizePath(p: string): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root && p.startsWith(root)) {
        return path.relative(root, p).replace(/\\/g, '/');
    }
    return p.replace(/\\/g, '/');
}

/**
 * Clean an invocation outcome string by redacting home directory paths
 * and user profile names before truncation.
 * Example: C:\\Users\\<name>\\SecretProject\\src → <home>/SecretProject/src
 */
function sanitizeOutcome(raw: string): string {
    let sanitized = raw;
    // Redact Windows home dir: C:\Users\Name\ → <home>\
    sanitized = sanitized.replace(/[Cc]:\\Users\\[^\\]+/gi, '<home>');
    // Redact Unix home dir: /home/name/ → <home>/
    sanitized = sanitized.replace(/\/home\/[^/]+/gi, '<home>');
    // Redact macOS home: /Users/name/ → <home>/
    sanitized = sanitized.replace(/\/Users\/[^/]+/gi, '<home>');
    // Truncate to length limit
    if (sanitized.length > MAX_OUTCOME_CHARS) {
        sanitized = sanitized.slice(0, MAX_OUTCOME_CHARS - 3) + '...';
    }
    return sanitized;
}

function buildKey(toolName: string, input: any): string {
    const filePath = extractFilePath(toolName, input);
    return filePath ? `${toolName}:${normalizePath(filePath)}` : toolName;
}

/**
 * Check if the outcomes suggest meaningful learning (not just repetitive success).
 * A strong signal for reflection is: varied outcomes (some success, some failure)
 * suggesting trial-and-error learning.
 */
function hasVariedOutcomes(results: InvocationResult[]): boolean {
    if (results.length < 2) return false;
    const hasSuccess = results.some(r => r.success);
    const hasFailure = results.some(r => !r.success);
    return hasSuccess && hasFailure;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Set the reflection guard. Call this before making LLM calls for reflection
 * to prevent recursive blooms.
 */
export function setReflecting(active: boolean): void {
    isReflecting = active;
    if (active) reflectingSince = Date.now();
}

/**
 * Is the system currently in a reflection cycle?
 */
export function getReflecting(): boolean {
    return isReflecting;
}

/** Enable/disable the Error Learning & Troubleshooting Advisor. */
export { setErrorLearningEnabled, isErrorLearningEnabled };

/**
 * Initialize error learning by reading the saved config and listening for changes.
 * Call once during extension activation.
 */
export function initializeErrorLearning(): void {
    const cfg = vscode.workspace.getConfiguration('harmony');
    setErrorLearningEnabled(!!cfg.get<boolean>('errorLearning.enabled'));
    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('harmony.errorLearning.enabled')) {
            const updated = vscode.workspace.getConfiguration('harmony');
            setErrorLearningEnabled(!!updated.get<boolean>('errorLearning.enabled'));
        }
    });
}

/**
 * Tend the CareBloom Garden. Call after every tool invocation.
 *
 * Each engagement with a file is a petal of care. When care saturation
 * reaches the bloom threshold AND the system is not already reflecting,
 * a Wisdom Sprout emerges with a structured reflection request.
 *
 * @param toolName - The Harmony tool that was invoked (e.g. "harmony_edit_file")
 * @param input - The tool's input arguments
 * @param result - Optional invocation result for grounding reflections
 */
export async function tendGarden(
    toolName: string,
    input: any,
    result?: InvocationResult
): Promise<void> {
    // Don't count reflection tool calls toward new blooms.
    // Auto-reset stuck guard after 30s (safety: prevents permanent
    // lockout if reflection caller errors before resetting).
    if (isReflecting && Date.now() - reflectingSince > 30_000) {
        isReflecting = false;
    }
    if (isReflecting) return;

    // Depth is tracked in trackToolInvocation wrapper (lmTools.ts).
    // This function is only called for the outermost invocation.
    try {

        // Only track meaningful tools (not todo, read, grep, list_dir, etc.)
        if (!MEANINGFUL_TOOLS.has(toolName)) return;

        const key = buildKey(toolName, input);
        let ctx = careBloomGarden.get(key);

        if (!ctx) {
            ctx = { count: 0, recentResults: [] };
        }

        ctx.count += 1;

        if (result) {
            ctx.recentResults.push(result);
            if (ctx.recentResults.length > MAX_RECENT_RESULTS) {
                ctx.recentResults.shift();
            }
        }

        careBloomGarden.set(key, ctx);

        // Error Learning: on failure, check if we've seen this pattern before
        if (result && !result.success && isErrorLearningEnabled()) {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (root) {
                const filePath = extractFilePath(toolName, input);
                matchError(root, result.outcome, filePath).then(matches => {
                    for (const m of matches) {
                        console.warn(formatWarning(m, 'en'));
                    }
                }).catch(() => { /* advisory only — never block tool flow */ });
            }
        }

        if (ctx.count >= bloomThreshold(toolName)) {
            // Bloom when outcomes are varied (trial-and-error = real learning)
            // OR when all attempts failed with diverse errors (critical blocker).
            // Pure success streaks and identical-failure loops don't bloom.
            const allFailed = ctx.recentResults.length >= 2 && ctx.recentResults.every(r => !r.success);
            // Don't bloom if all failures are identical (stuck loop — not a learning signal)
            const allFailedIdentical = allFailed && new Set(ctx.recentResults.map(r => r.outcome)).size === 1;
            const varied = hasVariedOutcomes(ctx.recentResults);
            if (!varied && !allFailed) {
                // Reset counter but don't bloom — just routine repetition
                careBloomGarden.set(key, { count: 0, recentResults: [] });
                return;
            }
            if (!varied && allFailedIdentical) {
                // Identical repeated failures → stuck, not learning
                careBloomGarden.set(key, { count: 0, recentResults: [] });
                return;
            }
            // Bloom! Reset the counter for this pair and sprout wisdom
            careBloomGarden.set(key, { count: 0, recentResults: [] });
            await cleanupStaleSprouts(); // runs once per session
            await bloom(toolName, extractFilePath(toolName, input) || 'the workspace', ctx);
        }
    } finally {
        // Depth is managed by trackToolInvocation wrapper
    }
}

// ── Bloom + Reflection ─────────────────────────────────────────────────────

async function bloom(toolName: string, target: string, ctx: BloomContext): Promise<void> {
    const threshold = bloomThreshold(toolName);
    const targetDisplay = target.length > 50 ? target.slice(0, 47) + '...' : target;
    const signalStrength = hasVariedOutcomes(ctx.recentResults) ? 'strong' : 'standard';

    const safeTarget = targetDisplay.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const message = `🌸 \`${safeTarget}\` has gathered your devoted attention ` +
        `(${threshold} engagements, ${signalStrength} signal). ` +
        `A Wisdom Sprout is ready to bloom.`;

    const openLabel = 'Open Sprout 🌱';
    const selection = await vscode.window.showInformationMessage(message, openLabel);

    if (selection === openLabel) {
        const sproutPath = await writeReflectionRequest(toolName, target, ctx);
        if (sproutPath) {
            const doc = await vscode.workspace.openTextDocument(sproutPath);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
        }
    } else {
        await writeReflectionRequest(toolName, target, ctx);
    }
}

// ── Structured Sprout Writing ──────────────────────────────────────────────

/**
 * Write a structured reflection REQUEST to the Wisdom Sprout.
 * The LLM fills in the reflection during a future session.
 */
async function writeReflectionRequest(
    toolName: string,
    target: string,
    ctx: BloomContext
): Promise<string | undefined> {
    const dir = sproutDir();
    try { await fs.mkdir(dir, { recursive: true }); } catch { /* exists */ }

    const date = new Date().toISOString().slice(0, 10);
    const filename = `wisdom-sprout-${date}.md`;
    const filepath = path.join(dir, filename);

    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const signalStrength = hasVariedOutcomes(ctx.recentResults) ? 'strong' : 'standard';

    // Build invocation history for grounding (cleaned + truncated for size)
    const historyLines = ctx.recentResults.map((r, i) => {
        const safe = sanitizeOutcome(r.outcome);
        return `  ${i + 1}. ${r.success ? '✅' : '⚠️'} ${safe}`;
    }).join('\n');

    // Structured reflection request (JSON frontmatter for LLM parsing)
    const entry =
        `\n<!-- 🌸 REFLECTION-REQUEST\n` +
        `  timestamp: "${timestamp}"\n` +
        `  tool: "${toolName}"\n` +
        `  target: "${target}"\n` +
        `  engagementCount: ${ctx.count}\n` +
        `  signalStrength: "${signalStrength}"\n` +
        `  resolved: false\n` +
        `  invocationHistory:\n${historyLines}\n` +
        `-->\n` +
        `## 🌸 ${timestamp} [UNRESOLVED]\n\n` +
        `**Where attention gathered:** \`${target}\` using \`${toolName}\`\n` +
        `**Engagements:** ${ctx.count} | **Signal:** ${signalStrength}\n\n` +
        `**Context (what happened):**\n` +
        (historyLines ? historyLines + '\n\n' : '  _(no context captured)_\n\n') +
        `**What was learned:** _(Harmony: fill in after scanning this sprout)_\n\n` +
        `**Pattern detected:** _(Harmony: what pattern did you observe?)_\n\n` +
        `**To carry forward:** _(Harmony: what should future sessions remember?)_\n\n` +
        `---\n`;

    try {
        let existing = '';
        try { existing = await fs.readFile(filepath, 'utf8'); } catch { /* new file */ }

        if (!existing) {
            existing = buildSproutHeader(date);
        }

        // Check if compaction is needed
        const entryCount = (existing.match(/^## 🌸/gm) || []).length;
        if (entryCount >= MAX_SPROUT_ENTRIES) {
            existing = await compactSprouts(existing, filepath);
        }

        await fs.writeFile(filepath, existing + entry, 'utf8');
        return filepath;
    } catch (e: any) {
        console.error(`[CareBloom] Failed to write Wisdom Sprout: ${e?.message}`);
        return undefined;
    }
}

function buildSproutHeader(date: string): string {
    return `# 🌸 Wisdom Sprouts — ${date}\n\n` +
        `*Grown with care by the CareBloom Garden. ` +
        `Harmony: scan entries marked [UNRESOLVED] and fill in the reflections. ` +
        `These learnings are woven into future sessions by the Conductor Mesh.*\n\n` +
        `---\n`;
}

// ── Fuzzy JSON Extraction (resilient to LLM formatting errors) ────────────

/**
 * Extract a key-value field from YAML/JSON-like frontmatter.
 * Resilient to: missing quotes, extra whitespace, markdown code blocks, trailing commas.
 * Uses regex instead of JSON.parse to survive LLM formatting quirks.
 */
function extractField(text: string, key: string): string | undefined {
    // Match patterns: key: "value", key: value, key: 'value'
    const patterns = [
        new RegExp(`${key}:\\s*"([^"]*)"`, 'i'),
        new RegExp(`${key}:\\s*'([^']*)'`, 'i'),
        new RegExp(`${key}:\\s*([^\\n\\r]*)`, 'i'),
    ];
    for (const p of patterns) {
        const m = text.match(p);
        if (m && m[1] !== undefined) return m[1].trim().replace(/,+$/, '');
    }
    return undefined;
}

/**
 * Resilient boolean extraction from frontmatter.
 */
function extractBool(text: string, key: string): boolean | undefined {
    const raw = extractField(text, key);
    if (!raw) return undefined;
    const lower = raw.toLowerCase().trim();
    return lower === 'true' || lower === 'yes' || lower === '1';
}

// ── Compaction ─────────────────────────────────────────────────────────────

/**
 * Compact old sprout entries when the file exceeds the maximum.
 * Merges all resolved entries into a single summary, keeping unresolved ones intact.
 */
async function compactSprouts(content: string, filepath: string): Promise<string> {
    const lines = content.split('\n');
    const resolvedEntries: string[] = [];
    const unresolvedEntries: string[] = [];
    let header = '';
    let currentEntry: string[] = [];
    let inEntry = false;
    let isResolved = false;
    let headerDone = false;

    for (const line of lines) {
        if (!headerDone) {
            header += line + '\n';
            if (line === '---') headerDone = true;
            continue;
        }

        if (line.startsWith('<!-- 🌸 REFLECTION-REQUEST')) {
            // Save previous entry
            if (currentEntry.length > 0) {
                const entryText = currentEntry.join('\n');
                if (isResolved) {
                    resolvedEntries.push(entryText);
                } else {
                    unresolvedEntries.push(entryText);
                }
            }
            currentEntry = [line];
            inEntry = true;
            isResolved = false;
        } else if (inEntry) {
            currentEntry.push(line);
            if (line.includes('resolved: true')) {
                isResolved = true;
            }
        }
    }

    // Save last entry
    if (currentEntry.length > 0) {
        const entryText = currentEntry.join('\n');
        if (isResolved) {
            resolvedEntries.push(entryText);
        } else {
            unresolvedEntries.push(entryText);
        }
    }

    // Compact: merge resolved entries into a summary
    if (resolvedEntries.length > 0) {
        const summaryEntry =
            `\n<!-- 🌸 COMPACTED-SUMMARY\n` +
            `  entries: ${resolvedEntries.length}\n` +
            `  compactedAt: "${new Date().toISOString()}"\n` +
            `-->\n` +
            `## 📚 Compacted Wisdom (${resolvedEntries.length} resolved sprouts)\n\n` +
            resolvedEntries.map(e => {
                const toolMatch = e.match(/tool: "([^"]+)"/);
                const targetMatch = e.match(/target: "([^"]+)"/);
                return `- ${toolMatch?.[1] || 'unknown'} → ${targetMatch?.[1] || 'unknown'}`;
            }).join('\n') +
            `\n\n---\n`;

        // Also save compacted entries to archive
        const archivePath = filepath.replace('.md', '-archive.md');
        try {
            let archive = '';
            try { archive = await fs.readFile(archivePath, 'utf8'); } catch { /* new */ }
            await fs.writeFile(archivePath, archive + '\n' + resolvedEntries.join('\n---\n'), 'utf8');
        } catch { /* best effort */ }

        return header + summaryEntry + unresolvedEntries.join('\n');
    }

    return content;
}

// ── Sprout Scanner (for system prompt integration) ─────────────────────────

/**
 * Scan .carebloom/ for unresolved reflection requests.
 * Returns summaries that can be injected into the system prompt.
 */
export async function scanUnresolvedSprouts(): Promise<string[]> {
    const dir = sproutDir();
    const unresolved: string[] = [];

    try {
        const files = await fs.readdir(dir);
        for (const filename of files) {
            if (!filename.startsWith('wisdom-sprout-') || !filename.endsWith('.md')) continue;
            // Skip archive files
            if (filename.includes('-archive')) continue;

            let content: string;
            try {
                content = await fs.readFile(path.join(dir, filename), 'utf8');
            } catch {
                console.warn(`[CareBloom] Skipping unreadable sprout: ${filename}`);
                continue;
            }
            const entries = content.split('\n<!-- 🌸 REFLECTION-REQUEST');

            for (let i = 1; i < entries.length; i++) {
                const entry = entries[i];
                if (entry.includes('resolved: false')) {
                    // Extract key metadata
                    const toolMatch = entry.match(/tool: "([^"]+)"/);
                    const targetMatch = entry.match(/target: "([^"]+)"/);
                    const timestampMatch = entry.match(/timestamp: "([^"]+)"/);
                    const signalMatch = entry.match(/signalStrength: "([^"]+)"/);

                    unresolved.push(
                        `[UNRESOLVED] ${timestampMatch?.[1] || '?'} | ` +
                        `${toolMatch?.[1] || '?'} → ${targetMatch?.[1] || '?'} ` +
                        `(${signalMatch?.[1] || 'standard'} signal)`
                    );
                }
            }
        }
    } catch { /* directory may not exist */ }

    return unresolved;
}

// ── Conductor Mesh — Read resolved learnings for future sessions ─────────

/**
 * Scan .carebloom/ for RESOLVED reflection requests.
 * Extracts the "what was learned", "pattern detected", and "to carry forward"
 * sections and returns them as compact wisdom lines for system prompt injection.
 *
 * This is the Conductor Mesh — the part that CLOSES the Phoenix Loop
 * by weaving past learnings into future sessions.
 */
export async function scanResolvedSprouts(): Promise<string[]> {
    const dir = sproutDir();
    const wisdom: string[] = [];

    try {
        const files = await fs.readdir(dir);
        for (const filename of files) {
            if (!filename.startsWith('wisdom-sprout-') || !filename.endsWith('.md')) continue;
            if (filename.includes('-archive')) continue;

            let content: string;
            try {
                content = await fs.readFile(path.join(dir, filename), 'utf8');
            } catch {
                console.warn(`[CareBloom] Skipping unreadable resolved sprout: ${filename}`);
                continue;
            }
            // Split on the HTML comment blocks that mark each reflection
            const blocks = content.split(/<!-- 🌸 REFLECTION-REQUEST/);

            for (let i = 1; i < blocks.length; i++) {
                const block = blocks[i];
                if (!block.includes('resolved: true')) continue;

                // Extract metadata using fuzzy regex (survives LLM formatting)
                const toolMatch = block.match(/tool:\s*"([^"]+)"/);
                const targetMatch = block.match(/target:\s*"([^"]+)"/);
                const timestampMatch = block.match(/timestamp:\s*"([^"]+)"/);

                // Extract the filled-in learnings from the Markdown body
                const learnedMatch = block.match(/\*\*What was learned:\*\*\s*(.+?)(?=\n\*\*Pattern|\n\n|$)/s);
                const patternMatch = block.match(/\*\*Pattern detected:\*\*\s*(.+?)(?=\n\*\*To carry|\n\n|$)/s);
                const carryMatch = block.match(/\*\*To carry forward:\*\*\s*(.+?)(?=\n\n---|\n---|$)/s);

                const learned = learnedMatch?.[1]?.trim();
                const pattern = patternMatch?.[1]?.trim();
                const carry = carryMatch?.[1]?.trim();

                // Skip if the fields still have placeholder text (not actually filled in)
                const isPlaceholder = (text: string | undefined) =>
                    !text || text.includes('Harmony:') || text.includes('_(your reflection') || text === '';

                if (isPlaceholder(learned) && isPlaceholder(carry)) continue;

                const tool = toolMatch?.[1] || '?';
                const target = targetMatch?.[1] || '?';
                const ts = timestampMatch?.[1] || '?';

                // Compile this resolved sprout into the error learning index
                if (isErrorLearningEnabled()) {
                    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                    if (root) {
                        const fm: any = { resolved: true, target, tool, invocationHistory: [] };
                        if (learned && !isPlaceholder(learned)) fm.lesson_en = learned;
                        compileSprout(root, path.join(dir, filename), fm).catch(() => {});
                    }
                }

                // Build a compact wisdom line
                const parts: string[] = [`[${ts}] ${tool} → ${target}`];
                if (learned && !isPlaceholder(learned)) parts.push(`  Learned: ${learned}`);
                if (pattern && !isPlaceholder(pattern)) parts.push(`  Pattern: ${pattern}`);
                if (carry && !isPlaceholder(carry)) parts.push(`  Carry forward: ${carry}`);

                wisdom.push(parts.join('\n'));
            }
        }
    } catch { /* directory may not exist */ }

    return wisdom;
}

// ── Stale Sprout Cleanup ──────────────────────────────────────────────────

/**
 * Remove sprouts that haven't been modified in over STALE_SPROUT_DAYS.
 * Runs once per session on first bloom. Prevents .carebloom/ from growing
 * unbounded over months of work.
 */
let cleanupRan = false;

export async function cleanupStaleSprouts(): Promise<void> {
    if (cleanupRan) return;
    cleanupRan = true;

    const dir = sproutDir();
    const cutoff = Date.now() - STALE_SPROUT_DAYS * 24 * 60 * 60 * 1000;

    try {
        const files = await fs.readdir(dir);
        for (const filename of files) {
            if (!filename.startsWith('wisdom-sprout-') || !filename.endsWith('.md')) continue;
            if (filename.includes('-archive')) continue;

            const filepath = path.join(dir, filename);
            let stat: { mtimeMs: number };
            try {
                stat = await fs.stat(filepath);
            } catch {
                continue; // file disappeared, skip
            }

            if (stat.mtimeMs < cutoff) {
                try {
                    // Move to archive instead of deleting
                    const archiveName = filename.replace('.md', '-stale-archive.md');
                    const archivePath = path.join(dir, archiveName);
                    const content = await fs.readFile(filepath, 'utf8');
                    await fs.writeFile(archivePath, content, 'utf8');
                    await fs.unlink(filepath);
                } catch {
                    // Best-effort — stale sprout cleanup should never break anything
                }
            }
        }
    } catch { /* directory may not exist */ }
}
