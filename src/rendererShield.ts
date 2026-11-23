/**
 * Renderer Memory Shield — protects VS Code's Chromium/V8 Renderer process
 * (<4 GB pointer-compression heap cage, exit code -536870904 / 0xE0000008) from:
 *   1. Per-step OutputChannel creation/disposal churn & unbounded Monaco log growth.
 *   2. High-frequency per-token stream.markdown() IPC + Markdown/DOM/Monaco re-parse storms.
 */

export const DEFAULT_DEBUG_CHANNEL_MAX_CHARS = 512_000;
export const DEFAULT_DEBUG_SINGLE_WRITE_MAX_CHARS = 64_000;
export const DEFAULT_MARKDOWN_COALESCE_MS = 40;
export const DEFAULT_MARKDOWN_MAX_BUFFER_CHARS = 8_192;

export interface RawOutputChannelLike {
    readonly name: string;
    append(value: string): void;
    appendLine(value: string): void;
    clear?(): void;
    show?(preserveFocus?: boolean): void;
    hide?(): void;
    replace?(value: string): void;
    dispose(): void;
}

export type RendererGuardEvent =
    | { kind: 'debug_channel_rotated'; rotationCount: number; clearedChars: number; maxChars: number }
    | { kind: 'debug_write_truncated'; originalChars: number; maxWriteChars: number };

let guardListener: ((event: RendererGuardEvent) => void) | undefined;

export function setRendererGuardListener(listener: ((event: RendererGuardEvent) => void) | undefined): void {
    guardListener = listener;
}

function notifyGuard(event: RendererGuardEvent, localListener?: (event: RendererGuardEvent) => void): void {
    try {
        localListener?.(event);
    } catch { /* never break logging */ }
    try {
        guardListener?.(event);
    } catch { /* never break logging */ }
}

export interface BoundedOutputChannel extends RawOutputChannelLike {
    clear(): void;
    show(preserveFocus?: boolean): void;
    hide(): void;
    replace(value: string): void;
    /** Exposed for diagnostics and verification gates. */
    getStats(): { bufferedChars: number; rotationCount: number; truncationCount: number; channelCreatedCount: number };
    /** True disposal for extension deactivate() only; regular .dispose() is a safe no-op on shared channels. */
    disposeForShutdown(): void;
}

export interface BoundedOutputChannelOptions {
    name?: string;
    maxChars?: number;
    maxSingleWriteChars?: number;
    ignoreDispose?: boolean;
    onGuard?: (event: RendererGuardEvent) => void;
}

