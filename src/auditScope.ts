/**
 * auditScope — decide which tool-call paths actually count as "touched".
 *
 * WHY THIS MODULE EXISTS
 * The scope builder used to collect ANY tool call whose input carried a
 * `path` / `file_path` / `filePath` key. `call.name` was checked for existence and
 * then never compared to anything, so READING a file was indistinguishable from
 * EDITING it. Two consumers were misled by that list:
 *   - the Triple-Check audit reported on files the turn never changed
 *   - continuity recorded reads as edits
 *
 * THE FAILURE DIRECTION IS DELIBERATE
 * This is an allowlist of KNOWN READ-ONLY tools, not an allowlist of write tools.
 * Any tool we do not recognise is INCLUDED, because a security audit that misses a
 * real change is worse than one that reviews an unchanged file. Consequences:
 *   - adding a new WRITE tool needs no change here (it is included by default)
 *   - adding a new READ tool is an opt-in improvement (until then it is over-included)
 *
 * Conditional tools are never listed as read-only. `harmony_code_actions` reads
 * unless `apply:true`; `harmony_canvas_project` inspects unless it mutates. A tool
 * that CAN write is not a read-only tool, whatever its default happens to be.
 *
 * Exclusions are COUNTED and returned, so a caller can disclose them. A filter that
 * removes input without saying so is a silent failure (AGENTS.md rule #6).
 *
 * It deliberately imports nothing — no `vscode`, no fs — so the gate can require the
 * compiled output directly and assert both directions.
 */

/** Input keys a tool call may use to name a file. */
export const PATH_INPUT_KEYS = ['path', 'file_path', 'filePath'] as const;

/**
 * Tools that can ONLY read. Naming a path through one of these is a reference,
 * never an edit, so the path must not enter an audit scope.
 */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
    // file and directory readers
    'harmony_read_file',
    'harmony_list_dir',
    'harmony_open_file',
    // symbol and line lookups
    'harmony_symbol_locations',
    'harmony_git_blame',
    // git readers — git_restore / git_commit / git_revert / git_stash / git_pull /
    // git_push / git_tag / git_branch are deliberately absent: they mutate state.
    'harmony_git_status',
    'harmony_git_diff',
    'harmony_git_show',
    'harmony_git_log',
    'harmony_git_conflicts',
    // media and canvas readers
    'harmony_canvas_inspect',
    'harmony_vision_read',
    'harmony_get_image_info',
    'harmony_get_generation_status',
    'harmony_mask_preview',
    'harmony_image_diff',
    'harmony_visual_regression',
    // search, diagnostics, and read-only orchestration/inspection tools
    'harmony_grep',
    'harmony_check_whispers',
    'harmony_compile_check',
    'harmony_parallel',
    'harmony_spawn_worker',
    'harmony_consult_model',
    'harmony_orchestrate_codebase',
    'harmony_get_errors',
    'harmony_repo_map',
    'harmony_route_map',
    'harmony_change_summary',
    'harmony_self_diagnose',
    'harmony_self_inspect',
    'harmony_provider_status',
    'harmony_tool_ledger',
    'harmony_page_inspect',
    'harmony_fetch_url',
    'harmony_web_search',
]);

/**
 * Tools known to be able to write. This set does NOT affect inclusion — every
 * non-read-only tool is included either way. It exists only so `unknownTools` can
 * report genuinely unrecognised names instead of listing obvious writers.
 */
export const KNOWN_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
    'harmony_write_file',
    'harmony_edit_file',
    'harmony_apply_patch',
    'harmony_rename_symbol',
    'harmony_code_actions',
    'harmony_canvas_project',
    'harmony_raster_edit',
    'harmony_crop_image',
    'harmony_resize_image',
    'harmony_draw_text',
    'harmony_composite_layer',
    'harmony_remove_background',
    'harmony_generate_image',
    'harmony_generate_layer_set',
    'harmony_save_to_likeness',
    'harmony_git_commit',
    'harmony_git_restore',
    'harmony_git_revert',
    'harmony_git_stash',
    'harmony_git_pull',
    'harmony_git_push',
    'harmony_git_tag',
    'harmony_git_branch',
    'harmony_run_terminal',
    'harmony_todo',
    'harmony_ask_question',
    'harmony_continuity',
    'harmony_process_registry',
    'harmony_working_memory',
]);

