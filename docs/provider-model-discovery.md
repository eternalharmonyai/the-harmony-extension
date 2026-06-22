# Harmony Provider Model Discovery Guide

This guide explains two different tasks:

1. Choose an exact model ID for your own Harmony install without editing source code.
2. Update Harmony's built-in default model IDs for a future VSIX release.

Use the first path when you only want your local setup to use a model returned by a provider. Use the second path only when you are changing the extension defaults for everyone who installs the next package.

## What This Changes

Live model discovery edits Harmony's per-provider tier overrides. It is not only an Agents setting, even though the buttons are near provider/Agents status in the sidebar.

The same provider/tier table can be used by these routes:

1. Primary `@harmony` direct-provider route:
   - Alibaba/Qwen and Moonshot/Kimi primary choices use the `coding` tier model.
   - DeepSeek primary choices use `harmony.deepseekModel`, so set that from `Harmony: Select Model` or the sidebar DeepSeek dropdown.
   - VS Code LM/Copilot primary route is controlled by the VS Code Chat model dropdown, not by this guide.
2. Collaborative Agents route:
   - `Harmony: Select Collaborative Agents Model` picks a provider and tier.
   - The selected provider/tier uses the exact model ID you assigned in discovery.
3. Swarm provider route:
   - `Harmony: Configure Swarm Defaults` picks a default provider and tier.
   - Swarm uses that model only when provider calls are enabled and explicitly approved.
4. Terminal/native route:
   - The CLI/native side uses environment variables or Windows DPAPI. VS Code Secret Storage and these tier overrides do not automatically rewrite native defaults.

If you only want the local VS Code or Cursor extension to try a newly discovered model, use Path A. If you want a future packaged VSIX to ship new built-in defaults, use Path B.

## Before You Start

You need these things:

1. VS Code or Cursor open with The Harmony Extension installed.
2. The HarmonyExtension source workspace open if you are changing source code. This is the folder that contains `package.json`, `src`, and `bin`.
3. A saved provider API key for the provider you want to query.

Provider keys are secret. Do not paste them into chat.

## Path A: Pick A Model For Your Local Install

This path does not edit source code and does not require packaging a VSIX.

### Step 1: Save Or Import A Provider Key

Use one of these options.

Option 1: Command Palette key entry

1. Press `Ctrl+Shift+P`.
2. Type one of these command names exactly:
   - `Harmony: Set DeepSeek API Key`
   - `Harmony: Set Alibaba / Qwen API Key`
   - `Harmony: Set Moonshot / Kimi API Key`
   - `Harmony: Set Gemini API Key`
3. Press Enter.
4. Paste the provider key into the password input.
5. Press Enter.

What you should see: Harmony says the key was saved. It should never print the key value.

Option 2: Import keys from `.env`

1. Open a terminal.
2. Type exactly this command and press Enter:

```powershell
Set-Location -Path "<HarmonyExtension repo path>"
```

3. Create or update a local `.env` file. Use placeholder text like this, replacing only the value after `=`:

```text
DEEPSEEK_AGENT_API_KEY=replace_with_your_deepseek_key
ALIBABA_API_KEY=replace_with_your_alibaba_key
MOONSHOT_API_KEY=replace_with_your_moonshot_key
GEMINI_API_KEY=replace_with_your_gemini_key
```

4. In VS Code or Cursor, press `Ctrl+Shift+P`.
5. Run `Harmony: Import Provider Keys From .env`.
6. Pick the `.env` file when VS Code asks.

What you should see: Harmony lists which provider keys were imported, using environment variable names only. It should not print secret values.

### Step 2: Open Live Model Discovery

Use either UI path.

Sidebar path:

1. Open the Harmony sidebar.
2. Find the Consult providers section. This section shows provider keys, Primary routing, Agents routing, and Swarm default routing together.
3. Click `Discover models live...`.

Command Palette path:

1. Press `Ctrl+Shift+P`.
2. Type exactly:

```text
Harmony: Discover Models (live)
```

3. Press Enter.

### Step 3: Choose Provider, Model, And Tier

1. Pick the provider to query.
2. Wait for Harmony to call that provider's `/models` endpoint.
3. Pick one exact model ID from the returned list.
4. Pick the tier to assign:
   - `light` for cheaper/faster routes.
   - `mid` for normal balanced routes.
   - `coding` for primary coding and collaborative agent routes.
   - `heavy` for harder, higher-cost routes.

