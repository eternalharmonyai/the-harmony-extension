/**
 * textualToolCallGuard.ts — Anti-imitation history hygiene & structured recovery
 * for misfired `[Tool call: name({...})]` prose output.
 *
 * Pure TypeScript (zero `vscode` runtime dependency) so unit gates can verify
 * every parser, code-fence mask, and history-hygiene invariant directly in Node.
 */

export interface RecoveredToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

export interface UnrecoverableTextualToolCall {
    raw: string;
    name: string;
    reason: 'disallowed_tool' | 'invalid_json';
}

export interface TextualToolCallExtraction {
    hasAnyTextualToolCallSyntax: boolean;
    recoveredCalls: RecoveredToolCall[];
    unrecoverableMatches: UnrecoverableTextualToolCall[];
    cleanedContent: string;
}

interface CodeRange {
    start: number;
    end: number;
}

/**
 * Compute character ranges inside fenced code blocks (``` or ~~~) or inline
 * single/multi-backtick code spans so documentation examples mentioning
 * `[Tool call: ...]` are never mistaken for live tool invocations.
 */
export function computeCodeSpanRanges(input: string): CodeRange[] {
    const ranges: CodeRange[] = [];
    const fenceRe = /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g;
    let m: RegExpExecArray | null;
    while ((m = fenceRe.exec(input)) !== null) {
        const leadingNewlineOffset = m[1] ? m[1].length : 0;
        ranges.push({
            start: m.index + leadingNewlineOffset,
            end: m.index + m[0].length,
        });
    }

    const isInsideFence = (pos: number): boolean =>
        ranges.some((r) => pos >= r.start && pos < r.end);

    let i = 0;
    while (i < input.length) {
        if (isInsideFence(i)) {
            const fence = ranges.find((r) => i >= r.start && i < r.end)!;
            i = fence.end;
            continue;
        }
        if (input[i] === '`') {
            let tickCount = 0;
            const start = i;
            while (i < input.length && input[i] === '`') {
                tickCount += 1;
                i += 1;
            }
            const closer = '`'.repeat(tickCount);
            const lineBreak = input.indexOf('\n', i);
            const closeIdx = input.indexOf(closer, i);
            if (closeIdx !== -1 && (lineBreak === -1 || closeIdx < lineBreak)) {
                ranges.push({ start, end: closeIdx + tickCount });
                i = closeIdx + tickCount;
                continue;
            }
            continue;
        }
        i += 1;
    }

    ranges.sort((a, b) => a.start - b.start);
    return ranges;
}

function isOffsetInsideRanges(offset: number, ranges: readonly CodeRange[]): boolean {
    for (const r of ranges) {
        if (offset < r.start) return false;
        if (offset >= r.start && offset < r.end) return true;
    }
    return false;
}

/**
 * Quick detector: returns true if `[Tool call: <identifier>(` appears outside
 * markdown code fences and inline backtick spans.
 */
export function hasTextualToolCallSyntax(content: string): boolean {
    if (!content || !content.includes('[Tool call:')) return false;
    const codeRanges = computeCodeSpanRanges(content);
    const headerRe = /\[Tool call:\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = headerRe.exec(content)) !== null) {
        if (!isOffsetInsideRanges(match.index, codeRanges)) {
            return true;
        }
    }
    return false;
}

/**
 * Scan from `openParenIdx` (pointing at `(`) to find the matching `)` followed by
 * optional whitespace and `]`, respecting JSON string literals and nested `{}`/`[]`/`()`.
 */
function scanBalancedTextualCallEnd(
    text: string,
    openParenIdx: number
): { argsRaw: string; endExclusive: number } | undefined {
    let i = openParenIdx + 1;
    let parenDepth = 1;
    let braceDepth = 0;
    let bracketDepth = 0;
    let inString = false;
    let escapeNext = false;

    while (i < text.length) {
        const ch = text[i];
        if (inString) {
            if (escapeNext) {
                escapeNext = false;
            } else if (ch === '\\') {
                escapeNext = true;
            } else if (ch === '"') {
                inString = false;
            }
            i += 1;
            continue;
        }

        if (ch === '"') {
            inString = true;
        } else if (ch === '{') {
            braceDepth += 1;
        } else if (ch === '}') {
            if (braceDepth > 0) braceDepth -= 1;
        } else if (ch === '[') {
            bracketDepth += 1;
        } else if (ch === ']') {
            if (bracketDepth > 0) bracketDepth -= 1;
        } else if (ch === '(') {
            parenDepth += 1;
        } else if (ch === ')') {
            parenDepth -= 1;
            if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
                const argsRaw = text.slice(openParenIdx + 1, i).trim();
                let j = i + 1;
                while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r' || text[j] === '\n')) {
                    j += 1;
                }
                if (j < text.length && text[j] === ']') {
                    return { argsRaw, endExclusive: j + 1 };
                }
                return undefined;
            }
        }
        i += 1;
    }

    return undefined;
}

