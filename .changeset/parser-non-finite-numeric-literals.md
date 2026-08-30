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

The guards now test `Number.isFinite` on value paths, and `Number.isSafeInteger`
on express-id / reference paths (an id is a key, not a measurement — see below):

- An attribute literal that is not a finite number falls through to the existing
  raw-token branch, so `1.0E400` is preserved verbatim as the string `"1.0E400"`
  rather than being dropped or clamped. The value type reported alongside it
  changes from number to string for that attribute.
- `getNumber` returns `undefined` for non-finite input on **every** branch,
  including when a number is passed in directly — `getNumber(Infinity)` and
  `getNumber(NaN)` previously returned the non-finite value unchanged, because
  only the string branch was guarded.
- `getReference` returns `undefined` for anything that is not a safe integer,
  on every branch, for the same reason the express-id paths below do.

Preserving the literal as a string is only honest where the consumer's value
type admits a string. Several consumers type the field `number`, so the
preserved string failed their `typeof x === 'number'` test and they fell back to
`0` — converting a visibly missing value into a plausible wrong one:

- `IfcElementQuantity` measures outside the double range are now dropped with a
  warning instead of being reported as `0`. This matches what the sibling
  `QuantityExtractor.extractQuantity` path already did for a non-numeric value.
  A genuine `0.0` measure is unaffected.
- An `IfcMapConversion` whose `Eastings`, `Northings`, `OrthogonalHeight`,
  `XAxisAbscissa`, `XAxisOrdinate` or `Scale` is outside the double range is
  refused with a warning, leaving `GeoreferenceInfo.mapConversion` and
  `transformMatrix` absent, instead of placing the model at a substituted `0`
  origin. The three optional components are included because
  `computeTransformMatrix` reads an absent `Scale` as `1.0` and an absent axis
  pair as no rotation, so dropping just the field would substitute the schema
  default for a value the file stated. An absent (`$`) optional is unchanged.
  `IfcProjectedCRS` in the same file is still reported. A genuine `0` easting is
  unaffected.
- The IFC2x3 `ePSet_MapConversion` twin of that path refuses on the same six
  property names, keeps any `ePSet_ProjectedCRS` it found, and warns before
  falling through to the legacy `IfcSite` fallback when nothing is left.
- An `IfcSite` whose `RefElevation` is outside the double range is skipped, so
  the legacy geolocation path reports a later site or none rather than one at a
  substituted sea level. An absent `RefElevation` still reads as `0`.
- An `IfcMaterialLayer` whose `LayerThickness` is outside the double range is
  dropped with a warning rather than recorded as `0` thick, and its
  `IfcMaterialLayerSet` reports no `totalThickness` rather than a total that is
  quietly short by that layer.

The last three bullets, and the optional-component half of the one above them,
are the same defect reached through the `?? 0` and `|| 0` fallbacks downstream of
`getNumber`: while it answered `Infinity` those fallbacks were unreachable, and
making it answer `undefined` armed every one of them.
The guard is shared (`isUnrepresentableNumericValue`), and it covers a
non-finite `number` as well as an overflowing token, so a value that arrives as
an actual `Infinity` — a hand-built entity map, an `IfcPropertySingleValue`
nominal value — cannot slip past the token check.

An express id that is not a safe integer is now refused at the point it is
read, on every path that accumulates one digit-by-digit (`StepTokenizer`'s two
scans, the inline scan worker, `readRefId` on the byte-level relationship
path, `extractEntity`'s own id parse, and both `parseInt`-based reference
reads in `entity-extractor` and `getReference`). The guard is
`Number.isSafeInteger`, not `Number.isFinite`: doubles lose integer precision
past 2^53 (~16 digits), so two distinct ids that merely exceed that — not the
~309 digits it takes to overflow to `Infinity` — already accumulate to the
*same* value, and one silently serves the other's data
(`parseInt('100000000000000001', 10) === parseInt('100000000000000002', 10)`
is `true`). `isFinite` alone missed this collision range entirely; it only
ever caught the Infinity case. Refusing at the accumulator also removes the
half-alive record the entity-level guard alone left behind — indexed under a
colliding key, its pset still answerable, its own `GlobalId` and `Name`
unreadable.
