---
'@ifc-lite/parser': patch
---

A string literal or comment that opened and never closed (an unescaped quote from a truncated download, a failed export, or a corrupted round-trip; or a `/* ... */` with no matching close) could make the fast entity scan run off the end of the buffer with no terminator and silently end the whole scan there. So could a `#id=TYPE(` declaration cut off before its own `(`, in the HEADER section, or between two DATA records. Every entity after that point, however well-formed, was missing from the result, and nothing said so: the caller got back a shorter `entityRefs` that looked like a complete, successful scan.

`scanIfcEntities` now reports this on `EntityScanResult.malformedRecordCount`, a single 0-or-1 flag, and on the existing `onDiagnostic` channel ("scan: stopped early, a record had a string literal or comment that never closed, or was cut off, before end of input..."). It is 0 or 1, never a count of how many, because the scan always stops at the first one it hits: there is no reliable place to resume once a string, a comment, or a declaration's own header has failed to close, so the scan does not guess.

Covers every copy of the scan: the main-thread `StepTokenizer.scanEntitiesFast`, its balanced-parenthesis sibling `StepTokenizer.scanEntities`, and the Web Worker's inline copy of the fast scan. Both `StepTokenizer` methods now reset the flag at the start of every run, so a truncated fast scan followed by a clean balanced scan on the same instance no longer leaves a stale 1 behind. The wasm scan path clears it too, for the same reason.
