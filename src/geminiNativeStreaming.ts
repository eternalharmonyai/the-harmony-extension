/**
 * geminiNativeStreaming.ts — Native Gemini generateContent REST API streaming.
 *
 * ════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ════════════════════════════════════════════════════════════════════
 * Gemini 3 thinking models require thought_signature round-tripping on
 * functionCall parts. The OpenAI-compatible endpoint sometimes doesn't
 * surface these signatures, causing HTTP 400 errors.
 *
 * The native generateContent API handles signatures as first-class metadata
 * inside functionCall/functionResponse parts — no sanitizer needed.
 *
 * This file implements:
 *   1. Message converter: OpenAI-format messages → Gemini contents[]
 *   2. Tool converter: OpenAI-format tools → Gemini functionDeclarations[]
 *   3. SSE parser for streamGenerateContent?alt=sse
 *   4. Response mapping back to the same shape as callDeepSeekStreaming
 *
 * Endpoint: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse
 * Auth: x-goog-api-key header (NOT query param — privacy: avoids proxy logs)
 *
 * Design decisions:
 *   - Separate function, not a shared abstraction (minimize risk to 17 providers)
 *   - generateContent path first; Interactions API as a future path
 *   - Fallback to OpenAI-compat on failure
 *   - BLOCK_NONE safety settings for agent loops
 * ════════════════════════════════════════════════════════════════════
 */

import * as vscode from 'vscode';
import { getVscodeHttpProxyOptions, isGeminiVertexProfile, resolveGeminiGenerateContentRequestAsync } from './providers';
import { enrichVertexHttpError, invalidateVertexTokenCache, redactUrlCredentials } from './vertexAuth';
import { harmonyDebugChannel } from './rendererShield';
import { formatDegradedHistoricalToolSummary } from './textualToolCallGuard';
import {
    evictIdleVpnSockets,
    markVpnHostPreferFreshIpv4,
    unwrapTransportErrorChain,
    vpnResilientFetch,
} from './vpnResilientTransport';

// ── Types ────────────────────────────────────────────────────────────

/** Mirrors the DeepSeekToolCall shape from chatParticipant.ts */
export interface GeminiNativeToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
    /** Gemini native: thought signature from the functionCall part */
    thought_signature?: string;
}

/** Mirrors the return type of callDeepSeekStreaming */
export interface GeminiNativeStreamResult {
    content: string;
    reasoning: string;
    toolCalls: GeminiNativeToolCall[];
    usage?: {
        promptTokens?: number;
        completionTokens?: number;
        cachedPromptTokens?: number;
        thoughtsTokens?: number;
    };
    durationMs: number;
}

/** OpenAI-format message (same shape we use everywhere internally) */
export interface OpenAICompatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    reasoning_content?: string;
    tool_calls?: GeminiNativeToolCall[];
    tool_call_id?: string;
}

/** Gemini native Content role mapping */
type GeminiRole = 'user' | 'model';

/** Gemini native Content object */
interface GeminiContent {
    role: GeminiRole;
    parts: GeminiPart[];
}

/** Gemini native Part — many possible shapes */
type GeminiPart =
    | { text: string }
    | { thought: true; text: string; thoughtSignature?: string }
    | { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }
    | { functionResponse: { name: string; response: Record<string, unknown> } };

/** Gemini native function declaration */
interface GeminiFunctionDeclaration {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
}

/** Gemini native generation config (sampling params removed — deprecated upstream) */
interface GeminiGenerationConfig {
    maxOutputTokens?: number;
    /** Gemini 3+ only; older models use the legacy integer `thinkingBudget` instead. */
    thinkingLevel?: string; // 'minimal' | 'low' | 'medium' | 'high'
}

/** Thinking level setting, mapped per-model */
type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

// ── Message Converter: OpenAI-format → Gemini contents[] ─────────────

/**
 * Convert OpenAI-format messages to Gemini native contents[] format.
 *
 * Key mappings:
 *   - system message → systemInstruction (extracted separately)
 *   - user/assistant → role: 'user'/'model'
 *   - assistant tool_calls → model parts with functionCall + thoughtSignature
 *   - tool results → model parts with functionResponse
 *   - reasoning_content → thought parts (preserves thinking chain)
 *
 * Gemini requires strict alternation: user → model → user → model...
 * Consecutive same-role messages are merged.
 */
