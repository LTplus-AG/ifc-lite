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

Bump level: `patch`. No export is added, removed or renamed and the signature is
unchanged; this only stops the function producing a wrong string. A caller that
was relying on it to decode a raw STEP literal was relying on a second decode
that has always been wrong for `\\` — such input should be decoded by its
producer with `decodeIfcString`, which is still exported.
