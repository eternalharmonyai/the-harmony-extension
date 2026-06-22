import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';

export interface AgentProfile {
  id: string;
  name: string;
  role: string;
  personality: string;
  provider_preference?: {
    provider: string;
    model: string;
  };
  knowledge_capsules?: string[];
  tool_restrictions?: {
    allowed_tools?: string[];
    denied_tools?: string[];
  };
}

/**
 * Simple YAML subset parser for Symphony agent profiles.
 * Handles: scalars, multi-line strings (|), nested mappings, lists (-).
 */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const lines = text.split('\n');
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentList: string[] = [];
  let collectingMultiLine = false;
  let multiLineIndent = 0;
  let multiLineLines: string[] = [];
  let currentNested: Record<string, unknown> | null = null;
  let nestedKey: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trimStart();
    const indent = raw.length - trimmed.length;

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) {
      if (collectingMultiLine) {
        multiLineLines.push(raw.slice(Math.min(multiLineIndent, raw.length)));
      }
      continue;
    }

    // End multi-line if indent drops back
    if (collectingMultiLine && indent <= multiLineIndent && !trimmed.startsWith('-') && trimmed.includes(':')) {
      result[currentKey!] = multiLineLines.join('\n').trim();
      collectingMultiLine = false;
      multiLineLines = [];
    }

    if (collectingMultiLine) {
      multiLineLines.push(raw.slice(Math.min(multiLineIndent, raw.length)));
      continue;
    }

    // List item
    if (trimmed.startsWith('- ')) {
      const value = trimmed.slice(2).trim();
      currentList.push(value);
      continue;
    }

    // Flush list
    if (currentList.length > 0 && currentKey && !trimmed.startsWith('- ')) {
      if (currentNested) {
        currentNested[currentKey] = [...currentList];
      } else {
        result[currentKey] = [...currentList];
      }
      currentList = [];
    }

    // Key: value
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();

    // Multi-line indicator |
    if (rest === '|') {
      currentKey = key;
      collectingMultiLine = true;
      multiLineIndent = indent;
      multiLineLines = [];
      currentNested = null;
      nestedKey = null;
      continue;
    }

    // Nested mapping indicator (empty value + next line indented)
    if (rest === '' || rest === '{}') {
      currentNested = {};
      nestedKey = key;
      continue;
    }

    // Nested value
    if (currentNested && indent > 0) {
      currentNested[key] = rest.replace(/^['"]|['"]$/g, '');
      continue;
    }

    // Flush nested
    if (currentNested && indent === 0) {
      result[nestedKey!] = currentNested;
      currentNested = null;
      nestedKey = null;
    }

    // Simple scalar
    result[key] = rest.replace(/^['"]|['"]$/g, '');
  }

  // Flush remaining
  if (collectingMultiLine && currentKey) {
    result[currentKey] = multiLineLines.join('\n').trim();
  }
  if (currentList.length > 0 && currentKey) {
    if (currentNested) {
      currentNested[currentKey] = [...currentList];
    } else {
      result[currentKey] = [...currentList];
    }
  }
  if (currentNested && nestedKey) {
    result[nestedKey] = currentNested;
  }

  return result;
}

export class ProfileRegistry {
  private static instance: ProfileRegistry;
  private profiles = new Map<string, AgentProfile>();
  private loaded = false;

  private constructor() {}

  static getInstance(): ProfileRegistry {
    if (!this.instance) this.instance = new ProfileRegistry();
    return this.instance;
  }

  private profilesDir(): string {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    return workspace
      ? path.join(workspace.uri.fsPath, '.harmony', 'profiles')
      : path.join(process.cwd(), '.harmony', 'profiles');
  }

  private capsulesDir(): string {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    return workspace
      ? path.join(workspace.uri.fsPath, '.harmony', 'capsules')
      : path.join(process.cwd(), '.harmony', 'capsules');
  }

  async loadAll(): Promise<void> {
    this.profiles.clear();
    const dir = this.profilesDir();
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
        try {
          const content = await fs.readFile(path.join(dir, entry), 'utf-8');
          const raw = parseSimpleYaml(content);
          const profile = this.validate(raw);
          if (profile) {
            this.profiles.set(profile.id, profile);
          }
        } catch {
          // Skip invalid profiles silently
        }
      }
    } catch {
      // Directory doesn't exist — no profiles
    }
    this.loaded = true;
  }

  private validate(raw: Record<string, unknown>): AgentProfile | null {
    if (!raw.id || !raw.name || !raw.role || !raw.personality) return null;
    const profile: AgentProfile = {
      id: String(raw.id),
      name: String(raw.name),
      role: String(raw.role),
      personality: String(raw.personality),
    };

    if (raw.provider_preference && typeof raw.provider_preference === 'object') {
      const pp = raw.provider_preference as Record<string, unknown>;
      if (pp.provider && pp.model) {
        profile.provider_preference = {
          provider: String(pp.provider),
          model: String(pp.model),
        };
      }
    }

    if (Array.isArray(raw.knowledge_capsules)) {
      profile.knowledge_capsules = raw.knowledge_capsules.map(String);
    }

    if (raw.tool_restrictions && typeof raw.tool_restrictions === 'object') {
      const tr = raw.tool_restrictions as Record<string, unknown>;
      profile.tool_restrictions = {};
      if (Array.isArray(tr.allowed_tools)) {
        profile.tool_restrictions.allowed_tools = tr.allowed_tools.map(String);
      }
      if (Array.isArray(tr.denied_tools)) {
        profile.tool_restrictions.denied_tools = tr.denied_tools.map(String);
      }
    }

    return profile;
  }

  get(id: string): AgentProfile | undefined {
    return this.profiles.get(id);
  }

  list(): AgentProfile[] {
    return Array.from(this.profiles.values());
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Compile a system prompt for a profile, including knowledge capsules.
   */
  async compileSystemPrompt(profile: AgentProfile): Promise<string> {
    let prompt = `You are ${profile.name}, acting as a ${profile.role}.\n`;
    prompt += `Personality: ${profile.personality}\n\n`;

    if (profile.knowledge_capsules && profile.knowledge_capsules.length > 0) {
      prompt += `=== ADDITIONAL DOMAIN KNOWLEDGE ===\n`;
      for (const capsuleRelPath of profile.knowledge_capsules) {
        const capsulePath = path.resolve(this.capsulesDir(), capsuleRelPath);
        try {
          const content = await fs.readFile(capsulePath, 'utf-8');
          prompt += `\n[Capsule: ${path.basename(capsuleRelPath)}]\n${content}\n`;
        } catch {
          // Capsule not found — skip
        }
      }
    }

    return prompt;
  }
}
