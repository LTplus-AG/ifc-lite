---
"@ifc-lite/renderer": minor
---

Remove the unused `Camera.zoomToFit(min, max, duration)` method. It had no callers anywhere in the repo (viewer, SDK, examples, tests) and was superseded by `Camera.frameBounds` (animated fit, keeps view direction) and `Camera.fitBoundsAdaptive` (aspect-aware fit used by the Home view and post-load auto-fit). The exported `Camera` class and the CI-tracked API surface are unchanged; only the dead convenience wrapper is gone. Callers that need an animated fit-to-bounds should use `frameBounds` (the quickstart cheat-sheet was updated to point at it).
