---
"@ifc-lite/extensions": minor
---

Phase 1 — end-to-end `entry.activate(ctx)` execution.

The activation runtime now actually runs extension entry scripts. The
calling convention for v1 is settled:

- Entry files are **plain JavaScript** that define a top-level function
  matching the entry name (`activate`, `deactivate`, or a command
  handler id).
- The function takes a `ctx` parameter; for v1, `ctx = { bim }` only.
  Future ctx fields (`fetch`, `storage`, `notify`, `onDispose`, `t`,
  `meta`) hang off the same contract — no rewrite required.
- ES module syntax (`import`, `export`) is **not supported** in v1.
  The source-wrap parser rejects it with structured errors; the CLI
  scaffold writes the right shape.
- Async user code is fire-and-forget at activation: the IIFE may
  return a Promise (`activateResult.value`), but the runtime does not
  await it. Long-running work belongs on command/trigger fires.

Three new modules:

- **`host/source-wrap.ts`** — wraps user source as an IIFE that
  installs `__ifclite_ctx__` and `bim`, then invokes the entry
  function. Validates with acorn; rejects `import`/`export`
  statements before the sandbox ever sees the code.
- **`host/memory-factory.ts`** — `createMemorySandboxFactory()`. Host
  realm `new Function()`-backed factory for headless tests. **Not a
  security boundary** — documented in-file. Production hosts use the
  QuickJS factory that ships with the viewer.
- **`host/runtime.ts`** (extended) — `ExtensionRuntime.activate(id, grants, bundle)`
  reads the entry script from the bundle, wraps it, runs it, captures
  logs + duration + return value. Disposes the sandbox on any
  failure. `deactivateWithBundle` mirrors the flow for the optional
  `entry.deactivate` script.

Test count: 307 (up from 269 / +38). The activation flow tests use
the in-memory factory to exercise the full pipeline end-to-end —
bundle in, IIFE out, activateResult captured. The viewer-side QuickJS
factory adapts `Sandbox.eval` to the same `RuntimeSandboxHandle.run`
shape; that wiring lands with the UI integration.
