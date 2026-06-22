/** Temporal Branch (Chronos) — Git-backed temporal branching for agent cognition
 *
 * @example
 *   invoke({ action: 'checkpoint', message: 'Before risky refactor' });
 *   invoke({ action: 'diff', branch_name: 'experiment-branch' });
 *   invoke({ action: 'merge', branch_name: 'experiment-branch', message: 'Merge experiment results' });
 */
import * as vscode from 'vscode';
import { workspaceRoot, textResult } from './shared';
import { BasePrimitive } from './basePrimitive';

interface TemporalBranchInput { action: 'checkpoint' | 'fork' | 'rollback' | 'switch' | 'list' | 'log' | 'diff' | 'merge'; branch_name?: string; message?: string; target_commit?: string; target_branch?: string; mode?: 'hard' | 'soft'; }

export class TemporalBranchTool extends BasePrimitive<TemporalBranchInput> {
    constructor() { super('temporal-branch'); }
    private _store: any = null;
    private async getStore(): Promise<any> {
        if (this._store) return this._store;
        const { TemporalStore } = await import('../temporalStore');
        const root = workspaceRoot(); if (!root) throw new Error('no workspace');
        this._store = new TemporalStore(root);
        await this._store.init();
        return this._store;
    }
    protected async invokeImpl(options: vscode.LanguageModelToolInvocationOptions<TemporalBranchInput>, token: vscode.CancellationToken) {
        const fieldErr = this.requireFields(options.input as any, ['action']);
        if (fieldErr) return textResult(JSON.stringify({ error: fieldErr }));
        const { action, branch_name, message, target_commit, target_branch, mode = 'hard' } = options.input;
        const cancelled = () => token.isCancellationRequested ? textResult(JSON.stringify({ error: 'cancelled', detail: 'Operation cancelled by user' })) : null;
        try {
            const store = await this.getStore();
            switch (action) {
                case 'checkpoint': { if (!message) return textResult(JSON.stringify({ error: 'message required' })); if (token.isCancellationRequested) return cancelled()!; const r = await store.checkpoint(message); return textResult(JSON.stringify({ status: 'checkpointed', commit: r.commit.slice(0, 8), branch: r.branch }, null, 2)); }
                case 'fork': { if (!branch_name || !message) return textResult(JSON.stringify({ error: 'branch_name and message required' })); if (token.isCancellationRequested) return cancelled()!; const r = await store.fork(branch_name, message); return textResult(JSON.stringify({ status: 'forked', branch: r.branch, commit: r.commit.slice(0, 8) }, null, 2)); }
                case 'rollback': {
                    if (!target_commit) return textResult(JSON.stringify({ error: 'target_commit required' }));
                    const dirty = await store.isDirty();
                    if (dirty && mode !== 'hard') return textResult(JSON.stringify({ error: 'WORKSPACE_DIRTY', detail: 'Uncommitted changes detected. Use mode:"hard" to force or commit/stash first.' }, null, 2));
                    if (token.isCancellationRequested) return cancelled()!;
                    const r = await store.rollback(target_commit, mode); return textResult(JSON.stringify({ status: 'rolled_back', current: r.commit.slice(0, 8), dirty_snapshot: dirty ? 'uncommitted changes were overwritten' : 'clean' }, null, 2));
                }
                case 'switch': {
                    if (!branch_name) return textResult(JSON.stringify({ error: 'branch_name required' }));
                    const dirty = await store.isDirty();
                    if (dirty) return textResult(JSON.stringify({ error: 'WORKSPACE_DIRTY', detail: 'Uncommitted changes detected. Commit or stash before switching branches.' }, null, 2));
                    if (token.isCancellationRequested) return cancelled()!;
                    const r = await store.switchTo(branch_name); return textResult(JSON.stringify({ status: 'switched', branch: r.branch, commit: r.commit.slice(0, 8) }, null, 2));
                }
                case 'list': { const branches = await store.listBranches(); return textResult(JSON.stringify({ branches }, null, 2)); }
                case 'log': { const log = await store.log(10); return textResult(JSON.stringify({ commits: log.map((e: any) => ({ oid: e.oid?.slice(0, 8), message: e.commit?.message ?? '' })) }, null, 2)); }
                case 'diff': {
                    const srcBranch = branch_name || target_branch;
                    if (!srcBranch) return textResult(JSON.stringify({ error: 'branch_name or target_branch required for diff' }));
                    const diffTarget = target_branch || (await store.listBranches()).find((b: any) => b.is_current)?.name || 'main';
                    if (token.isCancellationRequested) return cancelled()!;
                    const d = await store.diff(srcBranch, diffTarget);
                    return textResult(JSON.stringify({ source: srcBranch, target: diffTarget, files_changed: d.files_changed, commits_ahead: d.commits_ahead, commits_behind: d.commits_behind, common_ancestor: d.common_ancestor }, null, 2));
                }
                case 'merge': {
                    if (!branch_name) return textResult(JSON.stringify({ error: 'branch_name required for merge' }));
                    if (!message) return textResult(JSON.stringify({ error: 'message required for merge' }));
                    if (token.isCancellationRequested) return cancelled()!;
                    const m = await store.merge(branch_name, message);
                    return textResult(JSON.stringify({ status: m.merged ? 'merged' : 'failed', commit: m.commit.slice(0, 8), strategy: m.strategy }, null, 2));
                }
                default: return textResult(JSON.stringify({ error: `unknown action: ${action}` }));
            }
        } catch (e: any) { return textResult(JSON.stringify({ error: 'temporal branch error', detail: e?.message ?? String(e) }, null, 2)); }
    }
}
