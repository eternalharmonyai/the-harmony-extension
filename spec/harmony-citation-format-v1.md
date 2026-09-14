# Harmony Citation & Archive Format — v1 (draft)

**Status:** draft · **Spec version string:** `harmony-citation/1`

A plain-file, signed, hash-chained record of *what was retrieved, when, and what it said*.

This is a **format**, not a product. Any tool that can write JSON, hash bytes, and verify an
Ed25519 signature can produce and check these records. There is no server, no registry, and
no Harmony dependency. The reference implementation lives in `src/citationRecord.ts`; the
format is what matters.

---

## 1. Why this exists

Retrieval-augmented systems cite constantly and can prove nothing. Three questions have no
mechanical answer today:

1. **Did this source actually say that?** — fabricated and drifted citations are endemic.
2. **Did the model regress, or did the web change underneath the eval?** — corpus drift is
   indistinguishable from model regression without a pinned baseline.
3. **What did your system read, and when?** — audit and provenance obligations have no
   artifact to point at.

A capture record answers all three, and it is cheap: it is a byproduct of a fetch you already
performed.

## 1.1 What this does not prove

Read this before relying on a record as evidence.

**A capture record attests an ASSERTION, not a RETRIEVAL.** It is signed proof that a
particular key stated that a particular URL returned particular bytes at a particular time.
Nothing in the format establishes that the fetch actually happened. An observer can invent a
`content_sha256` for a URL it never requested, sign it, and every rule in §9 will pass —
correctly, because those rules check internal consistency and authorship, not honesty.

So the format's guarantee is narrower than "prove what it read":

| Proven | Not proven |
|---|---|
| This key signed this claim | The fetch occurred |
| The claim has not been altered since | The content was ever at that URL |
| The claim's position in a chain the observer presented | That this is the observer's *only* chain |
| — | That you have been shown **all** of it |
| — | The stated time is true (§5) |
| Which key signed | Which human or model composed it (§9) |

**Chains are tamper-evident, not fork-evident, and not completeness-evident.** An observer
can also simply present a PREFIX — records 1..N, withholding N+1..M. That is not a fork and
not tampering: the shortened chain verifies perfectly, while a later `liveness` record
showing `removed`, or a revocation, quietly never arrives (findings R17, R14).

 Hash linkage proves that a *presented*
sequence has not been edited. It does not prove the sequence is the only one. An observer
can build two internally valid chains from any common prefix — including from `genesis/1`,
which is equally forkable — sign both, and show whichever suits the audience. Nothing in
this document detects that, and "append-only" in §8 describes an intent, not a guarantee.
This was a design finding; the design response is tracked in §13.

The only adversarial guarantee available is **corroboration across observers in distinct
trust domains** — and only to the degree the domains are genuinely distinct. Keys sharing a
machine share a trust domain, so several signers on one host corroborate nothing. A single
observer's capture is a signed claim, and should be weighted as one.

## 2. Design constraints

- **Plain files.** Distribution is `git`, or a USB stick. No server is required, ever.
- **Per-observer chains.** Each observer keeps its own chain, so two nodes appending
  concurrently never conflict. Cross-observer agreement is *derived*, never coordinated —
  this is what makes the format distributed without consensus.
- **Hash-only records are first-class.** `verbatim` is OPTIONAL. A record can prove what text
  was at a URL without redistributing that text. Publishing an index of hashes is a very
  different act from republishing a corpus, and the format must not force the second.
- **No floating-point numbers anywhere.** Every number in this format is an integer. This
  removes the hardest part of JSON canonicalisation and makes independent implementations
  agree byte-for-byte without adopting RFC 8785 in full.
- **Absence is data.** A failed re-check is a record, not a dropped exception. The set of
  liveness records over time *is* an index of what disappeared.

## 3. Canonical form

Hashing and signing operate on **canonical bytes**, defined as:

1. UTF-8, **no BOM**.
2. Object keys sorted ascending by **UTF-16 code unit**, at every nesting level — the
   ordering RFC 8785 (JCS) §3.2.3 specifies. This is *not* code-point order: U+1D400
   precedes U+FB00 by code unit and follows it by code point. Implementations that sort
   by code point will disagree with this format on any astral key.
3. No insignificant whitespace — no spaces after `:` or `,`, no newlines.
4. **Integers only**, within the IEEE-754 safe range (±2^53−1), emitted in plain decimal:
   no exponent, no leading zeros, no `-0` (which serialises as `0`). A float, or an integer
   outside the safe range, is invalid and MUST be rejected — implementations disagree there.
5. `null` members are omitted entirely rather than serialised.
6. **Strings MUST already be Unicode NFC.** Canonicalisation MUST REJECT non-NFC input
   rather than normalise it, because normalising at this layer would alter the very bytes
   the signature attests. Producers normalise upstream (see `harmony-text/2` in §7).
7. Duplicate object keys are invalid. Parsers that silently keep the last occurrence will
   compute a hash the producer never signed.
8. `/` is never escaped.

The vectors in `spec/test-vectors/` are normative, but they are *examples of these rules*,
not a substitute for them — a rule with no vector covering it is untested, and a vector
without a rule behind it is a coincidence. Both are required. This distinction was finding
A later design finding, and it was well earned: an earlier corpus was entirely ASCII
and already-NFC, so adding the NFC rule changed nothing in it and the change passed
unnoticed.

The canonical unit is the object `{harmony_record, seq, prev, body}` — `id` and `signature`
are excluded, because they are computed *from* it.

Signing is **domain-separated**. The signed input is the domain tag, the
record type, and the canonical bytes, joined by NUL — which cannot occur in JSON text:

```
signed_input = "harmony-citation/1" 0x00 <harmony_record> 0x00 canonical_bytes
id           = hex( sha256( signed_input ) )
sig          = base64( ed25519_sign( private_key, signed_input ) )
```

The same Ed25519 key signs Web Bot Auth requests and citation records — that one-key design
is deliberate (§4), which is precisely why the contexts must be separated cryptographically
rather than merely looking different. Web Bot Auth carries its own separation through RFC
9421's `tag="web-bot-auth"`.

**Ed25519 verification follows RFC 8032**. RFC 8032 and ZIP-215 disagree on
cofactored verification and small-order points, so a signature can verify under one and fail
under the other. An implementation that accepts ZIP-215-only signatures is not conformant.

Implementations that disagree on canonical bytes will disagree on every signature. When
debugging interop, print the canonical bytes first.

## 4. Record envelope

Every record, of any type, has this shape:

```json
{
  "harmony_record": "capture/1",
  "seq": 1,
  "prev": null,
  "body": { "...": "type-specific" },
  "id": "9f2c…",
  "signature": {
    "alg": "ed25519",
    "keyid": "naYGrmGmhQG9Cu7e0FEEIc2B-6vzZsyJeVCQrIv46Rs",
    "signer": "harvester",
    "sig": "f6nrsYnF…"
  }
}
```

- `seq` — 1-based, strictly increasing within one observer's chain.
- `prev` — `id` of the preceding record, `null` only for `seq: 1`.
- All instants use one grammar: **`YYYY-MM-DDTHH:MM:SSZ`** — UTC, literal `Z`, whole
  seconds. "RFC 3339" alone permits `+00:00`, fractional seconds and non-UTC
  offsets, so three producers could write one moment three ways and sign three different
  records. Non-conforming instants MUST be rejected, never silently reformatted.
- `keyid` — RFC 7638 JWK thumbprint of the Ed25519 public key, base64url unpadded. **The same
  `keyid` used by Web Bot Auth** (`src/webBotAuth.ts`), so an agent's fetch identity and its
  citation identity are one key. A verifier that trusts the agent's requests already knows how
  to resolve its citations.

## 5. `capture/1` — what was retrieved