export function convertMessagesToGeminiContents(
    messages: OpenAICompatMessage[]
): { systemInstruction?: string; contents: GeminiContent[] } {
    let systemInstruction: string | undefined;
    // Tracks tool_call_id → function name so functionResponse parts can be
    // named after the DECLARED function (Gemini requires this), not the call id.
    const callIdToFnName = new Map<string, string>();
    // Tracks tool_call_ids whose functionCall part lacked a thought_signature
    // and was degraded to plain text — their matching tool result must also be
    // emitted as plain text instead of an orphaned functionResponse part.
    const unsignedCallIds = new Set<string>();

    // Group messages into Gemini contents with strict role alternation
    const contents: GeminiContent[] = [];
    const pendingParts: { role: GeminiRole; parts: GeminiPart[] } = { role: 'user', parts: [] };

    const flushPending = () => {
        if (pendingParts.parts.length > 0) {
            // Try to merge with previous content if same role
            const prev = contents[contents.length - 1];
            if (prev && prev.role === pendingParts.role) {
                prev.parts.push(...pendingParts.parts);
            } else {
                contents.push({ role: pendingParts.role, parts: [...pendingParts.parts] });
            }
            pendingParts.parts = [];
        }
    };

    for (const msg of messages) {
        if (msg.role === 'system') {
            // Accumulate system messages
            systemInstruction = systemInstruction
                ? `${systemInstruction}\n${msg.content ?? ''}`
                : (msg.content ?? undefined);
            continue;
        }

        const geminiRole: GeminiRole = msg.role === 'assistant' ? 'model' : 'user';

        // If role changes, flush pending
        if (pendingParts.parts.length > 0 && pendingParts.role !== geminiRole) {
            flushPending();
        }
        pendingParts.role = geminiRole;

        // Handle assistant messages with tool_calls
        if (msg.role === 'assistant') {
            if (msg.reasoning_content) {
                // Preserve reasoning as a thought part
                pendingParts.parts.push({ thought: true, text: msg.reasoning_content });
            }
            if (msg.content) {
                pendingParts.parts.push({ text: msg.content });
            }
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                // Google's thought-signature spec for Gemini 3+ / 4.x:
                // In a single model turn (including parallel tool calls), the first
                // functionCall part carries the turn's thoughtSignature. If any tool_call
                // in this turn has a signature, treat the turn as signed and ensure the
                // first emitted functionCall part carries it (so parallel siblings are not
                // partially degraded into text while others remain functionCall).
                // Conversely, if NO tool_call in the turn has a signature, degrade all
                // tool_calls in the turn to text together so no unsigned functionCall is sent.
                const turnSignature = msg.tool_calls.find(
                    tc => typeof tc.thought_signature === 'string' && tc.thought_signature.trim().length > 0
                )?.thought_signature?.trim();
                let attachedTurnSig = false;
                if (turnSignature) {
                    for (const tc of msg.tool_calls) {
                        let args: Record<string, unknown> = {};
                        try {
                            args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
                        } catch {
                            args = { _raw: tc.function.arguments };
                        }
                        callIdToFnName.set(tc.id, tc.function.name);
                        const explicitSig = typeof tc.thought_signature === 'string' && tc.thought_signature.trim().length > 0
                            ? tc.thought_signature.trim()
                            : undefined;
                        const sigToAttach = explicitSig ?? (!attachedTurnSig ? turnSignature : undefined);
                        if (sigToAttach) attachedTurnSig = true;
                        const part: GeminiPart = {
                            functionCall: { name: tc.function.name, args },
                            ...(sigToAttach ? { thoughtSignature: sigToAttach } : {}),
                        };
                        pendingParts.parts.push(part);
                    }
                } else {
                    // Never emit an unsigned functionCall part — Gemini 3+ and 4.x reject
                    // unsigned functionCall turns with HTTP 400. Also never emit literal
                    // `[Tool call: fn({...})]` syntax inside the `model` role, or the model
                    // will few-shot-imitate plain-text tool calls on subsequent steps.
                    for (const tc of msg.tool_calls) {
                        callIdToFnName.set(tc.id, tc.function.name);
                        unsignedCallIds.add(tc.id);
                    }
                    pendingParts.parts.push({
                        text: formatDegradedHistoricalToolSummary(msg.tool_calls.map(tc => tc.function.name)),
                    });
                }
            }
        } else if (msg.role === 'tool') {
            // Tool results → functionResponse parts. Gemini REQUIRES these in a
            // role:'user' content (the app answers the model's function call as
            // the user turn) — role:'model' causes an HTTP 400.
            const geminiRole: GeminiRole = 'user';
            if (pendingParts.parts.length > 0 && pendingParts.role !== geminiRole) {
                flushPending();
            }
            pendingParts.role = geminiRole;
            // functionResponse.name must match the DECLARED function name that
            // was called — not the OpenAI-style tool_call_id (would 400).
            const knownFnName = msg.tool_call_id ? callIdToFnName.get(msg.tool_call_id) : undefined;
            const toolName = knownFnName ?? msg.tool_call_id ?? 'unknown_tool';
            if (!knownFnName || (msg.tool_call_id && unsignedCallIds.has(msg.tool_call_id))) {
                pendingParts.parts.push({
                    text: `[Historical tool output from earlier turn (${toolName})]: ${String(msg.content ?? '(empty)')}`
                });
            } else {
                let responseContent: Record<string, unknown>;
                try {
                    responseContent = { result: msg.content ?? '(empty)' };
                } catch {
                    responseContent = { result: String(msg.content ?? '(empty)') };
                }
                pendingParts.parts.push({
                    functionResponse: { name: toolName, response: responseContent }
                });
            }
        } else {
            // Regular user message (including post-tool Mid-Session Whispers or Flow-State nudges).
            // Vertex AI's generateContent validator requires a functionResponse turn answering
            // a model functionCall turn to contain ONLY functionResponse parts (1:1 count match);
            // mixing a sibling `{ text }` part into a functionResponse turn causes HTTP 400.
            if (msg.content) {
                let lastFnRespPart: Extract<GeminiPart, { functionResponse: unknown }> | undefined;
                for (let idx = pendingParts.parts.length - 1; idx >= 0; idx--) {
                    const candidate = pendingParts.parts[idx];
                    if ('functionResponse' in candidate) {
                        lastFnRespPart = candidate;
                        break;
                    }
                }
                if (!lastFnRespPart && pendingParts.parts.length === 0 && contents.length > 0 && contents[contents.length - 1].role === 'user') {
                    const prevParts = contents[contents.length - 1].parts;
                    for (let idx = prevParts.length - 1; idx >= 0; idx--) {
                        const candidate = prevParts[idx];
                        if ('functionResponse' in candidate) {
                            lastFnRespPart = candidate;
                            break;
                        }
                    }
                }
                if (lastFnRespPart) {
                    const existingNote = typeof lastFnRespPart.functionResponse.response.additional_user_context === 'string'
                        ? `${lastFnRespPart.functionResponse.response.additional_user_context}\n\n${msg.content}`
                        : msg.content;
                    lastFnRespPart.functionResponse.response = {
                        ...lastFnRespPart.functionResponse.response,
                        additional_user_context: existingNote,
                    };
                } else {
                    pendingParts.parts.push({ text: msg.content });
                }
            }
        }
    }
    flushPending();

    return { systemInstruction, contents };
}

