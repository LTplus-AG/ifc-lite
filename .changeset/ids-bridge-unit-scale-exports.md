---
'@ifc-lite/ids': minor
---

`@ifc-lite/ids/bridge` now exports the unit-scale resolver pair the IDS
property-correction write path needs: `resolveEntityMeasureScales`,
`toRaw`, and the `EntityMeasureScales` type they exchange.

`resolveEffectivePropertySets` already forward-scales an override's raw
value into base SI on read. A caller that WRITES a correction has to make
the same trip in reverse, and doing that from its own copy of the scale
lookup is how the two sides drift apart. Exporting the resolver and its
inverse keeps one scale source for both directions.

`toBaseSI` stays internal: the read side lives in this package, so nothing
outside it consumes that half.
