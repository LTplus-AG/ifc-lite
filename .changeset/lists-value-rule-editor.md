---
"@ifc-lite/viewer": patch
---

The Lists builder's Rules editor now offers a "List value" rule (#6190) that authors every Lists-only predicate mode: zone-set assignment and its four display modes, exact Container/Storey/Building/Site/Project levels, model file name, Lists attributes, properties and quantities (including aggregation inheritance), material, classification and world coordinates. A zone rule stores the zone set's id and shows the set's current name. If the set has been deleted, the rule keeps pointing at it and the picker shows it as missing. Suggestions come from every loaded model. Search, Lens and clash builders do not offer the rule.
