---
"@ifc-lite/clash": patch
"@ifc-lite/cli": patch
---

Say which clashes report a measured penetration depth and which report an AABB estimate.

`Clash.distance` carries two different quantities under one name. For a hard clash it is either a depth measured on the triangle meshes — the distance from the deepest crossing-triangle vertex inside the other solid to that solid's surface — or, when the narrow phase had no such vertex to measure from, the smallest overlapping bounding-box dimension of the two elements. Nothing in the output distinguished them, so a reader had no way to tell a real measurement from a number that is a property of the boxes and can equal an element's own thickness.

The estimate is not a rare corner. It is what gets reported whenever the two surfaces merely coincide (stacked layers sharing a footprint), when one solid is modelled wholly inside another, and when a member pierces clean through so every crossing vertex sticks out the far side. On a layered infrastructure model, roughly a third of hard clashes land there, and their depths come out as the round layer thicknesses.

`Clash` now carries `distanceKind: 'mesh' | 'estimate'` recording which one it is. `clearance` and `touch` distances are exact triangle-to-triangle measurements and are labelled `'mesh'`. The field is optional on the type only so a clash rehydrated from a run recorded before it existed stays assignable — absent means "unknown", never "measured".

The CLI's human-readable clash list prints an estimated penetration as `penetration ~0.250m (AABB estimate)` instead of a bare `penetration 0.250m`.

**No distance value changes.** This release labels the existing numbers; it does not improve them. In particular the estimates are still bounding-box readings and still not penetration depths. Measuring a true depth for the coincident-surface case needs a translational penetration depth (Minkowski) over non-convex solids, which is a separate piece of work.

The Rust/WASM kernel records and reports the same label over the same code paths, and the differential suite now asserts the two kernels agree on it exactly.
