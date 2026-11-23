/**
 * auditToast - the Triple-Check notification surface as a pure, testable formatter.
 *
 * Why this module exists
 * ----------------------
 * Rule #6 says a guard that fires must be able to say so, on a surface a human
 * actually reads. For the auto Triple-Check the human surface is the notification
 * text. That text used to be built inline in chatParticipant.ts, which meant:
 *
 *   - check:audit-scope could prove the classifier picked the right paths (18/18)
 *   - and still pass if `${scopeSuffix}` were deleted from the message
 *
 * A narrowed audit would then be indistinguishable from a clean one, with a fully
 * green build. Extracting the string here lets check:audit-toast call the real
 * formatter and assert the RENDERED text instead of the shape of the source.
 *
 * What this module deliberately does NOT do
 * -----------------------------------------
 * It cannot prove the host rendered the notification. `showInformationMessage` is
 * host UI. The claim this module supports is exactly: "the string and action list
 * we hand the host are correct, and a narrowed audit never reads as a clean one."
 */

/** What the audit pipeline returns, narrowed to the fields the toast renders. */
export interface TripleCheckAuditInput {
    verdict?: string;
    summary?: unknown;
    urgentIssues?: readonly unknown[];
    findings?: readonly unknown[];
}

export interface TripleCheckToastInput extends TripleCheckAuditInput {
    /**
     * Output of formatScopeNote() from src/auditScope.ts.
     * Empty / undefined means nothing was filtered, so no suffix is rendered.
     */
    scopeNote?: string | null;
}

export interface TripleCheckDetailsInput extends TripleCheckAuditInput {
    scopeNote?: string | null;
    /** Count of write-capable paths - used only for the clean-scope fallback line. */
    pathCount?: number;
}

export interface TripleCheckToast {
    /** The notification text handed to vscode.window.showInformationMessage. */
    message: string;
    /** Action buttons, in render order. */
    actions: string[];
    /** Every finding, normalised - urgent first, then normal. Never truncated. */
    findings: string[];
    /** The inline preview (may be shorter than findings[0]). */
    firstFinding?: string;
}

/** How much of the first finding is shown inline before "Show Details" takes over. */
export const FIRST_FINDING_PREVIEW_CHARS = 140;

const asText = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

/**
 * Flatten urgent + normal findings and collapse whitespace.
 *
 * Both lists are kept: a verdict that names findings but only shows the urgent
 * ones is a partial silent discard. Empty entries are dropped, but the COUNT that
 * survives is always reported by the caller, so nothing disappears unaccounted.
 */
export function normalizeFindings(
    urgentIssues?: readonly unknown[],
    findings?: readonly unknown[]
): string[] {
    const merged = [
        ...(Array.isArray(urgentIssues) ? urgentIssues : []),
        ...(Array.isArray(findings) ? findings : []),
    ];
    return merged
        .map((f) => asText(f).replace(/\s+/g, ' ').trim())
        .filter(Boolean);
}

/** Verdict to glyph. Unknown verdicts degrade to the caution glyph, never to GO. */
export function verdictIcon(verdict?: string): string {
    if (verdict === 'GO') return '\u2705';
    if (verdict === 'NO-GO') return '\u{1F6A8}';
    return '\u26A0\uFE0F';
}

/**
 * Action buttons.
 *
 * 'Show Details' must be reachable on a GO verdict too: a quiet verdict still
 * keeps its logic notes, and a button that disappears exactly when there is
 * something to read is a silent discard.
 */
export function tripleCheckActions(verdict?: string, findingCount = 0): string[] {
    const actions: string[] = [];
    if (verdict !== 'GO') actions.push('Run Full Audit');
    if (findingCount > 0) actions.push('Show Details');
    actions.push('Dismiss');
    return actions;
}

/**
 * Build the notification text and action list.
 *
 * Invariant this function guarantees:
 *   formatTripleCheckToast({ ..., scopeNote: 'X' }).message
 *     !== formatTripleCheckToast({ ..., scopeNote: '' }).message
 * for the same audit result. A narrowed audit can never read as a clean one.
 */
export function formatTripleCheckToast(input: TripleCheckToastInput): TripleCheckToast {
    const findings = normalizeFindings(input.urgentIssues, input.findings);
    const icon = verdictIcon(input.verdict);
    const summary = asText(input.summary);

    const note = asText(input.scopeNote).trim();
    const scopeSuffix = note ? ` [${note}]` : '';

    const firstFinding = findings.length ? findings[0].slice(0, FIRST_FINDING_PREVIEW_CHARS) : undefined;
    const remainder = findings.length > 1 ? ` (+${findings.length - 1} more \u2014 Show Details)` : '';
    const findingSuffix = firstFinding ? ` \u2014 ${firstFinding}${remainder}` : '';

    return {
        message: `${icon} Triple-Check: ${summary}${scopeSuffix}${findingSuffix}`,
        actions: tripleCheckActions(input.verdict, findings.length),
        findings,
        firstFinding,
    };
}

/**
 * Build the Output-channel lines behind 'Show Details'.
 *
 * The scope line is the reason this exists: when nothing was filtered the line
 * still names the count, so "clean" is an affirmative statement rather than the
 * absence of a note.
 */
export function formatTripleCheckDetails(input: TripleCheckDetailsInput): string[] {
    const findings = normalizeFindings(input.urgentIssues, input.findings);
    const lines: string[] = [
        `[TripleCheck] verdict=${asText(input.verdict)} | ${asText(input.summary)}`,
    ];

    const note = asText(input.scopeNote).trim();
    const pathCount = Number.isFinite(input.pathCount) ? Number(input.pathCount) : 0;
    lines.push(`  scope: ${note || `all ${pathCount} path(s) are write-capable tool references`}`);

    findings.forEach((f, i) => lines.push(`  ${i + 1}. ${f}`));
    return lines;
}