```json
{
  "url": "https://example.org/record/5788",
  "retrieved": "2026-09-05",
  "retrieved_at": "2026-09-05T09:37:26Z",
  "http_status": 200,
  "content_sha256": "c1f0…",
  "normalization": "harmony-text/1",
  "evidence_tier": "content",
  "retrieval_class": "harvest",
  "engine": "primary:example.org",
  "jurisdiction": "institutional",
  "observer": { "signer": "harvester", "jurisdiction": "US" },
  "title": "Example document title …",
  "headers": { "etag": "\"a1b2\"", "last-modified": "Tue, 04 Jul 2023 10:00:00 GMT" },
  "verbatim": "…operative text…"
}
```

| Field | Required | Notes |
|---|---|---|
| `url` | yes | The URL as fetched. Not normalised — normalisation is for *comparison*, not identity. |
| `retrieved` | yes | `YYYY-MM-DD`. Wire-compatible with the citation schema's `retrieved` (`format: date`). Never rewritten — first-sight date. |
| `retrieved_at` | yes | RFC 3339 instant, for ordering. Distinct from `retrieved`, which stays a date for schema compatibility. **Self-asserted**: it comes from the observer's own clock, signed only by the observer, so it can be backdated at will. Any time claim in this format is unverifiable without an external anchor. |
| `raw_sha256` | no | **Archival identity**: sha256 of the raw bytes as received. Byte-exact and normalisation-independent, so it survives Unicode-version drift (§7, R12). |
| `raw_base64` | no | The raw bytes themselves. Omit for hash-only; `raw_sha256` still stands. |
| `content_sha256` | yes | **Comparison identity**: hash of the normalised text — see §7. |
| `normalization` | yes | Normaliser id + version. Changing the normaliser invalidates comparisons; recording it makes that detectable instead of silent. |
| `evidence_tier` | yes | `snippet` \| `content`. Only `content` is citable as authority. |
| `retrieval_class` | yes | `index` \| `synthesis` \| `harvest` \| `archive` — see §6. |
| `observer` | yes | Who captured it. Required for differential retrieval. |
| `verbatim` | **no** | Omit for a hash-only record. Omission does not weaken liveness checking, but it does remove the only way to check that any text hashes to the stored value — a hash-only record is the least falsifiable form in the format, and also the one recommended for redistribution safety. Verifiers SHOULD weight hash-only captures lower when corroborating. |

### Two identities, deliberately

A record carries up to two hashes because a document has two identities, and an earlier
version of this spec conflated them:

| | Hash | Answers | Stable under |
|---|---|---|---|
| **Archive** | `raw_sha256` | what the bytes *were* | everything — it is the bytes |
| **Comparison** | `content_sha256` | whether the document *changed meaningfully* | whitespace, markup and encoding churn |

Liveness compares the second, so trivial reformatting does not report `altered`. Integrity
of the archive rests on the first. Requiring NFC for the *stored payload* — as this spec
briefly did — made a legitimately NFD document unarchivable, which is a defect in an
archival format. Raw bytes travel base64-encoded and are therefore unaffected by §3's NFC
rule, which governs the canonical JSON only.

## 6. Retrieval class, and why `synthesis` can never be `content`

| Class | Returns | Max `evidence_tier` |
|---|---|---|
| `index` | links + snippets | `snippet`, then `content` after fetching the page |
| `synthesis` | model-generated prose with citations | **`snippet`, permanently** |
| `harvest` | structured repository records | `snippet`, then `content` after fetching |
| `archive` | historical capture | `content` |

`synthesis` covers every model-native grounding product — Google's, OpenAI's, Anthropic's
included. The constraint is not a judgement about any vendor: synthesised prose is text *about*
sources, not text *from* a source, so it cannot satisfy verbatim-or-abstain. A validator MUST
reject `retrieval_class: "synthesis"` combined with `evidence_tier: "content"`.

