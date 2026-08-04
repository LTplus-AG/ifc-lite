---
"@ifc-lite/sandbox": patch
---

Stop a caught `ScriptError`'s `logs` from being emptied by the next `eval()` (#2092).

`ScriptError` stored the constructor's `logs` argument by reference, and every `ScriptError` is constructed with the sandbox's single log buffer — the same array `Sandbox.eval()` clears in place (`this.logs.length = 0`) at the start of each run. An embedder that caught an error, kept it for a retry or a report, and then ran another script found the error's logs empty, after having already inspected them. `ScriptError` now copies the array at construction, so a caught error keeps the console output of the run that failed for as long as the error is held.

Only the error path was affected: the success path already returned `logs: [...this.logs]`, and the two are now consistent. Sandboxes that never retain an error across evals see no change.
