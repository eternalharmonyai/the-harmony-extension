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

export interface CompactionMessage {
    role: string;
    content?: unknown;
    tool_call_id?: string;
}

/** Content prefix marking an already-offloaded (stubbed) tool result. */
export const OFFLOAD_MARKER_PREFIX = '[offloaded to fit context';

/** Full marker text substituted for the original content. Kept short — it is context. */
export const OFFLOAD_MARKER = '[offloaded to fit context — full tool result retained in-process for this turn]';

/** Messages at the tail that must never be stubbed (recent state). */
export const COMPACTION_KEEP_NEWEST_MESSAGES = 8;

/** Results shorter than this stay — stubbing them saves less than the marker costs. */
const MIN_STUB_CONTENT_CHARS = 200;

export interface CompactionOutcome {
    /** Number of messages whose content was replaced with the marker. */
    stubbed: number;
    /** Net characters saved (original length − marker length), summed. */
    charsSaved: number;
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
    keepNewest: number = COMPACTION_KEEP_NEWEST_MESSAGES
): CompactionOutcome {
    const outcome: CompactionOutcome = { stubbed: 0, charsSaved: 0 };
    if (!Number.isFinite(charsToShed) || charsToShed <= 0) return outcome;
    const protectFrom = Math.max(0, messages.length - Math.max(0, keepNewest));
    for (let i = 0; i < messages.length && i < protectFrom; i++) {
        if (outcome.charsSaved >= charsToShed) break;
        const message = messages[i];
        if (!message || message.role !== 'tool') continue;
        if (typeof message.content !== 'string') continue;
        if (message.content.length < MIN_STUB_CONTENT_CHARS) continue;
        if (message.content.startsWith(OFFLOAD_MARKER_PREFIX)) continue;
        const saved = message.content.length - OFFLOAD_MARKER.length;
        if (saved <= 0) continue;
        message.content = OFFLOAD_MARKER;
        outcome.stubbed += 1;
        outcome.charsSaved += saved;
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
