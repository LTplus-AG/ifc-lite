---
"@ifc-lite/clash": patch
"@ifc-lite/cli": patch
---

**Corrected in this same release — see `clash-depth-box-exact-metric.md`.** The `'mesh'` label this changeset introduced was, for most hard clashes, applied to `TriMesh.maxPenetrationInto`'s output — a nearest-crossing-vertex sampling artifact, not a real measurement (see the superseding changeset for the analytic-oracle evidence). The `distanceKind` field and its meaning (`'mesh'` = certified measured, `'estimate'` = read off the AABBs) are unchanged; what changed is which pairs are ALLOWED to claim `'mesh'` — now only pairs where both elements are confirmed rectangular boxes, where the depth is provably exact. The description below is kept for history.

Say which clashes report a measured penetration depth and which report an AABB estimate.

`Clash.distance` carries two different quantities under one name. For a hard clash it is either a depth measured on the triangle meshes — the distance from the deepest crossing-triangle vertex inside the other solid to that solid's surface — or, when the narrow phase had no such vertex to measure from, the smallest overlapping bounding-box dimension of the two elements. Nothing in the output distinguished them, so a reader had no way to tell a real measurement from a number that is a property of the boxes and can equal an element's own thickness.

The estimate is not a rare corner. It is what gets reported whenever the two surfaces merely coincide (stacked layers sharing a footprint), when one solid is modelled wholly inside another, and when a member pierces clean through so every crossing vertex sticks out the far side. On a layered infrastructure model, roughly a third of hard clashes land there, and their depths come out as the round layer thicknesses.

`Clash` now carries `distanceKind: 'mesh' | 'estimate'` recording which one it is. `clearance` and `touch` distances are exact triangle-to-triangle measurements and are labelled `'mesh'`. The field is optional on the type only so a clash rehydrated from a run recorded before it existed stays assignable — absent means "unknown", never "measured".

The CLI's human-readable clash list prints an estimated penetration as `penetration ~0.250m (AABB estimate)` instead of a bare `penetration 0.250m`.

**This change adds only the label, no arithmetic.** It does not itself alter any `distance` value — it binds an existing internal boolean (whether the narrow phase found a mesh depth or fell back to the AABB reading) to the new field. Separately, `clash-mesh-penetration-depth.md` in this same release generalises which pairs take the mesh-depth path (previously only AABB-contained pairs; now every intersecting pair), which does change reported depths for some clashes — see that changeset. The estimates this label identifies are still bounding-box readings, not penetration depths; measuring a true depth for the coincident-surface case needs a translational penetration depth (Minkowski) over non-convex solids, which is a separate piece of work.

The Rust/WASM kernel records and reports the same label over the same code paths, and the differential suite now asserts the two kernels agree on it exactly.