// ── Tool Converter: OpenAI-format → Gemini functionDeclarations ─────

/**
 * Convert OpenAI-format tools array to Gemini functionDeclarations.
 *
 * Gemini schema differences from OpenAI:
 *   - Type names are UPPERCASE: 'STRING' not 'string', 'OBJECT' not 'object'
 *   - Properties are a map, not an array
 *   - No 'type: function' wrapper — just the declaration directly
 */
export function convertToolsToGemini(tools: any[]): GeminiFunctionDeclaration[] {
    const declarations: GeminiFunctionDeclaration[] = [];

    for (const tool of tools) {
        // OpenAI format: { type: 'function', function: { name, description, parameters } }
        const fn = tool?.function ?? tool;
        if (!fn?.name) continue;

        // Deep-convert OpenAI schema types to Gemini UPPERCASE
        const parameters = convertSchemaToGemini(fn.parameters ?? { type: 'object', properties: {} });

        declarations.push({
            name: fn.name,
            description: fn.description ?? '',
            parameters,
        });
    }

    // Deterministic code-unit sort so the 196-tool declaration prefix stays
    // byte-identical across turns and steps for Gemini implicit KV caching.
    declarations.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return declarations;
}

/** Recursively convert JSON Schema types from lowercase to Gemini UPPERCASE */
function convertSchemaToGemini(schema: any): Record<string, unknown> {
    if (!schema || typeof schema !== 'object') return { type: 'OBJECT', properties: {} };

    const result: Record<string, unknown> = {};

    // Convert type (handle JSON Schema union arrays like ['string', 'null'] safely)
    if (schema.type) {
        const rawType = Array.isArray(schema.type)
            ? (schema.type.find((t: unknown) => typeof t === 'string' && t !== 'null') ?? schema.type[0] ?? 'string')
            : schema.type;
        const typeStr = typeof rawType === 'string' ? rawType.toLowerCase() : 'string';
        const typeMap: Record<string, string> = {
            'string': 'STRING',
            'number': 'NUMBER',
            'integer': 'INTEGER',
            'boolean': 'BOOLEAN',
            'array': 'ARRAY',
            'object': 'OBJECT',
        };
        result.type = typeMap[typeStr] ?? typeStr.toUpperCase();
    }

    // Copy description
    if (schema.description) {
        result.description = schema.description;
    }

    // Convert properties recursively in deterministic key order
    if (schema.properties) {
        const props: Record<string, unknown> = {};
        const sortedKeys = Object.keys(schema.properties).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        for (const key of sortedKeys) {
            props[key] = convertSchemaToGemini(schema.properties[key]);
        }
        result.properties = props;
    }

    // Convert required array in deterministic order
    if (Array.isArray(schema.required)) {
        result.required = [...new Set<string>(schema.required.map(String))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }

    // Convert items for arrays
    if (schema.items) {
        result.items = convertSchemaToGemini(schema.items);
    }

    // Convert enum
    if (Array.isArray(schema.enum)) {
        result.enum = [...schema.enum];
    }

    return result;
}

// ── Response Parser: Gemini SSE → stream result ─────────────────────

/**
 * Parse a Gemini generateContent SSE stream and emit deltas.
 *
 * Gemini SSE chunks look like:
 *   data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}}
 *
 * For function calls:
 *   data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"location":"Tokyo"}},"thoughtSignature":"base64sig..."}]}}]}
 *
 * For thoughts:
 *   data: {"candidates":[{"content":{"role":"model","parts":[{"thought":true,"text":"reasoning here...","thoughtSignature":"sig..."}]}}]}
 */
export interface GeminiSSEStreamGuard {
    idleTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    onIdleHeartbeat?: (elapsedMs: number) => void;
    onIdleTimeout?: () => void;
    isCancelled?: () => boolean;
}

function readGeminiChunkWithIdleTimeout(
    readPromise: Promise<{ done: boolean; value?: Uint8Array }>,
    idleTimeoutMs?: number,
    onIdleTimeout?: () => void,
    heartbeatIntervalMs?: number,
    onIdleHeartbeat?: (elapsedMs: number) => void
): Promise<{ done: boolean; value?: Uint8Array }> {
    if (!idleTimeoutMs || idleTimeoutMs <= 0) return readPromise;
    readPromise.catch(() => { /* raced out or aborted — prevent unhandled rejection */ });
    const waitStartedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pulseTimer: ReturnType<typeof setInterval> | undefined;
    if (onIdleHeartbeat && heartbeatIntervalMs && heartbeatIntervalMs > 0) {
        pulseTimer = setInterval(() => {
            try { onIdleHeartbeat(Date.now() - waitStartedAt); } catch { /* ignore */ }
        }, heartbeatIntervalMs);
        if (typeof (pulseTimer as any).unref === 'function') {
            (pulseTimer as any).unref();
        }
    }
    const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            try { onIdleTimeout?.(); } catch { /* ignore */ }
            reject(new Error(`Gemini Native stream idle timeout after ${Math.round(idleTimeoutMs / 1000)}s without data — connection stalled`));
        }, idleTimeoutMs);
    });
    return Promise.race([readPromise, timeoutPromise]).finally(() => {
        if (timer) clearTimeout(timer);
        if (pulseTimer) clearInterval(pulseTimer);
    });
}

