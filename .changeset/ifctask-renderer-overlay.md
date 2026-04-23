---
"@ifc-lite/renderer": patch
---

Support real alpha-blended colour overlays so 4D phase tints composite
over the underlying material instead of replacing it. Previously the
overlay pipeline only respected the RGB channels; alpha below 1.0 produced
muddy opaque colour. With this change the overlay path honours per-entity
alpha + skips the glass-fresnel branch, so the 4D animator's preparation
ghost and palette-intensity slider render as proper translucent tints.