This is a property of the **path**, not of the document. It is deliberately not a liveness
verdict — see §7.

## 7. `liveness/1` — does it still say that

```json
{
  "capture": "9f2c…",
  "url": "https://example.org/record/5788",
  "checked_at": "2026-10-01T08:00:00Z",
  "verdict": "altered",
  "http_status": 200,
  "baseline_sha256": "c1f0…",
  "content_sha256": "77ab…",
  "final_url": null,
  "diagnostic": {
    "retry_count": 0,
    "headers": { "cf-ray": null, "retry-after": null, "etag": "\"z9\"" },
    "error_code": null,
    "message": null,
    "suggestion": "content-changed"
  }
}
```

### Verdicts

| Verdict | Condition | Says something about |
|---|---|---|
| `live-unchanged` | 2xx, hash equals baseline | the document |
| `altered` | 2xx, hash differs | the document |
| `soft-404` | 2xx, hash differs, and the body positively matches an error-page signature | the document |
| `moved` | 3xx to a different URL; `final_url` set | the document |
| `removed` | 404 or 410 | the document |
| `blocked` | 401, 403, 429, or a challenge interstitial | **the network path** |
| `transient-error` | 5xx, timeout, DNS failure, connection reset | **the network path** |

**The load-bearing rule:** `blocked` and `transient-error` are *not verdicts about the
document*. They mean "unverifiable from this network." An implementation MUST NOT report,
display, or aggregate them as `removed`, and MUST NOT treat them as evidence of absence. A
403 from a WAF and a 410 from a publisher are opposite claims.

`soft-404` requires **positive** identification, not merely a hash mismatch. When unsure, emit
`altered` — over-reporting `soft-404` smuggles "removed" back in through the side door.

Two detection methods, in order of reliability:

1. **Calibration probe (RECOMMENDED).** Re-request the same URL with its last path segment
   replaced by an implausible identifier. If that probe returns 2xx *and* renders
   substantially the same page as the target (token-set similarity > 0.9 with digits
   stripped), the target is an error page. If the probe correctly returns 404, the site does
   not serve soft-404s and the target's mismatch is a genuine edit. This is
   **language-independent** and costs one extra request, so it SHOULD run only after a hash
   mismatch, where the answer changes something.
2. **Error-page signatures (fallback).** Matching known error wording. Zero extra requests,
   but unavoidably incomplete and English-biased.

The reference implementation ships both. Method 2 alone was measured failing on
a repository that returns **HTTP 200** with *"Requested record does not seem to
exist"* for a missing record — a live soft-404 on the exact corpus this format was built for.

**The normaliser is defined by its test vectors, not by this prose.** `spec/test-vectors/`
is NORMATIVE for `harmony-text/1`; the description below is explanatory. Two implementations
written sincerely from prose will differ on some whitespace or entity edge case, produce
different `content_sha256` for byte-identical documents, and — worst of all — the
disagreement will not surface as an error. It will surface as DIVERGENCE, manufacturing
exactly the false signal §10's differential retrieval exists to detect. An implementation
conforms to `harmony-text/1` if and only if it reproduces the normalisation vectors.

Hashing normalised text rather than raw bytes is what makes any of this usable. Session ids,
CSRF tokens, rotating ad slots and "last updated" widgets each flip a raw-byte hash on a
document nobody touched, and a week of false `altered` reports buries the true signal.
`normalization` records which normaliser produced the baseline so a later change to it is
detectable rather than silently invalidating every comparison.

## 8. Layout on disk

```
citations/
  <signer>/                       # one chain per observer — concurrent appends never conflict
    chain.json                   # { spec, signer, keyid, head, count }
    records/
      000001-9f2c….json
      000002-4ab1….json
  keys/
    <signer>.pub                  # public key, same format as keys/<signer>.pub
```

One record per file, because a single append-only log file conflicts on every concurrent
merge, whereas distinct files merge cleanly. `chain.json` is a convenience head-pointer and is
**derivable** — if it conflicts, delete it and rebuild from `records/`.

