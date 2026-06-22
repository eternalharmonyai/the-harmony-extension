import * as path from 'path';
import * as vscode from 'vscode';
import { withOperationLock } from './operationLocks';

const MAX_RESULT_CHARS = 60000;

type LocationMode = 'references' | 'definition' | 'implementation' | 'type_definition';
type OutputFormat = 'markdown' | 'json';

interface SymbolPositionInput {
    path: string;
    line?: number;
    character?: number;
    symbol?: string;
    line_text?: string;
    format?: OutputFormat;
}

interface SymbolLocationsInput extends SymbolPositionInput {
    mode?: LocationMode;
    include_declaration?: boolean;
    max_results?: number;
}

interface SymbolRenameInput extends SymbolPositionInput {
    new_name: string;
    apply?: boolean;
}

interface CodeActionsInput extends SymbolPositionInput {
    end_line?: number;
    end_character?: number;
    kind?: string;
    only_preferred?: boolean;
    apply?: boolean;
    action_index?: number;
    action_title?: string;
    allow_command?: boolean;
    max_results?: number;
}

interface ResolvedPosition {
    uri: vscode.Uri;
    document: vscode.TextDocument;
    position: vscode.Position;
    note?: string;
}

interface NormalizedLocation {
    uri: vscode.Uri;
    range: vscode.Range;
}

function clip(text: string): string {
    if (text.length <= MAX_RESULT_CHARS) return text;
    return text.slice(0, MAX_RESULT_CHARS) + `\n...[truncated, ${text.length - MAX_RESULT_CHARS} more chars]`;
}

function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(clip(text))]);
}

function jsonResult(value: unknown): vscode.LanguageModelToolResult {
    return textResult(JSON.stringify(value, null, 2));
}

function workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function resolveWorkspaceUri(inputPath: string): vscode.Uri | undefined {
    const roots = vscode.workspace.workspaceFolders ?? [];
    if (!inputPath || roots.length === 0) return undefined;
    const requested = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(roots[0].uri.fsPath, inputPath);
    const containingRoot = roots.find(root => {
        const rel = path.relative(root.uri.fsPath, requested);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    return containingRoot ? vscode.Uri.file(requested) : undefined;
}

async function resolvePosition(input: SymbolPositionInput): Promise<ResolvedPosition | { error: string }> {
    const uri = resolveWorkspaceUri(input.path);
    if (!uri) return { error: `Path is outside the current workspace or no workspace is open: ${input.path}` };

    const document = await vscode.workspace.openTextDocument(uri);
    let lineIndex = typeof input.line === 'number' ? input.line - 1 : undefined;
    let note: string | undefined;

    if (typeof input.line_text === 'string' && input.line_text.length > 0) {
        const matches: number[] = [];
        for (let index = 0; index < document.lineCount; index++) {
            if (document.lineAt(index).text.includes(input.line_text)) matches.push(index);
        }
        if (matches.length === 0) return { error: `line_text was not found in ${input.path}` };
        if (typeof lineIndex === 'number' && !matches.includes(lineIndex)) {
            return { error: `line_text was found, but not on line ${input.line}` };
        }
        lineIndex = typeof lineIndex === 'number' ? lineIndex : matches[0];
        if (matches.length > 1) note = `line_text matched ${matches.length} lines; using line ${lineIndex + 1}.`;
    }

    if (typeof lineIndex !== 'number') return { error: 'Provide line or line_text to locate the symbol.' };
    if (lineIndex < 0 || lineIndex >= document.lineCount) return { error: `Line ${input.line} is outside ${input.path}.` };

    const line = document.lineAt(lineIndex);
    let character = typeof input.character === 'number' ? input.character : undefined;
    if (typeof character !== 'number' && input.symbol) {
        const index = line.text.indexOf(input.symbol);
        if (index >= 0) character = index;
    }
    if (typeof character !== 'number' && input.line_text) {
        const index = line.text.indexOf(input.line_text);
        character = index >= 0 ? index : 0;
    }
    character = Math.max(0, Math.min(character ?? 0, line.text.length));
    if (input.symbol && !line.text.slice(character, character + input.symbol.length).includes(input.symbol)) {
        const index = line.text.indexOf(input.symbol);
        if (index >= 0) character = index;
    }

    return { uri, document, position: new vscode.Position(lineIndex, character), note };
}

function asRelative(uri: vscode.Uri): string {
    return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
}

function normalizeLocation(value: vscode.Location | vscode.LocationLink): NormalizedLocation {
    if ('targetUri' in value) return { uri: value.targetUri, range: value.targetSelectionRange ?? value.targetRange };
    return { uri: value.uri, range: value.range };
}

function editSummary(edit: vscode.WorkspaceEdit): Array<{ path: string; edits: number; first_line?: number; last_line?: number }> {
    return edit.entries().map(([uri, edits]) => {
        const lines = edits.flatMap(item => [item.range.start.line + 1, item.range.end.line + 1]);
        return {
            path: asRelative(uri),
            edits: edits.length,
            first_line: lines.length ? Math.min(...lines) : undefined,
            last_line: lines.length ? Math.max(...lines) : undefined,
        };
    });
}

function isCodeAction(value: vscode.CodeAction | vscode.Command): value is vscode.CodeAction {
    return 'edit' in value || 'kind' in value || 'diagnostics' in value || 'isPreferred' in value || 'disabled' in value;
}

function actionCommand(action: vscode.CodeAction | vscode.Command): vscode.Command | undefined {
    return isCodeAction(action) ? action.command : action;
}

function actionSummary(action: vscode.CodeAction | vscode.Command, index: number) {
    const codeAction = isCodeAction(action) ? action : undefined;
    const edit = codeAction?.edit;
    const command = actionCommand(action);
    return {
        index: index + 1,
        title: action.title,
        kind: codeAction?.kind?.value,
        preferred: codeAction?.isPreferred === true,
        disabled: codeAction?.disabled?.reason,
        has_edit: !!edit,
        has_command: !!command,
        command: command?.command,
        edit_files: edit ? edit.entries().length : 0,
        edit_count: edit ? editSummary(edit).reduce((total, item) => total + item.edits, 0) : 0,
    };
}

function resolveAction(actions: Array<vscode.CodeAction | vscode.Command>, input: CodeActionsInput): vscode.CodeAction | vscode.Command | undefined {
    if (typeof input.action_index === 'number') return actions[input.action_index - 1];
    if (input.action_title) {
        return actions.find(action => action.title === input.action_title)
            ?? actions.find(action => action.title.toLowerCase().includes(input.action_title!.toLowerCase()));
    }
    return actions[0];
}

function buildActionRange(resolved: ResolvedPosition, input: CodeActionsInput): vscode.Range {
    if (typeof input.end_line !== 'number') return new vscode.Range(resolved.position, resolved.position);
    const endLine = Math.max(0, Math.min(input.end_line - 1, resolved.document.lineCount - 1));
    const endText = resolved.document.lineAt(endLine).text;
    const endCharacter = Math.max(0, Math.min(input.end_character ?? endText.length, endText.length));
    return new vscode.Range(resolved.position, new vscode.Position(endLine, endCharacter));
}

function formatLocations(mode: LocationMode, source: ResolvedPosition, locations: NormalizedLocation[], maxResults: number, note?: string): string {
    const lines = [
        `# Symbol ${mode}`,
        '',
        `Source: ${asRelative(source.uri)}:${source.position.line + 1}:${source.position.character}`,
        `Results: ${locations.length}`,
    ];
    if (note) lines.push(`Note: ${note}`);
    lines.push('');
    for (const location of locations.slice(0, maxResults)) {
        const start = location.range.start;
        lines.push(`- ${asRelative(location.uri)}:${start.line + 1}:${start.character}`);
    }
    if (locations.length > maxResults) lines.push(`- ...${locations.length - maxResults} more result(s) omitted`);
    return lines.join('\n');
}

class SymbolLocationsTool implements vscode.LanguageModelTool<SymbolLocationsInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SymbolLocationsInput>) {
        const mode = options.input.mode ?? 'references';
        const maxResults = Math.max(1, Math.min(options.input.max_results ?? 80, 500));
        const resolved = await resolvePosition(options.input);
        if ('error' in resolved) return textResult(resolved.error);

        const command = mode === 'references'
            ? 'vscode.executeReferenceProvider'
            : mode === 'definition'
                ? 'vscode.executeDefinitionProvider'
                : mode === 'implementation'
                    ? 'vscode.executeImplementationProvider'
                    : 'vscode.executeTypeDefinitionProvider';
        const raw = mode === 'references'
            ? await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(command, resolved.uri, resolved.position, options.input.include_declaration ?? false)
            : await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(command, resolved.uri, resolved.position);
        const locations = (raw ?? []).map(normalizeLocation);

        if ((options.input.format ?? 'markdown') === 'json') {
            return jsonResult({
                mode,
                source: { path: asRelative(resolved.uri), line: resolved.position.line + 1, character: resolved.position.character },
                note: resolved.note,
                count: locations.length,
                results: locations.slice(0, maxResults).map(location => ({
                    path: asRelative(location.uri),
                    line: location.range.start.line + 1,
                    character: location.range.start.character,
                    end_line: location.range.end.line + 1,
                    end_character: location.range.end.character,
                })),
            });
        }
        return textResult(formatLocations(mode, resolved, locations, maxResults, resolved.note));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SymbolLocationsInput>) {
        return { invocationMessage: `Finding ${options.input.mode ?? 'references'} for ${options.input.path}` };
    }
}

