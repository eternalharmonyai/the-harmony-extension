/**
 * Pure tool-call bridge for the DeepSeek language-model provider.
 *
 * VS Code-free so it can be unit-tested directly in plain Node
 * (scripts/run-deepseek-tool-bridge-tests.js). deepseekProvider.ts converts
 * VS Code message/part objects into the normalized shapes below, forwards tool
 * schemas, reassembles streamed delta.tool_calls fragments, and emits
 * LanguageModelToolCallPart events back to Agent mode.
 */

/** An OpenAI/DeepSeek-compatible tool definition. */
export interface OpenAiToolDef {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

/** A tool definition as VS Code presents it, reduced to what we need. */
export interface ToolSource {
    name?: string;
    description?: string;
    inputSchema?: unknown;
}

/** Text produced by the model or the user. */
export interface NormalizedTextPart {
    kind: 'text';
    text: string;
}

/** A tool call the model requested. Present in assistant history. */
export interface NormalizedToolCallPart {
    kind: 'toolCall';
    callId: string;
    name: string;
    input: unknown;
}

/** A tool result VS Code is sending back. Present in user-role history. */
export interface NormalizedToolResultPart {
    kind: 'toolResult';
    callId: string;
    text: string;
}

export type NormalizedPart =
    | NormalizedTextPart
    | NormalizedToolCallPart
    | NormalizedToolResultPart;

export interface NormalizedMessage {
    role: 'user' | 'assistant';
    parts: NormalizedPart[];
    /** Non-text media (images) for this message, opaque to this module. */
    media?: unknown[];
}

/** A chat message in the shape DeepSeek's /chat/completions accepts. */
export interface OpenAiChatMessage {
    role: 'user' | 'assistant' | 'tool';
    content: string | unknown[] | null;
    tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
    }[];
    tool_call_id?: string;
}

/** A tool call reassembled from streamed fragments. */
export interface AssembledToolCall {
    index: number;
    callId: string;
    name: string;
    input: unknown;
    rawArguments: string;
    /** True when the model's argument JSON could not be parsed. */
    parseFailed: boolean;
}

/**
 * Convert VS Code tool descriptors into DeepSeek tool definitions.
 * Returns undefined when there is nothing to advertise — sending an empty
 * `tools: []` array is rejected by some OpenAI-compatible servers.
 */
export function toOpenAiTools(
    tools?: readonly ToolSource[] | null
): OpenAiToolDef[] | undefined {
    if (!Array.isArray(tools) || tools.length === 0) {
        return undefined;
    }
    const defs: OpenAiToolDef[] = [];
    for (const tool of tools) {
        if (!tool || typeof tool.name !== 'string' || tool.name.trim().length === 0) {
            continue;
        }
        const schema =
            tool.inputSchema && typeof tool.inputSchema === 'object'
                ? (tool.inputSchema as Record<string, unknown>)
                : { type: 'object', properties: {} };
        defs.push({
            type: 'function',
            function: {
                name: tool.name,
                description: typeof tool.description === 'string' ? tool.description : '',
                parameters: schema,
            },
        });
    }
    return defs.length > 0 ? defs : undefined;
}

/**
 * Convert normalized conversation history into DeepSeek chat messages.
 *
 * Ordering matters and is enforced here: OpenAI-compatible servers require each
 * `role:'tool'` message to immediately follow the assistant message whose
 * `tool_calls` it answers. A user-role message can carry both tool results and
 * new text, so results are emitted first and the remaining text after them.
 *
 * @param renderText Optional hook so the caller can substitute multimodal
 *   content arrays (images) for plain text without this module knowing about
 *   VS Code image parts.
 */
export function buildChatMessages(
    messages: readonly NormalizedMessage[],
    renderText?: (text: string, message: NormalizedMessage) => string | unknown[]
): OpenAiChatMessage[] {
    const out: OpenAiChatMessage[] = [];

    for (const message of messages) {
        const texts: string[] = [];
        const toolCalls: NormalizedToolCallPart[] = [];
        const toolResults: NormalizedToolResultPart[] = [];

        for (const part of message.parts) {
            if (part.kind === 'text') {
                texts.push(part.text);
            } else if (part.kind === 'toolCall') {
                toolCalls.push(part);
            } else if (part.kind === 'toolResult') {
                toolResults.push(part);
            }
        }

        const text = texts.join('\n');
        const content = renderText ? renderText(text, message) : text;

        // Assistant turn that requested tools: text and calls travel together.
        if (message.role === 'assistant' && toolCalls.length > 0) {
            out.push({
                role: 'assistant',
                content: text.length > 0 ? content : null,
                tool_calls: toolCalls.map(call => ({
                    id: call.callId,
                    type: 'function' as const,
                    function: {
                        name: call.name,
                        arguments: JSON.stringify(call.input ?? {}),
                    },
                })),
            });
            continue;
        }

        // Tool results answer a previous assistant turn — they must come first.
        if (toolResults.length > 0) {
            for (const result of toolResults) {
                out.push({
                    role: 'tool',
                    tool_call_id: result.callId,
                    content: result.text.trim().length > 0
                        ? result.text
                        : '[tool returned empty result]',
                });
            }
            if (text.length > 0) {
                out.push({ role: message.role, content });
            }
            continue;
        }

        out.push({ role: message.role, content });
    }

    return out;
}

