---
'@ifc-lite/bcf': patch
---

Three more `readBCF` import-side gaps, filed as follow-ups to the label/CDATA/DefaultVisibility fixes above:

- A CDATA-wrapped `<Title>` or `<Comment>` fell back to `'Untitled'` / `''` instead of being read: `extractElement`'s content regex rejected CDATA the same way `parseLabels`'s did before it was fixed, but only `parseLabels` had been given the CDATA-aware extractor. `extractElement` (and every field that goes through it — Title, Comment, and the rest) now shares the same CDATA-tolerant decoding.
- `<DocumentReference isExternal="1">` read back as `isExternal: false`. markup.xsd types `isExternal` as `xs:boolean`, whose lexical space is `{true, false, 1, 0}`; the reader's other two `isExternal` sites already accepted the numeral form, this one compared only against the literal `'true'`.
- A whitespace-only `DefaultVisibility` (e.g. `DefaultVisibility="   "`) read as `true` instead of falling back to the archive version's schema-declared default. Trimming produces the empty string, which is not a member of `xs:boolean`'s lexical space — the same as the attribute being absent — but the reader treated an empty trimmed value as an explicit, truthy one.
