---
"@ifc-lite/ids": patch
---

`resolveEffectivePropertySets` (the IDS bridge's write overlay, used when an in-session IDS correction is applied) used to look up a property's property set with `result.find(p => p.name === psetName)`, stopping at the first same-named set. An entity carrying two distinct `IfcPropertySet`s sharing a name (e.g. one via the type, one via the occurrence) could have a correction silently land on the wrong set — a value update pushed a duplicate property onto the wrong set while the real one stayed stale, and a delete against the wrong set left the real property fully intact with no error. Every same-named set is now scanned: an update lands on whichever same-named set actually carries the property, a delete removes it from every same-named set that carries it, and a brand-new property (no same-named set has it yet) is created on the first same-named set, matching this function's pre-existing single-pset behaviour.