export async function parseGeminiSSEStream(
    response: Response,
    onDelta: (delta: { content?: string; reasoning?: string; toolCalls?: any[] }) => void,
    routeLabel: string,
    toolCallCounter: { count: number },
    streamGuard?: GeminiSSEStreamGuard
): Promise<{
    content: string;
    reasoning: string;
    toolCalls: GeminiNativeToolCall[];
    usage?: {
        promptTokens?: number;
        completionTokens?: number;
        cachedPromptTokens?: number;
        thoughtsTokens?: number;
    };
}> {
    const reader = (response.body as any).getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    const accumulated = { content: '', reasoning: '' };
    const toolCalls: GeminiNativeToolCall[] = [];
    let lastPartSignature: string | undefined;
    let usage: {
        promptTokens?: number;
        completionTokens?: number;
        cachedPromptTokens?: number;
        thoughtsTokens?: number;
    } | undefined;

    let streamCompleted = false;
    try {
        while (true) {
            if (streamGuard?.isCancelled?.()) break;
            const { done, value } = await readGeminiChunkWithIdleTimeout(
                reader.read(),
                streamGuard?.idleTimeoutMs,
                streamGuard?.onIdleTimeout,
                streamGuard?.heartbeatIntervalMs,
                streamGuard?.onIdleHeartbeat
            );
            if (done) {
                streamCompleted = true;
                break;
            }

            buffer += decoder.decode(value, { stream: true });

            let lineEnd: number;
            while ((lineEnd = buffer.indexOf('\n')) >= 0) {
                const rawLine = buffer.slice(0, lineEnd).trim();
                buffer = buffer.slice(lineEnd + 1);
                if (!rawLine || !rawLine.startsWith('data:')) continue;
                const data = rawLine.slice(5).trim();
                if (data === '[DONE]') continue;

                let parsed: any;
                try {
                    parsed = JSON.parse(data);
                } catch {
                    continue; // Skip malformed JSON
                }

                // Extract usage metadata:
                // - promptTokenCount INCLUDES cachedContentTokenCount
                // - candidatesTokenCount EXCLUDES thoughtsTokenCount (both are billed as output)
                if (parsed?.usageMetadata) {
                    const promptTokens = typeof parsed.usageMetadata.promptTokenCount === 'number'
                        ? parsed.usageMetadata.promptTokenCount
                        : undefined;
                    const candidatesTokens = typeof parsed.usageMetadata.candidatesTokenCount === 'number'
                        ? parsed.usageMetadata.candidatesTokenCount
                        : 0;
                    const thoughtsTokens = typeof parsed.usageMetadata.thoughtsTokenCount === 'number'
                        ? parsed.usageMetadata.thoughtsTokenCount
                        : undefined;
                    const cachedPromptTokens = typeof parsed.usageMetadata.cachedContentTokenCount === 'number'
                        ? parsed.usageMetadata.cachedContentTokenCount
                        : undefined;
                    const hasCompletion = typeof parsed.usageMetadata.candidatesTokenCount === 'number'
                        || typeof parsed.usageMetadata.thoughtsTokenCount === 'number';
                    usage = {
                        promptTokens: promptTokens ?? usage?.promptTokens,
                        completionTokens: hasCompletion
                            ? candidatesTokens + (thoughtsTokens ?? usage?.thoughtsTokens ?? 0)
                            : usage?.completionTokens,
                        cachedPromptTokens: cachedPromptTokens ?? usage?.cachedPromptTokens,
                        thoughtsTokens: thoughtsTokens ?? usage?.thoughtsTokens,
                    };
                }

                // Extract candidates[0].content.parts
                const candidate = parsed?.candidates?.[0];
                if (!candidate) continue;

                const candidateSig = candidate?.thoughtSignature
                    ?? candidate?.thought_signature
                    ?? candidate?.content?.thoughtSignature
                    ?? candidate?.content?.thought_signature;
                if (typeof candidateSig === 'string' && candidateSig) {
                    lastPartSignature = candidateSig;
                    for (const existingTc of toolCalls) {
                        if (!existingTc.thought_signature) {
                            existingTc.thought_signature = candidateSig;
                        }
                    }
                }

                const parts = candidate?.content?.parts;
                if (!Array.isArray(parts)) continue;

                for (const part of parts) {
                    const partSig = part.thoughtSignature ?? part.thought_signature;
                    if (typeof partSig === 'string' && partSig) {
                        lastPartSignature = partSig;
                        // Backfill any tool call emitted in an earlier SSE chunk of this turn
                        for (const existingTc of toolCalls) {
                            if (!existingTc.thought_signature) {
                                existingTc.thought_signature = partSig;
                            }
                        }
                    }
                    // Text content
                    if (typeof part.text === 'string' && part.text) {
                        if (part.thought === true) {
                            // This is a thinking/reasoning part
                            accumulated.reasoning += part.text;
                            onDelta({ reasoning: part.text });
                        } else {
                            // Regular text
                            accumulated.content += part.text;
                            onDelta({ content: part.text });
                        }
                    }

                    // Function call
                    if (part.functionCall) {
                        const fnName = part.functionCall.name ?? '(unknown)';
                        const fnArgs = part.functionCall.args ?? {};
                        const callId = `gemini-call-${toolCallCounter.count++}`;
                        const argsStr = JSON.stringify(fnArgs);
                        const signature = part.thoughtSignature ?? part.thought_signature ?? lastPartSignature;

                        const toolCall: GeminiNativeToolCall = {
                            id: callId,
                            type: 'function',
                            function: {
                                name: fnName,
                                arguments: argsStr,
                            },
                            ...(signature ? { thought_signature: signature } : {}),
                        };
                        toolCalls.push(toolCall);
                        onDelta({ toolCalls: [toolCall] });
                    }
                }
            }
        }
    } finally {
        if (!streamCompleted) {
            try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* ignore */ }
        }
        try { reader.releaseLock(); } catch { /* ignore */ }
    }

    if (toolCalls.length > 0 && lastPartSignature) {
        for (const existingTc of toolCalls) {
            if (!existingTc.thought_signature) {
                existingTc.thought_signature = lastPartSignature;
            }
        }
    }

    if (toolCalls.length > 0) {
        // Debug logging
        // (logged by caller)
        void routeLabel;
    }

    return { content: accumulated.content, reasoning: accumulated.reasoning, toolCalls, usage };
}

