---
"@ifc-lite/renderer": minor
---

Cull GPU-instanced template draws (frustum + contribution) and report instanced frame stats.

The instanced pass previously drew every template unconditionally — on CATIA-class models that is ~97% of all draw calls (e.g. 8,929 of 9,213), which made orbiting choppy. Each template now carries cull metadata built at shard-upload time (union of occurrence world AABBs + largest single-occurrence bounding-sphere radius): templates are frustum-culled against the union box, and contribution-culled when even the largest occurrence projected at the union box's nearest view depth falls below the active pixel threshold — a conservative upper bound that works for bolts-scattered-everywhere templates whose union box is model-sized. Templates with a selected occurrence are exempt from contribution culling; non-finite occurrence matrices poison a template's metadata so it fails open (never culled); Exploded-mode translates grow the union so moved occurrences can't be culled by pre-move bounds. `FrameStats` gains `instancedDrawn` / `instancedFrustumCulled` / `instancedContributionCulled`.

Measured on an 883 MB CATIA model: draw calls 9,213 → 2,122 and fast-orbit frame rate 25.5 → 58.4 FPS, with unchanged GPU residency.
