---
"@ifc-lite/ids": patch
---

Fix IDS `xs:pattern` value-restriction matching (#1100, #1101).

- Pattern facets now match the lexical form of the value gated by the
  restriction's `@base`, so `<restriction base="xs:decimal"><pattern value="^.*$"/>`
  ("any decimal value present") passes on numeric properties instead of
  failing every one. A number under an `xs:string` base (or a boolean
  under a numeric base) is still a type mismatch, matching the
  buildingSMART corpus.
- XSD `\p{...}` / `\P{...}`, `\d`, `\w`, `\i`, `\c` are now translated to
  their Unicode equivalents (compiled with the `u` flag) via a single
  shared translator, so e.g. `\p{L}+` no longer wrongly matches digits.
  The translator is character-class aware (`[\w]` → `[\p{L}\p{Nd}]`) and
  approximates constructs JS can't model (Unicode block escapes,
  char-class subtraction) permissively rather than rejecting valid values.
