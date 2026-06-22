/**
 * Provider Health Monitor — tracks provider/tier reliability for intelligent failover.
 * Uses exponential decay scoring: recent events count more than old ones.
 * Score range: -10 to +10. Success +1, failure -2, half-life 5 minutes.
 */
import * as vscode from 'vscode';
import { ProviderId, Tier } from './providers';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HealthEvent {
    ts: number;
    provider: ProviderId;
    tier: Tier;
    success: boolean;
    latencyMs?: number;
}

interface ProviderScore {
    score: number;
    totalAttempts: number;
    totalSuccesses: number;
    lastSuccessTs: number;
    lastFailureTs: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const HALF_LIFE_MS = 5 * 60 * 1000; // 5 minutes
const SUCCESS_WEIGHT = 1;
const FAILURE_WEIGHT = -2;
const MAX_EVENTS = 200; // rolling window

// ─── State ──────────────────────────────────────────────────────────────────

let events: HealthEvent[] = [];
let onHealthChangeEmitter = new vscode.EventEmitter<void>();

export const onHealthChange = onHealthChangeEmitter.event;

// ─── Core API ───────────────────────────────────────────────────────────────

/** Record a provider call outcome. */
export function recordHealth(event: HealthEvent): void {
    events.push(event);
    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
    onHealthChangeEmitter.fire();
}

/** Get the current health score for a provider+tier combination. */
export function getScore(provider: ProviderId, tier: Tier): ProviderScore {
    const now = Date.now();
    let score = 0;
    let totalAttempts = 0;
    let totalSuccesses = 0;
    let lastSuccessTs = 0;
    let lastFailureTs = 0;

    for (const e of events) {
        if (e.provider !== provider || e.tier !== tier) continue;
        totalAttempts++;
        const age = now - e.ts;
        // Exponential decay: weight halves every HALF_LIFE_MS
        const decay = Math.pow(0.5, age / HALF_LIFE_MS);
        if (e.success) {
            score += SUCCESS_WEIGHT * decay;
            totalSuccesses++;
            if (e.ts > lastSuccessTs) lastSuccessTs = e.ts;
        } else {
            score += FAILURE_WEIGHT * decay;
            if (e.ts > lastFailureTs) lastFailureTs = e.ts;
        }
    }

    // Clamp to [-10, 10]
    return {
        score: Math.max(-10, Math.min(10, Math.round(score * 10) / 10)),
        totalAttempts,
        totalSuccesses,
        lastSuccessTs,
        lastFailureTs,
    };
}

/** Get health status label for display. */
export function getStatusLabel(provider: ProviderId, tier: Tier): string {
    const s = getScore(provider, tier);
    if (s.totalAttempts === 0) return 'unknown';
    if (s.score >= 8) return 'excellent';
    if (s.score >= 5) return 'good';
    if (s.score >= 2) return 'fair';
    if (s.score >= -2) return 'unstable';
    if (s.score >= -5) return 'poor';
    return 'failing';
}

/**
 * Rank providers by health score, then by cost tier preference.
 * Returns a sorted list of [provider, score] tuples.
 * Only includes providers with keys available.
 */
export async function rankProviders(
    secrets: vscode.SecretStorage,
    tier: Tier,
    exclude: ProviderId[] = []
): Promise<ProviderId[]> {
    const { PROVIDER_IDS } = await import('./providers');
    const { hasKey } = await import('./providers');
    const scored: { provider: ProviderId; score: ProviderScore }[] = [];

    for (const p of PROVIDER_IDS) {
        if (exclude.includes(p)) continue;
        if (!(await hasKey(secrets, p))) continue;
        // Skip providers that don't support openaiCompat path
        if (p === 'gemini' || p === 'claude') {
            scored.push({ provider: p, score: getScore(p, tier) });
            continue;
        }
        scored.push({ provider: p, score: getScore(p, tier) });
    }

    // Sort: highest score first, then by provider preference order
    const prefOrder: ProviderId[] = ['deepseek', 'moonshot', 'kimiCode', 'alibaba', 'tencent', 'openai', 'openrouter', 'gemini', 'claude'];
    scored.sort((a, b) => {
        // Healthy providers first (score > 0)
        const aHealthy = a.score.score > 0 ? 1 : 0;
        const bHealthy = b.score.score > 0 ? 1 : 0;
        if (aHealthy !== bHealthy) return bHealthy - aHealthy;
        // Among same health band, sort by score
        if (a.score.score !== b.score.score) return b.score.score - a.score.score;
        // Tie-break by preference order
        return prefOrder.indexOf(a.provider) - prefOrder.indexOf(b.provider);
    });

    return scored.map(s => s.provider);
}

/** Check if a provider+tier is currently healthy. */
export function isHealthy(provider: ProviderId, tier: Tier): boolean {
    const s = getScore(provider, tier);
    if (s.totalAttempts === 0) return true; // untested = assume healthy
    return s.score >= 2;
}

/** Reset all health tracking. */
export function resetHealth(): void {
    events = [];
    onHealthChangeEmitter.fire();
}

/** Get recent events (for debugging/sidebar). */
export function getRecentEvents(count: number = 20): HealthEvent[] {
    return events.slice(-count);
}
