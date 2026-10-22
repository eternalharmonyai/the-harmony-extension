/**
 * Pure request-side step telemetry capture helper.
 *
 * This module imports nothing at runtime (the UsageRecord import is type-only
 * and erased), performs no I/O, and reads no clock or configuration so it can
 * be exercised directly in plain Node.
 */
import type { UsageRecord } from './costTracker';

/**
 * Estimator generation id stamped on ledger rows for formula versioning.
 */
export const PROMPT_ESTIMATOR_VERSION = 'e1-chars3-cjk15';

export interface StepCaptureInput {
    provider: UsageRecord['provider'];
    tier: UsageRecord['tier'];
    model: string;
    /** Characters of the outbound prompt view (the messages array as sent), measured pre-send. */
    promptChars: number;
    /** CJK characters within promptChars (Han + Kana + Hangul). */
    promptCjkChars: number;
    /** Serialized tool-schema characters sent with the request. */
    toolSchemaChars: number;
    /** Number of tool schemas advertised on the request. */
    toolCount: number;
    /** Opaque id grouping ledger rows by agent turn. */
    turnId: string;
    /** 0-based step index within the turn; recorded 1-based. */
    stepIndex: number;
    /** True when the route runs the pre-send prompt estimator. */
    isDeepSeek: boolean;
    /** The only field that varies with how the step ended. */
    stepOutcome: 'completed' | 'failed';
}

/** The capture fields, typed from the ledger record so union drift cannot break it. */
export type StepCaptureFields = Required<
    Pick<
        UsageRecord,
        | 'provider'
        | 'tier'
        | 'model'
        | 'promptChars'
        | 'promptCjkChars'
        | 'toolSchemaChars'
        | 'toolCount'
        | 'estimatorVersion'
        | 'turnId'
        | 'stepId'
        | 'stepOutcome'
    >
>;

/**
 * Every field a capture must carry — the completeness test asserts the key set is
 * exactly this, for both outcomes, so a field can be neither invented nor dropped.
 */
export const STEP_CAPTURE_FIELDS = [
    'provider',
    'tier',
    'model',
    'promptChars',
    'promptCjkChars',
    'toolSchemaChars',
    'toolCount',
    'estimatorVersion',
    'turnId',
    'stepId',
    'stepOutcome'
] as const;

/**
 * Build the request-side capture fields.
 *
 * Pure: the same input always produces the same output, and `stepOutcome` is the only
 * varying input — so a failed step records the same request facts as a completed one.
 */
export function captureStepFields(input: StepCaptureInput): StepCaptureFields {
    return {
        provider: input.provider,
        tier: input.tier,
        model: input.model,
        promptChars: input.promptChars,
        promptCjkChars: input.promptCjkChars,
        toolSchemaChars: input.toolSchemaChars,
        toolCount: input.toolCount,
        estimatorVersion: input.isDeepSeek ? PROMPT_ESTIMATOR_VERSION : 'none',
        turnId: input.turnId,
        stepId: input.stepIndex + 1,
        stepOutcome: input.stepOutcome
    };
}

/**
 * Helper that returns the capture fields with `stepOutcome` omitted (used by unit tests
 * to verify field-completeness assertions).
 */
export function captureStepFieldsWithoutOutcome(
    input: StepCaptureInput
): Omit<StepCaptureFields, 'stepOutcome'> {
    const { stepOutcome, ...rest } = captureStepFields(input);
    void stepOutcome;
    return rest;
}
