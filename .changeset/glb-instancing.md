---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
"@ifc-lite/cli": patch
"@ifc-lite/mcp": patch
---

Instance repeated geometry in GLB/glTF export (50-85% smaller on repetitive models).

The from-bytes GLB assembler baked every element occurrence in full, so a model with
hundreds of identical windows, doors, or steel parts (one IFC `RepresentationMap`
referenced by many `IfcMappedItem`s) emitted that geometry hundreds of times. The
exporter now reuses the same representation-identity collation the GPU/native
instancing path uses: each repeated shape is emitted ONCE and every occurrence is
placed with a glTF node matrix carrying its world pose.

Each occurrence's node matrix is recomputed in f64 from the per-occurrence world
placement, the model RTC / site-local offset the baker subtracted, and the Z-up to Y-up
basis change, then folded against the model-wide scene centre before the single f32
downcast. Doing the relative transform in the post-RTC baked frame (not the placement's
pre-RTC frame) is what keeps a ROTATED occurrence correct under a non-zero site/georef
offset — otherwise it is mis-translated by `(R - I) * rtc`, kilometres at national-grid
coordinates. The f64 composition keeps the absolute-magnitude terms cancelling to a
model-relative, f32-precise translation even at national-grid scale.

Only exact-bit groups are instanced (the template's local geometry IS each occurrence's),
so the exported per-occurrence geometry is byte-faithful; rigid-tier and any
singular-placement groups fall back to the flat path. Two round-trip tests reconstruct
every instanced occurrence's world geometry from `root.translation * node.matrix *
template_local` and match the baked geometry to under a millimetre — one on a real model,
one synthetic with a rotated instance at national-grid coordinates.

Non-instanced occurrences keep the existing self-contained `world - scene_center` vertex
bake (no node transform), so a consumer that ignores node transforms still sees them
correctly placed. The flat remainder is additionally content-hash deduped (byte-identical
baked meshes share one mesh placed by a node translation), so the output never regresses
below the prior per-occurrence baseline on models without representation-level repeats.

Measured GLB size: C20-Institute 4.0 -> 1.3 MB (-68%), AC20-Smiley 13.0 -> 2.4 MB (-82%),
schependomlaan 15.5 -> 7.6 MB (-51%); models with no repeats are unchanged. Output is
byte-deterministic. The viewer's from-meshes GLB path is unaffected (it carries no
instancing side-channel and falls back to the flat content-hash dedup).
