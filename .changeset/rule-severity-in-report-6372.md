---
"@ifc-lite/ids": minor
"@ifc-lite/rules": minor
"@ifc-lite/cli": patch
---

Carry an information-validation rule's `severity` on its validation result (#6372). `SpecificationSummary` gains an optional `severity: 'error' | 'warning'` (absent means `'error'`; IDS never sets it), and `runRuleSet` fills it from each rule, so a report consumer can tell warning failures from failures without the rule file. `ifc-lite check` now reads the severity off the report for its `--fail-on` exit code, with unchanged results.