export function createBoundedOutputChannel(
    factory: () => RawOutputChannelLike,
    options: BoundedOutputChannelOptions = {}
): BoundedOutputChannel {
    const channelName = options.name ?? 'Harmony Debug';
    const maxChars = Math.max(4_096, options.maxChars ?? DEFAULT_DEBUG_CHANNEL_MAX_CHARS);
    const maxSingleWriteChars = Math.max(1_024, options.maxSingleWriteChars ?? DEFAULT_DEBUG_SINGLE_WRITE_MAX_CHARS);
    const ignoreDispose = options.ignoreDispose ?? true;

    let rawChannel: RawOutputChannelLike | undefined;
    let bufferedChars = 0;
    let rotationCount = 0;
    let truncationCount = 0;
    let channelCreatedCount = 0;

    const ensureChannel = (): RawOutputChannelLike => {
        if (!rawChannel) {
            rawChannel = factory();
            channelCreatedCount += 1;
        }
        return rawChannel;
    };

    const sanitizeWrite = (value: string): string => {
        const str = typeof value === 'string' ? value : String(value ?? '');
        if (str.length <= maxSingleWriteChars) return str;
        truncationCount += 1;
        const omitted = str.length - maxSingleWriteChars;
        const suffix = `\n... [Harmony Debug write capped at ${maxSingleWriteChars} chars (${omitted} chars omitted) to protect VS Code Renderer memory]`;
        notifyGuard(
            { kind: 'debug_write_truncated', originalChars: str.length, maxWriteChars: maxSingleWriteChars },
            options.onGuard
        );
        return str.slice(0, maxSingleWriteChars) + suffix;
    };

    const rotateIfNeeded = (ch: RawOutputChannelLike, incomingLen: number): void => {
        if (bufferedChars === 0 || bufferedChars + incomingLen <= maxChars) return;
        const clearedChars = bufferedChars;
        rotationCount += 1;
        bufferedChars = 0;
        const banner =
            `[${channelName}] Output buffer rotated (#${rotationCount}; cleared ${clearedChars.toLocaleString('en-US')} chars) ` +
            `to keep VS Code Renderer memory below the 4 GB V8 ceiling. ` +
            `Complete session history & usage remain on disk in .harmony/history/ and .harmony/provider-usage/ledger.jsonl.`;
        if (typeof ch.clear === 'function') {
            ch.clear();
            ch.appendLine(banner);
            bufferedChars = banner.length + 1;
        } else if (typeof ch.replace === 'function') {
            ch.replace(banner + '\n');
            bufferedChars = banner.length + 1;
        } else {
            ch.appendLine('\n' + banner);
            bufferedChars = banner.length + 2;
        }
        notifyGuard(
            { kind: 'debug_channel_rotated', rotationCount, clearedChars, maxChars },
            options.onGuard
        );
    };

    return {
        get name(): string {
            return rawChannel?.name ?? channelName;
        },
        append(value: string): void {
            const safe = sanitizeWrite(value);
            if (!safe) return;
            const ch = ensureChannel();
            rotateIfNeeded(ch, safe.length);
            ch.append(safe);
            bufferedChars += safe.length;
        },
        appendLine(value: string): void {
            const safe = sanitizeWrite(value);
            const ch = ensureChannel();
            rotateIfNeeded(ch, safe.length + 1);
            ch.appendLine(safe);
            bufferedChars += safe.length + 1;
        },
        clear(): void {
            if (!rawChannel) {
                bufferedChars = 0;
                return;
            }
            rawChannel.clear?.();
            bufferedChars = 0;
        },
        show(preserveFocus?: boolean): void {
            ensureChannel().show?.(preserveFocus);
        },
        hide(): void {
            rawChannel?.hide?.();
        },
        replace(value: string): void {
            const safe = sanitizeWrite(value);
            const ch = ensureChannel();
            if (typeof ch.replace === 'function') {
                ch.replace(safe);
            } else {
                ch.clear?.();
                ch.append(safe);
            }
            bufferedChars = safe.length;
        },
        dispose(): void {
            if (ignoreDispose) {
                // Prevent per-step callers from destroying the shared singleton channel
                // and triggering repeated OutputChannel URI model churn in the Renderer.
                return;
            }
            if (rawChannel) {
                rawChannel.dispose();
                rawChannel = undefined;
                bufferedChars = 0;
            }
        },
        disposeForShutdown(): void {
            if (rawChannel) {
                rawChannel.dispose();
                rawChannel = undefined;
                bufferedChars = 0;
            }
        },
        getStats() {
            return { bufferedChars, rotationCount, truncationCount, channelCreatedCount };
        },
    };
}

/**
 * Shared lazy singleton for 'Harmony Debug' across chatParticipant, geminiNativeStreaming,
 * and helper modules. Never creates a VS Code OutputChannel until first log/show.
 */
export const harmonyDebugChannel: BoundedOutputChannel = createBoundedOutputChannel(
    () => {
        // Lazy require so pure Node verification gates can import rendererShield without a vscode host
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const vscode = require('vscode') as typeof import('vscode');
        return vscode.window.createOutputChannel('Harmony Debug');
    },
    {
        name: 'Harmony Debug',
        maxChars: DEFAULT_DEBUG_CHANNEL_MAX_CHARS,
        maxSingleWriteChars: DEFAULT_DEBUG_SINGLE_WRITE_MAX_CHARS,
        ignoreDispose: true,
    }
);

export interface CoalescedMarkdownOptions {
    intervalMs?: number;
    maxBufferChars?: number;
}

