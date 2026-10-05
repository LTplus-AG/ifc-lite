---
"@ifc-lite/rules": minor
---

Export `writeIdsXml`, the IDS 1.0 writer behind `ruleSetToIds`, and extend it (#6915): property `dataType`, `partOf` facets (upper-case XSD relation token, related entity required) and requirement `instructions` are now written. Constraint parts it has no XML for (`xs:length` / `minLength` / `maxLength` / digit bounds, conjunctive restriction facets, unparseable bounds) are refused with an error instead of being written as a weaker check. Every pass/fail case of the vendored buildingSMART IDS corpus that it writes (301 of 307) reads back with the same specifications and gives the same verdict.
