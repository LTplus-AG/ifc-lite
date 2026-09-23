---
"@ifc-lite/rules": minor
---

`idsToRuleSet` imports the simple specifications of an IDS document as rules, so an incoming deliverable can be extended with checks IDS cannot express. It never approximates. A specification whose facets have no exact rule equivalent (partOf, optional or prohibited facets, a property dataType, a pattern on an entity or attribute name, length restrictions, classification codes) is refused with every reason listed.
