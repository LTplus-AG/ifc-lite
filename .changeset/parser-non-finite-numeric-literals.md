---
'@ifc-lite/parser': patch
---

Stop non-finite numbers entering the property table from STEP literals.

A STEP real whose exponent overflows the IEEE-754 double range — `1.0E400` —
parses to `Infinity`, and `isNaN(Infinity)` is `false`, so the numeric guards in
`entity-extractor` and `attribute-helpers` admitted it. The value then flowed
into the property table and out through every writer, where `JSON.stringify`
turns it into `null`: the exported file silently lost the value.

The guards now test `Number.isFinite`:

- An attribute literal that is not a finite number falls through to the existing
  raw-token branch, so `1.0E400` is preserved verbatim as the string `"1.0E400"`
  rather than being dropped or clamped. The value type reported alongside it
  changes from number to string for that attribute.
- An express-id reference with enough digits to overflow (`#111…1`) resolves to
  `null` instead of `Infinity`, and a record whose own id overflows is refused.
- `getNumber` returns `undefined` and `getReference` returns `undefined` for
  non-finite input, matching their `number | undefined` contracts.
