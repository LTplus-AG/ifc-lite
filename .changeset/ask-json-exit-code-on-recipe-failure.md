---
"@ifc-lite/cli": patch
---

Fix `ifc-lite ask <file> "<question>" --json` always exiting 0, even when the matched recipe throws.

The recipe-execution catch branched on `--json`: the non-JSON path called `fatal()`, which hard-exits 1, but the JSON path only printed `{ error }` and fell through without setting `process.exitCode` — a caller reading just the exit code (a build pipeline, a script) saw success on a question that could not be answered. The `--json` path now sets `process.exitCode = 1` in that catch, matching the non-JSON verdict.
