---
"@ifc-lite/export": patch
---

`MergedExporter` `dropEmptyContainers` now also drops a container that is left empty because its only child unifies with the primary model's by GlobalId alone, not by name or elevation (#5937). The planner replays the GlobalId unification wherever the emit pass is sure to repeat it, and never where the outcome depends on schema conversion, a unit mismatch or a hidden entity, so it still never withholds an edge the export writes. IFC4X3 facilities and facility parts (`IfcBridge`, `IfcRoad`, `IfcRailway`, `IfcMarineFacility`, `IfcFacility` and their parts) now count as containers and are dropped when empty, like sites, buildings, storeys and spaces.
