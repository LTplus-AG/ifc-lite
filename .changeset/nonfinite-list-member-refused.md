---
"@ifc-lite/export": patch
---

STEP export no longer writes a non-finite number that sits inside a list as `$`. In ISO 10303-21, `$` omits a whole attribute and is not a legal list element, so an overlay `IfcCartesianPoint` created with `[NaN, 0, 0]` used to export as `(($,0,0))`, a malformed `LIST [1:3] OF IfcLengthMeasure`. That case now throws an error naming the entity type and attribute index. A non-finite value in a whole attribute slot, such as an optional REAL like `IfcMapConversion.Scale`, is still written as `$`, the omitted-attribute token.
