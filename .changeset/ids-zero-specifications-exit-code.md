---
"@ifc-lite/cli": patch
---

`ifc-lite ids` now exits non-zero and reports "declares zero specifications" (as a machine-readable `error` field in `--json` output, and in the human-readable result line) when the given IDS file declares zero specifications. Previously both output paths derived the exit code only from `failedSpecifications`, so an empty ruleset reported `Result: PASS` and exited `0` even though nothing was evaluated. Specifications that exist but legitimately match no entities are unaffected and continue to pass.

`ifc-lite layer publish --check <spec.ids>=<report.json>` also refuses a report that declares zero specifications. It used to record such a report as a passing check, which could satisfy a `requiredChecks` ref policy even though nothing had been evaluated.