## 9. Verification

A validator MUST check, and report per record:

1. Canonical bytes round-trip — re-serialising `body` reproduces `id`.
2. No floats anywhere.
3. `signature.sig` verifies over the canonical bytes with the key named by `keyid`.
4. `keyid` matches the thumbprint of the public key it resolves to.
5. `seq` increments by exactly 1 and `prev` equals the previous record's `id`;
   `prev` is `null` if and only if `seq` is 1.
6. `retrieval_class: "synthesis"` never appears with `evidence_tier: "content"`.
7. `retrieved` parses as `YYYY-MM-DD`. An unparseable date is a **rejection**, never a
   silently skipped check.
8. If `verbatim` is present, its normalised hash equals `content_sha256`.

A signature proves which key signed — origin under a role. It does not prove which human or
which model composed the content. Keys sharing a machine share a trust domain.

## 10. MCP surface

The point of the format is that other tools consume it without adopting Harmony. Four methods:

```
verify_citation(url, quote?, content_sha256?, as_of?)
  -> { found, capture_id, retrieved, evidence_tier, retrieval_class,
       quote_matches: bool|null, observers: [...] }
  "Does this quote exist verbatim at this URL, and who attests it?"

check_liveness(url, baseline_sha256?)
  -> liveness/1 record (unsigned unless persisted)
  "Does it still say that?" — returns the full n-state verdict + diagnostic.

get_captures(url)
  -> [capture/1, ...] across all known observers
  Multiple observers over one URL is the raw material for differential retrieval:
  same URL, differing content_sha256, differing observer.jurisdiction.

list_absences(since?, verdicts?)
  -> [liveness/1, ...] filtered to removed | moved | soft-404 | altered
  The index of absence. Everyone indexes what exists; this is the rest.
```

`verify_citation` returns `quote_matches: null` — not `false` — when the record is hash-only
and cannot confirm the quote. Absence of the text is not evidence against the quote.

## 11. `revocation/1` — retiring a compromised key

```json
{
  "revokes_keyid": "naYGrmGmhQG9Cu7e0FEEIc2B-6vzZsyJeVCQrIv46Rs",
  "signer": "harvester",
  "revoked_at": "2026-09-21T00:00:00Z",
  "valid_through": "9f2c1a…",
  "reason": "compromise",
  "note": "principal key exposed in a leaked backup",
  "attestations": []
}
```

A revocation is a standalone record (`seq: 1`, `prev: null`), not an entry in the principal's
chain — a different key signs it, and a chain is keyed to one signer. It lives at
`citations/keys/revocations/<signer>-<n>.json`.

### Three rules, each closing a way revocation normally fails

**0. The binding lives in the chain.** The principal's chain SHOULD open with a
`genesis/1` record at `seq: 1`, signed by the principal, carrying `recovery_keyid`:

```json
{ "signer": "harvester", "keyid": "naYG…", "recovery_keyid": "rGDl…",
  "created_at": "2026-09-05T00:00:00Z" }
```

Publishing the binding only in `<signer>.pub` covers key compromise but not **repository
compromise**, which is the likelier event: an attacker with write access rewrites
`recovery_public_key:` to a key they hold and issues a valid-looking revocation, or swaps it
so a legitimate revocation fails to verify. Committed in `genesis/1` the binding is covered
by the chain hash — editing the `.pub` afterwards is detectable by comparison, and editing
the genesis record breaks every signature after it.

A verifier MUST prefer the `genesis/1` binding over the `.pub` sidecar, MUST reject a
revocation not signed by the bound recovery key, and MUST report a mismatch between the two
as tampering. A chain without `genesis/1` remains valid but is `sidecar-only` bound, and
verification MUST report that rather than presenting the weaker mode as the stronger one.

