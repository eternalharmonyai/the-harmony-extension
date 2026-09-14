/**
 * Persistent storage for the institutional index.
 *
 * `institutionalIndex.ts` is host-agnostic with zero imports; persistence needs a
 * filesystem, so it lives here — the same split as `citationRecord` / `citationStore`.
 * Both classes implement `IndexStore`, so swapping `MemoryIndexStore` for one of these is
 * a one-line change at the call site.
 *
 * WHY THIS EXISTS
 * The index was in-memory only, which had three costs and the third is the serious one:
 *   1. Lost on every extension restart.
 *   2. Every session re-harvested the same sources — repeated load on the exact
 *      repositories whose `Crawl-delay` the harvester goes out of its way to honour.
 *      A storage choice was quietly undoing the politeness design.
 *   3. Offline-first is impossible without it.
 *
 * ENTERPRISE PROPERTIES
 *   - Atomic writes (temp + rename): a crash mid-write cannot leave a torn index.
 *   - Versioned envelope: a future format change invalidates cleanly instead of being
 *     misread as valid data.
 *   - Corruption is reported, never thrown: one bad domain file must not cost the others.
 *   - Freshness is queryable. An index with no age is the same failure as a revocation
 *     with no `data_as_of` — it cannot distinguish "current" from "never refreshed".
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { IndexedDoc, IndexStore } from './institutionalIndex';

export const STORE_VERSION = 'harmony-institutional-index/1';

interface StoredEnvelope {
    store: string;
    domain: string;
    /** When this domain was last harvested (canonical instant). */
    harvested_at: string;
    count: number;
    docs: IndexedDoc[];
}

export interface DomainStats {
    domain: string;
    count: number;
    harvested_at?: string;
    ageDays?: number;
    problem?: string;
}

/** Filesystem-safe file name for a domain. */
function fileFor(root: string, domain: string): string {
    return path.join(root, domain.replace(/[^a-z0-9.-]/gi, '_') + '.json');
}

function nowInstant(): string {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * File-backed store, one JSON document per domain. Chosen over SQLite deliberately for
 * now: it is dependency-free, human-inspectable, and trivially deletable by a user who
 * wants their index gone. Move to `node:sqlite` FTS5 when a corpus outgrows in-memory
 * BM25 — the interface will not change.
 */
export class FileIndexStore implements IndexStore {
    private readonly problems = new Map<string, string>();

    constructor(private readonly root: string, private readonly maxDocsPerDomain = 50_000) {}

    async load(domain: string): Promise<IndexedDoc[]> {
        const file = fileFor(this.root, domain);
        let text: string;
        try {
            text = await fs.readFile(file, 'utf8');
        } catch {
            return []; // not harvested yet is the normal case, not an error
        }
        try {
            const env = JSON.parse(text) as StoredEnvelope;
            if (env.store !== STORE_VERSION) {
                // Refuse to guess at an unknown layout rather than misread it as data.
                this.problems.set(domain, `unknown store version "${env.store}"; re-harvest needed`);
                return [];
            }
            if (!Array.isArray(env.docs)) {
                this.problems.set(domain, 'envelope has no docs array');
                return [];
            }
            this.problems.delete(domain);
            return env.docs;
        } catch (e) {
            // One corrupt domain file must not cost the others.
            this.problems.set(domain, `corrupt index file: ${(e as Error).message}`);
            return [];
        }
    }

    async save(domain: string, docs: IndexedDoc[]): Promise<void> {
        await fs.mkdir(this.root, { recursive: true });
        const capped = docs.length > this.maxDocsPerDomain ? docs.slice(0, this.maxDocsPerDomain) : docs;
        const envelope: StoredEnvelope = {
            store: STORE_VERSION,
            domain,
            harvested_at: nowInstant(),
            count: capped.length,
            docs: capped,
        };
        const file = fileFor(this.root, domain);
        const tmp = `${file}.${process.pid}.tmp`;
        // Atomic: a crash between these two lines leaves the previous index intact.
        await fs.writeFile(tmp, JSON.stringify(envelope), 'utf8');
        await fs.rename(tmp, file);
        this.problems.delete(domain);
    }

    /** Freshness and health, so a UI can say "3 days old" instead of implying "current". */
    async stats(domains: string[]): Promise<DomainStats[]> {
        const out: DomainStats[] = [];
        for (const domain of domains) {
            const file = fileFor(this.root, domain);
            try {
                const env = JSON.parse(await fs.readFile(file, 'utf8')) as StoredEnvelope;
                const harvested = env.harvested_at;
                const ageDays = harvested
                    ? Math.floor((Date.now() - Date.parse(harvested)) / 86_400_000)
                    : undefined;
                out.push({
                    domain, count: env.count ?? env.docs?.length ?? 0,
                    harvested_at: harvested, ageDays,
                    problem: this.problems.get(domain),
                });
            } catch {
                out.push({ domain, count: 0, problem: this.problems.get(domain) ?? 'not harvested' });
            }
        }
        return out;
    }

    /** Remove a domain's index. Users must be able to delete what they stored. */
    async clear(domain: string): Promise<void> {
        try { await fs.rm(fileFor(this.root, domain), { force: true }); } catch { /* already gone */ }
        this.problems.delete(domain);
    }
}

/**
 * A read-only base layer with a writable overlay.
 *
 * This is what makes a SHIPPED index possible: a prebuilt corpus bundled in the VSIX
 * (read-only, in the extension directory) plus whatever the user harvests locally
 * (writable). Reads merge, writes only ever touch the overlay — so an extension update
 * that replaces the bundle cannot destroy a user's own harvest, and a user's harvest
 * cannot corrupt the shipped baseline.
 *
 * Overlay wins on conflict: a locally re-harvested document is newer than the bundle.
 */
export class LayeredIndexStore implements IndexStore {
    constructor(private readonly base: IndexStore, private readonly overlay: IndexStore) {}

    async load(domain: string): Promise<IndexedDoc[]> {
        const [bundled, local] = await Promise.all([
            this.base.load(domain).catch(() => [] as IndexedDoc[]),
            this.overlay.load(domain).catch(() => [] as IndexedDoc[]),
        ]);
        if (local.length === 0) return bundled;
        if (bundled.length === 0) return local;
        const byId = new Map<string, IndexedDoc>();
        for (const d of bundled) byId.set(d.id, d);
        for (const d of local) byId.set(d.id, d); // overlay wins
        return [...byId.values()];
    }

    /** Writes never reach the base layer — the shipped bundle stays pristine. */
    async save(domain: string, docs: IndexedDoc[]): Promise<void> {
        return this.overlay.save(domain, docs);
    }
}

/**
 * The two-layer corpus: a standing library plus a project working set.
 *
 * These are different things, not a compromise between two options:
 *   shared   ~/.harmony/index/       sources you always want. Harvested ONCE and shared
 *                                    across every workspace and every host — extension,
 *                                    CLI, Tauri. This is what keeps a polite crawl-delay
 *                                    meaningful: each source gets fetched once, not once
 *                                    per project.
 *   project  <workspace>/.harmony/index/   this project's corpus, travelling with the repo.
 *
 * Reads merge with the project layer winning; writes only ever touch the project layer when
 * one is present, so a per-project harvest can never mutate the shared library.
 */
export function createLayeredFileStore(sharedRoot: string, projectRoot?: string): IndexStore {
    const shared = new FileIndexStore(sharedRoot);
    return projectRoot ? new LayeredIndexStore(shared, new FileIndexStore(projectRoot)) : shared;
}
