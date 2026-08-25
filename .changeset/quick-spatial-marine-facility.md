---
"@ifc-lite/geometry": patch
---

Quick metadata: stop severing marine facilities and common facility parts from the spatial tree.

`is_quick_spatial_type_ci` in `ifc-lite-processing` decides which scanned entities become nodes of the quick-metadata spatial tree (`MetadataBootstrap.spatialTree`). It was a hand-written list of 14 keywords, and it had drifted from the schema it implements: `IFCMARINEFACILITY`, `IFCMARINEPART` and `IFCFACILITYPARTCOMMON` were absent, while their siblings `IFCBRIDGE`/`IFCBRIDGEPART`, `IFCROAD`/`IFCROADPART` and `IFCRAILWAY`/`IFCRAILWAYPART` were all present.

The cost is not one missing node. Tree assembly skips an `IfcRelAggregates` edge whose parent OR child is not a known spatial node, so an unrecognised facility severs the edge above it and every edge below it: a port, quay or lock model rooted at `IfcMarineFacility` lost its whole subtree — storeys, spaces and the elements contained in them — from the bootstrap hierarchy, and any element contained directly in the facility was dropped rather than reparented.

The predicate now covers exactly the rule it always meant: `IfcProject`, plus the `IfcSpatialElement` branch minus the external-spatial (air volume) sub-branch, which stays excluded. A new test derives that set from the generated `IFC_TYPES` and compares it against the predicate in both directions, with an anti-vacuity floor and a control fixture, so a future schema addition cannot slip past the list again. The predicate is also now a length-keyed dispatch: at most three case-insensitive comparisons per scanned entity instead of up to fourteen.
