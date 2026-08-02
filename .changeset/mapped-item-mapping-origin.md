---
"@ifc-lite/wasm": patch
---

fix(geometry): apply `IfcRepresentationMap.MappingOrigin`, and fix the operator frame/scale gaps around it

An `IfcMappedItem`'s transform is `MappingTarget · MappingOrigin`: the mapped
items are authored in the mapping source's coordinate system, whose placement
inside the map IS `MappingOrigin` (attribute 0), so it composes innermost — the
same order IfcOpenShell uses. The mesh path never read that attribute at all: it
resolved the map straight to its `MappedRepresentation` and applied only the
`MappingTarget` operator. Any map with a non-identity origin therefore placed
every occurrence at the wrong spot, and because the origin sits INSIDE the
target, a scaling target multiplied the error (a `Scale = 1000` target turns a
1 mm origin offset into a 1 m miss). Both mapped-item paths (the single-mesh
`process_mapped_item_cached` and the per-style sub-mesh collector), the void
fast-path probes, and the 2D drawing profile extractor now compose it; the 2D
symbolic path already did, which is where the composition order is pinned.

The void probes had been deferring any non-identity-origin opening to the exact
kernel *specifically because* the mesh path dropped the origin, to keep the fast
path bit-consistent with the rendered geometry. They now compose the origin
themselves and keep the fast path.

Three smaller defects in the same operator code, found while confirming the
above:

- `IfcCartesianTransformationOperator2DnonUniform` keeps `Scale2` at attribute 4
  (the 2D forms have no `Axis3`), but the parser read the 3D layout: `Scale2`
  came from the nonexistent attribute 5, so Y silently fell back to the X scale,
  and attribute 4 (a REAL) was fed to the `Axis3` direction parse.
- `Axis2` was never read. A mirroring frame — `Axis2` anti-parallel to
  `Axis3 × Axis1`, which some exporters write — was silently un-mirrored into a
  right-handed one. `Axis2` is now honoured via `IfcSecondProjAxis` semantics
  (projected perpendicular to Z and X). An `Axis2` that AGREES with the
  right-handed frame keeps the exact cross-product bits, so output for every
  well-formed operator is bit-identical.
- The 2D drawing profile extractor ignored `Scale2`/`Scale3` entirely, so a
  non-uniform operator collapsed to its X scale on all three axes there while
  the 3D mesh honoured them, and the symbolic 2D path dropped `Scale` outright
  (a metre-authored map instantiated at `Scale = 1000` into a millimetre model
  drew its plan symbols 1000x too small while the 3D mesh was correct).

No fixture in the corpus changes: all 51,662 `IfcRepresentationMap` records
across the 63 test models carry an identity `MappingOrigin`, and every operator
in them is uniform with a consistent `Axis2`.