**1. Never self-signed.** A revocation MUST be signed by a **recovery key** generated
alongside the principal, bound in `genesis/1` and published in the principal's `.pub` as
`recovery_public_key:` at generation time. Self-signed revocation is worthless — an attacker holding the key can revoke,
or decline to. Because the binding predates any compromise, an attacker cannot nominate their
own recovery key afterwards. A verifier MUST reject a revocation whose signing `keyid` equals
`revokes_keyid`.

The recovery key's only power is revoking its principal. It MUST be moved offline; stored
beside the key it protects, it is compromised by the same breach it exists to survive.

`attestations` optionally carries m-of-n quorum signatures — attestations from a designated
set of m signers, of which n are required — over the same canonical bytes, for
the case where the recovery key itself is lost.

**2. Three states, split on the one time-claim that can be trusted.**

| Status | Condition |
|---|---|
| `verified` | at or before `valid_through`, **and** outside any `compromised_since` window |
| `suspect` | after `valid_through`, claiming a time before `revoked_at` |
| `invalid` | claiming a time at or after `revoked_at` |

`valid_through: null` means the compromise point is unknown, so nothing after genesis is
`verified`.

`compromised_since` (optional) closes a blind spot: `valid_through` is a
*position* claim — "this record was the last I vouch for" — while a revoker often knows the
*time* the key went bad more confidently than the position. Without it, records that precede
`valid_through` in sequence but fall inside the compromise window were reported `verified`.
Records claiming a time at or after `compromised_since` lose `verified` regardless of
position. The field is self-*widening* — it can only enlarge the revoker's own doubt — which
is why it can be trusted on the same reasoning as `invalid` above.

A verifier MUST NOT fail records purely because a later compromise occurred — signature
validity and trustworthiness are different questions, and conflating them destroys history
that remains well attested.

But `suspect` alone was too weak: it let a compromised key keep seeding records that still
carry weight. The obvious fix — invalidate everything after the revocation —
is unimplementable as stated, because record timestamps are self-asserted (§5) and an
attacker simply backdates. So the third state keys on a claim that cannot be self-serving:
a record asserting a time at or after `revoked_at` is admitting it was signed with a
publicly revoked key. **A self-incriminating claim can be believed; a self-serving one
cannot.** Backdating to escape `invalid` only lands the record in `suspect`, which is the
correct outcome for an unfalsifiable claim.

**3. Absence of a revocation is not evidence of non-revocation.** Records travel as files, so
a verifier that has not pulled recently may simply not have seen one. Verification MUST report
`data_as_of` — when revocation data was last refreshed — and MUST NOT imply a key is good
merely because no revocation is present. This is the same epistemics as `blocked` never
meaning `removed`: not seeing something is not the same as it not being there.

## 12. Versioning

`harmony_record` carries `type/major`. A consumer MUST reject a major it does not know rather
than best-effort parse it. New OPTIONAL fields do not bump the major; changing canonicalisation
or the meaning of an existing field does.

## 13. Open questions

- **Equivocation.** No head anchor exists, so forks are undetectable from a single
  chain. Candidate design: a `witness/1` record in which one observer signs "I saw
  observer A at seq N with head H at time T". Two witness records naming the same seq with
  different heads prove a fork. This detects rather than prevents, and it is worth nothing
  unless the witnesses sit in genuinely distinct trust domains — the same caveat as
  `attestations`. Until it exists, the limit is stated in §1.1 rather than papered over.
- Revocation **distribution**: §11 specifies the record, not how it reaches a verifier.
  Propagation is whatever carries the files, usually `git`. `data_as_of` makes the staleness
  visible rather than solving it.
- Recovery-key loss with no quorum leaves a key unrevocable. `attestations` is
  specified, but the m-of-n policy — who counts as an attester, and how many are needed — is
  not.
- Cross-observer chains are independent by design, so there is no global ordering. If total
  ordering is ever needed, it needs an external anchor.
- `soft-404` signature detection is unspecified beyond "best-effort"; a shared signature list
  would make implementations agree.
