---
"@ifc-lite/cli": minor
---

`ext test` now exits non-zero for a bundle that declares no tests, instead of vacuously passing on `summary.failed === 0` with nothing to fail; `--json` output now carries an `ok` field so a script does not have to infer this from `passed`/`failed` both being `0`. `ids --locale <value> <file.ifc> <rules.ids>` and `rekey --lineage <file> <table>` (with any value-taking flag before the positional path) now resolve the real file paths instead of consuming the flag's value as a positional argument. A CI pipeline relying on the previous `ext test` exit-0-on-empty behaviour will now see a failure on that path — a deliberate, minor behaviour change.