export interface AuditScope {
    /** Paths the turn may have changed. Unknown tools are included on purpose. */
    paths: string[];
    /** Paths dropped because the owning tool can only read. Reported, never silent. */
    readOnlyExcluded: string[];
    /** Tool names recognised as neither read-only nor known-write. Included conservatively. */
    unknownTools: string[];
}

export interface AuditScopeOptions {
    /** Hard cap on returned paths. Default 30, matching the previous behaviour. */
    maxPaths?: number;
}

const DEFAULT_MAX_PATHS = 30;
const HARD_MAX_PATHS = 200;

/** True when the named tool can only read, so a path argument is a reference. */
export function isReadOnlyTool(name: unknown): boolean {
    if (typeof name !== 'string') return false;
    const key = name.trim().toLowerCase();
    return key.length > 0 && READ_ONLY_TOOL_NAMES.has(key);
}

/** True when the named tool is recognised as able to write. */
export function isKnownWriteTool(name: unknown): boolean {
    if (typeof name !== 'string') return false;
    const key = name.trim().toLowerCase();
    return key.length > 0 && KNOWN_WRITE_TOOL_NAMES.has(key);
}

/**
 * Split a turn's tool calls into changed paths, read-only exclusions, and unknown tools.
 *
 * A path that appears in BOTH a read call and a write call is treated as changed:
 * the write wins, because the file really was written.
 */
export function classifyToolCallReferences(calls: unknown, options: AuditScopeOptions = {}): AuditScope {
    const raw = typeof options.maxPaths === 'number' && Number.isFinite(options.maxPaths)
        ? Math.min(Math.max(Math.trunc(options.maxPaths), 1), HARD_MAX_PATHS)
        : DEFAULT_MAX_PATHS;

    const list: unknown[] = Array.isArray(calls) ? calls : [];
    const paths: string[] = [];
    const excluded: string[] = [];
    const unknownTools: string[] = [];

    const writtenPaths = new Set<string>();
    const excludedPaths = new Set<string>();
    const unknownSeen = new Set<string>();

    for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const call = entry as { name?: unknown; input?: unknown };
        if (typeof call.name !== 'string' || !call.name.trim()) continue;

        const name = call.name.trim();
        const readOnly = isReadOnlyTool(name);
        if (!readOnly && !isKnownWriteTool(name) && !unknownSeen.has(name)) {
            unknownSeen.add(name);
            unknownTools.push(name);
        }

        const input = call.input && typeof call.input === 'object'
            ? call.input as Record<string, unknown>
            : {};

        for (const key of PATH_INPUT_KEYS) {
            const value = input[key];
            if (typeof value !== 'string' || !value.trim()) continue;
            const value_ = value.trim();
            if (readOnly) {
                if (!excludedPaths.has(value_)) {
                    excludedPaths.add(value_);
                    excluded.push(value_);
                }
            } else if (!writtenPaths.has(value_)) {
                writtenPaths.add(value_);
                paths.push(value_);
            }
        }
    }

    // A path that was read AND written is a change, not an exclusion.
    const readOnlyExcluded = excluded.filter((p) => !writtenPaths.has(p));

    return {
        paths: paths.slice(0, raw),
        readOnlyExcluded: readOnlyExcluded.slice(0, raw),
        unknownTools,
    };
}

/**
 * One-line human-readable disclosure of what the scope did. Empty string when the
 * scope needed no filtering and saw only recognised tools.
 */
export function formatScopeNote(scope: AuditScope): string {
    const parts: string[] = [];
    const excludedCount = scope.readOnlyExcluded.length;
    if (excludedCount > 0) {
        parts.push(`${excludedCount} read-only reference${excludedCount === 1 ? '' : 's'} excluded`);
    }
    const unknownCount = scope.unknownTools.length;
    if (unknownCount > 0) {
        parts.push(`unrecognised tool${unknownCount === 1 ? '' : 's'} included: ${scope.unknownTools.join(', ')}`);
    }
    return parts.join('; ');
}
