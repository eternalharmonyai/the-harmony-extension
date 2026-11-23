/**
 * Collaborator Workspace — L0 physical isolation.
 *
 * The one structural safeguard in the Collaborator safety architecture: a
 * Collaborator never writes to the Conductor's working tree. Each run gets its own
 * `git worktree` in its own directory on its own scratch branch, so a runaway or
 * misbehaving run can only damage its own sandbox.
 *
 * Design decisions ratified by the project owner (2026-11-08):
 *   - worktrees live in `.harmony/collab/worktrees/` (inside the repo, one place to look)
 *   - retention is 90 days, and expiry is ANNOUNCED, never silent
 *
 * Two invariants this module exists to enforce:
 *
 *   1. P1 — a run can never escape its own sandbox. Run ids are validated and every
 *      derived path is proven to stay inside the worktrees root. A run id of
 *      `../../etc` is refused, not sanitised.
 *
 *   2. P2 — nothing is deleted by accident. Runs move created → active → completed →
 *      archived and are RETAINED. Even pruning only ever produces a plan; the caller
 *      must execute it deliberately.
 *
 * No `vscode` import, so scripts/check-collaborator-workspace.js can test the real
 * compiled output rather than a hand-mirrored copy.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

// ── Constants ──────────────────────────────────────────────────────────────

/** Repo-relative root for all Collaborator sandboxes. */
export const COLLAB_ROOT = '.harmony/collab';

/** Repo-relative directory holding one worktree per run. */
export const WORKTREES_DIR = `${COLLAB_ROOT}/worktrees`;

/** Default retention window, in days. Ratified by the project owner. */
export const RETENTION_DAYS = 90;

/** Marker file proving a directory is a Harmony-managed worktree. */
export const RUN_MARKER = 'harmony-collab-run.json';

/**
 * Run ids become path segments and git branch names, so they are restricted to
 * lowercase alphanumerics and hyphens. This is a validation, not an escape: an
 * invalid id is refused outright rather than cleaned up, because sanitising input
 * that reaches a filesystem path is how traversal bugs survive review.
 */
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

export type RunStatus = 'created' | 'active' | 'completed' | 'archived';

export interface RunRecord {
    runId: string;
    /** Branch checked out in the worktree, e.g. `collab/<runId>`. */
    branch: string;
    /** Commit the worktree was created from — the provable "known good" base. */
    baseCommit: string;
    /** ISO timestamp of creation. */
    createdAt: string;
    status: RunStatus;
    /** Absolute worktree path. */
    path: string;
    /** Collaborator role that owns the run, when known. */
    role?: string;
    /** Human label for the work, when known. */
    label?: string;
}

// ── Identity ───────────────────────────────────────────────────────────────

export function isValidRunId(runId: string): boolean {
    return typeof runId === 'string' && RUN_ID_PATTERN.test(runId);
}

export function assertValidRunId(runId: string): void {
    if (!isValidRunId(runId)) {
        throw new Error(
            `invalid run id ${JSON.stringify(runId)}: must match ${RUN_ID_PATTERN} ` +
            `(lowercase letters, digits, hyphens; 3-64 chars). Refused rather than sanitised.`
        );
    }
}

/** Deterministic, sortable run id: `r-<epoch-ms>-<short suffix>`. */
export function makeRunId(now: number = Date.now(), suffix?: string): string {
    const tail = (suffix ?? Math.random().toString(36).slice(2, 8)).toLowerCase().replace(/[^a-z0-9]/g, '');
    const id = `r-${now}-${tail}`.slice(0, 64);
    assertValidRunId(id);
    return id;
}

export function branchForRun(runId: string): string {
    assertValidRunId(runId);
    return `collab/${runId}`;
}

// ── Path safety ────────────────────────────────────────────────────────────

/**
 * Resolve the absolute worktree path for a run, proving containment.
 *
 * This is the function that makes P1 real. It refuses (never rewrites) any input
 * that would resolve outside the worktrees root, so `..`, absolute paths, and
 * drive-letter tricks all fail closed.
 */
export function worktreePathFor(workspaceRoot: string, runId: string): string {
    assertValidRunId(runId);
    const base = path.resolve(workspaceRoot, WORKTREES_DIR);
    const target = path.resolve(base, runId);
    const withSep = base.endsWith(path.sep) ? base : base + path.sep;
    if (target !== base && !target.startsWith(withSep)) {
        throw new Error(`refused: run id ${JSON.stringify(runId)} resolves outside ${WORKTREES_DIR}`);
    }
    return target;
}

