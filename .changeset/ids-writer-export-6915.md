---
"@ifc-lite/rules": minor
---

Export `writeIdsXml`, the IDS 1.0 writer behind `ruleSetToIds`, and extend it (#6915): property `dataType`, `partOf` facets (upper-case XSD relation token, related entity required) and requirement `instructions` are now written. String-length restrictions (`xs:length` / `xs:minLength` / `xs:maxLength`) are written. Constraint parts it has no XML for (digit bounds, conjunctive restriction facets, unparseable bounds) are refused with an error instead of being written as a weaker check. Line breaks and tabs in attribute values (such as multi-line `instructions`) are written as character references so they read back unchanged, and a control character XML 1.0 cannot carry is refused with the element or attribute it is in. Every pass/fail case of the vendored buildingSMART IDS corpus (all 307) reads back with the same specifications and gives the same verdict.
