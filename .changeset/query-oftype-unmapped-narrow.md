---
"@ifc-lite/query": patch
---

`ofType()` no longer returns the whole Unknown bucket for a real IFC class that `IfcTypeEnum` has no member for (`IfcPipeFitting`, `IfcDistributionPort`, ...). Such names now answer only the entities of that class. Pass `'Unknown'` for the whole bucket.
