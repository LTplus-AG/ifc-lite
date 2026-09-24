---
"@ifc-lite/rules": minor
"@ifc-lite/lists": minor
"@ifc-lite/viewer": minor
---

Property and quantity rules, rule-set subjects, and list conditions take an `inherit` option. It works the same in search, applicability, validation and lists. With `'aggregation'`, an element with no value of its own, or on its type, takes the value of its nearest `IfcRelAggregates` ancestor, and its own value still wins. With `'type'`, a quantity also reads its type's quantity sets; properties already read the type. Leaving `inherit` unset keeps today's behaviour. `ListDataProvider` gains an optional `getAggregateParents`. The rule chips, the validation subject picker and list condition rows offer the option.