/** True when `candidate` sits inside the worktrees root. Used to vet recorded paths. */
export function isInsideCollabRoot(workspaceRoot: string, candidate: string): boolean {
    const base = path.resolve(workspaceRoot, WORKTREES_DIR);
    const resolved = path.resolve(candidate);
    const withSep = base.endsWith(path.sep) ? base : base + path.sep;
    return resolved === base || resolved.startsWith(withSep);
}

// ── Status transitions ─────────────────────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
    created: ['active', 'archived'],
    active: ['completed', 'archived'],
    completed: ['archived'],
    archived: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
    return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Archiving is not deletion. There is deliberately no `deleted` status: a run's
 * bytes are retained until an explicit prune that has passed the retention gate.
 */
export function assertTransition(from: RunStatus, to: RunStatus): void {
    if (!canTransition(from, to)) {
        throw new Error(`illegal run transition ${from} -> ${to} (archived runs are terminal)`);
    }
}

// ── Retention ──────────────────────────────────────────────────────────────

export interface RetentionPlan {
    /** Runs old enough to prune. Nothing has been removed. */
    expired: RunRecord[];
    /** Runs still inside the window. */
    retained: RunRecord[];
    /** Runs with an unreadable or missing timestamp — never auto-expired. */
    unknownAge: RunRecord[];
    retentionDays: number;
    /** Human-readable summary. Always non-empty, so expiry is never silent. */
    announcement: string;
}

/**
 * Work out what retention *would* remove. Purely a plan — this function never
 * deletes anything, which is what keeps "never fired by accident" true.
 *
 * A run with an unparseable timestamp is classified `unknownAge` and excluded from
 * expiry: an unreadable date must not be treated as "very old".
 */
export function planRetention(
    runs: RunRecord[],
    options: { now?: number; retentionDays?: number } = {}
): RetentionPlan {
    const now = options.now ?? Date.now();
    const retentionDays = options.retentionDays ?? RETENTION_DAYS;
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;

    const expired: RunRecord[] = [];
    const retained: RunRecord[] = [];
    const unknownAge: RunRecord[] = [];

    for (const run of runs) {
        const created = Date.parse(run.createdAt);
        if (!Number.isFinite(created)) {
            unknownAge.push(run);
            continue;
        }
        if (created <= cutoff) expired.push(run);
        else retained.push(run);
    }

    const parts = [
        `${retained.length} run(s) retained (within ${retentionDays} days)`,
        `${expired.length} run(s) past ${retentionDays} days and eligible for prune`,
    ];
    if (unknownAge.length > 0) {
        parts.push(`${unknownAge.length} run(s) with unreadable timestamps kept deliberately`);
    }
    return {
        expired,
        retained,
        unknownAge,
        retentionDays,
        announcement:
            `${parts.join('; ')}. ` +
            `Nothing has been removed — pruning requires an explicit, confirmed action.`,
    };
}

// ── Git execution (injectable so the gate can run without touching git) ────

export interface GitRunner {
    (args: string[], cwd: string): string;
}

export const defaultGitRunner: GitRunner = (args, cwd) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();

export interface CreateWorktreeOptions {
    workspaceRoot: string;
    runId: string;
    /** Ref the sandbox is created from. Defaults to HEAD. */
    baseRef?: string;
    role?: string;
    label?: string;
    git?: GitRunner;
    now?: number;
}

/**
 * Create an isolated worktree for one Collaborator run.
 *
 * The base commit is resolved *first* and recorded in the run record, so the
 * "known good" starting point is provable later rather than assumed.
 */
export function createRunWorktree(options: CreateWorktreeOptions): RunRecord {
    const git = options.git ?? defaultGitRunner;
    const root = options.workspaceRoot;
    const runId = options.runId;
    const target = worktreePathFor(root, runId);
    const branch = branchForRun(runId);

    const baseCommit = git(['rev-parse', options.baseRef ?? 'HEAD'], root).trim();
    if (!/^[0-9a-f]{7,40}$/.test(baseCommit)) {
        throw new Error(`refused: could not resolve a valid base commit (got ${JSON.stringify(baseCommit)})`);
    }

    // `git worktree add -b <branch> <path> <commit>` — the new branch points at the
    // resolved base, so the sandbox starts from exactly the commit we recorded.
    if (git === defaultGitRunner) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
    }
    git(['worktree', 'add', '-b', branch, target, baseCommit], root);

    return {
        runId,
        branch,
        baseCommit,
        createdAt: new Date(options.now ?? Date.now()).toISOString(),
        status: 'created',
        path: target,
        role: options.role,
        label: options.label,
    };
}

