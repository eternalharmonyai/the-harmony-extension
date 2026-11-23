/**
 * In-turn context compaction.
 *
 * Stubs the CONTENT of the oldest eligible tool-result messages when a turn's
 * pre-send prompt estimate exceeds the context guard:
 *   - messages are NEVER removed — `tool_call_id` pairing with assistant
 *     `tool_calls` is preserved by construction (only the content string changes);
 *   - only `role: 'tool'` entries are eligible — system / user / assistant and
 *     the newest window are protected;
 *   - hysteresis: one batched rewrite per activation, not per-step nibbling;
 *   - idempotent: already-stubbed content (marker prefix) is skipped;
 *   - the originals remain held in-process for the rest of the turn
 *     (`usageCalls` / `resolved` in chatParticipant) — the request view shrinks,
 *     nothing is ever re-run.
 *
 * This module is dependency-free so the compiled output can be exercised
 * by scripts/verify-in-turn-compaction.js without a VS Code host.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface CompactionMessage {
    role: string;
    content?: unknown;
    tool_call_id?: string;
    tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string | Record<string, unknown> };
    }>;
}

/** Content prefix marking an already-offloaded (stubbed) tool result. */
export const OFFLOAD_MARKER_PREFIX = '[offloaded to fit context';

/** Full marker text substituted for the original content. Kept short — it is context. */
export const OFFLOAD_MARKER = '[offloaded to fit context — full tool result retained in-process for this turn]';

/** Messages at the tail that must never be stubbed (recent state). */
export const COMPACTION_KEEP_NEWEST_MESSAGES = 8;

/** Results shorter than this stay — stubbing them saves less than the marker costs. */
const MIN_STUB_CONTENT_CHARS = 200;

/** Maximum length of a holographic structural stub (deterministic, zero-LLM-cost). */
export const MAX_HOLOGRAPHIC_STUB_CHARS = 340;

export interface HolographicSummary {
    sha256Prefix: string;
    originalChars: number;
    files: string[];
    symbols: string[];
    codes: string[];
}

export interface CompactionOptions {
    /**
     * When true, replaces offloaded content with a deterministic holographic
     * structural stub (preserving SHA-256 prefix, file/line paths, symbol names,
     * and error/HTTP codes in <=340 chars) instead of the static OFFLOAD_MARKER.
     * Defaults to false so legacy exact-equality callers continue to receive
     * OFFLOAD_MARKER unless opted in.
     */
    holographic?: boolean;
    /**
     * Optional directory on disk where offloaded payloads are spilled by
     * `tool_call_id` for lossless span rehydration (`rehydrateSpilledToolResult`).
     */
    spillDir?: string;
}

export interface CompactionOutcome {
    /** Number of messages whose content was replaced with the marker. */
    stubbed: number;
    /** Net characters saved (original length − marker length), summed. */
    charsSaved: number;
    /** IDs of tool calls spilled to disk when `options.spillDir` was provided. */
    spilledIds?: string[];
}

/**
 * Deterministic (<1ms, zero-LLM-cost) structural skeleton extractor.
 * Extracts SHA-256 prefix, file:line references, symbol names, and HTTP/error
 * constants from a raw tool output string.
 */
export function extractHolographicSummary(content: string): HolographicSummary {
    const sha256Prefix = crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 12);
    const sample = content.length > 64_000 ? content.slice(0, 64_000) : content;

    const files: string[] = [];
    const seenFiles = new Set<string>();
    const fileRe = /\b(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9]{1,6}(?::\d+(?::\d+)?)?\b/g;
    let m: RegExpExecArray | null;
    while ((m = fileRe.exec(sample)) !== null && files.length < 4) {
        const val = m[0];
        if (!seenFiles.has(val) && !val.startsWith('http/') && !val.startsWith('1.1/')) {
            seenFiles.add(val);
            files.push(val);
        }
    }

    const symbols: string[] = [];
    const seenSyms = new Set<string>();
    const symRe = /\b(?:function|class|interface|type|const|def|fn|struct)\s+([A-Za-z_$][\w$]{2,40})\b/g;
    while ((m = symRe.exec(sample)) !== null && symbols.length < 5) {
        const sym = m[1];
        if (!seenSyms.has(sym)) {
            seenSyms.add(sym);
            symbols.push(sym);
        }
    }

    const codes: string[] = [];
    const seenCodes = new Set<string>();
    const codeRe = /\b(?:HTTP\s+[1-5]\d\d|E[A-Z]{3,16}|ERR_[A-Z0-9_]+|[A-Z][A-Z0-9_]{4,28})\b/g;
    while ((m = codeRe.exec(sample)) !== null && codes.length < 4) {
        const c = m[0].replace(/\s+/g, ' ');
        if (!seenCodes.has(c) && c !== 'OFFLOAD_MARKER') {
            seenCodes.add(c);
            codes.push(c);
        }
    }

    return {
        sha256Prefix,
        originalChars: content.length,
        files,
        symbols,
        codes,
    };
}

