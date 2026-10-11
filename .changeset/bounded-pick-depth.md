---
"@ifc-lite/renderer": patch
"@ifc-lite/viewer": patch
---

Bound point-pick depth readback to a single GPU sample, sharing the ID staging buffer and releasing per-pick resources after mapping. Release point and rectangle readback buffers when encoding, submission or mapped-range access fails. Also retire all pending readbacks on picker teardown and discard results from a destroyed or replaced picker.

Reject stale viewport selections and hover readbacks after pointer, viewer-state or lifecycle changes, and dispatch the latest hover position when movement stops inside the throttle interval.
