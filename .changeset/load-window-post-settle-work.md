---
"@ifc-lite/cache": minor
"@ifc-lite/viewer": patch
---

A cold load's non-load work waits until the scene has settled, so the renderer's post-stream drain and finalize keep the main thread. "Settled" means the store has left its loading state, nothing streams or waits to upload, and the renderer has finished its async finalize. The work that now waits:
- The next open's cache entry is encoded after settle. A load that a newer one superseded drops its write.
- The placed spatial index (instanced materialisation plus the BVH) is built after settle. It serves SDK and server spatial queries, not picking.

The georeference minimap's readiness gate (#9623) now uses the same shared signal (`isSceneSettled` / `whenSceneSettled`). `BinaryCacheWriter.write` takes `yieldBetweenSections`, which returns to the event loop after each section, so a write made while the page is interactive runs as short tasks. The written bytes are unchanged.