/**
 * Extract structured tool calls from literal `[Tool call: name({...})]` blocks
 * emitted outside code spans, validating each against `allowedToolNames` and
 * strict JSON object syntax.
 */
export function extractTextualToolCalls(
    content: string,
    allowedToolNames: ReadonlySet<string> | readonly string[],
    idPrefix = 'recovered-call'
): TextualToolCallExtraction {
    if (!content || !content.includes('[Tool call:')) {
        return {
            hasAnyTextualToolCallSyntax: false,
            recoveredCalls: [],
            unrecoverableMatches: [],
            cleanedContent: content,
        };
    }

    const allowedSet: ReadonlySet<string> = allowedToolNames instanceof Set
        ? allowedToolNames
        : new Set(allowedToolNames);
    const codeRanges = computeCodeSpanRanges(content);
    const headerRe = /\[Tool call:\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;

    const recoveredCalls: RecoveredToolCall[] = [];
    const unrecoverableMatches: UnrecoverableTextualToolCall[] = [];
    const removalRanges: CodeRange[] = [];
    let hasAnySyntax = false;
    let seq = 0;

    let match: RegExpExecArray | null;
    while ((match = headerRe.exec(content)) !== null) {
        const startIdx = match.index;
        if (isOffsetInsideRanges(startIdx, codeRanges)) {
            continue;
        }
        hasAnySyntax = true;
        const toolName = match[1];
        const openParenIdx = startIdx + match[0].length - 1;
        const scanned = scanBalancedTextualCallEnd(content, openParenIdx);

        if (!scanned) {
            // Truncated `[Tool call: name({...` to end of line/message
            const lineEnd = content.indexOf('\n', startIdx);
            const fallbackEnd = lineEnd === -1 ? content.length : lineEnd;
            const raw = content.slice(startIdx, fallbackEnd);
            unrecoverableMatches.push({ raw, name: toolName, reason: 'invalid_json' });
            removalRanges.push({ start: startIdx, end: fallbackEnd });
            headerRe.lastIndex = fallbackEnd;
            continue;
        }

        const raw = content.slice(startIdx, scanned.endExclusive);
        removalRanges.push({ start: startIdx, end: scanned.endExclusive });
        headerRe.lastIndex = scanned.endExclusive;

        if (!allowedSet.has(toolName)) {
            unrecoverableMatches.push({ raw, name: toolName, reason: 'disallowed_tool' });
            continue;
        }

        const candidateJson = scanned.argsRaw === '' ? '{}' : scanned.argsRaw;
        let parsed: unknown;
        try {
            parsed = JSON.parse(candidateJson);
        } catch {
            unrecoverableMatches.push({ raw, name: toolName, reason: 'invalid_json' });
            continue;
        }

        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            unrecoverableMatches.push({ raw, name: toolName, reason: 'invalid_json' });
            continue;
        }

        recoveredCalls.push({
            id: `${idPrefix}-${seq++}`,
            type: 'function',
            function: {
                name: toolName,
                arguments: JSON.stringify(parsed),
            },
        });
    }

    if (removalRanges.length === 0) {
        return {
            hasAnyTextualToolCallSyntax: hasAnySyntax,
            recoveredCalls,
            unrecoverableMatches,
            cleanedContent: content,
        };
    }

    let cleaned = '';
    let cursor = 0;
    for (const r of removalRanges) {
        cleaned += content.slice(cursor, r.start);
        cursor = r.end;
    }
    cleaned += content.slice(cursor);
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

    return {
        hasAnyTextualToolCallSyntax: hasAnySyntax,
        recoveredCalls,
        unrecoverableMatches,
        cleanedContent: cleaned,
    };
}

/**
 * Strip any accidental `[Tool call: ...]` blocks and transient compat-fallback
 * status banners from replayed assistant turns so an existing chat thread never
 * few-shot-conditions subsequent steps into emitting plain-text tool calls.
 */
export function stripTextualToolCallsFromHistory(text: string): string {
    if (!text) return text;
    let out = text.replace(
        /(?:^|\n)> _\(\[Gemini native path unavailable — using compat fallback\]\(debug:gemini-native-fallback\)\)_[^\n]*(?:\n|$)/g,
        '\n'
    );
    if (out.includes('[Tool call:')) {
        out = extractTextualToolCalls(out, []).cleanedContent;
    }
    return out.trim();
}

/**
 * Non-imitable summary used when unsigned historical assistant `tool_calls`
 * must be represented in plain text (avoiding `[Tool call: fn({...})]` syntax
 * inside `assistant`/`model` turns so models never imitate text tool calls).
 */
export function formatDegradedHistoricalToolSummary(toolNames: readonly string[]): string {
    const names = toolNames.filter(Boolean);
    const label = names.length > 0 ? names.join(', ') : 'tool';
    return `(Earlier turn completed tool step: ${label}. Always invoke new tools via structured tool_calls, never as plain text.)`;
}
