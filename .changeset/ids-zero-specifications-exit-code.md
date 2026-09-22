---
"@ifc-lite/cli": patch
---

`ifc-lite ids` now exits non-zero and reports "declares zero specifications" (as a machine-readable `error` field in `--json` output, and in the human-readable result line) when the given IDS file declares zero specifications. Previously both output paths derived the exit code only from `failedSpecifications`, so an empty ruleset reported `Result: PASS` and exited `0` even though nothing was evaluated. Specifications that exist but legitimately match no entities are unaffected and continue to pass.
