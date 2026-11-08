---
"@ifc-lite/create": patch
---

`IfcCreator` now writes non-ASCII text (names, descriptions, property values, author) as ISO 10303-21 `\X2\…\X0\` / `\X4\…\X0\` directives instead of raw UTF-8, by delegating its string escaping to `escapeStepString` from `@ifc-lite/data`. `'Gartentür'` is written as `'Gartent\X2\00FC\X0\r'`. Readers that decode STEP as ISO-8859-1, as the standard assumes, previously saw mojibake. ASCII-only output is unchanged.
