---
"@ifc-lite/viewer": patch
---

Hand workers a source *envelope* instead of the whole source bytes (#2183).

`getWholeSourceForWorker` now returns an `IfcSourceTransfer` rather than a `Uint8Array`, and the overlay-parse and IDS workers rebuild it on their own thread with `sourceBytesFromTransferable`.

Behaviour-neutral today: a resident source describes itself as its underlying view, and a `SharedArrayBuffer` survives structured clone by reference, so the handoff stays exactly as cheap as it was. It matters once a source can be block-compressed, because materializing on the main thread would reintroduce the whole-file allocation the issue exists to remove — on the render thread, on every overlay re-parse.

The IDS client also drops its manual copy-then-transfer step. This is a simplification, not a speed-up: structured clone serializes on the *sending* thread, so a non-shared buffer costs the main thread an O(N) write either way. What it removes is the explicit `slice()`; what it must keep is that nothing goes into a transfer list, since transferring the source would detach the viewer's own bytes. On the paths that matter the source is `SharedArrayBuffer`-backed and crosses by reference, so neither form copies at all.