/**
 * Build a bounded holographic stub string that starts with `OFFLOAD_MARKER_PREFIX`
 * (so idempotency checks remain invariant) and carries the structural skeleton.
 */
export function buildHolographicStub(content: string, toolCallId?: string): string {
    const summary = extractHolographicSummary(content);
    const parts: string[] = [
        `${OFFLOAD_MARKER_PREFIX} — holographic stub`,
        `chars=${summary.originalChars}`,
        `sha256=${summary.sha256Prefix}`,
    ];
    if (toolCallId) {
        parts.push(`id=${toolCallId.slice(0, 24)}`);
    }
    if (summary.files.length > 0) {
        parts.push(`files=${summary.files.join(',')}`);
    }
    if (summary.symbols.length > 0) {
        parts.push(`syms=${summary.symbols.join(',')}`);
    }
    if (summary.codes.length > 0) {
        parts.push(`codes=${summary.codes.join(',')}`);
    }
    let built = parts.join(' | ') + ']';
    if (built.length > MAX_HOLOGRAPHIC_STUB_CHARS) {
        built = built.slice(0, MAX_HOLOGRAPHIC_STUB_CHARS - 4) + '...]';
    }
    return built;
}

function sanitizeSpillId(rawId: string): string {
    return rawId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'tool';
}

/**
 * Rehydrate a character span or regex match from a previously spilled tool result.
 */
export function rehydrateSpilledToolResult(
    spillDir: string,
    toolCallId: string,
    options?: { startChar?: number; maxChars?: number; pattern?: string }
): { ok: boolean; toolCallId: string; totalChars?: number; sha256Prefix?: string; slice?: string; matches?: string[]; error?: string } {
    try {
        const filePath = path.join(spillDir, `${sanitizeSpillId(toolCallId)}.json`);
        if (!fs.existsSync(filePath)) {
            return { ok: false, toolCallId, error: 'Spill record not found' };
        }
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const content = typeof raw.content === 'string' ? raw.content : '';
        if (options?.pattern) {
            const re = new RegExp(options.pattern, 'gm');
            const matches: string[] = [];
            const lines = content.split(/\r?\n/);
            for (let idx = 0; idx < lines.length && matches.length < 25; idx++) {
                re.lastIndex = 0;
                if (re.test(lines[idx])) {
                    matches.push(`L${idx + 1}: ${lines[idx].slice(0, 240)}`);
                }
            }
            return {
                ok: true,
                toolCallId,
                totalChars: content.length,
                sha256Prefix: raw.sha256Prefix,
                matches,
            };
        }
        const start = Math.max(0, Math.floor(options?.startChar ?? 0));
        const maxChars = Math.min(16_000, Math.max(1, Math.floor(options?.maxChars ?? 4_000)));
        return {
            ok: true,
            toolCallId,
            totalChars: content.length,
            sha256Prefix: raw.sha256Prefix,
            slice: content.slice(start, start + maxChars),
        };
    } catch (err: any) {
        return { ok: false, toolCallId, error: err?.message ?? String(err) };
    }
}

/**
 * Replace the content of the oldest eligible tool-result messages, in place,
 * until at least `charsToShed` characters have been saved (or nothing else is
 * eligible). Returns what was stubbed. A second call on the same array stubs
 * nothing (idempotent via the marker prefix check).
 */