class SymbolRenameTool implements vscode.LanguageModelTool<SymbolRenameInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SymbolRenameInput>) {
        const newName = String(options.input.new_name ?? '').trim();
        if (!newName) return textResult('new_name is required.');
        const resolved = await resolvePosition(options.input);
        if ('error' in resolved) return textResult(resolved.error);
        const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>('vscode.executeDocumentRenameProvider', resolved.uri, resolved.position, newName);
        if (!edit) return textResult('No rename edit was returned by the active language provider.');
        const entries = editSummary(edit);
        const summary = {
            source: { path: asRelative(resolved.uri), line: resolved.position.line + 1, character: resolved.position.character },
            new_name: newName,
            apply: options.input.apply === true,
            file_count: entries.length,
            edit_count: entries.reduce((total, item) => total + item.edits, 0),
            files: entries,
            note: resolved.note,
        };

        if (options.input.apply !== true) {
            if ((options.input.format ?? 'markdown') === 'json') return jsonResult({ ...summary, applied: false });
            return textResult([
                '# Symbol rename dry run',
                '',
                `Source: ${summary.source.path}:${summary.source.line}:${summary.source.character}`,
                `New name: ${newName}`,
                `Files: ${summary.file_count}`,
                `Edits: ${summary.edit_count}`,
                resolved.note ? `Note: ${resolved.note}` : undefined,
                '',
                ...entries.map(item => `- ${item.path}: ${item.edits} edit(s)`),
                '',
                'Set apply:true to apply this WorkspaceEdit after confirmation.',
            ].filter(Boolean).join('\n'));
        }

        const root = workspaceRoot();
        if (!root) return textResult('No workspace root is open.');
        const applied = await withOperationLock(root, 'symbol-rename', 'rename', summary, async () => vscode.workspace.applyEdit(edit));
        const result = { ...summary, applied };
        if ((options.input.format ?? 'markdown') === 'json') return jsonResult(result);
        return textResult([
            '# Symbol rename applied',
            '',
            `Applied: ${applied}`,
            `Source: ${summary.source.path}:${summary.source.line}:${summary.source.character}`,
            `New name: ${newName}`,
            `Files: ${summary.file_count}`,
            `Edits: ${summary.edit_count}`,
            '',
            ...entries.map(item => `- ${item.path}: ${item.edits} edit(s)`),
        ].join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SymbolRenameInput>) {
        const base = { invocationMessage: options.input.apply ? `Renaming symbol in ${options.input.path}` : `Previewing rename in ${options.input.path}` };
        if (!options.input.apply || (vscode.workspace.getConfiguration('harmony').get<boolean>('autoApproveTools') ?? false)) return base;
        return {
            ...base,
            confirmationMessages: {
                title: 'Apply symbol rename?',
                message: new vscode.MarkdownString(
                    `Harmony wants to apply a language-provider rename in:\n\n\`${options.input.path}\`\n\nNew name: \`${options.input.new_name}\``
                )
            }
        };
    }
}

