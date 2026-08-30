---
'@ifc-lite/extensions': minor
---

Fix the "Promote to tool" capability inference under-granting real `bim.viewer` and `bim.store` mutations.

`INFERENCE_CATALOGUE` in `src/inference/catalogue.ts` documents itself as kept in sync with `@ifc-lite/sandbox`'s `NAMESPACE_SCHEMAS`, and `inferCapabilities`'s own design rules say to never under-grant: if the inferred capability is wrong, an extension should fail to run rather than run with a capability it was never reviewed for. Two gaps of the same shape — a real, state-mutating bridge method missing from the catalogue and falling through to a read-only default:

- `bim.viewer`: `colorizeAll`, `resetColors`, `resetVisibility` (`packages/sandbox/src/bridge-viewer.ts`) had no entry in the `viewer` namespace's `methods` overrides, so calling them inferred only `viewer.read` instead of `viewer.colorize`/`viewer.isolate`. A script whose only viewer call was `bim.viewer.resetColors()` would have its capability grant pre-filled as read-only on the promote review screen while actually able to mutate colors/visibility at runtime.
- `bim.store` (`packages/sandbox/src/bridge-store.ts`) is entirely document-level edits — `addEntity`, `removeEntity`, `setPositionalAttribute`, and ten `addWall`/`addSlab`/... element helpers — but the namespace had no `methods` overrides at all, so every one of them inferred the namespace default `model.read`. A script that only called `bim.store.addWall(...)` would be offered a read-only grant for a call that creates a new entity.

`colorizeAll`/`resetColors` now map to `viewer.colorize` and `resetVisibility` to `viewer.isolate`. The `addEntity`/`addColumn`/`addWall`/`addSlab`/`addBeam`/`addDoor`/`addWindow`/`addSpace`/`addRoof`/`addPlate`/`addMember` methods now map to `model.create`, `removeEntity` to `model.delete`, and `setPositionalAttribute` to the wildcard `model.mutate:*` (mirroring how the `mutate` namespace already treats an unstructured attribute edit).

Two state-changing bridge methods are still left at their namespace's read-only default and are not changed here, because the capability catalogue has no scope that fits either: `bim.model.loadIfc` (`packages/sandbox/src/bridge-model.ts`) loads a file into the viewer but infers `model.read`, and `bim.viewer.select` (`packages/sandbox/src/bridge-viewer.ts`) writes viewer selection state but infers `viewer.read`. Closing those needs a new capability, which extensions would have to declare in their manifest, so it is a change to the manifest contract rather than to this catalogue.
