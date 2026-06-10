---
'@ifc-lite/merge': minor
'@ifc-lite/collab-server': minor
'@ifc-lite/cli': patch
---

Layer registry v1 (10-registry.md):

- **merge**: the ref-merge flow (fast-forward, three-way planning, ref-policy enforcement, unrelated-base refusal) moved into `@ifc-lite/merge` as store-agnostic `mergeIntoRef`/`resolveAncestor`/`checkRefPolicy` over a `LayerRefStore` interface — the CLI and the registry run one decision procedure.
- **collab-server**: opt-in `layerRegistry` mounts `/api/v1/layers|refs|reviews` — push with a server-side blake3 integrity gate (id recomputed, provenance validated), pull by id, refs with policies (policy-protected refs move only through the merge endpoint, where required checks and approval rules run), and review (PR) objects. Authorization derives from the websocket `authenticate` hook like the blob route: one token scheme for sync, blobs, and the registry; writes require write capability.
- **cli**: `layer merge` now delegates to the shared flow (behavior unchanged).
