---
"@ifc-lite/export": patch
---

STEP export writes IfcValue members in the source schema's own base, so an IFC4X3 count is an integer (`IFCCOUNTMEASURE(3)`, `IFCQUANTITYCOUNT(...,3,...)`). A fractional value for an INTEGER-based measure is refused instead of truncated: a quantity edit is left out with a warning naming the entity, set and quantity, and an untouched source value is kept as it was.
