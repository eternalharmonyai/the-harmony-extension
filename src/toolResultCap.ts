import * as vscode from 'vscode';

/**
 * Single source of truth for the tool-result length cap.
 *
 * Reads `harmony.toolResultMaxChars` fresh on every call so that changes made
 * in Settings or the Harmony sidebar apply mid-session, and falls back to the
 * shipped default only when the configured value is missing or invalid.
 *
 * When `harmony.toolResultAutoCap` is ON (default), the effective cap is also
 * clamped so a single tool result never exceeds ~40% of the active model's
 * context window (converted conservatively at ~4 chars/token). The live model
 * context is supplied by the chat participant at the start of each turn via
 * setActiveModelMaxInputTokens() — read from reality, never from a table, so it
 * can never go stale.
 */
export const DEFAULT_TOOL_RESULT_CHARS = 160000;

const AUTO_CAP_FRACTION = 0.4;
const CHARS_PER_TOKEN = 4;
const MIN_EFFECTIVE_CHARS = 1000;

let activeModelMaxInputTokens: number | undefined;

/** Called by the chat participant at the start of each turn with the live model's input-token limit. */
export function setActiveModelMaxInputTokens(maxInputTokens: number | undefined): void {
    activeModelMaxInputTokens = maxInputTokens;
}

/** The user's configured cap, without the model-aware clamp. */
export function toolResultMaxChars(): number {
    const n = Number(
        vscode.workspace
            .getConfiguration('harmony')
            .get<number>('toolResultMaxChars', DEFAULT_TOOL_RESULT_CHARS)
    );
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TOOL_RESULT_CHARS;
}

/** The user cap, optionally clamped by the active model's context window. */
export function effectiveToolResultMaxChars(): number {
    const userCap = toolResultMaxChars();
    const autoCapOn = vscode.workspace.getConfiguration('harmony').get<boolean>('toolResultAutoCap', true);
    if (!autoCapOn || !activeModelMaxInputTokens || activeModelMaxInputTokens <= 0) {
        return userCap;
    }
    const safeChars = Math.floor(activeModelMaxInputTokens * CHARS_PER_TOKEN * AUTO_CAP_FRACTION);
    return Math.max(MIN_EFFECTIVE_CHARS, Math.min(userCap, safeChars));
}

export function clipResult(s: string): string {
    const max = effectiveToolResultMaxChars();
    if (s.length <= max) return s;
    return s.slice(0, max) + `\n...[truncated, ${s.length - max} more chars]`;
}