/** List worktrees git knows about. Read-only. */
export function listWorktrees(workspaceRoot: string, git: GitRunner = defaultGitRunner): string[] {
    const out = git(['worktree', 'list', '--porcelain'], workspaceRoot);
    return out
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length).trim());
}

/**
 * Remove a worktree directory from git's bookkeeping.
 *
 * Refuses anything outside the collab root, so a bad record can never turn this
 * into an arbitrary delete. This is the only removal primitive in the module and it
 * is never called implicitly.
 */
export function removeRunWorktree(
    workspaceRoot: string,
    runId: string,
    options: { force?: boolean; git?: GitRunner } = {}
): string {
    const git = options.git ?? defaultGitRunner;
    const target = worktreePathFor(workspaceRoot, runId);
    if (!isInsideCollabRoot(workspaceRoot, target)) {
        throw new Error(`refused: ${target} is outside ${WORKTREES_DIR}`);
    }
    const args = ['worktree', 'remove', target];
    if (options.force) args.push('--force');
    return git(args, workspaceRoot);
}

/** Human-readable one-liner for a run, used in chat and receipts. */
export function describeRun(run: RunRecord): string {
    const label = run.label ? ` — ${run.label}` : '';
    const role = run.role ? ` [${run.role}]` : '';
    return `${run.runId}${role}${label}: ${run.status}, base ${run.baseCommit.slice(0, 8)}, branch ${run.branch}`;
}

// ── Lazy runs (decision 6) ─────────────────────────────────────────────────

/**
 * A run record whose base commit is not yet resolved.
 *
 * `git worktree add` checks out the whole tree, so materialising a worktree on every
 * dispatch would be slow and disk-heavy for no benefit while Collaborators are
 * read-only. A run *record* is therefore free: it touches no git, creates no directory,
 * and can be written on every single dispatch. The worktree is created only on first
 * write intent, and that is when the base commit is resolved and recorded.
 */
export function createLazyRun(options: {
    role?: string;
    label?: string;
    runId?: string;
    now?: number;
} = {}): RunRecord {
    const runId = options.runId ?? makeRunId(options.now);
    assertValidRunId(runId);
    return {
        runId,
        branch: branchForRun(runId),
        // Empty means "not yet resolved". Resolved at materialisation, never guessed.
        baseCommit: '',
        createdAt: new Date(options.now ?? Date.now()).toISOString(),
        status: 'created',
        path: '',
        role: options.role,
        label: options.label,
    };
}

/** True once the base commit has been resolved (i.e. the worktree was materialised). */
export function hasResolvedBase(run: RunRecord): boolean {
    return typeof run.baseCommit === 'string' && /^[0-9a-f]{7,40}$/.test(run.baseCommit);
}

// ── Run store ──────────────────────────────────────────────────────────────

/** Repo-relative path of the run ledger. */
export const RUNS_FILE = `${COLLAB_ROOT}/runs.json`;

/** Keep the ledger bounded so it cannot grow without limit. */
export const MAX_RUNS_KEPT = 500;

export function runsFilePath(workspaceRoot: string): string {
    return path.resolve(workspaceRoot, RUNS_FILE);
}

/**
 * Load run records, tolerating a missing or corrupt file.
 *
 * A corrupt ledger must not stop dispatch, but it must not be silently swallowed
 * either — the caller receives whatever could be salvaged plus a warning it can show.
 */
