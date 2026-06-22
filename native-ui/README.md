# Harmony Native Control

Design decision: this native window is a client shell for the existing localhost Harmony UI backend. It does not own policy, locks, ledgers, snapshots, provider keys, or execution. Those stay in the CLI/VS Code/HarmonyHub path.

## Run Locally

From the extension repo root, the one-command launcher is:

```powershell
node bin/harmony-cli.js ui native
```

That command starts or reuses the localhost backend at `http://127.0.0.1:8788`, opens the Tauri native window, and stops its owned backend when the window closes.

To inspect the launch plan without starting anything:

```powershell
node bin/harmony-cli.js ui native --dry-run --json
```

Manual two-terminal launch still works:

1. Start the existing backend from the extension repo root:

```powershell
node bin/harmony-cli.js ui serve --port 8788
```

1. In another terminal, install this scaffold once:

```powershell
npm install --prefix native-ui
```

1. Start the Tauri window:

```powershell
npm --prefix native-ui run tauri:dev
```

## Validate

```powershell
npm --prefix native-ui run build
cargo check --manifest-path native-ui/src-tauri/Cargo.toml
```

## Contract

- The native window loads `http://127.0.0.1:8788` by default.
- It can point at another local Harmony UI URL through the connection box.
- It never calls provider APIs directly.
- It never writes Harmony state directly.
- It never runs git, shell, snapshot, restore, apply, or commit operations.
- Any future native action must call the backend and inherit backend policy, lock, ledger, and recovery checks.