/**
 * Reassemble tool calls from DeepSeek's streamed `delta.tool_calls` fragments.
 *
 * DeepSeek (like OpenAI) splits a single tool call across many SSE chunks: the
 * `id` usually arrives once on the first fragment, the `name` normally arrives
 * whole but is allowed to stream, and `arguments` is a JSON string delivered in
 * arbitrary slices that is only valid once concatenated.
 */
export class ToolCallAccumulator {
    private readonly slots = new Map<number, { id: string; name: string; args: string }>();
    /** Index of the call currently being assembled, or null before the first fragment. */
    private lastIndex: number | null = null;

    /** First index not already occupied — used only when the server sends no index. */
    private nextFreeIndex(): number {
        let max = -1;
        for (const key of this.slots.keys()) {
            if (key > max) {
                max = key;
            }
        }
        return max + 1;
    }

    /** Feed one chunk's `delta.tool_calls` value. Non-arrays are ignored. */
    push(deltas: unknown): void {
        if (!Array.isArray(deltas)) {
            return;
        }
        for (const raw of deltas) {
            if (!raw || typeof raw !== 'object') {
                continue;
            }
            const delta = raw as {
                index?: unknown;
                id?: unknown;
                function?: { name?: unknown; arguments?: unknown };
            };

            let index: number;
            if (typeof delta.index === 'number' && Number.isFinite(delta.index)) {
                index = delta.index;
            } else {
                // When the server omits index, treat the fragment as a continuation
                // of the current slot unless a different non-empty id arrives.
                const incomingId = typeof delta.id === 'string' && delta.id.length > 0 ? delta.id : undefined;
                const current = this.lastIndex === null ? undefined : this.slots.get(this.lastIndex);
                const startsNewCall = current !== undefined
                    && incomingId !== undefined
                    && current.id.length > 0
                    && current.id !== incomingId;
                index = (this.lastIndex !== null && !startsNewCall)
                    ? this.lastIndex
                    : this.nextFreeIndex();
            }
            this.lastIndex = index;

            let slot = this.slots.get(index);
            if (!slot) {
                slot = { id: '', name: '', args: '' };
                this.slots.set(index, slot);
            }

            if (typeof delta.id === 'string' && delta.id.length > 0) {
                slot.id = delta.id;
            }

            const fn = delta.function;
            if (fn && typeof fn === 'object') {
                if (typeof fn.name === 'string' && fn.name.length > 0) {
                    // Names arrive whole in practice. If a server streams one in
                    // pieces, the fragment will not start with what we already
                    // hold — append only in that case so re-sent prefixes do not
                    // duplicate the name.
                    slot.name = slot.name.length === 0
                        ? fn.name
                        : fn.name.startsWith(slot.name)
                            ? fn.name
                            : slot.name + fn.name;
                }
                if (typeof fn.arguments === 'string') {
                    slot.args += fn.arguments;
                }
            }
        }
    }

    /** How many distinct tool calls have been seen so far. */
    get size(): number {
        return this.slots.size;
    }

    /**
     * Finalize assembled calls in the model's original index order.
     * Nameless calls are dropped — they cannot be invoked. Unparseable
     * argument JSON yields `parseFailed: true` and an empty object, so the
     * caller can surface a visible signal instead of failing silently.
     */
    finish(): AssembledToolCall[] {
        return [...this.slots.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([index, slot]) => {
                const rawArguments = slot.args.trim();
                let input: unknown = {};
                let parseFailed = false;
                if (rawArguments.length > 0) {
                    try {
                        input = JSON.parse(rawArguments);
                    } catch {
                        parseFailed = true;
                        input = {};
                    }
                }
                if (!input || typeof input !== 'object') {
                    input = {};
                }
                return {
                    index,
                    callId: slot.id.length > 0 ? slot.id : `deepseek_call_${index}`,
                    name: slot.name,
                    input,
                    rawArguments,
                    parseFailed,
                };
            })
            .filter(call => call.name.trim().length > 0);
    }
}
