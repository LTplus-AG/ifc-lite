---
"@ifc-lite/wasm": patch
---

Large mapped representations load again (#9102). A product whose mapped `SurfaceModel` held 65,536 or more items, such as an `IfcFlowTerminal` with 89,023 `IfcShellBasedSurfaceModel` surfaces, lost all its geometry after 10.4 and was reported only as a dropped `IfcMappedItem`. The representation walk charged the first read of every `Items` list against its fixed work budget, so a single wide, acyclic list that 10.4 meshed completely went over the cap. Now the first read of a distinct `Items` list is bounded by the file itself and costs nothing; every repeated read, the way a branching DAG fans out, still pays in full before anything is materialized. Every mapped-item attempt still pays as before, since each one expands a shared source, so cycles and pathological expansion remain bounded.
