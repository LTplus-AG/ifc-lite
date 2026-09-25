---
"@ifc-lite/parser": minor
"@ifc-lite/rules": minor
"@ifc-lite/viewer": minor
---

Property rules and rule-set property subjects take a `memberPath` that reads one member of an `IfcComplexProperty` by name, one entry per nesting level (`['Frame', 'Width']`). It works the same in search, applicability and validation, and a member keeps its own unit, so `valueUnit: 'si'` and unit checks see it. A property that is not complex, or has no such member, reads as absent. Without `memberPath` a complex property still reads as its members' joined text. The IDS export refuses a rule with `memberPath`, because no IDS facet can address a member. The parser now exposes a complex property's members as `members` on each extracted property. The rule chips and the validation subject picker have a member field.
