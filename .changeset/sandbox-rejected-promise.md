---
"@ifc-lite/sandbox": patch
---

Report a script that hands back a rejected promise as a failure instead of a successful run (#2077).

The extension host wraps an entry file as `return activate(ctx)`, so when the entry is `async` the eval result IS the promise. A throw after its first `await` settles that promise as *rejected* without ever touching `result.error` — the main body succeeded, so `eval()` reported success and `vm.dump` rendered the rejection as ordinary data (`{ type: 'rejected', error: … }`) in `ScriptResult.value`. A script whose async entry point threw therefore looked like a clean pass.

Draining the job queue cannot close this: `executePendingJobs()` documents that it does not return errors thrown inside `async` functions or rejected promises — QuickJS captures those in the promise itself — so the promise's own state is the only signal. After draining, the sandbox now reads that state and raises the same `ScriptError` (with the rejection reason as the message, plus logs and `durationMs`) the main-body error path already raises, freeing the settled-value and rejection handles on every exit so teardown stays clean.

The check runs *after* the interrupt flag added for the CPU-timeout case, so a job cut short by the deadline still reports as `interrupted` rather than as a generic rejection. The result of `executePendingJobs()` is now read before being disposed, so an exception that stops the queue outright is reported instead of discarded. Scripts whose promises fulfil, and scripts that return a non-promise value, are unaffected and still report success with the same value.

Not covered: a rejection in a promise the script never hands back (`run(); 'started'`) remains invisible — quickjs-emscripten 0.32 exposes no host promise-rejection tracker (`RuntimeOptions.promiseRejectionHandler` is unimplemented), so there is no handle to inspect.
