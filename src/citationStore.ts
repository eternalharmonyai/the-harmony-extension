/**
 * File-backed store for the Harmony Citation & Archive Format v1.
 * Layout per spec §8:
 *
 *   citations/
 *     <signer>/chain.json
 *     <signer>/records/000001-<id12>.json
 *     keys/<signer>.pub
 *
 * Unlike citationRecord.ts (host-agnostic, WebCrypto only) this module does real file
 * I/O and is therefore Node-only. That split is deliberate: the format core stays
 * portable, and persistence is a host concern.
 *
 * Records are read defensively. This store is fed by files that may arrive over `git`
 * from another observer, so a malformed record is a normal condition to report — never
 * a crash, and never a reason to discard the rest of the chain.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { SignedRecord, CaptureBody, LivenessBody, LivenessVerdict } from './citationRecord';

export interface LoadedChain {
    signer: string;
    records: SignedRecord[];
    /** Files that could not be parsed — surfaced, never silently dropped. */
    malformed: { file: string; problem: string }[];
    publicKeyHex?: string;
}

export interface StoreContents {
    root: string;
    chains: LoadedChain[];
}

async function exists(p: string): Promise<boolean> {
    try { await fs.access(p); return true; } catch { return false; }
}

/** Read every observer chain under `root`. Missing store is empty, not an error. */
export async function readStore(root: string): Promise<StoreContents> {
    const chains: LoadedChain[] = [];
    if (!(await exists(root))) return { root, chains };

    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'keys') continue;
        const signer = entry.name;
        const recordsDir = path.join(root, signer, 'records');
        if (!(await exists(recordsDir))) continue;

        const chain: LoadedChain = { signer, records: [], malformed: [] };
        const pubPath = path.join(root, 'keys', `${signer}.pub`);
        if (await exists(pubPath)) {
            const text = await fs.readFile(pubPath, 'utf8');
            chain.publicKeyHex = /^public_key:\s*([0-9a-fA-F]+)$/m.exec(text)?.[1];
        }

        for (const file of (await fs.readdir(recordsDir)).filter(f => f.endsWith('.json')).sort()) {
            const full = path.join(recordsDir, file);
            try {
                const parsed = JSON.parse(await fs.readFile(full, 'utf8')) as SignedRecord;
                if (typeof parsed?.harmony_record !== 'string' || typeof parsed?.seq !== 'number') {
                    chain.malformed.push({ file, problem: 'not a citation record envelope' });
                    continue;
                }
                chain.records.push(parsed);
            } catch (e) {
                chain.malformed.push({ file, problem: (e as Error).message });
            }
        }
        chain.records.sort((a, b) => a.seq - b.seq);
        chains.push(chain);
    }
    return { root, chains };
}

export interface CaptureHit {
    signer: string;
    record: SignedRecord<CaptureBody>;
}

/**
 * Every capture of a URL, across all observers. Multiple hits with differing
 * `content_sha256` or `observer.jurisdiction` are the raw material for differential
 * retrieval — the comparison is derived here, never stored.
 */
export function capturesForUrl(store: StoreContents, url: string): CaptureHit[] {
    const out: CaptureHit[] = [];
    for (const chain of store.chains) {
        for (const rec of chain.records) {
            if (rec.harmony_record !== 'capture/1') continue;
            const body = rec.body as CaptureBody;
            if (body.url === url) out.push({ signer: chain.signer, record: rec as SignedRecord<CaptureBody> });
        }
    }
    // Newest first: the most recent capture is usually the one a caller wants.
    return out.sort((a, b) => (b.record.body.retrieved_at ?? '').localeCompare(a.record.body.retrieved_at ?? ''));
}

export function captureById(store: StoreContents, id: string): CaptureHit | undefined {
    for (const chain of store.chains) {
        for (const rec of chain.records) {
            if (rec.id === id && rec.harmony_record === 'capture/1') {
                return { signer: chain.signer, record: rec as SignedRecord<CaptureBody> };
            }
        }
    }
    return undefined;
}

export interface LivenessHit {
    signer: string;
    record: SignedRecord<LivenessBody>;
}

export function livenessRecords(
    store: StoreContents, filter: { since?: string; verdicts?: LivenessVerdict[]; url?: string } = {}
): LivenessHit[] {
    const out: LivenessHit[] = [];
    for (const chain of store.chains) {
        for (const rec of chain.records) {
            if (rec.harmony_record !== 'liveness/1') continue;
            const body = rec.body as LivenessBody;
            if (filter.url && body.url !== filter.url) continue;
            if (filter.since && body.checked_at < filter.since) continue;
            if (filter.verdicts && !filter.verdicts.includes(body.verdict)) continue;
            out.push({ signer: chain.signer, record: rec as SignedRecord<LivenessBody> });
        }
    }
    return out.sort((a, b) => (b.record.body.checked_at ?? '').localeCompare(a.record.body.checked_at ?? ''));
}

/** Append a record to an observer's chain, creating directories as needed. */
export async function appendRecord(root: string, signer: string, rec: SignedRecord): Promise<string> {
    const dir = path.join(root, signer, 'records');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${String(rec.seq).padStart(6, '0')}-${rec.id.slice(0, 12)}.json`);
    await fs.writeFile(file, JSON.stringify(rec, null, 2) + '\n', 'utf8');
    await fs.writeFile(
        path.join(root, signer, 'chain.json'),
        JSON.stringify({
            spec: 'harmony-citation/1', signer,
            keyid: rec.signature.keyid, head: rec.id, count: rec.seq,
        }, null, 2) + '\n',
        'utf8'
    );
    return file;
}
