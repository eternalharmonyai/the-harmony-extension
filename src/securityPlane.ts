/**
 * Decision-grade separation-of-duties signal detection.
 *
 * This module exists because a single over-broad regular expression was being used as a
 * *verdict*: any sentence containing "replace", "remove", "drop" or "scrap" produced a
 * critical "SEPARATION-OF-DUTIES VIOLATION (NIST SP 800-53 AC-5)" finding. Measured against
 * nine ordinary business proposals it fired on eight of them. A governance tool that cries
 * critical on benign language trains its readers to ignore it, which is worse than silence.
 *
 * The replacement is deliberately NOT a cleverer regex. It separates the two things a regex
 * was conflating — *who is acting* and *what is acted upon* — and then asks whether they are
 * actually linked:
 *
 *   1. Locate removal / consolidation verbs on their own.
 *   2. Locate security-plane vocabulary on its own, graded strong vs. weak.
 *   3. Link a verb to a term only when they sit in the SAME SENTENCE and within a bounded
 *      character distance. A verb alone is never evidence.
 *   4. Suppress the whole finding when a negation or non-commitment cue precedes the verb
 *      ("we will not replace CrowdStrike", "if we were to eliminate the SIEM").
 *   5. Score the evidence and return the reasons that produced the score, so a human can
 *      audit the conclusion instead of trusting a boolean.
 *
 * The result is a confidence level, not a verdict: `confirmed` may be reported as a violation,
 * `likely` must be reported as needing verification, and `none` must stay silent.
 *
 * Domain-agnostic by construction: the vocabulary is security-infrastructure vocabulary, not
 * business-vertical vocabulary, and any workspace can extend it via `security_plane_terms`.
 */

export type SecurityTermStrength = 'strong' | 'weak';

export interface SecurityTermSpec {
    /** Plain-language term; whitespace also matches a hyphen ("incident-response"). */
    pattern: string;
    /**
     * `strong` terms are unambiguous security-infrastructure vocabulary.
     * `weak` terms are ordinary words ("endpoint", "security", "monitoring") that are real
     * words in unrelated contexts, so on their own they can never confirm a violation.
     */
    strength: SecurityTermStrength;
}

/**
 * Generic security-infrastructure vocabulary.
 *
 * Note the deliberate absence of bare "soc" (system-on-chip is the ordinary reading in
 * silicon proposals) and bare "defender" (a public defender is a lawyer).
 */
export const SECURITY_PLANE_TERMS: SecurityTermSpec[] = [
    { pattern: 'soc 2', strength: 'strong' },
    { pattern: 'soc2', strength: 'strong' },
    { pattern: 'siem', strength: 'strong' },
    { pattern: 'soar', strength: 'strong' },
    { pattern: 'edr', strength: 'strong' },
    { pattern: 'mdr', strength: 'strong' },
    { pattern: 'xdr', strength: 'strong' },
    { pattern: 'antivirus', strength: 'strong' },
    { pattern: 'firewall', strength: 'strong' },
    { pattern: 'incident response', strength: 'strong' },
    { pattern: 'cybersecurity', strength: 'strong' },
    { pattern: 'cyber security', strength: 'strong' },
    { pattern: 'infosec', strength: 'strong' },
    { pattern: 'security operations', strength: 'strong' },
    { pattern: 'security operations center', strength: 'strong' },
    { pattern: 'secops', strength: 'strong' },
    { pattern: 'endpoint protection', strength: 'strong' },
    { pattern: 'endpoint detection', strength: 'strong' },
    { pattern: 'endpoint security', strength: 'strong' },
    { pattern: 'endpoint defense', strength: 'strong' },
    { pattern: 'security monitoring', strength: 'strong' },
    { pattern: 'security plane', strength: 'strong' },
    { pattern: 'security stack', strength: 'strong' },
    { pattern: 'security tooling', strength: 'strong' },
    { pattern: 'security controls', strength: 'strong' },
    { pattern: 'threat detection', strength: 'strong' },
    { pattern: 'vulnerability scanning', strength: 'strong' },
    { pattern: 'endpoint', strength: 'weak' },
    { pattern: 'monitoring', strength: 'weak' },
    { pattern: 'observability', strength: 'weak' },
    { pattern: 'security', strength: 'weak' },
];

