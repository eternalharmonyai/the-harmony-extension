/**
 * Uncertainty Calibration Store — Tracks prediction→outcome pairs for
 * Beta distribution calibration in harmony_uncertainty_fabric.
 * 
 * Builds calibration curves per agent, per domain:
 *   - Bin predictions by confidence level
 *   - Compare to actual outcomes
 *   - Compute calibration error (ECE — Expected Calibration Error)
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

function uid(): string { return crypto.randomUUID().slice(0, 8); }

// ══════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════

export interface CalibrationPoint {
    id: string;
    timestamp: string;
    claim_id: string;
    /** The predicted Beta distribution parameters */
    predicted_alpha: number;
    predicted_beta: number;
    /** Predicted mean from Beta distribution */
    predicted_mean: number;
    /** Did the prediction come true? (1 = yes, 0 = no) */
    actual_outcome: number;
    /** Agent/role that made the prediction */
    agent: string;
    /** Domain/tag for grouping */
    domain: string;
    /** Confidence bucket label (e.g. 'high', 'medium', 'low') */
    confidence_bucket: string;
    /** Beta observation weight for calibration */
    weight: number;
}

export interface CalibrationStats {
    total_predictions: number;
    ece: number; // Expected Calibration Error (0-1, lower = better)
    mce: number; // Maximum Calibration Error
    by_bucket: CalibrationBucket[];
    by_domain: CalibrationDomain[];
    by_agent: CalibrationAgent[];
}

export interface CalibrationBucket {
    bucket: string;
    count: number;
    predicted_mean: number;
    actual_mean: number;
    error: number;
}

export interface CalibrationDomain {
    domain: string;
    count: number;
    ece: number;
    reliability: 'calibrated' | 'overconfident' | 'underconfident' | 'insufficient_data';
}

export interface CalibrationAgent {
    agent: string;
    count: number;
    ece: number;
    reliability: 'calibrated' | 'overconfident' | 'underconfident' | 'insufficient_data';
}

// ══════════════════════════════════════════════════════════════════
// CalibrationStore
// ══════════════════════════════════════════════════════════════════

export class CalibrationStore {
    private dbPath: string;
    private initializing = false;
    private _ready = false;

    constructor(workspaceRoot: string) {
        const dir = path.join(workspaceRoot, '.harmony', 'calibration');
        this.dbPath = path.join(dir, 'calibration.jsonl');
    }

    async init(): Promise<void> {
        if (this._ready) return;
        if (this.initializing) {
            // Wait for concurrent init to finish
            while (this.initializing) await new Promise(r => setTimeout(r, 50));
            return;
        }
        this.initializing = true;
        const dir = path.dirname(this.dbPath);
        await fs.mkdir(dir, { recursive: true });
        // Ensure file exists
        try { await fs.access(this.dbPath); } catch { await fs.writeFile(this.dbPath, '', 'utf8'); }
        this._ready = true;
        this.initializing = false;
    }

    // ── Record a prediction outcome ──

    async record(params: {
        claim_id: string;
        predicted_alpha: number;
        predicted_beta: number;
        actual_outcome: boolean;
        agent?: string;
        domain?: string;
        weight?: number;
    }): Promise<CalibrationPoint> {
        await this.init();
        const predictedMean = params.predicted_alpha / (params.predicted_alpha + params.predicted_beta);
        const bucket = this.bucketize(predictedMean);

        const point: CalibrationPoint = {
            id: uid(),
            timestamp: new Date().toISOString(),
            claim_id: params.claim_id,
            predicted_alpha: params.predicted_alpha,
            predicted_beta: params.predicted_beta,
            predicted_mean: Math.round(predictedMean * 1000) / 1000,
            actual_outcome: params.actual_outcome ? 1 : 0,
            agent: params.agent ?? 'unknown',
            domain: params.domain ?? 'general',
            confidence_bucket: bucket,
            weight: params.weight ?? 1,
        };

        await fs.appendFile(this.dbPath, JSON.stringify(point) + '\n', 'utf8');
        return point;
    }

    // ── Compute calibration statistics ──

