---
"@ifc-lite/mcp": minor
---

Add `script_run` and `script_run_mutate`: run JavaScript against the `bim` SDK in the `@ifc-lite/sandbox` QuickJS sandbox, with `timeout_ms` and `memory_mb` limits. `script_run` has no `bim.mutate` or `bim.store`; `script_run_mutate` is hidden under `--read-only`. Both need the `admin` scope (the stdio default): script code runs on the server's event loop and would hold every other session on a shared HTTP server. Neither gets network, files or viewer access. Tools can now declare an `outputSchema`, advertised in `tools/list`; an error result from such a tool carries its `{ code, message, details }` envelope in the text block instead of `structuredContent`, so clients that validate it against the schema still see the error.
