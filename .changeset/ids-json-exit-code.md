---
"@ifc-lite/cli": patch
---

Fix `ifc-lite ids --json` always exiting 0, even when the IDS report contains a failed specification.

The human-readable path has always set `process.exitCode` from `summary.failedSpecifications`, so a CI step piping `ifc-lite ids` output failed the build on a genuine validation failure. The `--json` path returned right after printing the report without ever touching `process.exitCode` — a script driving this command with `--json` (the shape any script would actually parse) saw a clean exit 0 even when every specification failed. Proven by direct invocation: the same fixture exited 1 without `--json` and 0 with it. The `--json` path now sets the same exit code from the same summary.
