---
"@ifc-lite/viewer": patch
---

Hand workers a source *envelope* instead of the whole source bytes (#2183).

`getWholeSourceForWorker` now returns an `IfcSourceTransfer` rather than a `Uint8Array`, and the overlay-parse and IDS workers rebuild it on their own thread with `sourceBytesFromTransferable`.

Behaviour-neutral today: a resident source describes itself as its underlying view, and a `SharedArrayBuffer` survives structured clone by reference, so the handoff stays exactly as cheap as it was. It matters once a source can be block-compressed, because materializing on the main thread would reintroduce the whole-file allocation the issue exists to remove — on the render thread, on every overlay re-parse.

The IDS client also drops its manual copy-then-transfer step. The serializer writes into the message directly, so the main thread no longer allocates a copy first, and nothing goes into a transfer list — transferring the source would have detached the viewer's own bytes.