// ── Main Streaming Function ──────────────────────────────────────────

// One-time guard: warn at most once per extension-host session.
let thinkingClampNotified = false;

/**
 * Call Gemini's native generateContent streaming API.
 *
 * This is the native streaming path that handles thought_signatures as
 * first-class metadata, eliminating the HTTP 400 errors that plagued
 * the OpenAI-compat endpoint.
 *
 * @returns Same shape as callDeepSeekStreaming for drop-in compatibility
 */
export interface GeminiNativeCallOptions {
    stepIndex?: number;
    isMechanicalStep?: boolean;
    costShieldMode?: 'auto' | 'manual' | 'off';
    connectTimeoutMs?: number;
    uploadTimeoutMs?: number;
    ttfbTimeoutMs?: number;
    streamIdleTimeoutMs?: number;
    tlsRejectUnauthorized?: boolean;
    fetchImpl?: typeof fetch;
    onGuardEvent?: (reason: string) => void;
    onProgressPulse?: (status: string) => void;
}

export function unwrapGeminiTransportError(err: any): string {
    return redactUrlCredentials(unwrapTransportErrorChain(err));
}

export function resolveGeminiTtfbMs(cfg: vscode.WorkspaceConfiguration, overrideMs?: number, model?: string): number {
    if (typeof overrideMs === 'number' && Number.isFinite(overrideMs) && overrideMs > 0) {
        return overrideMs;
    }
    const sec = cfg.get<number>('ttfbTimeoutSec');
    const inspected = typeof (cfg as any)?.inspect === 'function'
        ? (cfg as any).inspect('ttfbTimeoutSec')
        : undefined;
    const explicitlyConfigured =
        inspected?.globalValue !== undefined
        || inspected?.workspaceValue !== undefined
        || inspected?.workspaceFolderValue !== undefined
        || (typeof sec === 'number' && Number.isFinite(sec) && sec !== 180);
    const effective = (typeof sec === 'number' && Number.isFinite(sec) && sec >= 30) ? Math.min(sec, 600) : 180;
    // Frontier Gemini 4 Argon/Carbon/Neon legitimately queue/think for 140s-179s on Vertex global DSQ.
    // Because vpnResilientFetch separately enforces 15s connect/TLS and 30s paced-upload watchdogs,
    // raising the post-upload TTFB floor to 240s prevents false timeouts on healthy Carbon/Neon steps.
    if (!explicitlyConfigured && effective === 180 && /(^|[-_.])(argon|carbon|neon)($|[-_.])/i.test(model ?? '')) {
        return 240_000;
    }
    return effective * 1000;
}

export function resolveGeminiIdleMs(
    cfg: vscode.WorkspaceConfiguration,
    overrideMs?: number,
    model?: string,
    hasTools?: boolean
): number {
    if (typeof overrideMs === 'number' && Number.isFinite(overrideMs) && overrideMs > 0) {
        return overrideMs;
    }
    const sec = cfg.get<number>('streamIdleTimeoutSec');
    const inspected = typeof (cfg as any)?.inspect === 'function'
        ? (cfg as any).inspect('streamIdleTimeoutSec')
        : undefined;
    const explicitNonDefault =
        (inspected?.globalValue !== undefined && inspected.globalValue !== 120)
        || (inspected?.workspaceValue !== undefined && inspected.workspaceValue !== 120)
        || (inspected?.workspaceFolderValue !== undefined && inspected.workspaceFolderValue !== 120)
        || (typeof sec === 'number' && Number.isFinite(sec) && sec !== 120);
    const effective = (typeof sec === 'number' && Number.isFinite(sec) && sec >= 30) ? Math.min(sec, 900) : 120;
    // Gemini Native `streamGenerateContent?alt=sse` buffers each `functionCall` JSON
    // object server-side and emits zero SSE bytes after preceding prose until the
    // complete JSON `args` finishes generating. Meanwhile OS TCP `SO_KEEPALIVE` (15s)
    // probes wire liveness inside the VPN tunnel. Grant 300s (5m) on Argon/Carbon/Neon with tools.
    if (!explicitNonDefault && effective === 120 && hasTools && /(^|[-_.])(argon|carbon|neon)($|[-_.])/i.test(model ?? '')) {
        return 300_000;
    }
    return effective * 1000;
}

