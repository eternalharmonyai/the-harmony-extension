/** Horizon Planner (Metis) — Strategic/tactical/operational planning
 *
 * @example
 *   invoke({ action: 'plan', goal: 'migrate to DuckDB', horizon: 'tactical', parent_id: 'roadmap-1' });
 *   invoke({ action: 'query_parent_id', parent_id: 'roadmap-1' });
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { workspaceRoot, textResult, ensureDir, uid } from './shared';
import { safeHarmonyDir, appendJsonl, readJsonl, rewriteJsonl } from '../swarmHarden';
import { concertSpeak } from '../concertHall';
import { BasePrimitive } from './basePrimitive';

interface HorizonPlan { id: string; parent_id?: string; goal: string; next_step: string; blockers: string[]; estimated_impact: string; timeline: 'tactical' | 'operational' | 'strategic'; timestamp: number; status: string; }
interface HorizonPlannerInput { action: 'plan' | 'query' | 'align' | 'stats' | 'update'; goal?: string; next_step?: string; blockers?: string[]; estimated_impact?: string; timeline?: string; parent_id?: string; query_timeline?: string; query_parent_id?: string; update_id?: string; update_status?: string; update_next_step?: string; update_blockers?: string[]; limit?: number; }

export class HorizonPlannerTool extends BasePrimitive<HorizonPlannerInput> {
    constructor() { super('horizon-planner'); }
    protected async invokeImpl(options: vscode.LanguageModelToolInvocationOptions<HorizonPlannerInput>, _token: vscode.CancellationToken) {
        const fieldErr = this.requireFields(options.input as any, ['action']);
        if (fieldErr) return textResult(JSON.stringify({ error: fieldErr }));
        const { action, goal, next_step, blockers, estimated_impact, timeline = 'tactical', parent_id, query_timeline, query_parent_id, update_id, update_status, update_next_step, update_blockers, limit = 20 } = options.input;
        const root = workspaceRoot(); if (!root) return textResult(JSON.stringify({ error: 'no workspace' }));
        const dir = safeHarmonyDir(root, 'horizon-planner'); await ensureDir(dir);
        const fp = path.join(dir, 'plans.jsonl');
        const readAll = async (): Promise<HorizonPlan[]> => { return await readJsonl(fp); };
        switch (action) {
            case 'plan': {
                if (!goal || !next_step) return textResult(JSON.stringify({ error: 'goal and next_step required' }));
                if (parent_id) { const all = await readAll(); if (!all.some(p => p.id === parent_id)) return textResult(JSON.stringify({ error: `parent plan ${parent_id} not found` })); }
                const plan: HorizonPlan = { id: uid(), parent_id, goal, next_step, blockers: blockers ?? [], estimated_impact: estimated_impact ?? 'unknown', timeline: timeline as HorizonPlan['timeline'], timestamp: Date.now(), status: 'active' };
                await appendJsonl(fp, plan);
                try { await concertSpeak('horizon', 'metis', 'Plan [' + timeline + ']: ' + goal.slice(0, 150)); } catch {}
                return textResult(JSON.stringify({ status: 'planned', id: plan.id, parent_id: plan.parent_id, timeline, next_step, goal: goal.slice(0, 200) }, null, 2));
            }
            case 'query': {
                let plans = await readAll(); if (query_timeline) plans = plans.filter(p => p.timeline === query_timeline);
                plans.sort((a, b) => b.timestamp - a.timestamp);
                if (query_parent_id) plans = plans.filter(p => p.parent_id === query_parent_id);
                return textResult(JSON.stringify({ count: Math.min(plans.length, limit), total: plans.length, plans: plans.slice(0, limit).map(p => ({ id: p.id, parent_id: p.parent_id, timeline: p.timeline, goal: p.goal.slice(0, 150), next_step: p.next_step, blockers: p.blockers })) }, null, 2));
            }
            case 'align': {
                const plans = await readAll(); const active = plans.filter(p => p.status === 'active');
                const summary = { tactical: active.filter(p => p.timeline === 'tactical').length, operational: active.filter(p => p.timeline === 'operational').length, strategic: active.filter(p => p.timeline === 'strategic').length };
                return textResult(JSON.stringify({ active_plans: active.length, by_timeline: summary, recommendation: summary.strategic === 0 ? 'Consider adding strategic plans.' : summary.tactical > summary.strategic * 3 ? 'Many tactical plans - ensure alignment with strategy.' : 'Plan distribution looks balanced.' }, null, 2));
            }
            case 'stats': {
                try {
                    const plans = await readAll();
                    const byTimeline: Record<string, number> = {}; for (const p of plans) { byTimeline[p.timeline] = (byTimeline[p.timeline] || 0) + 1; }
                    const byStatus: Record<string, number> = {}; for (const p of plans) { byStatus[p.status] = (byStatus[p.status] || 0) + 1; }
                    const withBlockers = plans.filter(p => p.blockers.length > 0).length;
                    return textResult(JSON.stringify({ total: plans.length, by_timeline: byTimeline, by_status: byStatus, blocked: withBlockers, oldest: plans.length > 0 ? new Date(plans[0].timestamp).toISOString() : 'none' }, null, 2));
                } catch (e: any) { return textResult(JSON.stringify({ error: 'stats failed', detail: e.message })); }
            }
            case 'update': {
                if (!update_id) return textResult(JSON.stringify({ error: 'update_id required' }));
                const all = await readAll();
                const plan = all.find(p => p.id === update_id);
                if (!plan) return textResult(JSON.stringify({ error: 'plan not found' }));
                if (update_status) plan.status = update_status;
                if (update_next_step) plan.next_step = update_next_step;
                if (update_blockers) plan.blockers = update_blockers;
                plan.timestamp = Date.now();
                await rewriteJsonl(fp, all);
                return textResult(JSON.stringify({ status: 'updated', id: plan.id, new_status: plan.status, next_step: plan.next_step, blockers: plan.blockers }, null, 2));
            }
            default: return textResult(JSON.stringify({ error: `unknown action: ${action}` }));
        }
    }
}