export function planInTurnCompaction(
    messages: CompactionMessage[],
    charsToShed: number,
    keepNewest: number = COMPACTION_KEEP_NEWEST_MESSAGES,
    options?: CompactionOptions
): CompactionOutcome {
    const outcome: CompactionOutcome = { stubbed: 0, charsSaved: 0 };
    if (!Number.isFinite(charsToShed) || charsToShed <= 0) return outcome;
    const protectFrom = Math.max(0, messages.length - Math.max(0, keepNewest));
    const spilledIds: string[] = [];
    for (let i = 0; i < messages.length && i < protectFrom; i++) {
        if (outcome.charsSaved >= charsToShed) break;
        const message = messages[i];
        if (!message || message.role !== 'tool') continue;
        if (typeof message.content !== 'string') continue;
        if (message.content.length < MIN_STUB_CONTENT_CHARS) continue;
        if (message.content.startsWith(OFFLOAD_MARKER_PREFIX)) continue;
        const originalContent = message.content;
        const replacement = options?.holographic
            ? buildHolographicStub(originalContent, message.tool_call_id)
            : OFFLOAD_MARKER;
        const saved = originalContent.length - replacement.length;
        if (saved <= 0) continue;
        if (options?.spillDir && message.tool_call_id) {
            try {
                fs.mkdirSync(options.spillDir, { recursive: true });
                const summary = extractHolographicSummary(originalContent);
                const spillFile = path.join(options.spillDir, `${sanitizeSpillId(message.tool_call_id)}.json`);
                fs.writeFileSync(spillFile, JSON.stringify({
                    toolCallId: message.tool_call_id,
                    sha256Prefix: summary.sha256Prefix,
                    originalChars: originalContent.length,
                    content: originalContent,
                }), 'utf8');
                spilledIds.push(message.tool_call_id);
            } catch {
                // Spill persistence is best-effort and never blocks in-turn compaction.
            }
        }
        message.content = replacement;
        outcome.stubbed += 1;
        outcome.charsSaved += saved;
    }
    if (spilledIds.length > 0) {
        outcome.spilledIds = spilledIds;
    }
    return outcome;
}

/**
 * Classifies a provider error as a context-length rejection: an HTTP 4xx
 * whose body names the context window limit. Matches common API variants.
 * Deliberately 4xx-only — server-side 5xx wording is not a prompt-size rejection.
 */
export function isContextLengthError(message: string): boolean {
    return /HTTP 4\d\d/.test(message)
        && /maximum context length|context length exceeded|context_length_exceeded|context_length|reduce the length|token count exceeds the maximum number of tokens/i.test(message);
}

interface ParsedReadRange {
    pathKey: string;
    rawPath: string;
    start: number;
    end: number;
}

function canonicalPathKey(raw: unknown): string | undefined {
    if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0')) return undefined;
    let p = process.platform === 'win32' ? raw.replace(/\\/g, '/') : raw;
    const segments = p.split('/');
    if (segments.some(s => s === '..')) return undefined;
    p = p.replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/\.\//g, '/');
    if (p.length > 1) p = p.replace(/\/$/, '');
    return p || undefined;
}

function parseSafePositiveInt(v: unknown): number | undefined {
    if (typeof v === 'number') {
        return Number.isSafeInteger(v) && v >= 1 ? v : undefined;
    }
    if (typeof v === 'string' && /^[1-9]\d*$/.test(v)) {
        const n = Number(v);
        return Number.isSafeInteger(n) ? n : undefined;
    }
    return undefined;
}

function parseToolCallArgs(raw: unknown): Record<string, unknown> | undefined {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
    }
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            return undefined;
        }
    }
    return undefined;
}

function parseReadRangeFromArgs(args: Record<string, unknown>): ParsedReadRange | undefined {
    const rawPath = typeof args.path === 'string' ? args.path : undefined;
    const pathKey = canonicalPathKey(rawPath);
    if (!rawPath || !pathKey) return undefined;
    if (args.start_line !== undefined && parseSafePositiveInt(args.start_line) === undefined) return undefined;
    if (args.end_line !== undefined && parseSafePositiveInt(args.end_line) === undefined) return undefined;
    const start = args.start_line === undefined ? 1 : parseSafePositiveInt(args.start_line)!;
    const end = args.end_line === undefined ? Number.POSITIVE_INFINITY : parseSafePositiveInt(args.end_line)!;
    if (end < start) return undefined;
    return { pathKey, rawPath, start, end };
}

