---
'@ifc-lite/parser': patch
---

Stop non-finite numbers entering the property table from STEP literals, and
stop the paths downstream of it from substituting `0` for one.

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
- `getNumber` and `getReference` return `undefined` for non-finite input on
  **every** branch, including when a number is passed in directly —
  `getNumber(Infinity)`, `getNumber(NaN)` and both `getReference` equivalents
  previously returned the non-finite value unchanged, because only the string
  branch was guarded.

Preserving the literal as a string is only honest where the consumer's value
type admits a string. Two consumers type the field `number`, so the preserved
string failed their `typeof x === 'number'` test and they fell back to `0` —
converting a visibly missing value into a plausible wrong one:

- `IfcElementQuantity` measures outside the double range are now dropped with a
  warning instead of being reported as `0`. This matches what the sibling
  `QuantityExtractor.extractQuantity` path already did for a non-numeric value.
  A genuine `0.0` measure is unaffected.
- An `IfcMapConversion` whose `Eastings`, `Northings` or `OrthogonalHeight` is
  outside the double range is refused with a warning, leaving
  `GeoreferenceInfo.mapConversion` and `transformMatrix` absent, instead of
  placing the model at a substituted `0` origin. `IfcProjectedCRS` in the same
  file is still reported. A genuine `0` easting is unaffected.

An express id with enough digits to overflow is now refused at the point it is
read, on all four paths that accumulate one digit-by-digit (`StepTokenizer`'s
two scans, the inline scan worker, and `readRefId` on the byte-level
relationship path). Every overflowing id accumulated to the *same* `Infinity`,
so two distinct records collided on one key. Refusing at the accumulator also
removes the half-alive record the entity-level guard left behind — indexed
under a colliding key, its pset still answerable, its own `GlobalId` and `Name`
unreadable.
