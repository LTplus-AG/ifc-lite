---
"@ifc-lite/rules": patch
---

IDS import now reads `^` and `$` in an `xs:pattern` exactly as the IDS validator does: a pattern-initial `^` and pattern-final `$` are redundant anchors and are dropped, and every other `^` / `$` is a literal character. `^US$` previously imported as a rule requiring the literal text `^US$`; it now imports as a rule accepting `US`, the same values the validator accepts.