export interface CoalescedMarkdownStreamer {
    /** Queue a streaming text delta; coalesces sub-frame chunks into ~25 fps flushes. */
    push(delta: string): void;
    /** Flush any queued delta immediately BEFORE emitting an out-of-band status/thinking block. */
    emitImmediate(block: string): void;
    /** Synchronously flush any queued delta text right now. */
    flush(): void;
    /** Flush remaining text and cancel any pending timer. */
    dispose(): void;
    /** Telemetry for tests and diagnostics. */
    stats(): { pushedChunks: number; flushedBatches: number; totalChars: number };
}

export function createCoalescedMarkdownStreamer(
    rawEmit: (markdown: string) => void,
    options: CoalescedMarkdownOptions = {}
): CoalescedMarkdownStreamer {
    const intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_MARKDOWN_COALESCE_MS);
    const maxBufferChars = Math.max(256, options.maxBufferChars ?? DEFAULT_MARKDOWN_MAX_BUFFER_CHARS);

    let buffer = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pushedChunks = 0;
    let flushedBatches = 0;
    let totalChars = 0;

    const clearTimer = (): void => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };

    const flush = (): void => {
        clearTimer();
        if (buffer.length === 0) return;
        const out = buffer;
        buffer = '';
        flushedBatches += 1;
        rawEmit(out);
    };

    const push = (delta: string): void => {
        if (!delta) return;
        pushedChunks += 1;
        totalChars += delta.length;
        buffer += delta;
        if (intervalMs === 0 || buffer.length >= maxBufferChars) {
            flush();
            return;
        }
        if (timer === undefined) {
            timer = setTimeout(() => {
                timer = undefined;
                flush();
            }, intervalMs);
        }
    };

    const emitImmediate = (block: string): void => {
        flush();
        if (block) {
            flushedBatches += 1;
            totalChars += block.length;
            rawEmit(block);
        }
    };

    const dispose = (): void => {
        flush();
    };

    return {
        push,
        emitImmediate,
        flush,
        dispose,
        stats: () => ({ pushedChunks, flushedBatches, totalChars }),
    };
}

// ── Renderer OOM Shield v3: Tool Payload & ChatResult.metadata Diet ─────────

const METADATA_PATH_KEYS = ['path', 'file_path', 'filePath'] as const;
const MAX_METADATA_PATH_CHARS = 512;
const MAX_METADATA_ERROR_CHARS = 240;

export interface CompactUsageCallRecord {
    name: string;
    input?: Record<string, string>;
    resultChars?: number;
    error?: string;
}

/**
 * Strips multi-kilobyte / 160 KB tool outputs and large edit/swarm inputs
 * (`old_string`, `new_string`, `content`, `hunks`, `tasks`) from `ChatResult.metadata.functionCalls`
 * before VS Code IPC-clones `ChatResult` into the <4 GB Renderer heap for the life of the session.
 *
 * Preserves `name` and path reference keys (`path`, `file_path`, `filePath`) required by
 * `classifyToolCallReferences()` in `src/auditScope.ts`.
 */
export function compactUsageCallRecord(
    name: string,
    rawInput: unknown,
    outcome?: { resultChars?: number; error?: string }
): CompactUsageCallRecord {
    const safeName = typeof name === 'string' && name.trim() ? name.trim() : 'unknown_tool';
    let slimInput: Record<string, string> | undefined;
    if (rawInput && typeof rawInput === 'object') {
        const src = rawInput as Record<string, unknown>;
        for (const key of METADATA_PATH_KEYS) {
            const val = src[key];
            if (typeof val === 'string' && val.trim()) {
                if (!slimInput) slimInput = {};
                slimInput[key] = val.trim().slice(0, MAX_METADATA_PATH_CHARS);
            }
        }
    }
    const record: CompactUsageCallRecord = { name: safeName };
    if (slimInput) record.input = slimInput;
    if (typeof outcome?.resultChars === 'number' && Number.isFinite(outcome.resultChars) && outcome.resultChars >= 0) {
        record.resultChars = Math.trunc(outcome.resultChars);
    }
    if (typeof outcome?.error === 'string' && outcome.error.trim()) {
        record.error = outcome.error.trim().slice(0, MAX_METADATA_ERROR_CHARS);
    }
    return record;
}

