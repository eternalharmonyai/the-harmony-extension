#!/usr/bin/env node
/**
 * Gate: Collaborator review protocol.
 *
 * Proves the parts that matter most: that one evidenced dissent is never outvoted, that
 * an absence of reviews fails closed, that correlated reviewers are reported as a single
 * opinion, and that a verdict flip without new evidence is flagged as capitulation.
 *
 * Run: npm run check:collaborator-review
 */
'use strict';

const path = require('path');
const mod = require(path.join(__dirname, '..', 'out', 'collaboratorReview.js'));

const {
    WORKER_CONCURRENCY_CAP,
    REVIEWER_COUNT,
    REVIEW_LENSES,
    assignReviewers,
    isWellFormedReview,
    assessIndependence,
    aggregateReviews,
    detectCapitulation,
    describeAggregate,
} = mod;

let pass = 0;
const failures = [];
function check(name, condition, detail) {
    if (condition) pass++;
    else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const review = (over = {}) => ({
    reviewerId: 'r1',
    role: 'critic',
    provider: 'deepseek',
    verdict: 'pass',
    evidence: ['checked the diff'],
    confidence: 70,
    wouldChangeMind: 'a failing test',
    ...over,
});

// ── 1. Ratified capacity shape ────────────────────────────────────────────
check('worker cap is 5 as ratified', WORKER_CONCURRENCY_CAP === 5, String(WORKER_CONCURRENCY_CAP));
check('reviewer count is 2 as ratified', REVIEWER_COUNT === 2, String(REVIEWER_COUNT));
check('review lenses are ordered critic-first', REVIEW_LENSES[0] === 'critic' && REVIEW_LENSES[1] === 'verifier');

// ── 2. Reviewer lens assignment must be genuinely distinct ───────────────
const two = assignReviewers(2);
check('two reviewers assigned', two.length === 2);
check('two reviewers get different lenses', new Set(two).size === 2, JSON.stringify(two));
check('two reviewers are critic + verifier', two[0] === 'critic' && two[1] === 'verifier', JSON.stringify(two));
const one = assignReviewers(1);
check('one reviewer gets critic', one.length === 1 && one[0] === 'critic');
const three = assignReviewers(3);
check('three reviewers get three distinct lenses', new Set(three).size === 3, JSON.stringify(three));
check('zero reviewers yields empty', assignReviewers(0).length === 0);
check('negative count yields empty', assignReviewers(-3).length === 0);
check('fractional count floors', assignReviewers(2.9).length === 2);
check('default count uses REVIEWER_COUNT', assignReviewers().length === REVIEWER_COUNT);

// ── 3. Well-formedness requires evidence disclosure ──────────────────────
check('a complete review is well formed', isWellFormedReview(review()));
check('missing wouldChangeMind is malformed', !isWellFormedReview(review({ wouldChangeMind: '' })));
check('whitespace wouldChangeMind is malformed', !isWellFormedReview(review({ wouldChangeMind: '   ' })));
check('missing evidence array is malformed', !isWellFormedReview(review({ evidence: 'nope' })));
check('empty reviewerId is malformed', !isWellFormedReview(review({ reviewerId: '' })));
check('bad verdict is malformed', !isWellFormedReview(review({ verdict: 'maybe' })));
check('confidence above 100 is malformed', !isWellFormedReview(review({ confidence: 101 })));
check('negative confidence is malformed', !isWellFormedReview(review({ confidence: -1 })));
check('NaN confidence is malformed', !isWellFormedReview(review({ confidence: NaN })));
check('null review is malformed', !isWellFormedReview(null));
check('empty evidence list is still well formed', isWellFormedReview(review({ evidence: [] })));

// ── 4. Independence: different lenses, different providers ───────────────
const indep = assessIndependence([
    review({ reviewerId: 'a', role: 'critic', provider: 'deepseek' }),
    review({ reviewerId: 'b', role: 'verifier', provider: 'gemini' }),
]);
check('different lenses + providers is independent', indep.independent === true, JSON.stringify(indep.issues));

const sameRole = assessIndependence([
    review({ reviewerId: 'a', role: 'critic', provider: 'deepseek' }),
    review({ reviewerId: 'b', role: 'critic', provider: 'gemini' }),
]);
check('same lens is not independent', sameRole.independent === false);
check('same-lens issue names the lens problem', sameRole.issues.some((i) => i.includes('same lens')), JSON.stringify(sameRole.issues));

const sameProvider = assessIndependence([
    review({ reviewerId: 'a', role: 'critic', provider: 'deepseek' }),
    review({ reviewerId: 'b', role: 'verifier', provider: 'deepseek' }),
]);
check('same provider is not independent', sameProvider.independent === false);
check('same-provider issue names the provider', sameProvider.issues.some((i) => i.includes('deepseek')), JSON.stringify(sameProvider.issues));

const single = assessIndependence([review()]);
check('a single reviewer is not independent', single.independent === false);
check('single reviewer explains why', single.issues.length > 0);

const both = assessIndependence([
    review({ reviewerId: 'a', role: 'critic', provider: 'deepseek' }),
    review({ reviewerId: 'b', role: 'critic', provider: 'deepseek' }),
]);
check('identical reviewers raise both issues', both.issues.length >= 2, JSON.stringify(both.issues));

// ── 5. THE critical rule: a dissent is never outvoted ───────────────────
const outvoted = aggregateReviews([
    review({ reviewerId: 'a', role: 'critic', provider: 'deepseek', verdict: 'pass' }),
    review({ reviewerId: 'b', role: 'verifier', provider: 'gemini', verdict: 'pass' }),
    review({ reviewerId: 'c', role: 'researcher', provider: 'claude', verdict: 'block', evidence: ['breaks retry on 5xx'] }),
]);
check('2 pass vs 1 evidenced block escalates', outvoted.outcome === 'escalate', outvoted.outcome);
check('the dissent is preserved', outvoted.dissent.length === 1);
check('the dissent keeps its evidence', outvoted.dissent[0].evidence[0] === 'breaks retry on 5xx');
check('reason states it was not outvoted', /not outvoted/i.test(outvoted.reason), outvoted.reason);
check('reason quotes the evidence', outvoted.reason.includes('breaks retry on 5xx'));

// ── 6. Failing closed ────────────────────────────────────────────────────
const none = aggregateReviews([]);
check('no reviews is insufficient, never pass', none.outcome === 'insufficient', none.outcome);
check('no reviews explains failing closed', /fail/i.test(none.reason) || /not a pass/i.test(none.reason), none.reason);

const allMalformed = aggregateReviews([review({ wouldChangeMind: '' }), review({ verdict: 'maybe' })]);
check('all-malformed is insufficient', allMalformed.outcome === 'insufficient', allMalformed.outcome);
check('all-malformed counts them', allMalformed.malformed.length === 2, String(allMalformed.malformed.length));

const mixedMalformed = aggregateReviews([
    review({ reviewerId: 'a', verdict: 'pass' }),
    review({ reviewerId: 'b', wouldChangeMind: '' }),
    review({ reviewerId: 'c', role: 'verifier', provider: 'gemini', verdict: 'pass' }),
]);
check('malformed reviews are excluded but reported', mixedMalformed.malformed.length === 1, String(mixedMalformed.malformed.length));
check('usable reviews still decide', mixedMalformed.outcome === 'pass', mixedMalformed.outcome);

// ── 7. Unevidenced blocks escalate but are labelled ─────────────────────
const unevidenced = aggregateReviews([
    review({ reviewerId: 'a', role: 'critic', provider: 'deepseek', verdict: 'block', evidence: [] }),
    review({ reviewerId: 'b', role: 'verifier', provider: 'gemini', verdict: 'pass' }),
]);
check('unevidenced block still escalates', unevidenced.outcome === 'escalate', unevidenced.outcome);
check('unevidenced block is flagged, not treated as a finding', unevidenced.dissent.length === 0);
check('unevidenced block is preserved in its own bucket', unevidenced.unverifiedBlocks.length === 1);
check('reason says it arrived without evidence', /without evidence/i.test(unevidenced.reason), unevidenced.reason);
check('the unevidenced reviewer is named', unevidenced.reason.includes('a (critic)'), unevidenced.reason);

// ── 8. Unanimous pass reports independence honestly ─────────────────────
const good = aggregateReviews([
    review({ reviewerId: 'a', role: 'critic', provider: 'deepseek' }),
    review({ reviewerId: 'b', role: 'verifier', provider: 'gemini' }),
]);
check('independent unanimous pass is pass', good.outcome === 'pass', good.outcome);
check('pass reason cites genuine corroboration', /genuine corroboration/i.test(good.reason), good.reason);
check('pass keeps both reviews', good.corroborating.length === 2, String(good.corroborating.length));

const correlated = aggregateReviews([
    review({ reviewerId: 'a', role: 'critic', provider: 'deepseek' }),
    review({ reviewerId: 'b', role: 'critic', provider: 'deepseek' }),
]);
check('correlated unanimous pass is still pass', correlated.outcome === 'pass', correlated.outcome);
check('correlated pass is downgraded in words', /single opinion/i.test(correlated.reason), correlated.reason);
check('correlated pass is not called independent', correlated.independence.independent === false);

// ── 9. Rule 4: capitulation detection ───────────────────────────────────
const before = review({ verdict: 'block', evidence: ['breaks retry'] });
const flipNoEvidence = review({ verdict: 'pass', evidence: ['breaks retry'] });
const cap1 = detectCapitulation(before, flipNoEvidence);
check('flip with no new evidence is capitulation', cap1.capitulated === true, cap1.reason);
check('capitulation reason says so plainly', /capitulation/i.test(cap1.reason), cap1.reason);

const flipWithEvidence = review({ verdict: 'pass', evidence: ['breaks retry', 'retry fixed in 4.2'] });
const cap2 = detectCapitulation(before, flipWithEvidence);
check('flip with new evidence is legitimate', cap2.capitulated === false);
check('new evidence is identified', cap2.newEvidence.includes('retry fixed in 4.2'), JSON.stringify(cap2.newEvidence));

const noChange = detectCapitulation(review({ verdict: 'pass' }), review({ verdict: 'pass' }));
check('unchanged verdict is not capitulation', noChange.capitulated === false);

const blockToBlock = detectCapitulation(review({ verdict: 'block' }), review({ verdict: 'block' }));
check('block to block is not capitulation', blockToBlock.capitulated === false);

const missingSide = detectCapitulation(null, review());
check('missing side does not crash and does not accuse', missingSide.capitulated === false);

const caseInsensitive = detectCapitulation(
    review({ verdict: 'block', evidence: ['BREAKS Retry'] }),
    review({ verdict: 'pass', evidence: ['breaks retry'] })
);
check('evidence comparison is case-insensitive', caseInsensitive.capitulated === true, caseInsensitive.reason);

// ── 10. describeAggregate is informative ────────────────────────────────
const described = describeAggregate(outvoted);
check('describeAggregate names the outcome', described.includes('ESCALATE'), described);
check('describeAggregate counts evidenced blocks', described.includes('1 evidenced block'), described);
check('describeAggregate includes the reason', described.includes(outvoted.reason));

// ── 11. buildReviewerPrompt + parseReviewVerdict round-trip & fail-closed ──
const { buildReviewerPrompt, parseReviewVerdict } = mod;
const promptText = buildReviewerPrompt('Add Vertex AI support', 'Implemented resolveGeminiGenerateContentRequest', 'critic');
check('buildReviewerPrompt embeds lens and wouldChangeMind schema', promptText.includes('"critic"') && promptText.includes('wouldChangeMind'));

const parsedJsonVerdict = parseReviewVerdict(
    '```json\n{"verdict":"pass","evidence":["all 45 compaction checks pass"],"confidence":92,"wouldChangeMind":"A failing gate on Vertex URL resolution"}\n```',
    { reviewerId: 'rev-critic', role: 'critic', provider: 'deepseek' }
);
check('parseReviewVerdict extracts fenced JSON verdict', parsedJsonVerdict.verdict === 'pass' && parsedJsonVerdict.confidence === 92 && isWellFormedReview(parsedJsonVerdict));

const parsedProseBlock = parseReviewVerdict(
    '- Blocking defect in coerce(): empty string is rejected for optional projectId',
    { reviewerId: 'rev-verifier', role: 'verifier', provider: 'gemini' }
);
check('parseReviewVerdict detects blocking prose and preserves evidence', parsedProseBlock.verdict === 'block' && parsedProseBlock.evidence.length === 1 && isWellFormedReview(parsedProseBlock));

const parsedEmpty = parseReviewVerdict('   ', { reviewerId: 'rev-empty', role: 'critic' });
check('parseReviewVerdict on empty output produces malformed review so aggregateReviews fails closed', isWellFormedReview(parsedEmpty) === false && aggregateReviews([parsedEmpty]).outcome === 'insufficient');

const parsedNonString = parseReviewVerdict({ unexpected: true }, { reviewerId: 'rev-obj', role: 'verifier', provider: 'auto' });
check('parseReviewVerdict rejects non-string input and strips "auto" pseudo-provider', isWellFormedReview(parsedNonString) === false && parsedNonString.provider === undefined);

const parsedNegatedProse = parseReviewVerdict('All checks verified: no regressions found, no bugs or blocking issues.', { reviewerId: 'rev-clean-prose', role: 'verifier' });
check('parseReviewVerdict does not misclassify negated "no regressions found" prose as block', parsedNegatedProse.verdict === 'pass');

const parsedMultiFence = parseReviewVerdict(
    'Example code:\n```ts\nconst x = { a: 1 };\n```\nFinal verdict:\n```json\n{"verdict":"PASS","evidence":["verified",{"bad":1}],"confidence":88,"wouldChangeMind":"A failing test"}\n```',
    { reviewerId: 'rev-multi', role: 'critic' }
);
check('parseReviewVerdict reads the last JSON fence and filters non-string evidence items',
    parsedMultiFence.verdict === 'pass' && parsedMultiFence.evidence.length === 1 && parsedMultiFence.evidence[0] === 'verified');

// ── Report ──────────────────────────────────────────────────────────────
const total = pass + failures.length;
if (failures.length === 0) {
    console.log(`✅ check:collaborator-review — ${pass}/${total} assertions passed`);
    process.exit(0);
}
console.error(`❌ check:collaborator-review — ${failures.length} of ${total} failed:\n`);
for (const f of failures) console.error(`  - ${f}`);
process.exit(1);
