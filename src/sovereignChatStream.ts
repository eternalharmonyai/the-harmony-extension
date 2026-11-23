/**
 * sovereignChatStream.ts — Pure streaming primitives for Sovereign Harmony Chat
 * (Standalone Desktop 8789 + VS Code Studio Webview).
 *
 * Zero `vscode` runtime dependency so verification gates can exercise every
 * SSE boundary, tag-safe prefix filter, and multi-step state transition in Node.
 */

export const DEFAULT_STANDALONE_MAX_OUTPUT_TOKENS = 16_384;

export interface SseLineParserState {
    buffer: string;
}

/**
 * Incrementally split arbitrary UTF-8 stream chunks into complete lines,
 * preserving incomplete trailing lines across chunk boundaries.
 */
export function parseSseLinesIncremental(
    state: SseLineLineBuffer,
    chunkText: string,
    flush = false
): string[] {
    if (chunkText) {
        state.buffer += chunkText;
    }
    const out: string[] = [];
    let nlIdx = state.buffer.indexOf('\n');
    while (nlIdx !== -1) {
        const rawLine = state.buffer.slice(0, nlIdx);
        state.buffer = state.buffer.slice(nlIdx + 1);
        out.push(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
        nlIdx = state.buffer.indexOf('\n');
    }
    if (flush && state.buffer.length > 0) {
        const tail = state.buffer;
        state.buffer = '';
        out.push(tail.endsWith('\r') ? tail.slice(0, -1) : tail);
    }
    return out;
}

export type SseLineLineBuffer = SseLineParserState;

export type StepStreamMode = 'undecided' | 'tool_call' | 'final_answer' | 'plain_prose';

export interface AgentStepStreamFilterCallbacks {
    /** Invoked with clean user-facing text deltas (never `FINAL_ANSWER:` or `TOOL_CALL:` JSON). */
    onVisibleDelta: (delta: string) => void;
    /** Invoked once as soon as the current step is identified as a `TOOL_CALL: {...}` step. */
    onToolCallDetected?: () => void;
}

export interface AgentStepStreamSummary {
    mode: StepStreamMode;
    fullRawText: string;
    visibleText: string;
    suppressedAsToolCall: boolean;
}

const TOOL_PREFIX = 'TOOL_CALL:';
const FINAL_PREFIX = 'FINAL_ANSWER:';
const EMBEDDED_TOOL_LINE_RE = /^\s*TOOL_CALL\s*:\s*\{/m;
const FINAL_HEADER_CONFIRMED_RE = /^\s*FINAL_ANSWER\s*:\s*(?:\r?\n|(?=\S))/;

function isPossibleProtocolPrefix(trimmed: string): boolean {
    if (!trimmed) return true;
    // Allow optional whitespace before colon: "TOOL_CALL   :" or "FINAL_ANSWER  :"
    if (TOOL_PREFIX.startsWith(trimmed) || FINAL_PREFIX.startsWith(trimmed)) {
        return true;
    }
    if (/^TOOL_CALL\s*:?$/.test(trimmed)) {
        return true;
    }
    if (/^FINAL_ANSWER\s*:?\s*$/.test(trimmed)) {
        return true;
    }
    return false;
}

/**
 * Tag-safe live stream filter for `localAgent.ts` protocol responses:
 *   - Holds the tiny leading prefix until we know whether the step starts with
 *     `TOOL_CALL:`, `FINAL_ANSWER:`, or direct plain prose.
 *   - Strips `FINAL_ANSWER:\n` cleanly before streaming tokens live.
 *   - Suppresses `TOOL_CALL: {...}` JSON from flashing in the chat bubble.
 *   - If a model emits prose followed by a late `\nTOOL_CALL: {...}` line, stops
 *     forwarding the `TOOL_CALL:` tail and signals `onToolCallDetected`.
 */
export function createAgentStepStreamFilter(callbacks: AgentStepStreamFilterCallbacks) {
    let mode: StepStreamMode = 'undecided';
    let fullRawText = '';
    let visibleText = '';
    let pendingStreamTail = '';
    let toolNotified = false;

    const emitVisible = (text: string) => {
        if (!text) return;
        visibleText += text;
        callbacks.onVisibleDelta(text);
    };

    const notifyTool = () => {
        if (toolNotified) return;
        toolNotified = true;
        callbacks.onToolCallDetected?.();
    };

    /**
     * Guards against a mid-response `\nTOOL_CALL: {...}` line while streaming prose:
     * holds back only a trailing newline fragment that is currently matching `\nTOOL_CALL...`.
     */
    const flushSafeProseTail = (forceFlush: boolean) => {
        if (!pendingStreamTail) return;

        const embeddedMatch = EMBEDDED_TOOL_LINE_RE.exec(pendingStreamTail);
        if (embeddedMatch) {
            const before = pendingStreamTail.slice(0, embeddedMatch.index).replace(/\s+$/, '');
            pendingStreamTail = '';
            if (before) emitVisible(before);
            mode = 'tool_call';
            notifyTool();
            return;
        }

        if (forceFlush) {
            const rest = pendingStreamTail;
            pendingStreamTail = '';
            emitVisible(rest);
            return;
        }

        const lastNl = pendingStreamTail.lastIndexOf('\n');
        if (lastNl === -1) {
            const out = pendingStreamTail;
            pendingStreamTail = '';
            emitVisible(out);
            return;
        }

        const afterNlTrimmed = pendingStreamTail.slice(lastNl + 1).trimStart();
        if (
            afterNlTrimmed.length === 0 ||
            TOOL_PREFIX.startsWith(afterNlTrimmed) ||
            /^TOOL_CALL\s*:?\s*$/.test(afterNlTrimmed)
        ) {
            const safeHead = pendingStreamTail.slice(0, lastNl);
            pendingStreamTail = pendingStreamTail.slice(lastNl);
            if (safeHead) emitVisible(safeHead);
            return;
        }

        const out = pendingStreamTail;
        pendingStreamTail = '';
        emitVisible(out);
    };

    return {
        push(delta: string): void {
            if (!delta) return;
            fullRawText += delta;

            if (mode === 'tool_call') {
                return;
            }

            if (mode === 'undecided') {
                const trimmedStart = fullRawText.trimStart();
                if (!trimmedStart) {
                    // Still only leading whitespace; wait for first non-whitespace char (bounded at 64 chars)
                    if (fullRawText.length >= 64) {
                        mode = 'plain_prose';
                        pendingStreamTail = fullRawText;
                        flushSafeProseTail(false);
                    }
                    return;
                }

                if (/^\s*TOOL_CALL\s*:/.test(fullRawText)) {
                    mode = 'tool_call';
                    notifyTool();
                    return;
                }

                const finalHeader = FINAL_HEADER_CONFIRMED_RE.exec(fullRawText);
                if (finalHeader) {
                    mode = 'final_answer';
                    const remainder = fullRawText.slice(finalHeader[0].length);
                    if (remainder) {
                        pendingStreamTail += remainder;
                        flushSafeProseTail(false);
                    }
                    return;
                }

                if (isPossibleProtocolPrefix(trimmedStart)) {
                    return;
                }

                mode = 'plain_prose';
                pendingStreamTail = fullRawText;
                flushSafeProseTail(false);
                return;
            }

            pendingStreamTail += delta;
            flushSafeProseTail(false);
        },

        finish(): AgentStepStreamSummary {
            if (mode === 'undecided') {
                if (/^\s*TOOL_CALL\s*:/.test(fullRawText)) {
                    mode = 'tool_call';
                    notifyTool();
                } else {
                    const strippedFinal = fullRawText.replace(/^\s*FINAL_ANSWER\s*:\s*\r?\n?/, '');
                    if (strippedFinal !== fullRawText) {
                        mode = 'final_answer';
                        pendingStreamTail = strippedFinal;
                    } else {
                        mode = 'plain_prose';
                        pendingStreamTail = fullRawText;
                    }
                    flushSafeProseTail(true);
                }
            } else if (mode !== 'tool_call') {
                flushSafeProseTail(true);
            }

            return {
                mode,
                fullRawText,
                visibleText,
                suppressedAsToolCall: mode === 'tool_call',
            };
        },
    };
}
