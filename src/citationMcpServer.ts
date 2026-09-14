/**
 * MCP server for the Harmony Citation & Archive Format v1 (spec §10).
 *
 * The point of the format is that other tools consume it WITHOUT adopting Harmony, so this
 * server has zero dependencies: raw JSON-RPC 2.0 over newline-delimited stdio, the MCP
 * stdio transport. `node bin/harmony-citation-mcp.js` is the whole install story.
 *
 * Tools:
 *   verify_citation  — does this quote exist verbatim at this URL, and who attests it?
 *   check_liveness   — does it still say that? (7-state verdict + diagnostic)
 *   get_captures     — every observer's capture of a URL; raw material for differential retrieval
 *   list_absences    — the index of absence: removed | moved | soft-404 | altered over time
 *
 * SECURITY — this server fetches URLs on request, which makes it an SSRF surface. A caller
 * that can reach this server could otherwise probe loopback, private ranges, and cloud
 * metadata endpoints through it. `assertFetchableUrl` refuses those. See its note for the
 * residual DNS-rebinding risk, which a literal-address check cannot close.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import {
    checkLiveness, contentHash, verifyChain, isDocumentVerdict,
    type LivenessVerdict, type CaptureBody,
} from './citationRecord';
import {
    readStore, capturesForUrl, livenessRecords,
    type StoreContents,
} from './citationStore';

// ─── JSON-RPC plumbing ──────────────────────────────────────────────────────

interface RpcRequest { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: any }

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'harmony-citation', version: '1.0.0' };

function result(id: RpcRequest['id'], value: unknown) {
    return JSON.stringify({ jsonrpc: '2.0', id, result: value });
}

function error(id: RpcRequest['id'], code: number, message: string) {
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

/** MCP tool results are content blocks; JSON goes in a text block. */
function toolResult(value: unknown, isError = false) {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError };
}

// ─── SSRF guard ─────────────────────────────────────────────────────────────

const BLOCKED_HOSTNAMES = new Set([
    'localhost', 'metadata.google.internal', 'metadata', 'instance-data',
]);

function isBlockedIpLiteral(host: string): boolean {
    const h = host.replace(/^\[|\]$/g, '');
    if (h === '::1' || h === '::' || h.toLowerCase().startsWith('fe80:') ||
        h.toLowerCase().startsWith('fc') || h.toLowerCase().startsWith('fd')) return true;
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 0 || a === 10) return true;           // loopback, this-network, private
    if (a === 169 && b === 254) return true;                      // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;             // private
    if (a === 192 && b === 168) return true;                      // private
    return false;
}

/**
 * Refuse anything that is not a public http(s) URL.
 *
 * KNOWN LIMIT: this checks the literal host only. A hostname that resolves to a private
 * address (DNS rebinding) still passes. Closing that requires resolving the name and
 * checking the resolved address at connect time, which needs a custom agent. Documented
 * rather than hidden — an unstated gap is worse than a stated one.
 */
export function assertFetchableUrl(raw: string): URL {
    let u: URL;
    try { u = new URL(raw); } catch { throw new Error(`not a valid URL: ${raw}`); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error(`refused: only http(s) URLs may be fetched (got ${u.protocol})`);
    }
    const host = u.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || isBlockedIpLiteral(host)) {
        throw new Error(`refused: ${host} is loopback, private, or link-local`);
    }
    return u;
}

// ─── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
    {
        name: 'verify_citation',
        description:
            'Verify that a quote exists verbatim at a URL, according to signed capture records. ' +
            'Returns quote_matches: null (never false) when the record is hash-only and cannot ' +
            'confirm the quote — absence of stored text is not evidence against the quote.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'The cited URL.' },
                quote: { type: 'string', description: 'Operative text claimed to appear at the URL.' },
                content_sha256: { type: 'string', description: 'Alternative to quote: match a known hash.' },
            },
            required: ['url'],
        },
    },
    {
        name: 'check_liveness',
        description:
            'Re-fetch a cited URL and report a 7-state verdict: live-unchanged, altered, soft-404, ' +
            'moved, removed, blocked, transient-error. blocked and transient-error describe the ' +
            'NETWORK PATH, not the document, and never imply the document was removed.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string' },
                baseline_sha256: { type: 'string', description: 'Defaults to the newest stored capture.' },
                calibrate_soft_error: {
                    type: 'boolean',
                    description: 'Spend one extra request for language-independent soft-404 detection.',
                },
            },
            required: ['url'],
        },
    },
    {
        name: 'get_captures',
        description:
            'Every observer capture of a URL. Differing content_sha256 across observers in ' +
            'different jurisdictions is the raw signal for differential retrieval.',
        inputSchema: {
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url'],
        },
    },
    {
        name: 'list_absences',
        description:
            'The index of absence: liveness records where a document was removed, moved, became a ' +
            'soft-404, or was altered. Everyone indexes what exists; this is the rest.',
        inputSchema: {
            type: 'object',
            properties: {
                since: { type: 'string', description: 'RFC 3339 lower bound on checked_at.' },
                verdicts: {
                    type: 'array', items: { type: 'string' },
                    description: 'Defaults to removed, moved, soft-404, altered.',
                },
                include_unverifiable: {
                    type: 'boolean',
                    description: 'Also include blocked/transient-error, clearly labelled as NOT absence.',
                },
            },
        },
    },
];