function isEarlyZeroDeltaSseDrop(err: unknown): boolean {
    const unwrapped = unwrapTransportErrorChain(err);
    return /\beconnreset\b|\bepipe\b|\betimedout\b|\bsocket hang ?up\b|\bother side closed\b|\bpremature close\b|\bterminated\b|\bund_err_(?:socket|closed|aborted)\b/i.test(unwrapped);
}

export async function callGeminiNativeStreaming(
    model: string,
    apiKey: string,
    messages: OpenAICompatMessage[],
    tools: any[],
    token: vscode.CancellationToken,
    onDelta: (delta: { content?: string; reasoning?: string; toolCalls?: any[] }) => void,
    options?: GeminiNativeCallOptions
): Promise<GeminiNativeStreamResult> {
    const cfg = vscode.workspace.getConfiguration('harmony');
    const proxyOpts = getVscodeHttpProxyOptions();
    const ttfbMs = resolveGeminiTtfbMs(cfg, options?.ttfbTimeoutMs, model);
    const idleMs = resolveGeminiIdleMs(cfg, options?.streamIdleTimeoutMs, model, Array.isArray(tools) && tools.length > 0);
    let activeController = new AbortController();
    const cancelSub = token.onCancellationRequested(() => activeController.abort());
    const startedAt = Date.now();

    // Read user-configurable settings
    const rawThinkingLevel = (cfg.get<string>('gemini.thinking.level') ?? 'medium').trim().toLowerCase();
    // Clamp to the four API-valid strings — settings files can be hand-edited.
    const thinkingLevelValid = /^(minimal|low|medium|high)$/.test(rawThinkingLevel);
    const thinkingLevel: ThinkingLevel = thinkingLevelValid ? (rawThinkingLevel as ThinkingLevel) : 'medium';
    // A corrected hand-edited value must not be silent — one visible notice per
    // session (debug line follows below).
    if (!thinkingLevelValid && !thinkingClampNotified) {
        thinkingClampNotified = true;
        void vscode.window.showWarningMessage(
            `Harmony: Gemini thinking level "${String(rawThinkingLevel).slice(0, 20)}" is not valid (minimal|low|medium|high) — using medium. Please update harmony.gemini.thinking.level in Settings.`
        );
    }
    const safetyPreset = cfg.get<string>('gemini.safety.preset') ?? 'permissive';
    // No temperature: Gemini sampling params are deprecated (ignored since 3.6 Flash,
    // error on upcoming models). Gemini uses its own defaults.

    // Convert messages → Gemini contents format
    const { systemInstruction, contents } = convertMessagesToGeminiContents(messages);

    // Convert tools → Gemini functionDeclarations
    const functionDeclarations = convertToolsToGemini(tools);

    // Thinking config is model-gated (Google deprecation notice; classifier and
    // casing follow):
    // - 'level'  (Gemini 3+ and -latest aliases): `thinkingLevel` — uppercase API
    //   enum; `minimal` is mapped to `low`, because several 3.x models don't list
    //   minimal and Argon documents it as a 400.
    // - 'budget' (Gemini 2.5.x): legacy integer `thinkingBudget` (still supported).
    // - 'none'   (older or unrecognized ids): omit `thinkingConfig` entirely — the
    //   safe default, because new models reject the legacy field with a 400.
    const thinkingMode = classifyGeminiThinking(model);
    let effectiveLevel: ThinkingLevel = thinkingLevel === 'minimal' ? 'low' : thinkingLevel;
    const shieldMode = options?.costShieldMode ?? (cfg.get<string>('costShield.mode') as 'auto' | 'manual' | 'off' | undefined) ?? 'auto';
    const adaptiveStepDown = shieldMode === 'auto'
        && (options?.stepIndex ?? 0) > 0
        && options?.isMechanicalStep === true;
    const isFrontierGemini4 = /(^|[-_.])(argon|carbon|neon)($|[-_.])/i.test(model);
    if (adaptiveStepDown) {
        if (isFrontierGemini4) {
            // Frontier Gemini 4 models (Argon / Carbon / Neon): clamp mechanical follow-up
            // tool steps directly to 'low' so multi-step loops don't burn frontier thinking budgets.
            effectiveLevel = 'low';
        } else if (effectiveLevel === 'high') {
            effectiveLevel = 'medium';
        } else if (effectiveLevel === 'medium') {
            effectiveLevel = 'low';
        }
    }
    const thinkingConfig = thinkingMode === 'level'
        ? { thinkingLevel: effectiveLevel.toUpperCase() }
        : thinkingMode === 'budget'
            ? {
                thinkingBudget: effectiveLevel === 'high' ? 8192
                    : effectiveLevel === 'low' ? 1024
                    : 2048
            }
            : undefined;

    // Build the generateContent request body (no sampling params — deprecated).
    const requestBody: any = {
        contents,
        generationConfig: thinkingConfig ? { thinkingConfig } : undefined,
        tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
        toolConfig: functionDeclarations.length > 0 ? { functionCallingConfig: { mode: 'AUTO' } } : undefined,
    };

    // Attach system instruction if present
    if (systemInstruction) {
        requestBody.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    // Safety settings: BLOCK_NONE for agent loops (prevents false-positive crashes)
    if (safetyPreset === 'permissive') {
        requestBody.safetySettings = [
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        ];
    }

    // Debug log (uses shared bounded singleton channel — never recreate/dispose per step)
    if (cfg.get<boolean>('enableDebugLogging') !== false) {
        harmonyDebugChannel.appendLine(`\n[Gemini Native API] Fetching streamGenerateContent for ${model} ...`);
        harmonyDebugChannel.appendLine(`[Gemini Native API] contents=${contents.length} tools=${functionDeclarations.length} thinking=${thinkingMode === 'level' ? effectiveLevel.toUpperCase() : thinkingLevel}${thinkingMode === 'none' ? ' (omitted)' : ''}${thinkingLevelValid ? '' : ' (clamped from invalid setting)'} safety=${safetyPreset}`);
    }

    const toolCallCounter = { count: 0 };

    const serializedBody = JSON.stringify(requestBody);

    let emittedAnyDelta = false;
    const trackedOnDelta: typeof onDelta = (delta) => {
        if (
            (delta.content && delta.content.length > 0)
            || (delta.reasoning && delta.reasoning.length > 0)
            || (delta.toolCalls && delta.toolCalls.length > 0)
        ) {
            emittedAnyDelta = true;
        }
        onDelta(delta);
    };

    const executeNativeFetch = async (
        url: string,
        headers: Record<string, string>,
        forceFreshSocket = false,
        preferIpv4 = false
    ): Promise<Response> => {
        activeController = new AbortController();
        if (token.isCancellationRequested) {
            activeController.abort();
        }
        return await vpnResilientFetch(url, {
            method: 'POST',
            headers,
            body: serializedBody,
            signal: activeController.signal,
            label: `Gemini Native (${model})`,
            connectTimeoutMs: options?.connectTimeoutMs,
            uploadTimeoutMs: options?.uploadTimeoutMs,
            ttfbTimeoutMs: ttfbMs,
            forceFreshSocket,
            preferIpv4,
            ...proxyOpts,
            tlsRejectUnauthorized: options?.tlsRejectUnauthorized,
            fetchImpl: options?.fetchImpl,
            onGuardEvent: (reason) => {
                if (cfg.get<boolean>('enableDebugLogging') !== false) {
                    harmonyDebugChannel.appendLine(`[Gemini Native Self-Heal] ${reason}`);
                }
                options?.onGuardEvent?.(reason);
            },
        });
    };

    const checkResponseAndRequireBody = async (
        res: Response,
        reqInfo: Awaited<ReturnType<typeof resolveGeminiGenerateContentRequestAsync>>
    ): Promise<void> => {
        if (!res.ok) {
            const text = await res.text();
            if (reqInfo.backend === 'vertex') {
                throw new Error(enrichVertexHttpError(res.status, text, model, reqInfo.vertexAuth));
            }
            throw new Error(`Gemini Native HTTP ${res.status}: ${redactUrlCredentials(text).slice(0, 500)}`);
        }
        if (!res.body) throw new Error('Gemini Native returned no body.');
    };

    try {
        let reqInfo = await resolveGeminiGenerateContentRequestAsync(model, apiKey, 'streamGenerateContent', true);
        if (cfg.get<boolean>('enableDebugLogging') !== false) {
            const authTag = reqInfo.vertexAuth ? ` auth=${reqInfo.vertexAuth.mode}/${reqInfo.vertexAuth.source}` : '';
            harmonyDebugChannel.appendLine(`[Gemini Native API] backend=${reqInfo.backend}${authTag} url=${redactUrlCredentials(reqInfo.url)}`);
        }

        let response = await executeNativeFetch(reqInfo.url, reqInfo.headers, false, false);

        if (response.status === 401 && reqInfo.backend === 'vertex' && reqInfo.vertexAuth?.cacheKey) {
            try { await response.body?.cancel(); } catch { /* ignore */ }
            invalidateVertexTokenCache(reqInfo.vertexAuth.cacheKey);
            const refreshNote = `Gemini Native (${model}) Vertex OAuth token expired (HTTP 401); refreshing token automatically`;
            if (cfg.get<boolean>('enableDebugLogging') !== false) {
                harmonyDebugChannel.appendLine(`[Gemini Native Self-Heal] ${refreshNote}`);
            }
            options?.onGuardEvent?.(refreshNote);
            reqInfo = await resolveGeminiGenerateContentRequestAsync(model, apiKey, 'streamGenerateContent', true, { bypassVertexCache: true });
            response = await executeNativeFetch(reqInfo.url, reqInfo.headers, false, false);
        }

        await checkResponseAndRequireBody(response, reqInfo);

        let idleTimedOut = false;
        const ssePhaseStart = Date.now();
        let result: Awaited<ReturnType<typeof parseGeminiSSEStream>>;
        const buildStreamGuard = (): GeminiSSEStreamGuard => ({
            idleTimeoutMs: idleMs,
            heartbeatIntervalMs: 25_000,
            onIdleHeartbeat: (elapsedMs) => {
                const secWait = Math.max(1, Math.round(elapsedMs / 1000));
                const phase = emittedAnyDelta && functionDeclarations.length > 0
                    ? `synthesizing structured tool call (${secWait}s buffered, TCP keep-alive active)`
                    : `reasoning (${secWait}s elapsed, TCP keep-alive active)`;
                options?.onProgressPulse?.(`Gemini (${model}) ${phase}…`);
            },
            onIdleTimeout: () => {
                idleTimedOut = true;
                activeController.abort();
            },
            isCancelled: () => token.isCancellationRequested,
        });
        try {
            result = await parseGeminiSSEStream(
                response,
                trackedOnDelta,
                'Gemini Native',
                toolCallCounter,
                buildStreamGuard()
            );
        } catch (sseErr: any) {
            const sseElapsed = Date.now() - ssePhaseStart;
            if (
                !token.isCancellationRequested
                && !idleTimedOut
                && !emittedAnyDelta
                && sseElapsed <= 25_000
                && isEarlyZeroDeltaSseDrop(sseErr)
            ) {
                evictIdleVpnSockets();
                try { markVpnHostPreferFreshIpv4(new URL(reqInfo.url).hostname); } catch { /* ignore */ }
                const detail = unwrapGeminiTransportError(sseErr).slice(0, 160);
                const healNote = `Gemini Native (${model}) SSE stream dropped before first delta (${detail}); reconnecting immediately on fresh IPv4 socket inside tunnel`;
                if (cfg.get<boolean>('enableDebugLogging') !== false) {
                    harmonyDebugChannel.appendLine(`[Gemini Native Self-Heal] ${healNote}`);
                }
                options?.onGuardEvent?.(healNote);
                toolCallCounter.count = 0;
                idleTimedOut = false;
                response = await executeNativeFetch(reqInfo.url, reqInfo.headers, true, true);
                await checkResponseAndRequireBody(response, reqInfo);
                result = await parseGeminiSSEStream(
                    response,
                    trackedOnDelta,
                    'Gemini Native',
                    toolCallCounter,
                    buildStreamGuard()
                );
            } else {
                throw sseErr;
            }
        }

        if (result.toolCalls.length > 0 && cfg.get<boolean>('enableDebugLogging') !== false) {
            harmonyDebugChannel.appendLine(`[Gemini Native] parsed ${result.toolCalls.length} tool calls: ${JSON.stringify(result.toolCalls.map(tc => ({ id: tc.id, name: tc.function.name, hasSig: !!tc.thought_signature })))}`);
        }

        return {
            content: result.content,
            reasoning: result.reasoning,
            toolCalls: result.toolCalls,
            usage: result.usage,
            durationMs: Date.now() - startedAt,
        };
    } finally {
        cancelSub.dispose();
    }
}

// ── Helper: Check if model supports native generateContent ───────────

/** Normalize a Gemini model id: trim, lowercase, strip a leading `models/`. */
export function normalizeGeminiModelId(model: string): string {
    return model.trim().toLowerCase().replace(/^models\//, '');
}

export type GeminiThinkingMode = 'level' | 'budget' | 'none';

/**
 * Classify how a Gemini model wants its thinking config (shared by the native
 * request builder and the route selector):
 * - 'level'  — Gemini 3+ (and gemini-(pro|flash|flash-lite)-latest): `thinkingLevel`.
 * - 'budget' — Gemini 2.5.x: legacy integer `thinkingBudget`.
 * - 'none'   — older or unrecognized ids: omit thinkingConfig (safe default —
 *              new models 400 on the legacy field, so guessing is the worst choice).
 */
export function classifyGeminiThinking(model: string): GeminiThinkingMode {
    const id = normalizeGeminiModelId(model);
    if (/^gemini-(pro|flash|flash-lite)-latest$/.test(id)) return 'level';
    const m = /^gemini-(\d+)(?:\.(\d+))?/.exec(id);
    if (!m) return 'none';
    const major = parseInt(m[1], 10);
    const minor = parseInt(m[2] ?? '0', 10);
    if (major >= 3) return 'level';
    if (major === 2 && minor >= 5) return 'budget';
    return 'none';
}

/**
 * Determine if a Gemini model should use the native generateContent path.
 *
 * Native for thinking-capable models (Gemini 2.5 and later, including future
 * families like gemini-4-*): they attach
 * thought_signatures to function calls and are where the thinking config belongs.
 * Everything else stays on compat.
 */
export function shouldUseGeminiNative(model: string, userPreference: string): boolean {
    // Explicit user override
    if (userPreference === 'generateContent') return true;
    if (userPreference === 'openai-compat') return false;

    // Vertex AI Express Mode only exposes native generateContent / streamGenerateContent,
    // and project-scoped Vertex AI prefers native for full Gemini feature parity.
    try {
        if (isGeminiVertexProfile()) return true;
    } catch { /* headless unit test without vscode workspace config */ }

    // 'auto' mode: native for 2.5+ and -latest aliases (any parsed major >= 2.5)
    const mode = classifyGeminiThinking(model);
    return mode === 'level' || mode === 'budget';
}
