---
"@ifc-lite/viewer": patch
---

Show IfcElementAssembly / IfcStair parts in the spatial tree and make assemblies
selectable (#1133). A decomposing assembly carries no geometry of its own — its
stair flights, railings, landing slabs and virtual clearance volumes hang off it
via `IfcRelAggregates` and hold the meshes — so the spatial panel previously
listed the assembly as a childless leaf, the parts were unreachable, and
clicking the assembly highlighted nothing. The hierarchy now nests an
assembly's aggregated parts beneath it (recursively, cycle-guarded), clicking
the assembly highlights and frames the whole thing, soloing a storey keeps the
parts (they inherit the storey through the assembly), and `IfcVirtualElement`
clearance volumes are hidden by default with a new "Virtual Elements"
visibility toggle.
