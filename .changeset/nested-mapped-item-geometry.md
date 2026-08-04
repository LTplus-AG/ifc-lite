---
"@ifc-lite/wasm": patch
---

Stop dropping the geometry of an `IfcMappedItem` nested inside another mapped item's representation.

`process_mapped_item_cached` walked the items of a `RepresentationMap`'s mapped representation and `continue`d past every item that was itself an `IfcMappedItem`, as a guard against unbounded recursion on a malformed model. The nested item's geometry contributed nothing, silently: the map's cached source mesh held only its direct solids.

Its sibling walker `collect_submeshes_from_item_inner` — the per-style sub-mesh path the viewer takes for a normal occurrence — has always recursed into nested mapped items, bounded by `MAX_MAPPED_ITEM_DEPTH` plus a per-walk visited set. So the same file rendered differently depending on which of the two walkers processed it. Paths in the shipping product that take the cached one:

- Type-product geometry (`IfcTypeProduct` `RepresentationMaps` with no instantiating occurrence, #957/#961). The type's own items are walked directly and a mapped item among them is processed, but a mapped item nested one level deeper inside it was dropped, so part of the type's body was missing from the render and from every export fed by it.
- Void cutters and the void probes. An `IfcOpeningElement` whose body is a mapped representation is meshed through this path to build the cutter; a nested mapped item inside the map left the cutter truncated or empty, so the opening was cut short or not cut at all and the host rendered solid.

- The whole-element fallback. When the sub-mesh walker yields nothing for an element, meshing falls back to `process_element`, which walks representation items through this path.

The cached path now recurses like its sibling, under the same `MAX_MAPPED_ITEM_DEPTH` cap and a visited set, so a cyclic or absurdly deep mapped-item chain still terminates instead of overflowing the stack. The recursive result is already unit-scaled with its own `MappingTarget` applied, so composing the outer level's transform over the merge reproduces the nesting algebra the sub-mesh walker applies per sub-mesh.
