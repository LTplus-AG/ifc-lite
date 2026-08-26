---
"@ifc-lite/drawing-2d": minor
---

Resolve graphic-override subtypes from the IFC schema instead of a drifted hand-written table.

`ifcTypeCriterion` defaults `includeSubtypes` to `true`, so a rule naming a supertype is meant to style everything beneath it. That expansion ran off `IFC_TYPE_HIERARCHY`, a hand-written table in `rule-engine.ts` that had fallen far behind the schema. A rule on `IfcBuildingElement` reached 21 of the 31 entities IFC4 puts under it, never touching `IfcCurtainWall`, `IfcPlate`, `IfcMember`, `IfcFooting`, `IfcPile`, `IfcBuildingElementProxy`, `IfcChimney`, `IfcShadingDevice` or the two `StandardCase` leaves. A rule on `IfcDistributionElement` reached 2 of 76 — it resolved `IfcDistributionFlowElement` and `IfcDistributionControlElement` and stopped, because neither was itself a key, so no duct, pipe, cable, terminal, valve or sensor was ever styled. The elements still drew; they drew without the override the rule asked for, with no warning.

The table now lives in `ifc-type-hierarchy.ts` and is the direct-children map of every entity under `IfcElement` and `IfcSpatialElement`, derived from IFC4 ADD2 TC1. Rules matching more elements than before is the point of the fix, but it is a visible change to any drawing that used a supertype rule.

`IfcFlowElement` was a table key and is not an IFC entity — not in IFC2X3, IFC4 or IFC4X3, so it was never a legacy alias for anything. Rather than delete a name users may already have written into a rule, it is kept in an explicit `AUTHORING_ALIASES` map pointing at `IfcDistributionFlowElement`, the real supertype of the four names it used to list; it now reaches that whole subtree. `IfcStair` -> `IfcStairFlight` and `IfcRamp` -> `IfcRampFlight` move to the same map: IFC4 makes both flights siblings rather than subtypes, and silently narrowing those rules would be its own regression.

`getIfcSubtypes` now de-duplicates its result and tracks visited nodes, so an alias pointing back into the table cannot spin.

The module had no tests. It now has two suites: one driving rules through `applyOverrides` against named required entities, and one that re-derives the hierarchy from `@ifc-lite/data`'s `ENTITIES_IFC4` — an authority independent of the parser registry the table was generated from — and fails if the table omits a subtype, invents an entity, or claims an edge the schema does not have. `@ifc-lite/data` is a devDependency only; nothing is added to the published bundle.