// ─── Tool implementations ───────────────────────────────────────────────────

async function verifyCitation(store: StoreContents, args: any) {
    const url = String(args?.url ?? '');
    const hits = capturesForUrl(store, url);
    if (hits.length === 0) {
        return { found: false, url, observers: [], note: 'no capture record for this URL' };
    }
    const quote = typeof args?.quote === 'string' ? args.quote : undefined;
    const wantHash = typeof args?.content_sha256 === 'string' ? args.content_sha256 : undefined;
    const quoteHash = quote !== undefined ? await contentHash(quote) : undefined;

    const observers = await Promise.all(hits.map(async h => {
        const b = h.record.body;
        let quote_matches: boolean | null = null;
        if (quote !== undefined) {
            // Hash-only record: cannot confirm, must not deny.
            if (b.verbatim === undefined) quote_matches = null;
            else quote_matches = b.verbatim.includes(quote) || quoteHash === b.content_sha256;
        } else if (wantHash !== undefined) {
            quote_matches = wantHash === b.content_sha256;
        }
        return {
            signer: h.signer,
            capture_id: h.record.id,
            retrieved: b.retrieved,
            evidence_tier: b.evidence_tier,
            retrieval_class: b.retrieval_class,
            jurisdiction: b.observer?.jurisdiction,
            content_sha256: b.content_sha256,
            hash_only: b.verbatim === undefined,
            quote_matches,
        };
    }));

    const citable = observers.some(o =>
        o.evidence_tier === 'content' && o.retrieval_class !== 'synthesis');

    return {
        found: true, url, observers,
        citable_as_authority: citable,
        note: citable ? undefined
            : 'No observer holds this at evidence_tier "content" from a non-synthesis class; ' +
              'under verbatim-or-abstain this is a lead, not a citation.',
    };
}

async function doCheckLiveness(store: StoreContents, args: any) {
    // Validate, but keep the caller's exact string: capture.url is stored as fetched and
    // matched by exact string, so re-serialising here made stored captures unfindable
    // (https://Example.org/Doc would never match https://example.org/Doc). Finding R20.
    const url = String(args?.url ?? '');
    assertFetchableUrl(url);
    let baseline = typeof args?.baseline_sha256 === 'string' ? args.baseline_sha256 : undefined;
    let captureId = 'ad-hoc';
    if (!baseline) {
        const hits = capturesForUrl(store, url);
        if (hits.length === 0) {
            throw new Error('no stored capture for this URL; supply baseline_sha256 explicitly');
        }
        baseline = hits[0].record.body.content_sha256;
        captureId = hits[0].record.id;
    }
    const body = await checkLiveness(
        { id: captureId, url, content_sha256: baseline },
        { calibrateSoftError: args?.calibrate_soft_error === true }
    );
    return {
        ...body,
        describes: isDocumentVerdict(body.verdict) ? 'document' : 'network-path',
        note: isDocumentVerdict(body.verdict) ? undefined
            : 'This verdict describes the network path, not the document. It is NOT evidence ' +
              'that the document was removed or altered.',
    };
}

function getCaptures(store: StoreContents, args: any) {
    const url = String(args?.url ?? '');
    const hits = capturesForUrl(store, url);
    const hashes = new Set(hits.map(h => h.record.body.content_sha256));
    const jurisdictions = [...new Set(hits.map(h => h.record.body.observer?.jurisdiction).filter(Boolean))];
    return {
        url,
        count: hits.length,
        distinct_content_hashes: hashes.size,
        jurisdictions,
        differential: hashes.size > 1
            ? 'Observers disagree on content for this URL — differing captures across ' +
              'observers is the signal differential retrieval exists to surface.'
            : undefined,
        captures: hits.map(h => ({ signer: h.signer, id: h.record.id, body: h.record.body })),
    };
}

const ABSENCE_DEFAULT: LivenessVerdict[] = ['removed', 'moved', 'soft-404', 'altered'];

