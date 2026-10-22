/**
 * Memory-health notice classification.
 *
 * Pure and dependency-free: no `vscode` import, so plain Node can test it
 * (scripts/run-memory-notice-tests.js).
 *
 * The Hub reports distinct signals about memory health:
 *   memory_last_error     a real failure            -> warning
 *   state=incompatible    writes are paused         -> error (persistence is severed)
 *   memory_backup_skipped no rolling backup is kept -> informational, once per session
 *   memory_reason         a recovery/adoption note  -> informational if lossless, warning otherwise
 *   state=empty           a fresh install           -> silent
 *
 * Because the Hub exposes reason strings rather than an enum for lossless vs.
 * lossy recovery, recognized lossless recovery prefixes are classified as
 * informational while any unrecognized or lossy recovery reason warns.
 */

export type MemoryNoticeSeverity = 'silent' | 'info' | 'warning' | 'error';

export interface MemoryNotice {
    severity: MemoryNoticeSeverity;
    /** Stable identity used for once-per-session dedupe. null when silent. */
    key: string | null;
    /** Already-localized text, placeholders substituted. Empty when silent. */
    text: string;
}

type TextLookup = (key: string) => string;

const KEYS = {
    adopted: 'memory.adopted',
    stateNote: 'memory.stateNote',
    backupSkipped: 'memory.backupSkipped',
    healthAttention: 'memory.healthAttention',
    healthUnreadable: 'memory.healthUnreadable',
    unknownReason: 'memory.unknownReason',
} as const;

/**
 * Recognized Hub `memory_reason` prefixes that indicate a lossless recovery.
 * Any recovery reason not matching one of these prefixes is classified as a warning.
 */
export const LOSSLESS_REASON_PREFIXES: readonly string[] = [
    'pre-manifest snapshot adopted and checksummed',
    'snapshot adopted and checksummed (manifest was unreadable and rewritten)',
    'recovered the previous complete generation',
    'recovered generation',
    "committed a 'pending' save from an interrupted restart",
];

function isLosslessReason(text: string): boolean {
    return LOSSLESS_REASON_PREFIXES.some((prefix) => text.startsWith(prefix));
}

const SILENT: MemoryNotice = { severity: 'silent', key: null, text: '' };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Present = a non-empty trimmed string, a finite number, or boolean true. */
function present(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value);
    return true;
}

