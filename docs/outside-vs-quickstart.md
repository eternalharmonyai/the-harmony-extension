# Harmony Outside VS Code Quickstart

Use this when VS Code or Cursor is closed and you still want Harmony's local control surface.

## What This Is

This starts Harmony's local/native control window from the source workspace. It uses the same CLI, policy, receipts, snapshots, provider-key metadata, and self-healing checks as the VS Code extension.

## What This Is Not

This is not a replacement for the `@harmony` VS Code chat participant. It does not give the native window direct access to VS Code Secret Storage. Extension-side Primary, Agents, and VS Code swarm provider calls still use VS Code Secret Storage when VS Code is open.

## Start The Native Window

1. Open PowerShell.
2. Go to the Harmony repository root. Replace `<path-to-HarmonyExtension>` with the folder where this repository is checked out:

```powershell
cd <path-to-HarmonyExtension>
```

3. Start the native control window:

```powershell
node bin\harmony-cli.js ui native
```

You should see a Tauri window open. The command starts or reuses the local backend at `http://127.0.0.1:8788`.

## Preview Without Starting

Run this when you want to confirm what would launch before opening anything:

```powershell
node bin\harmony-cli.js ui native --dry-run --json
```

## Provider Keys Outside VS Code

CLI/native provider calls use this order:

1. Process environment variables.
2. Windows User environment variables.
3. Windows Machine environment variables.
4. Harmony's Windows DPAPI current-user secret store.

To import keys from the ignored workspace `.env` file without printing values:

```powershell
node bin\harmony-cli.js secrets set --provider deepseek --from-dotenv .env --dotenv-key DEEPSEEK_EXTERNAL_API_KEY --confirm
node bin\harmony-cli.js secrets set --provider alibaba --from-dotenv .env --dotenv-key ALIBABA_EXTERNAL_API_KEY --confirm
node bin\harmony-cli.js secrets set --provider moonshot --from-dotenv .env --dotenv-key MOONSHOT_EXTERNAL_API_KEY --confirm
```

Then verify metadata only:

```powershell
node bin\harmony-cli.js providers status
node bin\harmony-cli.js secrets status
```

After a confirmed terminal provider call, `providers status` also shows the most recent provider latency for that provider. This is timing metadata only; it does not print prompts, responses, or keys.

## Alibaba Regions

The Alibaba console region is where the key is created. The API base URL is the endpoint Harmony calls.

For Alibaba Model Studio OpenAI-compatible Chat, Alibaba documents the SDK base URL for Singapore and US (Virginia) as:

```text
https://dashscope-intl.aliyuncs.com/compatible-mode/v1
```

In Harmony, keep `harmony.alibaba.endpointProfile` as `international` for Singapore and US (Virginia) keys. The `us` profile also uses this shared international base URL unless `harmony.alibaba.baseUrl` is set for an account-specific override.

Use `harmony.alibaba.endpointProfile = mainland` only for mainland China/Beijing keys. Use `custom` only when Alibaba gives you a different exact `https://.../v1` style base URL.

## Self-Healing Checks

These commands do not install or reload editors:

```powershell
node bin\harmony-cli.js self-healing status
node bin\harmony-cli.js self-healing report
node bin\harmony-cli.js self-healing gate
node bin\harmony-cli.js self-healing package-preflight
```

`package-preflight` is preview-only until you add `--confirm`.

## If Something Does Not Open

1. Run the dry run command above.
2. Check whether port `8788` is already in use:

```powershell
node bin\harmony-cli.js ui serve --port 8788
```

3. If the backend starts but the native window does not, start the backend in one terminal and the native UI in another:

```powershell
node bin\harmony-cli.js ui serve --port 8788
```

```powershell
npm --prefix native-ui run tauri:dev
```

If a command reports a missing dependency, run `npm install` in the repository root and `npm install --prefix native-ui` once.