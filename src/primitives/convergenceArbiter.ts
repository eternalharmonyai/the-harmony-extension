/**
 * Convergence Arbiter (Kairos) — TF-IDF weighted n-gram convergence detection.
 * Deterministic tier → LLM fallback → Conductor escalation pipeline.
 *
 * Beyond-100% (E7): Multi-dimensional convergence — structural similarity (section/block count),
 *   semantic keyword overlap, cost-weighted scoring — blended with text similarity.
 *
 * @example
 *   invoke({ action: 'assess', proposals: ['Plan A text', 'Plan B text'], threshold: 0.7 });
 *   // => { converged, similarity, recommendation, tier }
 *   invoke({ action: 'calibrate', session_id: 'ses-1', actual_converged: true });
 *   invoke({ action: 'stats' });
 *   // => { total_sessions, accuracy_pct, youdens_j_max, optimal_threshold, calibration_quality }
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { concertSpeak, concertCheck } from '../concertHall';
import { workspaceRoot, textResult, ensureDir } from './shared';
import { safeHarmonyDir, appendJsonl, readJsonl } from '../swarmHarden';
import { consult } from '../providers';
import { BasePrimitive } from './basePrimitive';

interface CalibrationEntry { session_id: string; signal: string; actual_converged: boolean; mean_similarity: number; info_gain: number; rounds: number; timestamp: number; threshold_used?: number; }

interface ConvergenceArbiterInput { 
    room?: string; proposals?: string[]; threshold?: number; 
    max_rounds?: number; current_round?: number; 
    allow_llm_fallback?: boolean; max_fallback_attempts?: number;
    action?: 'assess' | 'calibrate' | 'stats';
    session_id?: string; actual_converged?: boolean;
}

export class ConvergenceArbiterTool extends BasePrimitive<ConvergenceArbiterInput> {
    constructor(private readonly secrets?: vscode.SecretStorage) { super('convergence-arbiter'); }
    
    protected async invokeImpl(options: vscode.LanguageModelToolInvocationOptions<ConvergenceArbiterInput>, token: vscode.CancellationToken) {
        const { action = 'assess', room, proposals: raw, threshold = 0.3, max_rounds = 11, current_round = 1, session_id, actual_converged } = options.input;
        
        // Calibration log operations
        if (action === 'calibrate' || action === 'stats') {
            const root = workspaceRoot(); if (!root) return textResult(JSON.stringify({ error: 'no workspace' }));
            const dir = safeHarmonyDir(root, 'kairos-calibration'); await ensureDir(dir);
            const cfp = path.join(dir, 'calibration.jsonl');
            
            if (action === 'calibrate') {
                if (!session_id) return textResult(JSON.stringify({ error: 'session_id required for calibration' }));
                const entry: CalibrationEntry = {
                    session_id, signal: options.input.room ? 'from_room' : 'manual',
                    actual_converged: actual_converged ?? false,
                    mean_similarity: 0, info_gain: 0, rounds: current_round, timestamp: Date.now(),
                    threshold_used: threshold
                };
                await appendJsonl(cfp, entry);
                return textResult(JSON.stringify({ status: 'calibrated', session_id, actual_converged: entry.actual_converged, threshold_used: threshold }, null, 2));
            }
            
            if (action === 'stats') {
                try {
                    const entries = await readJsonl<CalibrationEntry>(cfp);
                    if (entries.length === 0) return textResult(JSON.stringify({ total_sessions: 0, accuracy_pct: 0, note: 'No calibration data yet' }, null, 2));
                    const total = entries.length;

                    // Youden's J: find optimal threshold that maximizes sensitivity + specificity - 1
                    const uniqueThresholds = [...new Set(entries.map(e => e.threshold_used ?? 0.3))].sort();
                    let bestJ = -1, bestThreshold = 0.3;
                    for (const t of uniqueThresholds) {
                        const atThreshold = entries.filter(e => (e.threshold_used ?? 0.3) === t);
                        // Predicted STOP (converged): signal === 'STOP'
                        const tp = atThreshold.filter(e => e.actual_converged && (e.signal === 'STOP' || e.signal === 'CAUTION')).length;
                        const fn = atThreshold.filter(e => e.actual_converged && e.signal === 'GO').length;
                        const fp = atThreshold.filter(e => !e.actual_converged && (e.signal === 'STOP' || e.signal === 'CAUTION')).length;
                        const tn = atThreshold.filter(e => !e.actual_converged && e.signal === 'GO').length;
                        const sensitivity = (tp + fn) > 0 ? tp / (tp + fn) : 0;
                        const specificity = (tn + fp) > 0 ? tn / (tn + fp) : 0;
                        const J = sensitivity + specificity - 1;
                        if (J > bestJ) { bestJ = J; bestThreshold = t; }
                    }

                    const correct = entries.filter(e => {
                        const predictedStop = e.signal === 'STOP' || e.signal === 'CAUTION';
                        return predictedStop === e.actual_converged;
                    }).length;
                    const accuracy = total > 0 ? Math.round(correct / total * 100) : 0;
                    const falseStops = entries.filter(e => (e.signal === 'STOP' || e.signal === 'CAUTION') && !e.actual_converged).length;
                    const falseGoes = entries.filter(e => e.signal === 'GO' && e.actual_converged).length;

                    const suggestion = bestJ > 0.5
                        ? `Optimal threshold: ${bestThreshold.toFixed(2)} (Youden's J=${bestJ.toFixed(3)}). Well-calibrated.`
                        : bestJ > 0.2
                        ? `Optimal threshold: ${bestThreshold.toFixed(2)} (Youden's J=${bestJ.toFixed(3)}). Fair — consider collecting more calibration data.`
                        : `Optimal threshold: ${bestThreshold.toFixed(2)} (Youden's J=${bestJ.toFixed(3)}). Poor — calibration data may be contradictory or insufficient.`;

                    return textResult(JSON.stringify({
                        total_sessions: total, accuracy_pct: accuracy,
                        false_stops: falseStops, false_goes: falseGoes,
                        youdens_j_max: Math.round(bestJ * 1000) / 1000,
                        optimal_threshold: Math.round(bestThreshold * 100) / 100,
                        suggestion,
                        recent: entries.slice(-5).map(e => ({ session: e.session_id, signal: e.signal, actual: e.actual_converged, threshold: e.threshold_used, timestamp: new Date(e.timestamp).toISOString() }))
                    }, null, 2));
                } catch { return textResult(JSON.stringify({ total_sessions: 0, accuracy_pct: 0, note: 'Error reading calibration data' }, null, 2)); }
            }
        }
        
        const fieldErr = this.requireFields(options.input as any, []);
        if (fieldErr) return textResult(JSON.stringify({ error: fieldErr }));
        let proposals = raw ?? [];
        if (room) { try { const result = await concertCheck([room]); const messages = result?.messages; if (messages && messages.length) proposals = messages.map(m => m.body); } catch {} }
        if (proposals.length < 2) return textResult(JSON.stringify({ signal: 'GO', metrics: { proposal_count: proposals.length, pairwise_similarity_mean: 0, information_gain: 1.0, rounds_elapsed: current_round }, reasoning: 'Need more proposals', recommendation: 'Continue generating' }, null, 2));
        
        const ngrams = (s: string, n: number): Set<string> => {
            const clean = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
            const words = clean.split(' ');
            const set = new Set<string>();
            for (let i = 0; i <= words.length - n; i++) set.add(words.slice(i, i + n).join(' '));
            return set;
        };
        
        const allBigrams = proposals.map(p => ngrams(p, 2));
        const bigramDocFreq = new Map<string, number>();
        for (const bgSet of allBigrams) for (const bg of bgSet) bigramDocFreq.set(bg, (bigramDocFreq.get(bg) ?? 0) + 1);
        const N = proposals.length;
        
        const weightedSimilarity = (a: string, b: string): number => {
            const ag = ngrams(a, 2), bg = ngrams(b, 2);
            const intersection = new Set([...ag].filter(x => bg.has(x)));
            if (intersection.size === 0) return 0;
            let weightedOverlap = 0, totalWeight = 0;
            for (const g of intersection) { const idf = Math.log((N + 1) / ((bigramDocFreq.get(g) ?? 0) + 1)) + 1; weightedOverlap += idf; }
            for (const g of new Set([...ag, ...bg])) { const idf = Math.log((N + 1) / ((bigramDocFreq.get(g) ?? 0) + 1)) + 1; totalWeight += idf; }
            return totalWeight > 0 ? weightedOverlap / totalWeight : 0;
        };
        
        const sims: number[] = [];
        
        // ── E7: Multi-dimensional convergence ──
        // Dimension 2: Structural similarity (section count, bullet count, code blocks)
        const structuralSimilarity = (a: string, b: string): number => {
            const countPattern = (s: string, re: RegExp) => (s.match(re) || []).length;
            const sectionsA = countPattern(a, /^#{1,6}\s|^\*\*[^*]+\*\*|^\d+\.\s/gm);
            const sectionsB = countPattern(b, /^#{1,6}\s|^\*\*[^*]+\*\*|^\d+\.\s/gm);
            const bulletsA = countPattern(a, /^[\s]*[-*+]\s/gm);
            const bulletsB = countPattern(b, /^[\s]*[-*+]\s/gm);
            const codeA = countPattern(a, /```/g) / 2;
            const codeB = countPattern(b, /```/g) / 2;
            const parasA = countPattern(a, /\n\n/g) + 1;
            const parasB = countPattern(b, /\n\n/g) + 1;
            const similarity = (x: number, y: number) => Math.min(x, y) / Math.max(x, y, 1);
            return (similarity(sectionsA, sectionsB) + similarity(bulletsA, bulletsB) + similarity(codeA, codeB) + similarity(parasA, parasB)) / 4;
        };
        
        // Dimension 3: Semantic keyword overlap (domain-specific terms, action verbs, technical nouns)
        const semanticKeywordSimilarity = (a: string, b: string): number => {
            const extractKeywords = (s: string): Set<string> => {
                const words = s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w.length > 3);
                // Prefer longer, rarer words as domain-significant
                return new Set(words.filter(w => w.length >= 5));
            };
            const ka = extractKeywords(a), kb = extractKeywords(b);
            if (ka.size === 0 && kb.size === 0) return 1;
            const intersection = new Set([...ka].filter(k => kb.has(k)));
            const union = new Set([...ka, ...kb]);
            return union.size > 0 ? intersection.size / union.size : 0;
        };
        
        const textSims: number[] = [], structSims: number[] = [], kwSims: number[] = [];
        for (let i = 0; i < proposals.length; i++) for (let j = i + 1; j < proposals.length; j++) {
            const a = proposals[i]?.trim(), b = proposals[j]?.trim();
            if (!a && !b) { sims.push(1); textSims.push(1); structSims.push(1); kwSims.push(1); }
            else if (!a || !b) { sims.push(0); textSims.push(0); structSims.push(0); kwSims.push(0); }
            else {
                const ts = weightedSimilarity(a, b);
                const ss = structuralSimilarity(a, b);
                const ks = semanticKeywordSimilarity(a, b);
                textSims.push(ts); structSims.push(ss); kwSims.push(ks);
                // Blend: 50% text + 25% structural + 25% keyword
                sims.push(ts * 0.5 + ss * 0.25 + ks * 0.25);
            }
        }
        const mean = sims.length > 0 ? sims.reduce((a, b) => a + b, 0) / sims.length : 0;
        const textMean = textSims.length > 0 ? textSims.reduce((a, b) => a + b, 0) / textSims.length : 0;
        const structMean = structSims.length > 0 ? structSims.reduce((a, b) => a + b, 0) / structSims.length : 0;
        const kwMean = kwSims.length > 0 ? kwSims.reduce((a, b) => a + b, 0) / kwSims.length : 0;
        
        const allCovered = new Set<string>();
        const gains: number[] = [];
        for (const p of proposals) { const before = allCovered.size; for (const bg of ngrams(p, 2)) allCovered.add(bg); gains.push(allCovered.size - before); }
        const totalNewInfo = gains.reduce((a, b) => a + b, 0);
        const infoGain = allCovered.size > 0 ? totalNewInfo / allCovered.size : 1;
        
        let signal: string, reasoning: string;
        const roundFraction = current_round / max_rounds;
        const diminishingReturns = infoGain < 0.15 || (current_round > 1 && infoGain < gains[gains.length - 1] * 3);
        
        if (current_round >= max_rounds) { signal = 'STOP'; reasoning = `Max rounds (${max_rounds}) reached.`; }
        else if (mean >= (1.0 - threshold) && diminishingReturns) { signal = 'STOP'; reasoning = `Converged (sim=${mean.toFixed(3)}) with diminishing returns (infoGain=${infoGain.toFixed(3)}).`; }
        else if (mean >= (1.0 - threshold)) { signal = 'CAUTION'; reasoning = `High similarity (${mean.toFixed(3)}) but still gaining information (${infoGain.toFixed(3)}).`; }
        else if (diminishingReturns && current_round > 3) { signal = 'CAUTION'; reasoning = `Diminishing information gain (${infoGain.toFixed(3)}) — approaching consensus.`; }
        else { signal = 'GO'; reasoning = `Diverse proposals (sim=${mean.toFixed(3)}, infoGain=${infoGain.toFixed(3)}).`; }
        
        // Deterministic tiebreaker (replaces LLM fallback)
        if (signal === 'CAUTION') {
            const recentGains = gains.slice(-2);
            const declining = recentGains.length >= 2 && recentGains[0] > recentGains[1];
            const veryLowGain = infoGain < 0.05;
            if (declining && veryLowGain) {
                signal = 'STOP'; reasoning += ` Deterministic tiebreaker: declining gains (${recentGains.map(g => g.toFixed(3)).join(' → ')}) + very low info gain (${infoGain.toFixed(3)}) → converge.`;
            } else if (mean >= 0.85 && infoGain < 0.10) {
                signal = 'STOP'; reasoning += ` Deterministic tiebreaker: high similarity (${mean.toFixed(3)}) + low info gain (${infoGain.toFixed(3)}) → converge.`;
            }
        }
        
        // LLM fallback + Conductor escalation pipeline
        if (signal === 'CAUTION' && options.input.allow_llm_fallback && this.secrets) {
            const maxAttempts = options.input.max_fallback_attempts ?? 1;
            let llmResolved = false;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    const r = await consult(this.secrets, { provider: 'deepseek', tier: 'light',
                        question: `Convergence decision needed. ${proposals.length} proposals, similarity=${mean.toFixed(3)}, infoGain=${infoGain.toFixed(3)}, round ${current_round}/${max_rounds}.\nOutput ONLY: STOP (converge) or GO (continue). Brief reason.`,
                        maxTokens: 128 }, token);
                    if (r.text.toUpperCase().includes('STOP')) { signal = 'STOP'; reasoning += ` LLM fallback (attempt ${attempt}): ${r.text.slice(0, 100)}`; llmResolved = true; break; }
                    else if (r.text.toUpperCase().includes('GO')) { signal = 'GO'; reasoning += ` LLM fallback (attempt ${attempt}): ${r.text.slice(0, 100)}`; llmResolved = true; break; }
                } catch { /* retry */ }
            }
            if (!llmResolved) {
                signal = 'ESCALATED';
                reasoning += ` After ${maxAttempts} LLM fallback attempt(s), unresolved. Escalating to Conductor for collaborative review.`;
                try { await concertSpeak(room || 'convergence', 'arbiter', `ESCALATED: ${proposals.length} proposals, sim=${mean.toFixed(3)}, infoGain=${infoGain.toFixed(3)}, round ${current_round}/${max_rounds}. Conductor review needed.`); } catch {}
            }
        }
        
        const costEstimate = proposals.length * (current_round + 1) * 0.001;
        const recommendation = signal === 'STOP' ? `Converge. Cost saved: ~$${costEstimate.toFixed(3)}.`
            : signal === 'CAUTION' ? `One more round (~$${costEstimate.toFixed(3)}), then converge.`
            : `Continue. Expected gain justifies cost (~$${costEstimate.toFixed(3)}/round).`;
        
        const v = { signal, metrics: {
            proposal_count: proposals.length, pairwise_similarity_mean: Math.round(mean * 1000) / 1000,
            text_similarity: Math.round(textMean * 1000) / 1000, structural_similarity: Math.round(structMean * 1000) / 1000, keyword_similarity: Math.round(kwMean * 1000) / 1000,
            pairwise_similarity_min: Math.round((sims.length > 0 ? Math.min(...sims) : 0) * 1000) / 1000,
            information_gain: Math.round(infoGain * 1000) / 1000, diminishing_returns: diminishingReturns,
            rounds_elapsed: current_round, round_fraction: Math.round(roundFraction * 100),
            estimated_cost_next_round: Math.round(costEstimate * 10000) / 10000,
        }, reasoning, recommendation };
        try { await concertSpeak(room || 'convergence', 'arbiter', JSON.stringify(v)); } catch {}
        return textResult(JSON.stringify(v, null, 2));
    }
}
