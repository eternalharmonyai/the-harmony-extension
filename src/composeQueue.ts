/**
 * In-memory queue that bridges the Harmony Compose webview and the chat
 * participant. The webview pushes a payload (text + attached images) and
 * triggers `workbench.action.chat.open`. The chat handler drains the
 * queue at the start of each turn and, if present, runs a vision
 * pre-step plus prepends compose context to the user's prompt.
 *
 * One pending payload at a time (last write wins). Cleared on consume.
 */

export interface ComposeImage {
    /** MIME type, e.g. 'image/png'. */
    mimeType: string;
    /** Base64-encoded image bytes (no data URL prefix). */
    base64: string;
    /** Original filename if known, else 'pasted-image.png'. */
    name: string;
}

export interface ComposePayload {
    /** Free-form note the user typed in the compose panel. */
    text: string;
    /** Workspace-relative paths the user attached as file references. */
    filePaths: string[];
    /** Images the user dropped/pasted. Routed via vision model on consume. */
    images: ComposeImage[];
    /** Timestamp the payload was queued (for staleness checks). */
    ts: number;
}

let pending: ComposePayload | null = null;

export function setComposePayload(p: ComposePayload): void {
    pending = p;
}

/** Returns and clears the pending payload, or null if none. */
export function consumeComposePayload(): ComposePayload | null {
    const p = pending;
    pending = null;
    return p;
}

export function peekComposePayload(): ComposePayload | null {
    return pending;
}
