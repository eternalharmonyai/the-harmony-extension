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
 * Design consensus (Gemini 3.1 Pro + DeepSeek V4 Pro + Kimi K3):
 *   - Separate function, not a shared abstraction (minimize risk to 17 providers)
 *   - generateContent path first; Interactions API as future Phase 3
 *   - Fallback to OpenAI-compat on failure
 *   - BLOCK_NONE safety settings for agent loops
 * ════════════════════════════════════════════════════════════════════
 */

import * as vscode from 'vscode';

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
    usage?: { promptTokens?: number; completionTokens?: number };
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

/** Gemini native generation config */
interface GeminiGenerationConfig {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    topK?: number;
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
                for (const tc of msg.tool_calls) {
                    let args: Record<string, unknown> = {};
                    try {
                        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
                    } catch {
                        args = { _raw: tc.function.arguments };
                    }
                    callIdToFnName.set(tc.id, tc.function.name);
                    const part: GeminiPart = {
                        functionCall: { name: tc.function.name, args }
                    };
                    // Attach thought_signature if present
                    if (tc.thought_signature) {
                        (part as any).thoughtSignature = tc.thought_signature;
                    }
                    pendingParts.parts.push(part);
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
            const toolName = callIdToFnName.get(msg.tool_call_id ?? '') ?? msg.tool_call_id ?? 'unknown_tool';
            let responseContent: Record<string, unknown>;
            try {
                responseContent = { result: msg.content ?? '(empty)' };
            } catch {
                responseContent = { result: String(msg.content ?? '(empty)') };
            }
            pendingParts.parts.push({
                functionResponse: { name: toolName, response: responseContent }
            });
        } else {
            // Regular user message
            if (msg.content) {
                pendingParts.parts.push({ text: msg.content });
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

    return declarations;
}

/** Recursively convert JSON Schema types from lowercase to Gemini UPPERCASE */
function convertSchemaToGemini(schema: any): Record<string, unknown> {
    if (!schema || typeof schema !== 'object') return { type: 'OBJECT', properties: {} };

    const result: Record<string, unknown> = {};

    // Convert type
    if (schema.type) {
        const typeMap: Record<string, string> = {
            'string': 'STRING',
            'number': 'NUMBER',
            'integer': 'INTEGER',
            'boolean': 'BOOLEAN',
            'array': 'ARRAY',
            'object': 'OBJECT',
        };
        result.type = typeMap[schema.type] ?? schema.type.toUpperCase();
    }

    // Copy description
    if (schema.description) {
        result.description = schema.description;
    }

    // Convert properties recursively
    if (schema.properties) {
        const props: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(schema.properties)) {
            props[key] = convertSchemaToGemini(val);
        }
        result.properties = props;
    }

    // Convert required array
    if (Array.isArray(schema.required)) {
        result.required = [...schema.required];
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
export async function parseGeminiSSEStream(
    response: Response,
    onDelta: (delta: { content?: string; reasoning?: string; toolCalls?: any[] }) => void,
    routeLabel: string,
    toolCallCounter: { count: number }
): Promise<{ content: string; reasoning: string; toolCalls: GeminiNativeToolCall[]; usage?: { promptTokens?: number; completionTokens?: number } }> {
    const reader = (response.body as any).getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    const accumulated = { content: '', reasoning: '' };
    const toolCalls: GeminiNativeToolCall[] = [];
    let usage: { promptTokens?: number; completionTokens?: number } | undefined;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

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

            // Extract usage metadata
            if (parsed?.usageMetadata) {
                usage = {
                    promptTokens: parsed.usageMetadata.promptTokenCount,
                    completionTokens: parsed.usageMetadata.candidatesTokenCount,
                };
            }

            // Extract candidates[0].content.parts
            const candidate = parsed?.candidates?.[0];
            if (!candidate) continue;

            const parts = candidate?.content?.parts;
            if (!Array.isArray(parts)) continue;

            for (const part of parts) {
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
                    const signature = part.thoughtSignature ?? part.thought_signature;

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

    if (toolCalls.length > 0) {
        // Debug logging
        // (logged by caller)
        void routeLabel;
    }

    return { content: accumulated.content, reasoning: accumulated.reasoning, toolCalls, usage };
}

// ── Main Streaming Function ──────────────────────────────────────────

/**
 * Call Gemini's native generateContent streaming API.
 *
 * This is the Phase 2 native path that handles thought_signatures as
 * first-class metadata, eliminating the HTTP 400 errors that plagued
 * the OpenAI-compat endpoint.
 *
 * @returns Same shape as callDeepSeekStreaming for drop-in compatibility
 */
export async function callGeminiNativeStreaming(
    model: string,
    apiKey: string,
    messages: OpenAICompatMessage[],
    tools: any[],
    token: vscode.CancellationToken,
    onDelta: (delta: { content?: string; reasoning?: string; toolCalls?: any[] }) => void
): Promise<GeminiNativeStreamResult> {
    const cfg = vscode.workspace.getConfiguration('harmony');
    const controller = new AbortController();
    const cancelSub = token.onCancellationRequested(() => controller.abort());
    const startedAt = Date.now();

    // Read user-configurable settings
    const thinkingLevel = cfg.get<string>('gemini.thinking.level') ?? 'medium';
    const safetyPreset = cfg.get<string>('gemini.safety.preset') ?? 'permissive';
    const temperature = 0.2; // Match our agent loop default

    // Convert messages → Gemini contents format
    const { systemInstruction, contents } = convertMessagesToGeminiContents(messages);

    // Convert tools → Gemini functionDeclarations
    const functionDeclarations = convertToolsToGemini(tools);

    // Gemini's valid field is generationConfig.thinkingConfig.thinkingBudget
    // (an integer). The old `thinkingLevel` string field does not exist in the
    // API and 400s every native call. Map our level to a budget:
    // high → 8192, low/minimal → 1024, anything else (medium) → 2048.
    const thinkingBudget = thinkingLevel === 'high' ? 8192
        : (thinkingLevel === 'low' || thinkingLevel === 'minimal') ? 1024
        : 2048;

    // Build the generateContent request body
    const requestBody: any = {
        contents,
        generationConfig: {
            temperature,
            thinkingConfig: { thinkingBudget },
        },
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

    // Debug log
    const harmonyDebugChannel = vscode.window.createOutputChannel('Harmony Debug');
    if (cfg.get<boolean>('enableDebugLogging') !== false) {
        harmonyDebugChannel.appendLine(`\n[Gemini Native API] Fetching streamGenerateContent for ${model} ...`);
        harmonyDebugChannel.appendLine(`[Gemini Native API] contents=${contents.length} tools=${functionDeclarations.length} thinking=${thinkingLevel} safety=${safetyPreset}`);
    }

    const toolCallCounter = { count: 0 };

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // Use header, NOT query param (?key=) — privacy: avoids proxy logs
                'x-goog-api-key': apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal as any,
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Gemini Native HTTP ${response.status}: ${text.slice(0, 500)}`);
        }

        if (!response.body) throw new Error('Gemini Native returned no body.');

        const result = await parseGeminiSSEStream(
            response,
            onDelta,
            'Gemini Native',
            toolCallCounter
        );

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
        harmonyDebugChannel.dispose();
    }
}

// ── Helper: Check if model supports native generateContent ───────────

/**
 * Determine if a Gemini model should use the native generateContent path.
 *
 * Only Gemini 2.5+ thinking models benefit from native path (they have
 * thought_signature requirements). Non-thinking models work fine on compat.
 */
export function shouldUseGeminiNative(model: string, userPreference: string): boolean {
    // Explicit user override
    if (userPreference === 'generateContent') return true;
    if (userPreference === 'openai-compat') return false;

    // 'auto' mode: use native for thinking models (2.5+ and 3.x)
    const lowerModel = model.toLowerCase();
    return lowerModel.includes('gemini-2.5')
        || lowerModel.includes('gemini-3.')
        || lowerModel.includes('gemini-3-');
}
