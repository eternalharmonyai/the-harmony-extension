# 🔴 Harmony Lifeline — Repair Without VS Code Chat

**Use when:** `@harmony` chat is unavailable, the extension host is broken, or
you need to repair the extension from a plain terminal. Everything below runs
from a terminal with **zero VS Code chat involvement**. Keep this file
readable offline (print or open in Notepad).

> Replace `<extension-root>` with the folder where the extension is installed
> or where you keep its source checkout.

## 0. Golden rules

- Every mutating CLI step has `--confirm` gates and writes receipts under `.harmony/`.
- Snapshots exist before patches (`snapshot create`), so nothing is one-way.
- A previous VSIX build is always one install command away — see step 2.

## 1. Diagnose from outside (read-only)

```powershell
cd <extension-root>

# Hub/backend/lock/supervisor summary
node bin/harmony-cli.js status
node bin/harmony-cli.js diagnose

# VS Code extension host errors (which window, what failed)
$logs = Join-Path $env:APPDATA 'Code\logs'
Get-ChildItem $logs -Directory | Sort-Object Name | Select-Object -Last 3 -ExpandProperty Name
# then: Get-ChildItem "$logs\<session>" -Recurse -Filter *.log | Select-String -Pattern 'harmony' -List
```

## 2. Rollback to a previous VSIX (the definitive reverse)

```powershell
# Replace <path-to-vsix> with a previously working .vsix file.
# NOTE: plain `code` on PATH may be another editor's shim — use the full path
# to your VS Code CLI if `code` is not VS Code itself.
code --install-extension <path-to-vsix> --force
```

Then reload the window: `Ctrl+Shift+P` → `Developer: Reload Window`.

## 3. Apply a patch from outside (guarded)

```powershell
# Snapshot first (always)
node bin/harmony-cli.js snapshot create

# Apply a unified-diff patch file through the policy/lock/git-apply-check gates
node bin/harmony-cli.js run-fail-fix --apply --patch-file .\fix.patch --confirm

# If it went wrong:
node bin/harmony-cli.js snapshot list
node bin/harmony-cli.js snapshot restore --latest --all --confirm
```

## 4. Rebuild + reinstall from outside

```powershell
cd <extension-root>
npm run package
code --install-extension .\harmony-extension-<version>.vsix --force
```

## 5. Editor identity cheatsheet

If `code` on your PATH points to a different editor than the one you use for
Harmony, use the full path to the correct CLI instead:

| Command | Installs to |
|---|---|
| `code --install-extension` | The editor whose CLI owns PATH |
| `"...\Microsoft VS Code\bin\code.cmd" --install-extension` | VS Code |
| VS Code install root | `...\Microsoft VS Code\<commit-hash>\resources\app\...` (hash dir in recent builds) |

## 6. When VS Code itself changes the rules

1. `node bin/harmony-cli.js self-healing status` — source/package/install readiness.
2. Inspect the installed workbench bundle for the changed API truth:
   ```powershell
   $wb = Get-ChildItem '...\Microsoft VS Code\*\resources\app\out\vs\workbench\workbench.desktop.main.js' | Select-Object -First 1
   Select-String -Path $wb.FullName -Pattern 'your-search-string' -SimpleMatch
   ```
3. Patch, snapshot, rebuild, reinstall — steps 3–4 above.

## 7. Float UI without chat (native window)

```powershell
node bin/harmony-cli.js ui native          # backend + native floating chat window
node bin/harmony-cli.js ui serve --open    # browser dashboard fallback
```
