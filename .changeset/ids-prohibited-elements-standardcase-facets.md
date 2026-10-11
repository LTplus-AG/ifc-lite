---
"@ifc-lite/ids": patch
---

A prohibited specification (`<applicability maxOccurs="0">`) now reports every element it applies to as failed, with a "prohibited" check carrying the reason, so the element results, the passed/failed counts and the specification status agree. Previously each such element came back as passed while the specification failed through cardinality alone (#7403). The `failures.prohibited` message now fills both its placeholders, naming the facet and the value found.

The entity facet now matches the class the STEP line declares. `IfcBeamStandardCase` and the seven other IFC4 `*StandardCase` classes, `IfcDistributionFlowElement` and `IfcDistributionControlElement` were seen as their parent class, so an `IFCBEAMSTANDARDCASE` facet matched nothing and an `IfcBeamStandardCase` satisfied an `IFCBEAM` requirement. Reported `entityType` values for these elements now name their declared class (#7402).
