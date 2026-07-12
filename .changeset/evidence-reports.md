---
"@ifc-lite/collab-server": minor
"@ifc-lite/cli": minor
---

Check evidence becomes fetchable (08-review.md §8.4): the registry gains `PUT/GET /api/v1/reports/<digest>` (blake3-verified, content-addressed, durable on the fs store), `ifc-lite layer publish --check` keeps the spec/report bytes in the local store, and the new `ifc-lite layer push` uploads a ref's stack (or one layer) plus its evidence to a registry.
