---
"@ifc-lite/cli": patch
---

`ifc-lite validate` gains a reference-integrity rule: every `#N` attribute reference is checked against the parsed entity index, and each reference to a nonexistent expressId is reported as an error with the referencing entity id, attribute slot, and missing target (additive issue fields; existing issue shape unchanged). The validation rules are also exported as `computeValidationIssues(store)` for programmatic reuse.
