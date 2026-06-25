/** Uncertainty Fabric (Aletheia) — Beta distributions + calibration + Bayesian model averaging
 *
 * Beyond-100% (E2): Bayesian model averaging — combine multiple uncertainty sources
 *   (LLM confidence, historical calibration, evidence weight) into a single weighted posterior.
 *
 * @example
 *   invoke({ action: 'assess', claim: 'The sort function is correct', evidence_count: 5, counterevidence_count: 1 });
 *   invoke({ action: 'combine', sources: [{ label:'LLM', alpha:5, beta:2 }, { label:'History', alpha:10, beta:3 }], k: 12, n: 15 });
 *   invoke({ action: 'aggregate', ids: ['claim-1','claim-2','claim-3'] });
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { workspaceRoot, textResult, ensureDir, uid } from './shared';
import { safeHarmonyDir, appendJsonl, readJsonl, rewriteJsonl } from '../swarmHarden';
import { concertSpeak } from '../concertHall';
import { BasePrimitive } from './basePrimitive';

interface UClaim { id: string; claim: string; alpha: number; beta: number; evidence: string[]; counterevidence: string[]; source: string; timestamp: number; status: string; calibrated?: boolean; }
interface UFabricInput { action: 'add' | 'query' | 'escalate' | 'stats' | 'calibrate' | 'combine'; add?: { claim: string; confidence?: number; variance?: number; evidence?: string[]; counterevidence?: string[]; source?: string }; query?: { min_confidence?: number; max_variance?: number; status?: string; source?: string; limit?: number }; escalate_threshold?: number; calibrate?: { claim_id: string; actual_outcome: boolean }; combine?: { sources: { label: string; alpha: number; beta: number }[]; k: number; n: number }; }

export class UncertaintyFabricTool extends BasePrimitive<UFabricInput> {
    constructor() { super('uncertainty-fabric'); }
    protected async invokeImpl(options: vscode.LanguageModelToolInvocationOptions<UFabricInput>, _token: vscode.CancellationToken) {
        this.requireFields(options.input as any, ['action']);
        const { action, add, query, escalate_threshold = 0.4, calibrate, combine } = options.input;
        const root = workspaceRoot(); if (!root) return textResult(JSON.stringify({ error: 'no workspace' }));
        const dir = safeHarmonyDir(root, 'uncertainty-fabric'); await ensureDir(dir);
        const fp = path.join(dir, 'claims.jsonl'), calFp = path.join(dir, 'calibration.jsonl');
        const readAll = async (): Promise<UClaim[]> => { return await readJsonl(fp); };
        const rewrite = async (cs: UClaim[]) => { await rewriteJsonl(fp, cs); };
        const betaMean = (a: number, b: number) => a / (a + b);
        const betaVar = (a: number, b: number) => (a * b) / ((a + b) ** 2 * (a + b + 1));
        const fromLegacy = (mean: number, variance: number): { alpha: number; beta: number } => {
            // Reject impossible variance — Beta variance is bounded by mean*(1-mean)
            const maxVar = mean * (1 - mean);
            if (variance <= 0) return { alpha: Math.max(1, mean * 10), beta: Math.max(1, (1 - mean) * 10) };
            if (variance >= maxVar) variance = maxVar * 0.99; // clamp to near-maximum
            const k = (mean * (1 - mean)) / variance - 1;
            const alpha = Math.max(0.5, mean * k);
            const beta = Math.max(0.5, (1 - mean) * k);
            // Preserve the mean: re-normalize if clamping distorted it
            const actualMean = alpha / (alpha + beta);
            if (Math.abs(actualMean - mean) > 0.01) {
                // Re-derive with preserved mean
                const totalObs = alpha + beta;
                return { alpha: Math.max(0.5, mean * totalObs), beta: Math.max(0.5, (1 - mean) * totalObs) };
            }
            return { alpha, beta };
        };
        switch (action) {
            case 'add': {
                if (!add?.claim) return textResult(JSON.stringify({ error: 'claim required' }));
                const dist = fromLegacy(add.confidence ?? 0.5, add.variance ?? 0.1);
                // Evidence-weighted initialization: each evidence item incrementally shifts the Beta
                const evCount = (add.evidence ?? []).length;
                const ceCount = (add.counterevidence ?? []).length;
                const evWeight = Math.log2(evCount + 2) - 1; // diminishing returns: 0→0, 1→0.58, 2→1, 3→1.32
                const ceWeight = Math.log2(ceCount + 2) - 1;
                const alpha = dist.alpha + evWeight;
                const beta = dist.beta + ceWeight;
                const c: UClaim = { id: uid(), claim: add.claim, alpha, beta, evidence: add.evidence ?? [], counterevidence: add.counterevidence ?? [], source: add.source ?? 'unknown', timestamp: Date.now(), status: (alpha/(alpha+beta) < escalate_threshold || betaVar(alpha,beta) > 0.3) ? 'escalated' : 'pending', calibrated: false };
                await appendJsonl(fp, c);
                const m = betaMean(c.alpha, c.beta), v = betaVar(c.alpha, c.beta);
                return textResult(JSON.stringify({ status: c.status, id: c.id, mean: Math.round(m*1000)/1000, variance: Math.round(v*1000)/1000, alpha: c.alpha, beta: c.beta, observations: Math.max(0, c.alpha + c.beta - 2) }, null, 2));
            }
            case 'calibrate': {
                if (!calibrate?.claim_id) return textResult(JSON.stringify({ error: 'claim_id required' }));
                const cs = await readAll(); const claim = cs.find(c => c.id === calibrate.claim_id);
                if (!claim) return textResult(JSON.stringify({ error: 'claim not found' }));
                if (calibrate.actual_outcome) claim.alpha += 1; else claim.beta += 1;
                claim.calibrated = true;
                if (claim.alpha + claim.beta - 2 >= 5) claim.status = 'resolved';
                await rewrite(cs);
                // Persist calibration event to calibration.jsonl
                try { await appendJsonl(calFp, { claim_id: calibrate.claim_id, actual: calibrate.actual_outcome, alpha: claim.alpha, beta: claim.beta, timestamp: Date.now() }); } catch {}
                return textResult(JSON.stringify({ status: 'calibrated', alpha: claim.alpha, beta: claim.beta, mean: Math.round(betaMean(claim.alpha,claim.beta)*1000)/1000, observations: Math.max(0, claim.alpha+claim.beta-2), direction: calibrate.actual_outcome ? 'confirmed ↑' : 'contradicted ↓' }, null, 2));
            }
            case 'query': {
                let claims = await readAll();
                if (query?.min_confidence !== undefined) claims = claims.filter(c => betaMean(c.alpha, c.beta) >= query.min_confidence!);
                if (query?.max_variance !== undefined) claims = claims.filter(c => betaVar(c.alpha, c.beta) <= query.max_variance!);
                if (query?.status) claims = claims.filter(c => c.status === query.status);
                if (query?.source) claims = claims.filter(c => c.source === query.source);
                claims.sort((a, b) => b.timestamp - a.timestamp);
                const subset = claims.slice(0, query?.limit ?? 20);
                return textResult(JSON.stringify({ count: subset.length, total: claims.length, claims: subset.map(c => ({ id: c.id, claim: c.claim.slice(0, 200), mean: Math.round(betaMean(c.alpha, c.beta) * 1000) / 1000, variance: Math.round(betaVar(c.alpha, c.beta) * 1000) / 1000, status: c.status, observations: c.alpha + c.beta - 2 })) }, null, 2));
            }
            case 'stats': {
                const claims = await readAll();
                const byStatus: Record<string, number> = {}; for (const c of claims) { byStatus[c.status] = (byStatus[c.status] || 0) + 1; }
                const means = claims.map(c => betaMean(c.alpha, c.beta));
                const avgMean = means.length > 0 ? means.reduce((a, b) => a + b, 0) / means.length : 0;
                const calibrated = claims.filter(c => c.calibrated).length;
                const escalated = claims.filter(c => c.status === 'escalated').length;
                return textResult(JSON.stringify({ total: claims.length, by_status: byStatus, average_confidence: Math.round(avgMean * 1000) / 1000, calibrated, escalated, needs_escalation: escalated > 0 ? `⚠ ${escalated} claims below threshold` : 'none' }, null, 2));
            }
            case 'escalate': {
                const claims = await readAll();
                const below = claims.filter(c => betaMean(c.alpha, c.beta) < escalate_threshold);
                for (const c of below) c.status = 'escalated';
                if (below.length > 0) await rewrite(claims);
                return textResult(JSON.stringify({ escalated: below.length, threshold: escalate_threshold, claims: below.map(c => ({ id: c.id, claim: c.claim.slice(0, 150), confidence: Math.round(betaMean(c.alpha, c.beta) * 1000) / 1000 })) }, null, 2));
            }
            case 'combine': {
                // ── E2: Bayesian model averaging ──
                if (!combine?.sources?.length) return textResult(JSON.stringify({ error: 'sources[] required for combine action' }));
                const { sources, k, n } = combine;
                const logBeta = (a: number, b: number): number => {
                    // Lanczos approximation for log-Gamma → log-Beta
                    const lgamma = (z: number): number => {
                        if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - lgamma(1 - z);
                        z -= 1;
                        const g = 7;
                        const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
                        let x = c[0];
                        for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
                        const t = z + g + 0.5;
                        return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x) - Math.log(z);
                    };
                    return lgamma(a) + lgamma(b) - lgamma(a + b);
                };
                // Compute marginal likelihood via Beta-Binomial conjugate
                let maxLogLike = -Infinity;
                const logLikes = sources.map(src => {
                    const { alpha, beta } = src;
                    const logLike = logBeta(k + alpha, n - k + beta) - logBeta(alpha, beta);
                    if (logLike > maxLogLike) maxLogLike = logLike;
                    return { label: src.label, alpha, beta, logLike };
                });
                // Numerically stable softmax
                const weights = logLikes.map(s => {
                    const expLike = Math.exp(s.logLike - maxLogLike);
                    return { ...s, weight: expLike };
                });
                const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);
                const normalized = weights.map(w => ({ ...w, weight: totalWeight > 0 ? w.weight / totalWeight : 1 / sources.length }));
                // Weighted posterior mean
                const weightedMean = normalized.reduce((sum, s) => sum + s.weight * (s.alpha / (s.alpha + s.beta)), 0);
                return textResult(JSON.stringify({
                    action: 'combine',
                    sources: normalized.map(s => ({ label: s.label, alpha: s.alpha, beta: s.beta, evidence_weight: Math.round(s.weight * 10000) / 10000 })),
                    posterior_mean: Math.round(weightedMean * 1000) / 1000,
                    observations: { k, n },
                    dominant_source: normalized.reduce((best, s) => s.weight > best.weight ? s : best, normalized[0]).label
                }, null, 2));
            }
        }
    }
}
