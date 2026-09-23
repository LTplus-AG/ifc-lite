---
"@ifc-lite/rules": minor
"@ifc-lite/ids": minor
---

`ruleSetToIds` exports the rules of a rule set that IDS 1.0 can express as IDS XML. It never approximates: each rule without an exact IDS equivalent is refused with every reason listed. `@ifc-lite/ids` now exports `translateXsdRegex`, the XSD-to-JavaScript regex translator its checker uses.