/**
 * Named security platforms. These are strong because a proposal that names an incumbent
 * security vendor and a removal verb is usually talking about exactly one thing.
 */
export const SECURITY_PLATFORM_NAMES: string[] = [
    'crowdstrike', 'huntress', 'sentinelone', 'sophos', 'carbon black', 'cylance',
    'cortex xdr', 'microsoft defender', 'windows defender', 'defender for endpoint',
    'falcon', 'splunk', 'wazuh', 'rapid7', 'tenable', 'qualys', 'darktrace',
    'fortinet', 'palo alto', 'okta', 'auth0', 'jumpcloud',
];

export interface RemovalVerbSpec {
    /** Plain-language verb; inflections (s/es/ed/d/ing) are matched. */
    pattern: string;
    /** True when the verb removes outright; false when it consolidates, merges or transfers. */
    explicit: boolean;
}

export const PLANE_REMOVAL_VERBS: RemovalVerbSpec[] = [
    { pattern: 'scrap', explicit: true },
    { pattern: 'replace', explicit: true },
    { pattern: 'remove', explicit: true },
    { pattern: 'eliminate', explicit: true },
    { pattern: 'cancel', explicit: true },
    { pattern: 'terminate', explicit: true },
    { pattern: 'decommission', explicit: true },
    { pattern: 'retire', explicit: true },
    { pattern: 'sunset', explicit: true },
    { pattern: 'halt', explicit: true },
    { pattern: 'rip out', explicit: true },
    { pattern: 'switch off', explicit: true },
    { pattern: 'stop paying', explicit: true },
    { pattern: 'let lapse', explicit: true },
    { pattern: 'drop', explicit: false },
    { pattern: 'merge', explicit: false },
    { pattern: 'consolidate', explicit: false },
    { pattern: 'fold', explicit: false },
    { pattern: 'absorb', explicit: false },
    { pattern: 'offload', explicit: false },
    { pattern: 'subsume', explicit: false },
    { pattern: 'outsource', explicit: false },
    { pattern: 'lapse', explicit: false },
    { pattern: 'hand off', explicit: false },
    { pattern: 'hand over', explicit: false },
    { pattern: 'take over', explicit: false },
    { pattern: 'took over', explicit: false },
];

/**
 * Phrases where an otherwise-security word means something unrelated. Scored as strong
 * vocabulary but removed from the text before matching, so "security deposit" and
 * "public defender" never read as a security plane.
 */
export const AMBIGUOUS_SECURITY_PHRASES: string[] = [
    'social security', 'security deposit', 'security deposits', 'security interest',
    'security clearance', 'security badge', 'security guard', 'security personnel',
    'public defender', 'system-on-chip', 'system on chip',
];

/** Cues meaning the nearby verb is negated, conditional, or merely under consideration. */
const SUPPRESSION_CUE_PATTERN = new RegExp(
    '\\b(?:' + [
        'not',
        'never',
        'no\\s+longer',
        'without',
        'avoid',
        'refus\\w*',
        'declin\\w*',
        'unless',
        'hypothetical',
        'would\\s+consider',
        'evaluating\\s+whether',
        'considering\\s+whether',
        "won't",
        'cannot',
        "can't",
        "isn'?t",
        "aren'?t",
        'rather\\s+than',
        'were\\s+to',
    ].join('|') + ')\\b',
    'i'
);

/** Maximum character distance between a removal verb and a security term to count as linked. */
const PLANE_PROXIMITY_CHARS = 160;

/** How far before the verb to look for a negation or non-commitment cue. */
const SUPPRESSION_LOOKBEHIND_CHARS = 60;

export interface SecurityPlaneSignal {
    /** `confirmed` may be reported as a violation; `likely` must be reported as needing verification. */
    level: 'confirmed' | 'likely' | 'none';
    /** 0-100 evidence score. Only meaningful when level is not `none`. */
    score: number;
    /** Human-readable reasons, in the order they contributed. */
    reasons: string[];
    /** True when a negation or non-commitment cue suppressed an otherwise plausible signal. */
    negated: boolean;
}

