---
"@ifc-lite/wasm": patch
---

Large mapped representations load again (#9102). A product whose mapped `SurfaceModel` held 65,536 or more items, such as an `IfcFlowTerminal` with 89,023 `IfcShellBasedSurfaceModel` surfaces, lost all its geometry after 10.4 and was reported only as a dropped `IfcMappedItem`. The representation walk charged the first read of every `Items` list against its fixed work budget, so a single wide, acyclic list that 10.4 meshed completely went over the cap. Now only repeated work pays: the first read of a distinct `Items` list and the first entry into a distinct `IfcMappedItem` are bounded by the file itself and cost nothing. Every repeated occurrence, the way a branching DAG fans out, still pays in full before anything is materialized, so cycles and pathological expansion remain bounded.