class CodeActionsTool implements vscode.LanguageModelTool<CodeActionsInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<CodeActionsInput>) {
        const resolved = await resolvePosition(options.input);
        if ('error' in resolved) return textResult(resolved.error);
        const range = buildActionRange(resolved, options.input);
        const kind = options.input.kind ? vscode.CodeActionKind.Empty.append(options.input.kind) : undefined;
        const raw = await vscode.commands.executeCommand<Array<vscode.CodeAction | vscode.Command>>('vscode.executeCodeActionProvider', resolved.uri, range, kind);
        const allActions = raw ?? [];
        const actions = options.input.only_preferred
            ? allActions.filter(action => isCodeAction(action) && action.isPreferred === true)
            : allActions;
        const maxResults = Math.max(1, Math.min(options.input.max_results ?? 50, 200));
        const summaries = actions.slice(0, maxResults).map(actionSummary);
        const base = {
            source: { path: asRelative(resolved.uri), line: resolved.position.line + 1, character: resolved.position.character },
            range: {
                start_line: range.start.line + 1,
                start_character: range.start.character,
                end_line: range.end.line + 1,
                end_character: range.end.character,
            },
            kind: options.input.kind,
            count: actions.length,
            note: resolved.note,
            actions: summaries,
        };

        if (options.input.apply !== true) {
            if ((options.input.format ?? 'markdown') === 'json') return jsonResult({ ...base, applied: false });
            return textResult([
                '# Code actions',
                '',
                `Source: ${base.source.path}:${base.source.line}:${base.source.character}`,
                `Results: ${actions.length}`,
                resolved.note ? `Note: ${resolved.note}` : undefined,
                '',
                ...summaries.map(action => `- ${action.index}. ${action.title}${action.kind ? ` (${action.kind})` : ''}${action.disabled ? ` - disabled: ${action.disabled}` : ''}${action.has_command && !action.has_edit ? ' - command' : ''}`),
                actions.length > maxResults ? `- ...${actions.length - maxResults} more result(s) omitted` : undefined,
                '',
                'Set apply:true with action_index or action_title to apply one action after confirmation.',
            ].filter(Boolean).join('\n'));
        }

        const selected = resolveAction(actions, options.input);
        if (!selected) return textResult('No matching code action was found.');
        const codeAction = isCodeAction(selected) ? selected : undefined;
        if (codeAction?.disabled) return textResult(`Selected action is disabled: ${codeAction.disabled.reason}`);
        const edit = codeAction?.edit;
        const command = actionCommand(selected);
        if (!edit && !command) return textResult('Selected action has no edit or command to apply.');
        if (command && options.input.allow_command !== true) {
            return textResult(`Selected action includes command '${command.command}'. Re-run with allow_command:true if you explicitly want Harmony to execute it.`);
        }

        const root = workspaceRoot();
        if (!root) return textResult('No workspace root is open.');
        const summary = actionSummary(selected, actions.indexOf(selected));
        const result = await withOperationLock(root, 'code-action', 'apply-code-action', { source: base.source, action: summary }, async () => {
            const editApplied = edit ? await vscode.workspace.applyEdit(edit) : undefined;
            const commandResult = command ? await vscode.commands.executeCommand(command.command, ...(command.arguments ?? [])) : undefined;
            return { edit_applied: editApplied, command_executed: !!command, command_result_type: commandResult === undefined ? undefined : typeof commandResult };
        });
        if ((options.input.format ?? 'markdown') === 'json') return jsonResult({ ...base, selected: summary, applied: true, result });
        return textResult([
            '# Code action applied',
            '',
            `Action: ${summary.title}`,
            `Edit applied: ${result.edit_applied ?? 'none'}`,
            `Command executed: ${result.command_executed}`,
            `Source: ${base.source.path}:${base.source.line}:${base.source.character}`,
        ].join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<CodeActionsInput>) {
        const base = { invocationMessage: options.input.apply ? `Applying code action in ${options.input.path}` : `Listing code actions in ${options.input.path}` };
        if (!options.input.apply || (vscode.workspace.getConfiguration('harmony').get<boolean>('autoApproveTools') ?? false)) return base;
        return {
            ...base,
            confirmationMessages: {
                title: 'Apply code action?',
                message: new vscode.MarkdownString(
                    `Harmony wants to apply one VS Code code action in:\n\n\`${options.input.path}\`\n\nAction selector: \`${options.input.action_title ?? options.input.action_index ?? 'first result'}\``
                )
            }
        };
    }
}

export function registerSymbolTools(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.lm.registerTool('harmony_symbol_locations', new SymbolLocationsTool()),
        vscode.lm.registerTool('harmony_symbol_rename', new SymbolRenameTool()),
        vscode.lm.registerTool('harmony_code_actions', new CodeActionsTool()),
    );
}