    async stats(): Promise<CalibrationStats> {
        await this.init();
        const points = await this.readAll();

        if (points.length === 0) {
            return {
                total_predictions: 0,
                ece: 0,
                mce: 0,
                by_bucket: [],
                by_domain: [],
                by_agent: [],
            };
        }

        // Bucket definitions
        const buckets = ['very_low', 'low', 'medium', 'high', 'very_high'];
        const byBucket = buckets.map(bucket => {
            const pts = points.filter(p => p.confidence_bucket === bucket);
            if (pts.length === 0) return { bucket, count: 0, predicted_mean: 0, actual_mean: 0, error: 0 };
            const predMean = pts.reduce((s, p) => s + p.predicted_mean, 0) / pts.length;
            const actualMean = pts.reduce((s, p) => s + p.actual_outcome, 0) / pts.length;
            return {
                bucket,
                count: pts.length,
                predicted_mean: Math.round(predMean * 1000) / 1000,
                actual_mean: Math.round(actualMean * 1000) / 1000,
                error: Math.abs(predMean - actualMean),
            };
        });

        // ECE = weighted average of |predicted - actual| per bucket
        const weightedErrors = byBucket
            .filter(b => b.count > 0)
            .map(b => (b.count / points.length) * Math.abs(b.predicted_mean - b.actual_mean));
        const ece = weightedErrors.reduce((s, e) => s + e, 0);
        const mce = Math.max(...byBucket.map(b => b.error));

        // By domain
        const domainMap = new Map<string, CalibrationPoint[]>();
        for (const p of points) {
            const arr = domainMap.get(p.domain) ?? [];
            arr.push(p);
            domainMap.set(p.domain, arr);
        }
        const byDomain: CalibrationDomain[] = [];
        for (const [domain, pts] of domainMap) {
            const predMean = pts.reduce((s, p) => s + p.predicted_mean, 0) / pts.length;
            const actualMean = pts.reduce((s, p) => s + p.actual_outcome, 0) / pts.length;
            const err = Math.abs(predMean - actualMean);
            byDomain.push({
                domain,
                count: pts.length,
                ece: Math.round(err * 1000) / 1000,
                reliability: pts.length < 5 ? 'insufficient_data'
                    : err < 0.1 ? 'calibrated'
                    : predMean > actualMean + 0.1 ? 'overconfident'
                    : 'underconfident',
            });
        }
        byDomain.sort((a, b) => b.count - a.count);

        // By agent
        const agentMap = new Map<string, CalibrationPoint[]>();
        for (const p of points) {
            const arr = agentMap.get(p.agent) ?? [];
            arr.push(p);
            agentMap.set(p.agent, arr);
        }
        const byAgent: CalibrationAgent[] = [];
        for (const [agent, pts] of agentMap) {
            const predMean = pts.reduce((s, p) => s + p.predicted_mean, 0) / pts.length;
            const actualMean = pts.reduce((s, p) => s + p.actual_outcome, 0) / pts.length;
            const err = Math.abs(predMean - actualMean);
            byAgent.push({
                agent,
                count: pts.length,
                ece: Math.round(err * 1000) / 1000,
                reliability: pts.length < 5 ? 'insufficient_data'
                    : err < 0.1 ? 'calibrated'
                    : predMean > actualMean + 0.1 ? 'overconfident'
                    : 'underconfident',
            });
        }
        byAgent.sort((a, b) => b.count - a.count);

        return {
            total_predictions: points.length,
            ece: Math.round(ece * 1000) / 1000,
            mce: Math.round(mce * 1000) / 1000,
            by_bucket: byBucket,
            by_domain: byDomain,
            by_agent: byAgent,
        };
    }

    // ── Get calibration adjustment for a prediction ──

    async getAdjustment(alpha: number, beta: number, domain?: string, agent?: string): Promise<{
        adjusted_alpha: number;
        adjusted_beta: number;
        calibration_factor: number;
        is_calibrated: boolean;
    }> {
        await this.init();
        const predictedMean = alpha / (alpha + beta);
        const bucket = this.bucketize(predictedMean);

        // Find similar past predictions
        const points = await this.readAll();
        const relevant = points.filter(p => {
            if (domain && p.domain !== domain) return false;
            if (agent && p.agent !== agent) return false;
            if (p.confidence_bucket !== bucket) return false;
            return true;
        });

        if (relevant.length < 5) {
            return {
                adjusted_alpha: alpha,
                adjusted_beta: beta,
                calibration_factor: 1.0,
                is_calibrated: false,
            };
        }

        const actualRate = relevant.reduce((s, p) => s + p.actual_outcome, 0) / relevant.length;
        const predictedRate = relevant.reduce((s, p) => s + p.predicted_mean, 0) / relevant.length;

        // Calibration factor: how much to adjust predictions toward reality
        const calibrationFactor = predictedRate > 0.01
            ? Math.max(0.3, Math.min(3.0, actualRate / predictedRate))
            : 1.0;

        // Adjust alpha/beta to reflect calibrated probability
        const calibratedMean = Math.max(0.01, Math.min(0.99, predictedMean * calibrationFactor));
        const totalObs = alpha + beta;
        const adjustedAlpha = Math.max(0.5, calibratedMean * totalObs);
        const adjustedBeta = Math.max(0.5, (1 - calibratedMean) * totalObs);

        return {
            adjusted_alpha: Math.round(adjustedAlpha * 100) / 100,
            adjusted_beta: Math.round(adjustedBeta * 100) / 100,
            calibration_factor: Math.round(calibrationFactor * 1000) / 1000,
            is_calibrated: true,
        };
    }

    // ── Read all points ──

    private async readAll(): Promise<CalibrationPoint[]> {
        try {
            const raw = await fs.readFile(this.dbPath, 'utf8');
            if (!raw.trim()) return [];
            return raw.trim().split('\n').map(line => JSON.parse(line));
        } catch {
            return [];
        }
    }

    // ── Confidence bucketing ──

    private bucketize(mean: number): string {
        if (mean >= 0.9) return 'very_high';
        if (mean >= 0.7) return 'high';
        if (mean >= 0.3) return 'medium';
        if (mean >= 0.1) return 'low';
        return 'very_low';
    }
}
