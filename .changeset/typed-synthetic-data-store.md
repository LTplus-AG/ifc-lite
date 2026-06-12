---
"@ifc-lite/parser": minor
"@ifc-lite/viewer": patch
---

Add `createSyntheticDataStore()` — a typed factory for building a fully-typed
`IfcDataStore` for synthetic / non-STEP models (GLB meshes, point-cloud scans).
It assembles real `@ifc-lite/data` tables (empty, or a single synthetic entity
row) and wires the lazy `getEntity` / `getEntitiesByType` / `getProperties` /
`getQuantities` accessors through `attachDataStoreAccessors`, the same single
source of truth the columnar parse / worker transport / cache restore use.

The viewer's GLB (`createMinimalGlbDataStore`) and LAS/LAZ point-cloud
(`emptyDataStore`) ingest paths now build their synthetic stores through this
factory instead of whole-object `as unknown as IfcDataStore` casts. Those casts
silently dropped the `IfcStoreBase` accessors, so a future required
`IfcDataStore` member stayed green at the cast site and threw
`TypeError: store.getProperties is not a function` at runtime on the
GLB / point-cloud ingest flow (same crash class as #950). The contract is now
compiler-enforced for these synthetic stores.
