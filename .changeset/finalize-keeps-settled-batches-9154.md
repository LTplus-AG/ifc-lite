---
"@ifc-lite/renderer": patch
---

A model that has already loaded stays visible when the next model's streamed geometry is all removed before that stream finishes. `Scene.finalizeStreaming` now lists every bucket's batch even when nothing is left to rebuild. Before, the settled model disappeared and `hasPendingBatches()` returned false, so callers that only rebuild when something is pending never brought it back.
