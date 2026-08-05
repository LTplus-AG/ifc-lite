---
"@ifc-lite/sandbox": minor
---

Sandbox: serialize `eval()` per sandbox, and contain the upstream QuickJS teardown abort.

`Sandbox.eval` no longer runs overlapping calls concurrently. The bridge's log buffer, its byte budget and the `truncated` flag are built once per sandbox and shared by every run, and `eval()` resets them before each script — so two overlapping calls fought over one buffer and either run's `ScriptResult.logs` could come back short, empty, or carrying the other run's entries. Each call now queues behind the one before it on a per-sandbox promise chain. Sequential callers see no change; a caller that fanned out concurrent evals on one sandbox now gets serialized execution and correct per-run logs. A failed run does not block the runs queued behind it.

`Sandbox.dispose()` now reports the upstream `JS_FreeRuntime` abort as a `SandboxAbortError` naming the condition and the issue, instead of a bare emscripten assertion. That abort is upstream (`quickjs-emscripten`) and still cannot be prevented from here: an out-of-memory inside a drained promise job orphans objects with leaked refcounts, and forcing collection, lifting the memory limit, re-draining the job queue and skipping the context free were each measured — in a fresh process per trial — to abort anyway.

New exports supporting that:

- `SandboxAbortError` — thrown by `dispose()` when the runtime free aborts.
- `isSandboxRuntimeAborted()` — whether an abort has occurred in this process. It matters because emscripten latches its `ABORT` flag: only the *first* abort throws, so every later broken teardown reports a false clean. A host that cares should reload rather than keep trusting sandbox teardown.
- `Sandbox.disposed` — a disposed sandbox now rejects `eval()` with "Sandbox disposed" instead of the misleading "Sandbox not initialized. Call init() first." That holds for a `dispose()` arriving *during* a run too: disposal is re-checked after the TypeScript transpile, which is the run's only suspension point, so a React cleanup firing mid-eval rejects with "Sandbox disposed" rather than `TypeError: Cannot read properties of null (reading 'evalCode')`. Runs queued behind it settle with the same error.
