---
"@ifc-lite/export": patch
---

Fix `filterHiddenRefsFromRelationshipLine` (part of this release's dangling-reference fix) dropping the `IfcRelConnectsStructuralMember.ConditionCoordinateSystem` → `$` rewrite — and withholding the whole relationship instead — when the source line's `#N = TYPE(` has whitespace between `#N` and `=`, or between `=` and the type name. Both are legal STEP; the line regex already accepted them (`#\d+\s*=\s*\w+\(`), but the code that pulled the entity type out of the matched prefix did not trim it before comparing with `===`, so `' IFCRELCONNECTSSTRUCTURALMEMBER'` never matched `'IFCRELCONNECTSSTRUCTURALMEMBER'` and the position-10-of-10 rewrite never fired. On a `includeGeometry: false` export of such a file, the entire relationship — and every association it carried — was withheld instead of just its optional coordinate system.
