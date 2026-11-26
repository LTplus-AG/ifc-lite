---
"@ifc-lite/mcp": minor
---

Add `script_run` and `script_run_mutate`: run JavaScript against the `bim` SDK in the `@ifc-lite/sandbox` QuickJS sandbox, with `timeout_ms` and `memory_mb` limits. `script_run` has no `bim.mutate`, `bim.store`, `bim.export` or `bim.create`; `script_run_mutate` is hidden under `--read-only` and gets `bim.export` and `bim.create` only when the token also holds the `export` scope; both tools need `read`. Script code runs synchronously on the server's event loop, so other requests wait while it runs; `timeout_ms` tops out at 30 s. Neither gets network, files or viewer access. Tools can now declare an `outputSchema`, advertised in `tools/list`; an error result from such a tool carries its `{ code, message, details, hint }` envelope in the text block instead of `structuredContent`, so clients that validate it against the schema still see the error.
