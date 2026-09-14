/**
 * Versioned, idempotent data migrations for the local HarmonyHub store.
 *
 * WHY THIS EXISTS
 * The durable index store (snapshot.bincode + index-manifest.json + the embedding model
 * cache) used to live inside the extension's `globalStorage`. VS Code DELETES that
 * directory when the extension is uninstalled, so every install/uninstall cycle silently
 * destroyed a perfectly good index and forced a full re-index. Migration `0001` moves the
 * store to a stable, reinstall-proof folder beside the shared auth token (~/.harmony).
 *
 * WHY IT IS A PLATFORM, NOT A ONE-OFF
 * The same disciplines are needed by every future store change (manifest v3, schema
 * bumps, format moves). So this module provides them once:
 *   - a recorded id per migration, so re-running is a no-op (idempotent);
 *   - an on-disk ledger, so migration state is OBSERVABLE rather than buried in a log;
 *   - coordination with the owning process, so a store is never renamed out from under a
 *     live daemon (which fails on Windows and can tear a copy on any OS);
 *   - verify-then-accept, with rollback, so a new home is only adopted when it really
 *     holds a usable store;
 *   - a reversible record (from -> to), so the move can always be undone.
 *
 * This module performs no Hub I/O of its own: the caller supplies the liveness probe.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Stable id recorded in the ledger. Never reuse or renumber an applied id. */
export const HUB_DATA_RELOCATION_ID = '0001-hub-data-relocation';

export type MigrationStatus = 'applied' | 'pending' | 'failed' | 'skipped' | 'already';

export interface MigrationRecord {
    id: string;
    from: string;
    to: string;
    status: MigrationStatus;
    /** Epoch SECONDS of the last attempt (coarse, matching the manifest timestamps). */
    at: number;
    detail?: string;
}

interface MigrationLedger {
    version: 1;
    migrations: MigrationRecord[];
}

export interface RelocationDeps {
    /** Pre-0.4.16 home, inside the extension's globalStorage. */
    legacyDir: string;
    /** The reinstall-proof home we want the store to live in. */
    targetDir: string;
    /** Must be true ONLY while the Hub actually answers /status. */
    isHubRunning: () => Promise<boolean>;
    log: (message: string) => void;
    now?: () => number;
}

export interface RelocationOutcome {
    /** The directory the caller must use from now on. */
    dir: string;
    status: MigrationStatus | 'already' | 'nothing';
    detail?: string;
}

/** `~/.harmony/migrations.json` — the observable record of what has been migrated. */
export function migrationLedgerPath(): string {
    // Same override pattern as the Hub auth token, so tests never touch the real ledger.
    const override = process.env.HARMONY_MIGRATIONS_FILE;
    if (override && override.trim()) return override;
    return path.join(os.homedir(), '.harmony', 'migrations.json');
}

function readLedger(): MigrationLedger {
    try {
        const raw = JSON.parse(fs.readFileSync(migrationLedgerPath(), 'utf8'));
        if (raw && Array.isArray(raw.migrations)) {
            return { version: 1, migrations: raw.migrations as MigrationRecord[] };
        }
    } catch { /* absent or unreadable ledger simply means "nothing recorded yet" */ }
    return { version: 1, migrations: [] };
}

/** Atomic replace, so a crash mid-write cannot leave a half-written ledger. */
function writeLedger(ledger: MigrationLedger): void {
    const file = migrationLedgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
}

/** True when this migration already has a record, whatever its outcome. */
function hasRecord(id: string): boolean {
    return readLedger().migrations.some(m => m.id === id);
}

function record(rec: MigrationRecord): void {
    const ledger = readLedger();
    const i = ledger.migrations.findIndex(m => m.id === rec.id);
    if (i >= 0) {
        const prev = ledger.migrations[i];
        // Same outcome as last time: keep the ORIGINAL timestamp and leave the file alone.
        // The relocation is re-evaluated on every activation, so without this the ledger
        // would be rewritten on each window reload while saying nothing new.
        if (prev.status === rec.status && prev.from === rec.from && prev.to === rec.to && prev.detail === rec.detail) {
            return;
        }
        ledger.migrations[i] = rec;
    } else {
        ledger.migrations.push(rec);
    }
    try { writeLedger(ledger); } catch { /* ledger is observability, never a hard dependency */ }
}

/**
 * True when `dir` holds a store complete enough to serve: a non-empty snapshot, plus a
 * parseable manifest when one is present. The manifest is written LAST in the two-phase
 * commit, so "snapshot present + manifest parseable" is a sound integrity proxy.
 */
