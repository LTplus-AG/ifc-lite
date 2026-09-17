---
"@ifc-lite/renderer": patch
---

Colour overlays (chart buckets, lens colours, IDS pass/fail, compare, 4D)
now paint on every surface of large models. Overlay batches are grouped by
their source bucket and inherit that batch's f32/quantized vertex decision
instead of re-deciding from their own (much wider) extent, so the
`depthCompare: 'equal'` overlay pass finds bit-identical depth. Previously an
overlay spanning more than ~64 m fell back to f32 while its base stayed
lattice-quantized and the colour was silently discarded (#4832). Partial
(visibility) sub-batches inherit the same way, and a derived batch that
cannot honour an inherited quantization now warns instead of failing
silently.