export function loadRuns(workspaceRoot: string): { runs: RunRecord[]; warning?: string } {
    const file = runsFilePath(workspaceRoot);
    try {
        if (!fs.existsSync(file)) return { runs: [] };
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return { runs: [], warning: `${RUNS_FILE} did not contain an array; ignoring it.` };
        const runs = parsed.filter(
            (r): r is RunRecord => !!r && typeof r === 'object' && typeof r.runId === 'string' && isValidRunId(r.runId)
        );
        const dropped = parsed.length - runs.length;
        return dropped > 0
            ? { runs, warning: `${dropped} malformed run record(s) skipped in ${RUNS_FILE}.` }
            : { runs };
    } catch (err) {
        const msg = err && (err as Error).message ? (err as Error).message : String(err);
        return { runs: [], warning: `Could not read ${RUNS_FILE}: ${msg}` };
    }
}

/**
 * Persist a run record, newest last, bounded to MAX_RUNS_KEPT.
 *
 * Writing is the owning code's job (AGENTS.md rule 2): this file is only ever written
 * here, never hand-edited. Returns the number of records written.
 */
export function saveRun(workspaceRoot: string, run: RunRecord): number {
    assertValidRunId(run.runId);
    const file = runsFilePath(workspaceRoot);
    const existing = loadRuns(workspaceRoot).runs.filter((r) => r.runId !== run.runId);
    const next = [...existing, run].slice(-MAX_RUNS_KEPT);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
    return next.length;
}

/**
 * Materialise the sandbox for an existing lazy run, resolving its base commit.
 *
 * This is the point where a read-only advisory run becomes capable of holding writes —
 * so it is also the point at which the base commit becomes provable.
 */
export function materializeRun(
    workspaceRoot: string,
    run: RunRecord,
    options: { baseRef?: string; git?: GitRunner } = {}
): RunRecord {
    const git = options.git ?? defaultGitRunner;
    const expectedBranch = branchForRun(run.runId);
    if (run.branch && run.branch !== expectedBranch) {
        throw new Error(
            `refused: run branch ${JSON.stringify(run.branch)} does not match expected ${JSON.stringify(expectedBranch)}`
        );
    }
    const baseCommit = git(['rev-parse', options.baseRef ?? 'HEAD'], workspaceRoot).trim();
    if (!/^[0-9a-f]{7,40}$/.test(baseCommit)) {
        throw new Error(`refused: could not resolve a valid base commit (got ${JSON.stringify(baseCommit)})`);
    }
    const target = worktreePathFor(workspaceRoot, run.runId);
    if (git === defaultGitRunner) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
    }
    git(['worktree', 'add', '-b', expectedBranch, target, baseCommit], workspaceRoot);
    return { ...run, branch: expectedBranch, baseCommit, path: target };
}

/**
 * Look up a saved run by id, materialise its isolated git worktree if not yet
 * materialised, transition its status to `active`, write the RUN_MARKER inside
 * the worktree when the directory exists on disk, and persist the updated record.
 *
 * Calling this on an already-materialised `active` run is idempotent and returns
 * the existing record without running `git worktree add` a second time.
 * Calling this on an `archived` or `completed` run is refused by `assertTransition`.
 */
export function materializeRunById(
    workspaceRoot: string,
    runId: string,
    options: { baseRef?: string; git?: GitRunner } = {}
): { run: RunRecord; alreadyMaterialized: boolean; description: string } {
    assertValidRunId(runId);
    const { runs, warning } = loadRuns(workspaceRoot);
    const existing = runs.find((r) => r.runId === runId);
    if (!existing) {
        const suffix = warning ? ` (ledger warning: ${warning})` : '';
        throw new Error(`refused: run ${JSON.stringify(runId)} not found in ${RUNS_FILE}${suffix}`);
    }
    if (existing.status !== 'active') {
        assertTransition(existing.status, 'active');
    }
    if (hasResolvedBase(existing) && existing.path && isInsideCollabRoot(workspaceRoot, existing.path)) {
        return {
            run: existing,
            alreadyMaterialized: true,
            description: describeRun(existing),
        };
    }
    const materialized = materializeRun(workspaceRoot, existing, options);
    const activeRun: RunRecord = {
        ...materialized,
        status: 'active',
    };
    try {
        if (fs.existsSync(activeRun.path)) {
            fs.writeFileSync(
                path.join(activeRun.path, RUN_MARKER),
                JSON.stringify(activeRun, null, 2),
                'utf8'
            );
        }
    } catch {
        // Marker write is best-effort if the git runner is a dry-run stub in tests.
    }
    saveRun(workspaceRoot, activeRun);
    return {
        run: activeRun,
        alreadyMaterialized: false,
        description: describeRun(activeRun),
    };
}