What you should see: Harmony shows a message like `alibaba coding -> qwen3-coder-plus`.

If you see `No API key for provider`, go back to Step 1 and save the key for that provider.

If the provider returns an HTTP error, the key, base URL, account region, or provider availability may be wrong. Do not retry many times with paid providers until the key and endpoint are confirmed.

### Step 4: Use The Selected Model

For primary `@harmony` turns:

1. Press `Ctrl+Shift+P`.
2. Run `Harmony: Select Model`.
3. Choose the provider route you want.
   - Pick Alibaba/Qwen or Moonshot/Kimi if you assigned that provider's `coding` tier.
   - Pick DeepSeek V4 Flash or DeepSeek V4 Pro if you are changing the DeepSeek primary dropdown.
   - Pick VS Code/Copilot if you want the model controlled by the VS Code Chat model picker instead.
4. Start a new `@harmony` chat turn.
5. Confirm the first model banner names the expected provider and model.

For collaborative Agents:

1. Press `Ctrl+Shift+P`.
2. Run `Harmony: Select Collaborative Agents Model`.
3. Choose the provider/tier profile you want.
4. Run `Harmony: Show Agents Provider Status`.
5. Confirm the current tier model matches your selected model ID.

For Swarm provider calls:

1. Press `Ctrl+Shift+P`.
2. Run `Harmony: Configure Swarm Defaults`.
3. Choose the provider and tier that match your discovery assignment.
4. Leave provider-call execution disabled unless you explicitly want a paid provider call during a guarded swarm workflow.

## Path B: Update Built-In Defaults For A VSIX Release

Use this path only when you are changing Harmony source code.

### Step 1: Open The Workspace Terminal

1. Open VS Code or Cursor.
2. Open the HarmonyExtension source folder. It is the folder that contains `package.json`, `src`, and `bin`.
3. Open a PowerShell terminal.
4. Type exactly:

```powershell
Set-Location -Path "<HarmonyExtension repo path>"
```

5. Press Enter.

What you should see: the prompt path ends with the HarmonyExtension source folder name.

### Step 2: Edit The Default Model Map

Open this file:

```text
src/providers.ts
```

Find `PROVIDER_DEFAULTS`. Update only the provider/tier model IDs you intend to change.

Example shape:

```ts
alibaba: {
    light: 'qwen-turbo-latest',
    mid: 'qwen3.5-plus',
    heavy: 'qwen3-max',
    coding: 'qwen3-coder-plus'
}
```

Do not put vision-only or omni-only models into the primary text/tool loop unless the route is intentionally handling image/video payloads.

### Step 3: Update The User-Facing Labels

Check these files when defaults change:

```text
src/extension.ts
src/chatParticipant.ts
src/sidebar.ts
package.json
bin/harmony-cli.js
```

Why: the default map controls routing, but these files control what people see in pickers, slash help, settings descriptions, sidebar controls, and terminal/native defaults.

### Step 4: Compile And Run Focused Smokes

In the same PowerShell terminal, type these commands one at a time:

```powershell
npm run compile
npm run smoke:model-routing
npm run smoke:sidebar-provider
npm run smoke:authority-boundaries
```

What you should see: each command should end with `passed` or exit with no TypeScript errors.

If a command fails, stop and fix that failure before packaging.

### Step 5: Package A VSIX Checkpoint

Check the version first:

```powershell
$version = (Get-Content .\package.json | ConvertFrom-Json).version
$version
```

Then package:

```powershell
npm run package
node bin\harmony-cli.js privacy-scan --vsix "harmony-extension-$version.vsix"
node bin\harmony-cli.js release-receipt --vsix "harmony-extension-$version.vsix" --package-only
```

What you should see: the privacy scan and package-only release receipt should pass.

Do not install this checkpoint unless you are ready for the final install step.

## Final Install Step

Use this only after all planned waves are complete.

```powershell
$version = (Get-Content .\package.json | ConvertFrom-Json).version
npm run install:vsix:both:dry-run
npm run install:vsix:both
node bin\harmony-cli.js release-receipt --vsix "harmony-extension-$version.vsix"
```

What you should see: VS Code and Cursor both verify `harmony.harmony-extension@$version`.

Reload VS Code and Cursor after install so the running extension host uses the new package.