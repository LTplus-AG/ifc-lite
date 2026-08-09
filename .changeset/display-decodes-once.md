---
"@ifc-lite/encoding": patch
---

Stop decoding STEP strings a second time at display

`parsePropertyValue` decoded its input, but every producer of a property value
already decodes exactly once at the parse boundary — `EntityExtractor` /
`columnar-parser-attributes.ts` on the TypeScript path,
`AttributeValue::from_token` on the Rust/WASM and server paths.

That double decode was harmless while `decodeIfcString` passed `\\` through
untouched. Since #2394 the decoder correctly collapses `\\` to `\`, which makes
it non-idempotent: an authored UNC path `\\server\share` is stored, exported and
round-tripped correctly but was **displayed** as `\server\share`. `C:\temp` is a
fixed point of the decoder, which is why the defect hid on the common case.

Making the decoder idempotent is not the alternative: idempotence requires
treating an already-decoded `\` and an authored, still-doubled `\\` alike, which
is exactly the ambiguity #2394 removed. The invariant is "decode once, at the
parse boundary".

**Behaviour change for callers outside this repo.** If you were handing
`parsePropertyValue` a *still-encoded* STEP literal, it decoded it for you and
now returns it unchanged: `'Br\X2\00FC\X0\cke'` comes back as written rather
than as `Brücke`. Decode at your parse boundary instead —
`parsePropertyValue(decodeIfcString(literal))` — with `decodeIfcString` still
exported for exactly that. Every in-repo caller (the viewer's property and
quantity cards, `filter-match`, `@ifc-lite/lists`) sits downstream of a parse
path that already decoded, so none of them changes meaning. The package README's
`parsePropertyValue` entry is corrected in this PR; it said "raw STEP property
values", which is what made the second decode look intended.

Bump level: `patch`, matching how this package has shipped every previous
correction to what these functions return — #2394 (`decodeIfcString` collapses
`\\`), #1773 (`\X4\` out-of-range throws → U+FFFD), #1500 (`\S\` multi-byte).
No export is added, removed or renamed and no signature changes.
