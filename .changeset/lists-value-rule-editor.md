---
"@ifc-lite/viewer": patch
"@ifc-lite/lists": minor
---

The Lists builder's Rules editor now offers a "List value" rule (#6190) that authors every Lists-only predicate mode: zone-set assignment and its four display modes, exact Container/Storey/Building/Site/Project levels, model file name, Lists attributes, properties and quantities (including aggregation inheritance), material, classification and world coordinates. A zone rule stores the zone set's id and shows the set's current name. If the set has been deleted, the rule keeps pointing at it and the picker shows it as missing. Suggestions come from every loaded model. Search, Lens and clash builders do not offer the rule.

Each mode offers the operators that can match the value it reads, so a zone volume can be compared with `gt`, `lt` and the other numeric operators, and Straddles offers only equality and presence. `@ifc-lite/lists` exports `listConditionValueKind(source, propertyName)`, the kind of value the engine compares for each source and mode.
