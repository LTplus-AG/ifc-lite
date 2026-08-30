---
'@ifc-lite/cli': minor
---

Fix `ifc-lite bsdd`'s `--json` flag doing nothing: every subcommand (`class`, `search`, `psets`, `qsets`) called `printJson(...)` unconditionally, so the parsed `--json` value was never read and output was identical with or without the flag. `bsdd` now prints a human-readable summary by default (matching every other CLI command's `--json` convention, e.g. `ext capabilities`) and the raw structured payload only under `--json`.

Anyone piping `bsdd` output into `jq`/another JSON consumer without passing `--json` (relying on the previous always-JSON behaviour) now needs to add `--json` to keep getting structured output.
