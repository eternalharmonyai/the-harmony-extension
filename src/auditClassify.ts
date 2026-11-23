/**
 * auditClassify — the Triple-Check post-filter, as a pure, testable classifier.
 *
 * WHY THIS MODULE EXISTS
 * The previous filter was DESTRUCTIVE: it deleted every finding that did not match a
 * security regex, and reported the deletion only to `console.log`. That created a real
 * trade-off — tightening the regex bought quiet at the cost of silently losing recall —
 * and no human-readable surface could distinguish "nothing was found" from
 * "something was found and thrown away".
 *
 * This module removes the trade-off by CLASSIFYING instead of DELETING:
 *   - security findings drive the verdict
 *   - logic findings are kept, labelled, and stay retrievable
 *   - the only items removed are NEGATION-ANCHORED "no secrets found" echoes, and
 *     their count is reported so the removal is loud rather than silent
 *
 * A tighter security pattern can therefore only change RANK, never EXISTENCE.
 *
 * NEGATION DISCIPLINE (learned the hard way): an echo pattern that matches a bare
 * "secrets found" will delete "Secret found in config.ts" — a real positive, and the
 * single most dangerous deletion this module can perform. Every removal path must be
 * anchored on an explicit negation, and must re-check that no security signal survives
 * the negation clause being removed.
 *
 * It deliberately imports nothing — no `vscode`, no fs, no providers — so a gate can
 * require the compiled output directly and assert both directions.
 */

/** Mentions of "token" that carry no credential meaning. */
const BENIGN_TOKEN_PATTERN =
    /\bmax[_\s]?tokens?\b|cancel(?:lation)?[_\s]?token|token(?:s)?\s+(?:budget|count|limit|usage|estimat|cap)\w*|tokeniz\w*/gi;

/** Genuine credential / exposure / privacy language. */
export const SECURITY_FINDING_PATTERN =
    /secret|api[_\s-]?key|passw(?:or)?d|credential|private[_\s-]?key|access[_\s-]?token|auth[_\s-]?token|bearer\s+token|\.env\b|leak|expos(?:e|ed|ure)|pii|personal\s*(?:data|info)|hardcod\w*\s+(?:secret|key|token|password|credential)|token\s+(?:in|inside|embedded|committed|hardcod|leak|expos|stored|written|passed|sent)/i;

/**
 * The model restating that it found NO secrets. That is an echo, not a finding.
 *
 * EVERY alternative must be anchored on a negation word. An earlier version also
 * matched a bare `secrets?\s+found` / `secrets?\s+detected`, which made
 * "Secret found in config.ts" and "Hardcoded secret detected in handler" look like
 * echoes — so they were DELETED. That is negating the wrong direction, and it is
 * exactly the invisible recall loss this module exists to prevent.
 *
 * This pattern carries /g and is only ever passed to replace(). Do not call .test()
 * on it directly — use isSecretsEcho(), which is state-free.
 */
export const NO_SECRETS_PATTERN =
    /\b(?:no|zero|none|nothing|not|never|without|isn'?t|aren'?t|didn'?t)\b[^.;\n]{0,40}?\bsecrets?\b(?:\s+(?:or|and)\s+(?:\w+\s+){0,3}terms?)?(?:\s+(?:were|was|is|are)\b)?(?:\s+(?:found|detected|present|identified|discovered|observed))?/gi;

/** Never let the wording imply a scanner was run. */
export const AUDIT_SURFACE_LABEL = 'model review, not a scan';

/** Genuine credential/exposure language, with benign "token" mentions removed first. */
function hasSecuritySignal(text: string): boolean {
    return SECURITY_FINDING_PATTERN.test(String(text ?? '').replace(BENIGN_TOKEN_PATTERN, ' '));
}

/**
 * True when the text is the model echoing "no secrets found" rather than reporting one.
 *
 * Two conditions, both required:
 *   1. a negation clause naming secrets is present, and
 *   2. removing that clause leaves NO security signal behind.
 *
 * Condition 2 is what keeps "No secrets found, but a hardcoded API key exists in
 * config.ts" a finding instead of an echo. Without it, a negation anywhere in the
 * sentence would erase a real positive — the very bug this rewrite fixes.
 */
export function isSecretsEcho(text: string): boolean {
    const value = String(text ?? '');
    if (!value.trim()) return false;
    const stripped = value.replace(NO_SECRETS_PATTERN, ' ');
    if (stripped === value) return false;
    return !hasSecuritySignal(stripped);
}

/**
 * True when the text describes a genuine credential, exposure, or privacy concern.
 *
 * A bare "token" or "hardcod" is NOT enough: maxTokens, CancellationToken and
 * "token budget" all contain "token", and every module in this repo contains a
 * hardcoded constant. Benign mentions are stripped before the security test, so a
 * logic nit cannot walk through the door wearing the word "token".
 */
export function isSecurityFinding(text: string): boolean {
    const value = String(text ?? '');
    if (!value.trim()) return false;
    if (isSecretsEcho(value)) return false;
    return hasSecuritySignal(value);
}

export interface AuditClassification {
    /** Security findings first, then logic findings. Nothing else is removed. */
    findings: string[];
    /** Security findings the model marked urgent. This is what drives the verdict. */
    urgentIssues: string[];
    /** Kept so a reader can see exactly what was downgraded, and that it still exists. */
    logicFindings: string[];
    /**
     * `dropped` counts ONLY "no secrets found" echoes. Anything else dropped in
     * future must be added here too, and surfaced — never logged and forgotten.
     */
    counts: { security: number; logic: number; dropped: number };
}

/**
 * Classify raw model findings without losing any of them.
 *
 * Order is preserved within each class, duplicates across the two input lists are
 * collapsed, and security findings are placed first so the most actionable item is
 * always the one a caller surfaces first.
 */
export function classifyAuditFindings(rawFindings: unknown, rawUrgent: unknown): AuditClassification {
    const findingsIn = Array.isArray(rawFindings)
        ? rawFindings.map((f) => String(f)).filter((f) => f.trim().length > 0)
        : [];
    const urgentIn = Array.isArray(rawUrgent)
        ? rawUrgent.map((f) => String(f)).filter((f) => f.trim().length > 0)
        : [];

    const seen = new Set<string>();
    const unique: string[] = [];
    for (const raw of [...urgentIn, ...findingsIn]) {
        const key = raw.trim();
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(key);
    }

    const echoes = unique.filter(isSecretsEcho);
    const candidates = unique.filter((f) => !isSecretsEcho(f));
    const security = candidates.filter(isSecurityFinding);
    const logic = candidates.filter((f) => !isSecurityFinding(f));

    return {
        findings: [...security, ...logic],
        urgentIssues: urgentIn.filter(isSecurityFinding),
        logicFindings: logic,
        counts: { security: security.length, logic: logic.length, dropped: echoes.length },
    };
}
