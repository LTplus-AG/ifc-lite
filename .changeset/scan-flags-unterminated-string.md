---
'@ifc-lite/parser': patch
---

A record whose argument list opened a `'` string that never closed (an unescaped quote from a truncated download, a failed export, or a corrupted round-trip) made the fast entity scan's "skip to the next `;`" loop run off the end of the buffer with no terminator — silently ending the whole scan there. Every entity after that point, however well-formed, was missing from the result, and nothing said so: the caller got back a shorter `entityRefs` that looked like a complete, successful scan.

`scanIfcEntities` now reports this on both `EntityScanResult.malformedRecordCount` and the existing `onDiagnostic` channel (`scan: stopped early — N record(s) had a string literal that never closed...`), covering both the main-thread `StepTokenizer.scanEntitiesFast` and the Web Worker's inline copy of the same loop. The scan is not resynced past the break — with no reliable terminator, guessing a resume point risks fabricating entities from misaligned bytes — but the caller can now tell a genuinely short file apart from one where the scan gave up early.
