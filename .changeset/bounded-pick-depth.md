---
"@ifc-lite/renderer": patch
---

Bound point-pick depth readback to a single GPU sample, sharing the ID staging buffer and releasing per-pick resources after mapping. Release point and rectangle readback buffers when encoding, submission or mapped-range access fails.
