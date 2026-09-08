# Agent Editing Rules — VS Code Extension Development

These rules prevent accidental data loss when an AI coding collaborator edits a
VS Code extension workspace. Treat them as a **starting point**: always check
for newer rules first, but apply these by default.

## 1. Prove the defect before writing the fix

Establish that the problem exists, with evidence you can show, before writing
anything that repairs it. A repair applied to healthy data is how healthy data
gets lost. If measurement contradicts the report, investigate the
contradiction — do not assume either is right.

## 2. Reading is always safe; writing to live data is not

Reading a file — including one a running process is writing — is safe and is
exactly how you diagnose. Only *writing* is restricted.

Before **editing** any file, ask: **is a running process writing to this file
right now?**

- **Live-written data** — logs, ledgers, caches, state databases, event
  streams, or anything appended-to by an active extension or service — must
  **never be edited in place**. Editing while the owner writes to it corrupts
  or loses data. Instead:
  1. Change the *owning code* so it writes correctly going forward.
  2. Rebuild and reinstall the extension, then reload the window.
  3. Only transform existing live data while the owning process is stopped.

- **Static files** — source code, configuration, documentation — may be
  edited directly. But an already-running extension executes its *compiled*
  output, so edits take effect only after rebuild + reinstall + reload.

## 3. If you must write to data, make it reversible

Back up first, verify after, and provide an undo path. Never rewrite data
without a way back.

## 4. The host UI vs. the host's data

The editor's own surfaces (chat panel, views, menus) are rendered by the host
application — an extension cannot edit them directly; change the extension's
source and rebuild + reinstall + reload.

The host's *data files* (e.g. session/chat storage) are separate: they belong
to the host. Touch them only when the host is stopped, only with proof of a
defect, and only with a backup.

## 5. Verify before you touch

- Confirm a file's live-vs-static status before writing to it.
- When unsure, change code rather than editing data.
- Re-check for updated rules before acting on older guidance.
