---
"@ifc-lite/ids": minor
---

Refuse `xs:pattern` facets that use XSD character-class subtraction (`[a-z-[aeiou]]`) instead of silently dropping the exclusion. The matcher previously approximated the construct as the positive class — `[a-z-[aeiou]]` became `[a-z]` — so a pattern written to exclude values (e.g. a consonants-only pattern) accepted exactly what it excluded (`"aeiou"`). The specification now fails with an error naming the unsupported construct, matching the document auditor's existing warning for the same pattern, instead of validating model data against a wrong approximation.

This changes validation outcomes for IDS files that rely on subtraction patterns: a specification that previously reported a false pass now fails, with an error explaining why. Patterns without subtraction are unaffected.
