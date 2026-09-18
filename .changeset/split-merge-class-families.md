---
"@ifc-lite/diff": minor
---

**diff**: split/merge detection buckets candidates by class FAMILY instead of exact `ifcType` (issue #4955). A wall republished as three `IfcWallStandardCase` pieces, or as `IfcBuildingElementPart` layers — the IFC4 way to publish a buildup as parts — was invisible because the pieces never met the whole; the volume and containment evidence is the same, so they are now claimed like any other split, with a new `SplitMergeClaim.crossClass` flag when the class changed on the way. `DiffOptions.classFamilies` overrides the default table (the schema's `StandardCase`/`ElementedCase` subtypes, `IfcBuildingElementPart` under walls, the furniture classes); matching is case-insensitive, an unlisted class is its own family, and `[]` restores exact-class bucketing. A split across families (a wall becoming a covering) remains invisible by design.
