---
"@ifc-lite/cli": minor
---

CLI-wide verbosity convention: global `--verbose`, `--quiet`, `--debug`, and `--log-level <error|warn|info|debug>` flags (parsed and stripped before dispatch, so positional file paths are never confused with flag values). Human logs go to stderr only; stdout stays reserved for payloads and `--json`. Failures now print `Error [<command>]: <message>` with a remediation hint, and stack traces show under `--debug`/`--verbose` (the `DEBUG` env var still works). Parser diagnostics are no longer hard-silenced: they surface on stderr under `--verbose`. `export` gains `--diagnostics` (implied by `--verbose`), printing the same CSG/opening geometry report as `diagnose-geometry` from the export's own context.