function listAbsences(store: StoreContents, args: any) {
    const requested: LivenessVerdict[] = Array.isArray(args?.verdicts) && args.verdicts.length
        ? args.verdicts
        : ABSENCE_DEFAULT;
    const verdicts = args?.include_unverifiable === true
        ? ([...requested, 'blocked', 'transient-error'] as LivenessVerdict[])
        : requested;

    const hits = livenessRecords(store, { since: args?.since, verdicts });
    const documentAbsences = hits.filter(h => isDocumentVerdict(h.record.body.verdict));
    const unverifiable = hits.filter(h => !isDocumentVerdict(h.record.body.verdict));

    return {
        count: hits.length,
        absences: documentAbsences.map(h => ({
            signer: h.signer, url: h.record.body.url, verdict: h.record.body.verdict,
            checked_at: h.record.body.checked_at, final_url: h.record.body.final_url,
        })),
        // Deliberately a separate list: folding these in would present unreachability as absence.
        unverifiable: unverifiable.map(h => ({
            signer: h.signer, url: h.record.body.url, verdict: h.record.body.verdict,
            checked_at: h.record.body.checked_at,
            note: 'network path, not the document — not evidence of absence',
        })),
    };
}

async function verifyStore(store: StoreContents) {
    const chains = [];
    for (const chain of store.chains) {
        if (!chain.publicKeyHex) {
            chains.push({ signer: chain.signer, verified: false, reason: `no keys/${chain.signer}.pub` });
            continue;
        }
        const raw = new Uint8Array((chain.publicKeyHex.match(/../g) ?? []).map(h => parseInt(h, 16)));
        const v = await verifyChain(chain.records, raw);
        chains.push({
            signer: chain.signer, verified: v.ok, records: v.verified,
            issues: v.issues, malformed: chain.malformed,
        });
    }
    return { chains };
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

export async function handleToolCall(store: StoreContents, name: string, args: any) {
    switch (name) {
        case 'verify_citation': return verifyCitation(store, args);
        case 'check_liveness': return doCheckLiveness(store, args);
        case 'get_captures': return getCaptures(store, args);
        case 'list_absences': return listAbsences(store, args);
        case 'verify_store': return verifyStore(store);
        default: throw new Error(`unknown tool: ${name}`);
    }
}

// ─── stdio server ───────────────────────────────────────────────────────────

export async function serve(root: string, io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream }) {
    let store = await readStore(root);
    const send = (line: string) => io.stdout.write(line + '\n');

    let buffer = '';
    io.stdin.setEncoding('utf8');
    for await (const chunk of io.stdin) {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;

            let req: RpcRequest;
            try { req = JSON.parse(line); } catch { send(error(null, -32700, 'parse error')); continue; }

            // Notifications carry no id and MUST NOT be answered.
            const isNotification = req.id === undefined || req.id === null;

            try {
                switch (req.method) {
                    case 'initialize':
                        if (!isNotification) send(result(req.id, {
                            protocolVersion: PROTOCOL_VERSION,
                            capabilities: { tools: {} },
                            serverInfo: SERVER_INFO,
                        }));
                        break;
                    case 'notifications/initialized':
                    case 'initialized':
                        break; // notification: no reply
                    case 'ping':
                        if (!isNotification) send(result(req.id, {}));
                        break;
                    case 'tools/list':
                        if (!isNotification) send(result(req.id, { tools: TOOLS }));
                        break;
                    case 'tools/call': {
                        if (isNotification) break;
                        // Re-read: another observer's records may have arrived via git
                        // between calls, and a stale store would silently under-report.
                        store = await readStore(root);
                        const { name, arguments: args } = req.params ?? {};
                        try {
                            send(result(req.id, toolResult(await handleToolCall(store, name, args ?? {}))));
                        } catch (e) {
                            // Tool failures are results with isError, not protocol errors —
                            // the caller needs the reason, not a dead connection.
                            send(result(req.id, toolResult({ error: (e as Error).message }, true)));
                        }
                        break;
                    }
                    default:
                        if (!isNotification) send(error(req.id, -32601, `method not found: ${req.method}`));
                }
            } catch (e) {
                if (!isNotification) send(error(req.id, -32603, (e as Error).message));
            }
        }
    }
}

/** Entry point: `node bin/harmony-citation-mcp.js [citations-root]` */
export async function main(argv: string[]): Promise<void> {
    const root = argv[0] ? path.resolve(argv[0]) : path.resolve(process.cwd(), 'citations');
    await fs.mkdir(root, { recursive: true }).catch(() => { /* read-only store is fine */ });
    await serve(root, { stdin: process.stdin, stdout: process.stdout });
}
