---
"@ifc-lite/sandbox": patch
---

Reset the captured-log budget on every `eval()`, so one log-heavy script no longer silences every later script on the same sandbox.

The bridge caps captured console output twice — by entry count (1000) and by cumulative serialized size (4 MB) — because `vm.dump` copies sandbox values onto the host heap, which the QuickJS memory limit does not bound. `eval()` clears the log buffer in place at the start of every run and hands each result its own copy, so the caps bound one run's output; but `totalBytes` and the `truncated` latch were closed over at construction and never reset. Once a script tripped either cap, `truncated` stayed `true` for the life of the sandbox and the console handlers returned immediately, so every subsequent `eval()` on that sandbox produced **no log entries at all** — not even the truncation marker, which is pushed only on the run that trips the cap.

This affects embedders that reuse a sandbox across evals, which is the normal path for two of them: `bim.sandbox.eval()` keeps one `activeSandbox` alive across calls, and the extension host holds one sandbox per activated extension and re-enters it for every command and exporter invocation. (The viewer's script editor creates a fresh sandbox per run and was never affected.) The observable symptom was a script whose `console.log` calls appeared not to fire, with nothing to indicate the limit belonged to an earlier run.

`buildConsole` now owns the reset: it returns a `resetLogs()` that empties the buffer *and* zeroes both counters, and `eval()` calls only that instead of clearing the array itself — the two can no longer drift apart. A single script that genuinely exceeds either cap is truncated exactly as before.

**Embedder-visible:** captured output is now bounded per eval rather than per sandbox, so a long-lived sandbox can hand back up to 4 MB of logs per run instead of 4 MB in total. Embedders that retain every `ScriptResult` across many runs hold correspondingly more. `buildBridge()`, exported for advanced embedders, gains a `resetLogs` property on its return value; existing callers are unaffected.
