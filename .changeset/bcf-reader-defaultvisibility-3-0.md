---
'@ifc-lite/bcf': patch
---

Two `readBCF` defects in the same `DefaultVisibility` read, both of which inverted a third-party BCF 3.0 viewpoint's visibility on import. (This release also carries separate `@ifc-lite/bcf` reader fixes for dropped BCF 3.0 topic labels and for CDATA/`xs:boolean` handling; each has its own entry.)

- An omitted `<Visibility>`/`DefaultVisibility` attribute was treated as `true` for every BCF archive, but visinfo.xsd only leaves that undefined for 2.1 — 3.0 declares `default="false"`. A spec-legal 3.0 viewpoint that omits the attribute (meaning "show only the listed exceptions") was silently read as "show everything." The reader now resolves the omitted-attribute default per the archive's own `bcf.version`; a 2.1 archive with the same omission is unaffected.
- An explicit `DefaultVisibility="0"` read back as `true`. `xs:boolean`'s lexical space is `{true, false, 1, 0}`, but the reader compared only against the literal `'false'`, so the numeral form of false read as its opposite — for 2.1 and 3.0 alike.

ifc-lite's own writer always emits the attribute explicitly, and always in the `true`/`false` form, so neither could surface from a self-round-trip — only from a third-party BCF file.