interface TextHit {
    start: number;
    end: number;
    label: string;
}

interface VerbHit extends TextHit {
    explicit: boolean;
}

interface TermHit extends TextHit {
    term: string;
    strength: SecurityTermStrength;
}

/**
 * Turns a plain-language term into a safe regex fragment.
 *
 * Metacharacters are escaped, so a workspace-supplied term like "SOC 2 (Type II)" or even "["
 * can never throw or inject an alternation into the pattern. Whitespace matches a space or a
 * hyphen, so "incident response" also catches "incident-response".
 */
function escapeTermPart(part: string): string {
    return part.replace(/[.*+?^${}()|[\]\\]/g, (ch) => '\\' + ch);
}

export function securityTermToPattern(term: string): string {
    return term
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(escapeTermPart)
        .join('[\\s-]+');
}

/**
 * Expands one verb word into its common inflections so "handed off" and "scrapped" match
 * while "replacement" still does not. Every form is escaped, so no pattern can be injected.
 */
function inflectWord(word: string): string {
    const forms = new Set<string>([word]);
    if (word.endsWith('e')) {
        forms.add(word.slice(0, -1) + 'ing');
        forms.add(word + 'd');
        forms.add(word + 's');
    } else if (/(?:s|x|z|ch|sh)$/.test(word)) {
        forms.add(word + 'es');
        forms.add(word + 'ed');
        forms.add(word + 'ing');
    } else if (/[^aeiou]y$/.test(word)) {
        forms.add(word.slice(0, -1) + 'ies');
        forms.add(word.slice(0, -1) + 'ied');
        forms.add(word + 'ing');
    } else {
        forms.add(word + 's');
        forms.add(word + 'ed');
        forms.add(word + 'ing');
        if (/[^aeiou][aeiou][^aeiouwxy]$/.test(word)) {
            forms.add(word + word.slice(-1) + 'ed');
            forms.add(word + word.slice(-1) + 'ing');
        }
    }
    return '(?:' + Array.from(forms).map(escapeTermPart).join('|') + ')';
}

/**
 * Builds a verb pattern with inflection only on the leading word, so multi-word verbs still
 * match their natural past tense ("handed off", "handing over") without over-matching.
 */
function verbToPattern(verb: string): string {
    const words = verb.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '';
    return [inflectWord(words[0]), ...words.slice(1).map(escapeTermPart)].join('[\\s-]+');
}

function findHits(pattern: string, text: string): TextHit[] {
    const hits: TextHit[] = [];
    const re = new RegExp(pattern, 'gi');
    let match: RegExpExecArray | null = re.exec(text);
    while (match !== null) {
        hits.push({ start: match.index, end: match.index + match[0].length, label: match[0].toLowerCase() });
        if (match.index === re.lastIndex) re.lastIndex++;
        match = re.exec(text);
    }
    return hits;
}

function hasSuppressionCue(text: string, verbStart: number): boolean {
    const window = text.slice(Math.max(0, verbStart - SUPPRESSION_LOOKBEHIND_CHARS), verbStart);
    return SUPPRESSION_CUE_PATTERN.test(window);
}

/**
 * Analyse a proposal summary for evidence that the independent security plane is being
 * removed, replaced or consolidated into an application/workflow vendor.
 *
 * Returns a graded signal with its reasons attached. Never throws: a malformed
 * workspace-supplied term is escaped, not executed.
 */
