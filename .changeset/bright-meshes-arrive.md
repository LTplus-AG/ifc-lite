---
"@ifc-lite/viewer": major
---

Reuse the canonical incremental mesh-owner cache for single-model streams, preserving immutable replacements, content updates, point-cloud owners and federation transitions. Refresh cached wrappers when the store releases CPU geometry, without requesting a GPU reupload of empty buffers. End-to-end speed improvement remains unqualified.

Breaking change: the viewer model-placement module no longer exports the unused `geometryWithModelIndex` helper. Mesh ownership now passes through `useFederatedGeometry` for one model and federations.
