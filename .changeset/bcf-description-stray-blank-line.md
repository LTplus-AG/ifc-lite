---
'@ifc-lite/viewer': patch
---

Fix a stray blank line in the exported BCF description for compare rows with a synthetic key.

`bcfTextFromChange` builds its description as an array of lines, dropping the
GlobalId line for synthetic `missing:` keys by pushing `''` in its place, then
filtering with `lines.filter((l, i) => l !== '' || i > 0)`. That filter is a
no-op: `lines[0]` is always the `"Detected in model comparison: …"` line and is
never blank, so `i > 0` is true for every other index and nothing was ever
removed. A `missing:` row therefore kept an empty line where the GlobalId line
should have been omitted.

The direct fix (`lines.filter(l => l !== '')`) would have broken a second,
unrelated use of `''`: the function also pushes an intentional blank separator
before the `"Data changes:"` block, and dropping every `''` removes that
separator too. `''` was overloaded between "omit this line" and "this line is
a deliberate blank" - two meanings needed two values.

`lines` is now typed `(string | null)[]`; a synthetic-key row pushes `null`
(omitted) instead of `''`, and the filter drops only `null`, leaving the real
`''` separator before "Data changes:" untouched.

Cosmetic only - an extra blank line in an exported BCF topic description for
rows with no GlobalId (deleted or added-without-GlobalId compare rows).