export function analyzeSecurityPlaneMerge(text: string, extraTerms: string[] = []): SecurityPlaneSignal {
    const scrubbed = AMBIGUOUS_SECURITY_PHRASES.reduce(
        (acc, phrase) => acc.split(phrase).join(' '),
        text.toLowerCase()
    );

    // 1. Removal / consolidation verbs, found independently of any object.
    const verbHits: VerbHit[] = [];
    for (const spec of PLANE_REMOVAL_VERBS) {
        const verbPattern = verbToPattern(spec.pattern);
        if (!verbPattern) continue;
        for (const hit of findHits(`\\b${verbPattern}\\b`, scrubbed)) {
            verbHits.push({ ...hit, explicit: spec.explicit });
        }
    }
    if (verbHits.length === 0) {
        return {
            level: 'none',
            score: 0,
            reasons: ['No removal or consolidation verb was present.'],
            negated: false,
        };
    }

    // 2. Security-plane vocabulary. Workspace-supplied terms are always treated as strong.
    const termHits: TermHit[] = [];
    const pushTerm = (raw: string, strength: SecurityTermStrength) => {
        const pattern = securityTermToPattern(raw);
        if (!pattern) return;
        for (const hit of findHits(`(?:${pattern})[\\w-]*`, scrubbed)) {
            termHits.push({ ...hit, term: raw, strength });
        }
    };
    for (const spec of SECURITY_PLANE_TERMS) pushTerm(spec.pattern, spec.strength);
    for (const name of SECURITY_PLATFORM_NAMES) pushTerm(name, 'strong');
    for (const extra of extraTerms.filter(Boolean)) pushTerm(extra, 'strong');

    // 3. Link a verb to a term only inside one sentence and within the proximity budget.
    //    A verb and a term that never co-occur in a clause are not evidence of anything.
    interface PlanePair { verb: VerbHit; term: TermHit }
    const pairs: PlanePair[] = [];
    for (const verb of verbHits) {
        for (const term of termHits) {
            const lo = Math.min(verb.start, term.start);
            const hi = Math.max(verb.end, term.end);
            if (hi - lo > PLANE_PROXIMITY_CHARS) continue;
            if (/[.!?]/.test(scrubbed.slice(lo, hi))) continue;
            pairs.push({ verb, term });
        }
    }
    if (pairs.length === 0) {
        return {
            level: 'none',
            score: 0,
            reasons: ['Removal language and security-plane vocabulary never appeared in the same clause, so no link was established.'],
            negated: false,
        };
    }

    // 4. Negation and non-commitment. If every plausible link is negated, the proposal is a
    //    non-action and must not produce a finding.
    const everyLinkNegated = pairs.every(pair => hasSuppressionCue(scrubbed, pair.verb.start));
    if (everyLinkNegated) {
        return {
            level: 'none',
            score: 0,
            reasons: ['A negation or non-commitment cue precedes the removal verb, so the proposal reads as a non-action rather than a removal.'],
            negated: true,
        };
    }
    const livePairs = pairs.filter(pair => !hasSuppressionCue(scrubbed, pair.verb.start));

    // 5. Score on evidence strength, never on verbosity or word order.
    const strongPairs = livePairs.filter(pair => pair.term.strength === 'strong');
    const weakPairs = livePairs.filter(pair => pair.term.strength === 'weak');
    const activePairs = strongPairs.length > 0 ? strongPairs : weakPairs;
    const verbsMatched = Array.from(new Set(activePairs.map(pair => pair.verb.label)));
    const termsMatched = Array.from(new Set(activePairs.map(pair => pair.term.term)));

    let score = strongPairs.length > 0 ? 70 : 40;
    const explicitVerb = activePairs.some(pair => pair.verb.explicit);
    if (explicitVerb) score += 15;
    if (termsMatched.length >= 2) score += 10;
    if (strongPairs.length > 0 && weakPairs.length > 0) score += 5;
    score = Math.min(100, score);

    const reasons = [
        `Removal verb(s): ${verbsMatched.join(', ')}.`,
        `Security-plane term(s): ${termsMatched.join(', ')}.`,
    ];
    if (!explicitVerb) {
        reasons.push('The verb consolidates or transfers rather than removes outright, which is a softer signal.');
    }
    if (strongPairs.length === 0) {
        reasons.push('Only ambiguous vocabulary matched, so a human must verify intent before this is treated as a violation.');
    }
    if (strongPairs.length > 0 && weakPairs.length > 0) {
        reasons.push('Unambiguous and ambiguous vocabulary both matched, which raises confidence.');
    }

    return {
        level: score >= 70 ? 'confirmed' : 'likely',
        score,
        reasons,
        negated: false,
    };
}

/** Convenience wrapper for callers that only need the confirmed-violation boolean. */
export function mentionsSecurityPlaneMerge(text: string, extraTerms: string[] = []): boolean {
    return analyzeSecurityPlaneMerge(text, extraTerms).level === 'confirmed';
}
