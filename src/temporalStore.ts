/**
 * Temporal Branch Store — Chronos primitive.
 * Git-backed checkpointing for agent cognition branches.
 * Uses isomorphic-git (already a dependency).
 * 
 * MVP: checkpoint + fork + rollback
 * Later: semantic merge via deliberation
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import * as git from 'isomorphic-git';

function uid(): string { return crypto.randomUUID().slice(0, 8); }

export interface BranchState {
    episodic_memory_snapshot?: any;
    working_memory?: any;
    concert_log?: any[];
    provider_config?: any;
    message: string;
    timestamp: number;
}

export interface BranchInfo {
    name: string;
    commit: string;
    message: string;
    timestamp: number;
    is_current: boolean;
}

export class TemporalStore {
    private workspaceRoot: string;
    private gitDir: string;
    private initialized = false;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
        this.gitDir = path.join(workspaceRoot, '.harmony', 'timeline');
    }

    async init(): Promise<void> {
        if (this.initialized) return;
        await fs.mkdir(this.gitDir, { recursive: true });

        // Initialize git repo if not exists
        try {
            await git.resolveRef({ fs, dir: this.gitDir, ref: 'HEAD' });
        } catch {
            await git.init({ fs, dir: this.gitDir, defaultBranch: 'main' });
        }

        this.initialized = true;
    }

    private safeBranchName(name: string): string {
        return name.replace(/[^a-zA-Z0-9_\-]/g, '-').slice(0, 64);
    }

    // ══════════════════════════════════════════════════════════════
    // Checkpoint — save state snapshot as git commit
    // ══════════════════════════════════════════════════════════════

    async checkpoint(message: string, state?: Partial<BranchState>): Promise<{ commit: string; branch: string }> {
        await this.init();

        // Write state files
        const stateDir = this.gitDir;
        const checkpoint: BranchState = {
            message,
            timestamp: Date.now(),
            ...state,
        };

        await fs.writeFile(
            path.join(stateDir, 'checkpoint.json'),
            JSON.stringify(checkpoint, null, 2),
            'utf8'
        );

        // Stage and commit
        await git.add({ fs, dir: this.gitDir, filepath: 'checkpoint.json' });
        const sha = await git.commit({
            fs,
            dir: this.gitDir,
            message: `checkpoint: ${message}`,
            author: { name: 'Chronos', email: 'chronos@harmony.local' },
        });

        const branch = await git.currentBranch({ fs, dir: this.gitDir }) || 'main';

        return { commit: sha, branch };
    }

    // ══════════════════════════════════════════════════════════════
    // Fork — create a new branch from current state
    // ══════════════════════════════════════════════════════════════

    async fork(branchName: string, message: string): Promise<{ branch: string; commit: string }> {
        await this.init();
        const safeName = this.safeBranchName(branchName);

        // First checkpoint current state
        const { commit } = await this.checkpoint(message);

        // Create branch at current commit
        await git.branch({ fs, dir: this.gitDir, ref: safeName, checkout: false });

        return { branch: safeName, commit };
    }

    // ══════════════════════════════════════════════════════════════
    // Switch — checkout a different branch
    // ══════════════════════════════════════════════════════════════

    async switchTo(branchName: string): Promise<{ branch: string; commit: string }> {
        await this.init();
        const safeName = this.safeBranchName(branchName);

        await git.checkout({ fs, dir: this.gitDir, ref: safeName });

        const commit = await git.resolveRef({ fs, dir: this.gitDir, ref: 'HEAD' });

        return { branch: safeName, commit };
    }

    // ══════════════════════════════════════════════════════════════
    // Rollback — restore to a specific commit
    // ══════════════════════════════════════════════════════════════

    async rollback(targetCommit: string, mode: 'hard' | 'soft' = 'hard'): Promise<{ commit: string }> {
        await this.init();

        if (mode === 'hard') {
            await (git as any).reset({
                fs,
                dir: this.gitDir,
                ref: targetCommit,
                mode: 'hard',
            });
        } else {
            await (git as any).reset({
                fs,
                dir: this.gitDir,
                ref: targetCommit,
                mode: 'soft',
            });
        }

        const commit = await git.resolveRef({ fs, dir: this.gitDir, ref: 'HEAD' });

        return { commit };
    }

    // ══════════════════════════════════════════════════════════════
    // List branches
    // ══════════════════════════════════════════════════════════════

    async listBranches(): Promise<BranchInfo[]> {
        await this.init();

        const branches = await git.listBranches({ fs, dir: this.gitDir });
        const current = await git.currentBranch({ fs, dir: this.gitDir });

        const result: BranchInfo[] = [];
        for (const branch of branches) {
            try {
                const commit = await git.resolveRef({ fs, dir: this.gitDir, ref: branch });
                const log = await git.log({ fs, dir: this.gitDir, ref: branch, depth: 1 });
                result.push({
                    name: branch,
                    commit,
                    message: log[0]?.commit?.message ?? '',
                    timestamp: log[0]?.commit?.author?.timestamp ?? 0,
                    is_current: branch === current,
                });
            } catch {
                result.push({ name: branch, commit: '', message: '', timestamp: 0, is_current: false });
            }
        }

        return result;
    }

    // ══════════════════════════════════════════════════════════════
    // Get current commit
    // ══════════════════════════════════════════════════════════════

    async currentCommit(): Promise<string> {
        await this.init();
        return await git.resolveRef({ fs, dir: this.gitDir, ref: 'HEAD' });
    }

    // ══════════════════════════════════════════════════════════════
    // Check for uncommitted changes in the timeline working directory
    // ══════════════════════════════════════════════════════════════

    async isDirty(): Promise<boolean> {
        await this.init();
        try {
            const matrix = await git.statusMatrix({ fs, dir: this.gitDir });
            // Any file that is not unmodified (status 1) means dirty
            return matrix.some(([_, HEAD, WORKDIR]) => HEAD !== WORKDIR);
        } catch { return false; }
    }

    // ══════════════════════════════════════════════════════════════
    // Get log
    // ══════════════════════════════════════════════════════════════

    async log(depth = 10): Promise<any[]> {
        await this.init();
        return await git.log({ fs, dir: this.gitDir, depth });
    }

    // ══════════════════════════════════════════════════════════════
    // Diff — show changes between two branches
    // ══════════════════════════════════════════════════════════════

    async diff(sourceBranch: string, targetBranch: string): Promise<{ files_changed: string[]; commits_ahead: any[]; commits_behind: any[]; common_ancestor?: string }> {
        await this.init();
        const safeSource = this.safeBranchName(sourceBranch);
        const safeTarget = this.safeBranchName(targetBranch);

        // Get commits from each branch
        const sourceLog = await git.log({ fs, dir: this.gitDir, ref: safeSource, depth: 50 });
        const targetLog = await git.log({ fs, dir: this.gitDir, ref: safeTarget, depth: 50 });

        const sourceOids = new Set(sourceLog.map((l: any) => l.oid));
        const targetOids = new Set(targetLog.map((l: any) => l.oid));

        // Commits in source not in target
        const commits_ahead = sourceLog.filter((l: any) => !targetOids.has(l.oid)).map((l: any) => ({
            oid: l.oid?.slice(0, 8),
            message: l.commit?.message ?? '',
            timestamp: l.commit?.author?.timestamp ?? 0
        }));

        // Commits in target not in source
        const commits_behind = targetLog.filter((l: any) => !sourceOids.has(l.oid)).map((l: any) => ({
            oid: l.oid?.slice(0, 8),
            message: l.commit?.message ?? '',
            timestamp: l.commit?.author?.timestamp ?? 0
        }));

        // Find common ancestor (first shared OID)
        let common_ancestor: string | undefined;
        for (const l of sourceLog) {
            if (targetOids.has(l.oid)) { common_ancestor = l.oid; break; }
        }

        // Get file-level diff by comparing checkpoint content
        const files_changed: string[] = [];
        try {
            const sourceCommit = await git.resolveRef({ fs, dir: this.gitDir, ref: safeSource });
            const targetCommit = await git.resolveRef({ fs, dir: this.gitDir, ref: safeTarget });
            if (sourceCommit !== targetCommit) {
                try {
                    const sourceFiles = (await git.listFiles({ fs, dir: this.gitDir, ref: safeSource })).sort();
                    const targetFiles = (await git.listFiles({ fs, dir: this.gitDir, ref: safeTarget })).sort();
                    const allFiles = new Set([...sourceFiles, ...targetFiles]);
                    for (const file of allFiles) {
                        let sourceContent = '', targetContent = '';
                        try { const blob = await git.readBlob({ fs, dir: this.gitDir, oid: sourceCommit, filepath: file }); sourceContent = Buffer.from((blob as any).blob).toString('utf-8'); } catch {}
                        try { const blob = await git.readBlob({ fs, dir: this.gitDir, oid: targetCommit, filepath: file }); targetContent = Buffer.from((blob as any).blob).toString('utf-8'); } catch {}
                        if (sourceContent !== targetContent) files_changed.push(file);
                    }
                } catch { files_changed.push('checkpoint.json'); } // fallback
            }
        } catch { /* best effort */ }

        return { files_changed, commits_ahead, commits_behind, common_ancestor: common_ancestor?.slice(0, 8) };
    }

    // ══════════════════════════════════════════════════════════════
    // Merge — merge source branch into current branch
    // ══════════════════════════════════════════════════════════════

    async merge(sourceBranch: string, message: string): Promise<{ commit: string; merged: boolean; strategy: string }> {
        await this.init();
        const safeSource = this.safeBranchName(sourceBranch);
        const currentBranch = await git.currentBranch({ fs, dir: this.gitDir }) || 'main';

        // Check if merge would be trivial (fast-forward)
        const sourceCommit = await git.resolveRef({ fs, dir: this.gitDir, ref: safeSource });
        const currentCommit = await git.resolveRef({ fs, dir: this.gitDir, ref: 'HEAD' });

        // Try isomorphic-git mergeMerge
        try {
            const mergeResult = await (git as any).merge({
                fs,
                dir: this.gitDir,
                theirs: safeSource,
                author: { name: 'Chronos', email: 'chronos@harmony.local' },
                message: `merge: ${message}`
            });
            return { commit: mergeResult?.oid ?? sourceCommit, merged: true, strategy: 'merge' };
        } catch (mergeErr: any) {
            // Fast-forward fallback: reset to source commit
            if (mergeErr?.message?.includes('fast-forward') || mergeErr?.code === 'FastForwardError') {
                try {
                    await (git as any).fastForward({ fs, dir: this.gitDir, ref: safeSource });
                    return { commit: sourceCommit, merged: true, strategy: 'fast_forward' };
                } catch (ffErr: any) {
                    return { commit: currentCommit, merged: false, strategy: `failed: ${ffErr?.message ?? String(ffErr)}` };
                }
            }
            return { commit: currentCommit, merged: false, strategy: `conflict: ${mergeErr?.message ?? String(mergeErr)}` };
        }
    }
}
