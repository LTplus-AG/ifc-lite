---
"@ifc-lite/ids": minor
---

Two new `auditIDSDocument` codes. `E_IFC_ENTITY_CASE`: an entity name written other than in upper case (`IfcWall` instead of `IFCWALL`), which names no class in IDS. `E_IFC_ENTITY_IMPOSSIBLE`: an entity requirement whose classes (by simple value, enumeration or pattern) never include a class the applicability selects, so every applicable element fails; IDS entity facets match the exact class, so `IFCWALL` required of `IFCWALLSTANDARDCASE` is reported. Five more `invalid-` cases of the buildingSMART IDS corpus are detected (25 of 27).