function stateOf(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function substitution(value: unknown): string | null {
    if (typeof value === 'string') {
        const t = value.trim();
        return t.length > 0 ? t : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
}

/** Never throw out of a localization lookup; never return a non-string. */
function safeText(text: TextLookup, key: string): string {
    try {
        const v = text(key);
        return typeof v === 'string' ? v : '';
    } catch {
        return '';
    }
}

/**
 * Localized text with placeholders filled.
 *
 * Two guarantees:
 *   1. A missing i18n key must NOT produce an empty message — that would be a silent
 *      failure of the notice itself. Fall back to the generic attention string.
 *   2. No raw `{token}` may ever reach a user. Any token we could not fill is replaced
 *      with the localized "unknown" wording.
 */
function composeText(
    text: TextLookup,
    key: string,
    health: Record<string, unknown> | null,
    detail?: string | null,
): string {
    const raw = safeText(text, key) || safeText(text, KEYS.healthAttention);
    const reason = substitution(detail) ?? (health ? substitution(health.memory_reason) : null);
    const generation = health ? substitution(health.memory_generation) : null;
    const entries = health ? substitution(health.memory_entries) : null;
    const unknown = safeText(text, KEYS.unknownReason) || 'unknown';

    const values: Record<string, string | null> = { reason, generation, entries };

    const filled = raw.replace(/\{(reason|generation|entries)\}/g, (match, name: string) => {
        const v = values[name];
        return v === null || v === undefined ? unknown : v;
    });

    return filled.trim().length > 0 ? filled : reason ?? '';
}

function notice(
    severity: Exclude<MemoryNoticeSeverity, 'silent'>,
    key: string,
    textKey: string,
    health: Record<string, unknown> | null,
    text: TextLookup,
    detail?: string | null,
): MemoryNotice {
    return { severity, key, text: composeText(text, textKey, health, detail) };
}

/**
 * The read itself failed, so there is no health payload to classify. Kept separate on
 * purpose: the reason here is a transport/HTTP detail, not `memory_reason`.
 */
export function memoryUnreadableNotice(text: TextLookup, detail: string): MemoryNotice {
    return notice('warning', 'healthUnreadable', KEYS.healthUnreadable, null, text, detail);
}

/**
 * A recovery/adoption reason: informational only when the Hub's sentence names a
 * repair where nothing was lost. Anything else is unverified, so it warns. See
 * LOSSLESS_REASON_PREFIXES for why the default is the loud one.
 */
function reasonNotice(
    health: Record<string, unknown>,
    text: TextLookup,
    textKey: string,
    key: string,
    detail: string | null,
): MemoryNotice {
    if (detail !== null && isLosslessReason(detail)) {
        return notice('info', key, textKey, health, text, detail);
    }
    // Preserve the Hub reason using the stateNote template ({reason} placeholder).
    return notice('warning', 'stateNote', KEYS.stateNote, health, text, detail);
}

/**
 * Pure classification of one health payload. No session state.
 *
 * Precedence rule: a real failure always outranks an informational condition, so a
 * benign notice can never displace a warning.
 */
export function classifyMemoryHealthNotice(
    health: Record<string, unknown>,
    text: TextLookup,
): MemoryNotice {
    if (!isRecord(health)) {
        return memoryUnreadableNotice(text, 'invalid health payload');
    }

    const state = stateOf(health.memory_state);
    const lastError = present(health.memory_last_error);
    const backupSkipped = present(health.memory_backup_skipped);
    const reason = present(health.memory_reason);

    // Read the specific field first, falling back to memory_reason if needed.
    const words = (field: string): string | null => substitution(health[field])
        ?? substitution(health.memory_reason);

    if (state === 'empty') return SILENT;

    if (state === 'loaded') {
        if (lastError) return notice('warning', 'lastError', KEYS.healthAttention, health, text, words('memory_last_error'));
        if (backupSkipped) return notice('info', 'backupSkipped', KEYS.backupSkipped, health, text, words('memory_backup_skipped'));
        if (reason) return reasonNotice(health, text, KEYS.stateNote, 'stateNote', words('memory_reason'));
        return SILENT;
    }

    if (state === 'adopted') {
        if (lastError) return notice('warning', 'lastError', KEYS.healthAttention, health, text, words('memory_last_error'));
        return reasonNotice(health, text, KEYS.adopted, 'adopted', words('memory_reason'));
    }

    if (state === 'incompatible') {
        if (lastError) return notice('error', 'lastError', KEYS.healthAttention, health, text, words('memory_last_error'));
        return notice('error', 'incompatible', KEYS.healthAttention, health, text, words('memory_reason'));
    }

    if (state === 'corrupt') {
        const detail = words('memory_last_error') ?? words('memory_reason');
        if (lastError) return notice('warning', 'lastError', KEYS.healthAttention, health, text, detail);
        return notice('warning', 'corrupt', KEYS.healthAttention, health, text, detail);
    }

    // Unknown state (a newer Hub): never silent, never fatal. Say so plainly.
    return notice('warning', 'healthUnreadable', KEYS.healthUnreadable, health, text);
}

/**
 * Once-per-session gate.
 *
 * Two independent slots, which is the whole point:
 *   - at most one notice of severity `warning` or `error` per session
 *   - at most one notice per informational `key` per session
 *
 * An informational notice therefore cannot consume the failure slot, and a failure
 * cannot be concealed by a receipt that arrived first.
 */
export class MemoryNoticeSession {
    private failureShown = false;
    private readonly infos = new Set<string>();

    /** Returns the notice to surface, or null when silent or already spoken. */
    consider(health: Record<string, unknown>, text: TextLookup): MemoryNotice | null {
        return this.gate(classifyMemoryHealthNotice(health, text));
    }

    /** Same gate, for a read that could not produce a payload at all. */
    considerUnreadable(text: TextLookup, detail: string): MemoryNotice | null {
        return this.gate(memoryUnreadableNotice(text, detail));
    }

    /**
     * Claim the failure slot for a message built outside the classifier — e.g. a
     * transport failure on the store path. One failure slot for ALL memory failures,
     * so a health warning and a store warning can never double-notify in one session.
     */
    considerFailureText(text: string): MemoryNotice | null {
        return this.gate({ severity: 'warning', key: 'storeFailure', text });
    }

    private gate(n: MemoryNotice): MemoryNotice | null {
        if (n.severity === 'silent') return null;

        if (n.severity === 'warning' || n.severity === 'error') {
            if (this.failureShown) return null;
            this.failureShown = true;
            return n;
        }

        if (n.key === null) return null;
        if (this.infos.has(n.key)) return null;
        this.infos.add(n.key);
        return n;
    }
}
