---
'@ifc-lite/export': minor
'@ifc-lite/cli': minor
---

Merged export can now drop spatial containers the merge leaves holding nothing — the step of IfcOpenShell/BlenderBIM's "Merge Projects" recipe that container *matching* (`mergeSites` / `mergeBuildings` / `mergeStoreys`) does not cover. `MergedExporter` takes `dropEmptyContainers` (off by default, so existing output is byte-identical) and reports `stats.droppedContainerCount`; the CLI exposes it as `ifc-lite merge … --drop-empty-containers`, and the native merge as `MergedOptions::drop_empty_containers` / `MergedStats::dropped_container_count`.

An `IfcSite` / `IfcBuilding` / `IfcBuildingStorey` / `IfcSpace` counts as empty when it contains no surviving element, directly aggregates no surviving non-spatial object, and transitively aggregates no non-empty spatial child; `IfcProject` is never a candidate. Emptiness is judged on the **merged** model — after visibility filtering and after spatial unification — so a container that only a later model fills is kept. Because the drop happens inside the merge plan rather than as a pass over the assembled bytes, nothing is ever written referencing a dropped container (a relationship that named one is narrowed; one left with no subject goes with it), so no dangling-reference clean-up pass has to follow and a native consumer never has to materialise the merged file to do it.