export function storeLooksUsable(dir: string): boolean {
    try {
        const snap = fs.statSync(path.join(dir, 'snapshot.bincode'));
        if (!snap.isFile() || snap.size === 0) return false;
        const manifest = path.join(dir, 'index-manifest.json');
        if (fs.existsSync(manifest)) {
            JSON.parse(fs.readFileSync(manifest, 'utf8'));
        }
        return true;
    } catch { return false; }
}

/**
 * Idempotent relocation of the durable store. Safe to call repeatedly and from any code
 * path: the steady state costs a single stat.
 */
export async function runHubDataRelocation(deps: RelocationDeps): Promise<RelocationOutcome> {
    const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    const { legacyDir, targetDir } = deps;

    // Steady state — the new home already holds a usable store. Cheapest path, no Hub probe.
    // Record it ONLY when nothing is recorded yet: a fresh install still shows the migration
    // was evaluated and resolved, while a real "applied" record from an earlier move is
    // never overwritten by a later no-op observation.
    if (storeLooksUsable(targetDir)) {
        if (!hasRecord(HUB_DATA_RELOCATION_ID)) {
            record({
                id: HUB_DATA_RELOCATION_ID, from: legacyDir, to: targetDir,
                status: 'already', at: now(),
                detail: `${targetDir} already holds a usable store`,
            });
        }
        return { dir: targetDir, status: 'already' };
    }

    // Nothing durable to move (fresh install, or the store already moved away). Not an
    // error — but it must not be SILENT either, so record it and the ledger can answer
    // "was this migration evaluated, and what did it find?" without reading logs.
    if (!fs.existsSync(path.join(legacyDir, 'snapshot.bincode'))) {
        record({
            id: HUB_DATA_RELOCATION_ID, from: legacyDir, to: targetDir,
            status: 'skipped', at: now(),
            detail: `no durable store at ${legacyDir}; nothing to relocate`,
        });
        deps.log(`[hub-data] no legacy store at ${legacyDir}; nothing to migrate (recorded as skipped).`);
        return { dir: targetDir, status: 'nothing' };
    }

    // Never rename a store the daemon holds open. Record the intent so the wait is visible.
    if (await deps.isHubRunning()) {
        record({
            id: HUB_DATA_RELOCATION_ID, from: legacyDir, to: targetDir,
            status: 'pending', at: now(), detail: 'waiting for the Hub to stop',
        });
        deps.log(`[hub-data] durable store at ${legacyDir}; migration to ${targetDir} is PENDING until the Hub stops.`);
        return { dir: legacyDir, status: 'pending' };
    }

    try {
        fs.mkdirSync(path.dirname(targetDir), { recursive: true });
        let moved = false;
        try {
            fs.renameSync(legacyDir, targetDir);
            moved = true;
        } catch (renameErr) {
            // Cross-device, or a lock we did not expect: copy instead of move.
            deps.log(`[hub-data] move failed (${(renameErr as any)?.message ?? renameErr}); copying instead.`);
            fs.cpSync(legacyDir, targetDir, { recursive: true, force: true });
        }

        if (storeLooksUsable(targetDir)) {
            record({
                id: HUB_DATA_RELOCATION_ID, from: legacyDir, to: targetDir,
                status: 'applied', at: now(), detail: moved ? 'renamed' : 'copied',
            });
            deps.log(`[hub-data] migration applied: ${legacyDir} -> ${targetDir} (the index now survives reinstall).`);
            return { dir: targetDir, status: 'applied' };
        }

        // Verification failed — do NOT accept the new home. Roll back and say so.
        try {
            if (moved) {
                fs.renameSync(targetDir, legacyDir);
            } else {
                // Keep the legacy store authoritative; park the bad copy out of the way.
                fs.renameSync(targetDir, `${targetDir}.failed-${now()}`);
            }
        } catch { /* best effort: the caller still falls back to legacyDir */ }
        record({
            id: HUB_DATA_RELOCATION_ID, from: legacyDir, to: targetDir,
            status: 'failed', at: now(), detail: 'verification failed; rolled back',
        });
        deps.log(`[hub-data] migration FAILED verification; kept ${legacyDir}.`);
        return { dir: legacyDir, status: 'failed' };
    } catch (err) {
        record({
            id: HUB_DATA_RELOCATION_ID, from: legacyDir, to: targetDir,
            status: 'failed', at: now(), detail: String((err as any)?.message ?? err),
        });
        deps.log(`[hub-data] migration error: ${(err as any)?.message ?? err}`);
        return { dir: legacyDir, status: 'failed' };
    }
}
