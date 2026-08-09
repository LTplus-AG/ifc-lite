---
"@ifc-lite/geometry": patch
---

`IfcLiteBridge.disposeBestEffort()`'s recovery `catch` — reached when `free()` itself throws or traps while cleaning up after a primary WASM failure — silently dropped the secondary error, unlike every other catch site in `ifc-lite-bridge.ts`, which reports what it recovered from via `log.error`. It now does the same, so a `free()` failure during recovery leaves a trace instead of vanishing.

This is diagnostics only: `reset()` still runs unconditionally and `disposeBestEffort()` still never throws, so the original error the caller is already unwinding with (including the fatal `isWasmRuntimeError` path in `init()`) is unaffected — the `log.error` call is itself wrapped so a throwing logger cannot defeat that guarantee.
