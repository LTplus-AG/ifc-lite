---
"@ifc-lite/export": patch
---

Re-mesh subgraphs (`serializeEntitySubgraph`, `remeshContextRoots`) now carry the model's `IfcSite` records, written without their representation, so the mesher can recognise a host's site placement and cut it in the same frame as on load (#10435). A site carried this way is context, not an element to re-mesh: `expandAffectedSet` skips it like the project.
