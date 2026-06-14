---
"@ifc-lite/renderer": patch
---

Add `Scene.hasStreamingFragments()` and `Scene.isEphemeralStreaming()`
accessors. They let the viewer detect an element that was appended during
streaming and still rendered as a streaming fragment — which, after the element
is moved (its colour bucket re-batched), would otherwise linger as a ghost
duplicate at the original position — and finalise the fragments into clean
buckets (skipping ephemeral mode, where no geometry is retained to rebuild from).
