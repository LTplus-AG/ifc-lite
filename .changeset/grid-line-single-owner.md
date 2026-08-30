---
'@ifc-lite/viewer': patch
---

Stop drawing every `IfcGridAxis` twice in the 3D viewport, which also made section-clipping of grid lines inert and let the two copies disagree in elevation.

The viewport fed the `ifcGrid`-visibility toggle from two independent sources at once: `useSymbolicAnnotations` (its grid buckets, section-clipped against the active cut plane and rebased by the TS-side `originShift`) and `useGridLines3D` (the wasm `parseGridLines` API, unclipped and rebased only by RTC). The two were merged into one buffer (`mergeGridLineChannels`) and uploaded to the renderer's `grid` line-overlay channel, so every axis drew twice, issue #862's grid section-clipping never had any effect (the unclipped copy always drew the full grid), and a federated or re-aligned model with a nonzero `originShift` could show the two copies at different elevations.

Grid lines in the viewport now draw only from `useSymbolicAnnotations`'s already-split `grid` channel (issue #3359), which already section-clips and origin-shift-rebases its grid buckets. The redundant `useGridLines3D` hook and the now-empty `mergeGridLineChannels` merge step are removed. `parseGridLines`/`parseGridAxes` themselves are unchanged — they remain published `@ifc-lite/geometry` SDK surface for embedders who want raw, unclipped grid geometry with no annotation/storey semantics.
