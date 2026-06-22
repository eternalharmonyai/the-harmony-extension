/**
 * BasePrimitive — shared infrastructure for all 15 swarm primitives.
 * 
 * ## Design Pattern
 * Primitives extend this class and override {@link invokeImpl} instead of {@link invoke}.
 * The base class handles telemetry, concurrency safety, input validation, and
 * graceful degradation automatically.
 * 
 * ## Lifecycle
 * 1. `invoke()` is called by VS Code → records start time + action
 * 2. Acquires mutex lock (concurrency safety)
 * 3. Delegates to `invokeImpl()` (your primitive logic)
 * 4. On success: logs latency + returns result
 * 5. On error: calls `degradedFallback()` for safe error response
 * 6. Releases mutex in `finally` block
 * 
 * ## Best Practices
 * - Always call `this.requireFields(input, ['action'])` at start of `invokeImpl()`
 * - Use `token.isCancellationRequested` before long-running operations
 * - Return structured JSON errors: `textResult(JSON.stringify({ error: ... }))`
 * - Override `degradedFallback()` for primitive-specific error handling
 * 
 * @typeParam TInput — The input interface for this primitive
 */
import * as vscode from 'vscode';
import { structuredLog } from '../storageUtils';

export abstract class BasePrimitive<TInput> implements vscode.LanguageModelTool<TInput> {
    /** Human-readable name used in telemetry logs */
    protected readonly name: string;
    /** Sequential mutex: ensures operations execute one-at-a-time per primitive instance */
    private _mutex: Promise<void> = Promise.resolve();

    /** @param name — Display name for telemetry (e.g. 'thought-graph', 'value-resolver') */
    constructor(name: string) {
        this.name = name;
    }

    /**
     * Override this in subclasses with your primitive's logic.
     * Do NOT override `invoke()` — that is managed by BasePrimitive.
     * @returns A LanguageModelToolResult (use `textResult()` helper)
     */
    protected abstract invokeImpl(
        options: vscode.LanguageModelToolInvocationOptions<TInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult>;

    /**
     * Entry point called by VS Code tool host.
     * Wraps `invokeImpl()` with:
     * - Structured telemetry (start → success/fail with latency)
     * - Concurrency mutex (one-at-a-time execution)
     * - Automatic error recovery via `degradedFallback()`
     */
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<TInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const start = Date.now();
        structuredLog(this.name, 'info', 'invoke:start', { action: (options.input as any)?.action });

        // Concurrency safety: queue operations through a mutex
        let release: () => void;
        const lock = new Promise<void>(resolve => { release = resolve; });
        await (this._mutex = this._mutex.then(() => lock));

        try {
            const result = await this.invokeImpl(options, token);
            const latency = Date.now() - start;
            structuredLog(this.name, 'info', 'invoke:success', { latency_ms: latency });
            return result;
        } catch (e: any) {
            const latency = Date.now() - start;
            structuredLog(this.name, 'error', 'invoke:fail', { latency_ms: latency, error: e.message });
            return this.degradedFallback(e, options);
        } finally {
            release!();
        }
    }

    /**
     * Graceful degradation fallback called when `invokeImpl()` throws.
     * Override in subclasses for primitive-specific error handling.
     * Default: returns a structured JSON error with `degraded: true` flag.
     */
    protected async degradedFallback(
        error: Error,
        _options: vscode.LanguageModelToolInvocationOptions<TInput>
    ): Promise<vscode.LanguageModelToolResult> {
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                JSON.stringify({ error: `${this.name} failed`, detail: error.message, degraded: true })
            )
        ]);
    }

    /**
     * Validate that required fields exist and are non-empty.
     * @returns Error string if a field is missing, `null` if all fields pass.
     * @example this.requireFields(input, ['action', 'claim'])
     */
    protected requireFields(input: Record<string, any>, fields: string[]): string | null {
        for (const f of fields) {
            if (input[f] === undefined || input[f] === null || (typeof input[f] === 'string' && !input[f].trim())) {
                return `error: ${f} is required`;
            }
        }
        return null;
    }
}
