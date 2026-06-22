# Harmony Browser Tooling Recovery

## What This Is

This is the recovery path for Harmony browser/screenshot failures such as `spawn EINVAL`, missing Playwright packages, or a Chromium launch failure.

## First Check

Run `harmony_browser_health` without repair first. It should report:

- the Playwright package name
- the local tool-cache folder
- whether the package is cached
- whether Chromium launches
- whether repair was requested

## Playwright Cache Repair

If the package is missing or Chromium cannot launch, run `harmony_browser_health` with `repair: true` after confirmation.

Repair may install or verify Playwright/Chromium in the local Harmony tool cache. It should not print secrets, prompts, or browser session data.

## Integrated Browser Fallback

If Harmony's Playwright-backed tools still fail, use the VS Code Integrated Browser fallback for public or local pages:

1. Open the page with `open_browser_page`.
2. Inspect the page with `read_page` or the accessibility snapshot returned by the open call.
3. Capture the viewport with `screenshot_page`.
4. Continue the user task from that screenshot and page snapshot.

This fallback does not fix the Harmony Playwright cache, but it keeps visual/frontend work moving while the cache or process-launch problem is diagnosed.

Harmony browser health, screenshot, and browser-action failures include these fallback steps in their output so the next agent turn has an explicit continuation path.

## After Installing A Fix

After installing a VSIX that changes browser tooling, reload VS Code or Cursor before testing again. The installed extension package can be newer than the currently running extension host until reload.

## Success Gate

The browser tooling path is healthy when all of these are true:

- `harmony_browser_health` returns JSON instead of a raw tool failure.
- `chromium_launch_ok` is `true`, or the error is structured enough to explain the next repair step.
- `harmony_browser_action` can open a public page and return page text or a screenshot path.
- If Playwright still fails, the Integrated Browser fallback can open and screenshot the same page.