function isSuccessfulNonTruncatedReadResult(content: string): boolean {
    if (!content || content.length < MIN_STUB_CONTENT_CHARS) return false;
    if (content.startsWith(OFFLOAD_MARKER_PREFIX)) return false;
    if (/^(tool error:|Error:|tool argument parse error:)/i.test(content.trim())) return false;
    if (/\[truncated|\.\.\.\[truncated/i.test(content)) return false;
    return true;
}

/**
 * Tombstones earlier `harmony_read_file` tool-result contents in place when a
 * strictly later assistant step performs a successful, non-truncated
 * `harmony_read_file` on the exact same canonical path whose `[start_line, end_line]`
 * range covers the earlier read (including across intervening file edits once
 * the post-edit read has captured the updated lines).
 *
 * Preserves `tool_call_id` pairing, assistant `tool_calls`, and `thought_signature`
 * metadata 100% intact.
 */
export function deduplicateSupersededToolResults(
    messages: CompactionMessage[]
): CompactionOutcome {
    const outcome: CompactionOutcome = { stubbed: 0, charsSaved: 0 };
    if (!Array.isArray(messages) || messages.length < 4) return outcome;

    const callMeta = new Map<string, {
        name: string;
        args: Record<string, unknown>;
        assistantMsgIdx: number;
    }>();
    const duplicateCallIds = new Set<string>();

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
        for (const tc of msg.tool_calls) {
            const id = typeof tc?.id === 'string' ? tc.id.trim() : '';
            const name = typeof tc?.function?.name === 'string' ? tc.function.name.trim() : '';
            const args = parseToolCallArgs(tc?.function?.arguments);
            if (!id || !name || !args) continue;
            if (callMeta.has(id)) {
                duplicateCallIds.add(id);
                continue;
            }
            callMeta.set(id, { name, args, assistantMsgIdx: i });
        }
    }

    interface ReadEntry {
        msgIdx: number;
        assistantMsgIdx: number;
        toolCallId: string;
        range: ParsedReadRange;
        content: string;
    }

    const readsByPath = new Map<string, ReadEntry[]>();
    const seenToolResultIds = new Set<string>();

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg || msg.role !== 'tool') continue;
        const callId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id.trim() : '';
        if (!callId || duplicateCallIds.has(callId)) continue;
        if (seenToolResultIds.has(callId)) {
            duplicateCallIds.add(callId);
            continue;
        }
        seenToolResultIds.add(callId);

        const meta = callMeta.get(callId);
        if (!meta || meta.name !== 'harmony_read_file') continue;
        if (typeof msg.content !== 'string' || !isSuccessfulNonTruncatedReadResult(msg.content)) continue;

        const range = parseReadRangeFromArgs(meta.args);
        if (!range) continue;

        const list = readsByPath.get(range.pathKey) ?? [];
        list.push({
            msgIdx: i,
            assistantMsgIdx: meta.assistantMsgIdx,
            toolCallId: callId,
            range,
            content: msg.content,
        });
        readsByPath.set(range.pathKey, list);
    }

    for (const entries of readsByPath.values()) {
        if (entries.length < 2) continue;
        for (let a = 0; a < entries.length - 1; a++) {
            const earlier = entries[a];
            if (duplicateCallIds.has(earlier.toolCallId)) continue;
            let coveringLater: ReadEntry | undefined;
            for (let b = entries.length - 1; b > a; b--) {
                const later = entries[b];
                if ( duplicateCallIds.has(later.toolCallId)) continue;
                if (later.assistantMsgIdx <= earlier.assistantMsgIdx) continue;
                if (later.range.start <= earlier.range.start && later.range.end >= earlier.range.end) {
                    coveringLater = later;
                    break;
                }
            }
            if (!coveringLater) continue;

            const targetMsg = messages[earlier.msgIdx];
            if (!targetMsg || typeof targetMsg.content !== 'string') continue;
            if (targetMsg.content.startsWith(OFFLOAD_MARKER_PREFIX)) continue;

            const spanLabel = Number.isFinite(earlier.range.end)
                ? `${earlier.range.rawPath}:${earlier.range.start}-${earlier.range.end}`
                : `${earlier.range.rawPath}`;
            const replacement = `${OFFLOAD_MARKER_PREFIX} — superseded by newer read of ${spanLabel} (call ${coveringLater.toolCallId.slice(0, 20)})]`;
            const saved = targetMsg.content.length - replacement.length;
            if (saved <= 0) continue;

            targetMsg.content = replacement;
            outcome.stubbed += 1;
            outcome.charsSaved += saved;
        }
    }

    return outcome;
}
