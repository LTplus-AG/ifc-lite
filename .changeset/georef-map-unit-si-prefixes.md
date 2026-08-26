---
'@ifc-lite/parser': patch
---

Resolve every `IfcSIPrefix` on an `IfcProjectedCRS.MapUnit`, not four of them

`extractGeoreferencing` carried a private four-entry SI prefix table
(MILLI/CENTI/DECI/KILO), while the project length-unit reader in the same
package uses the full `IfcSIPrefix` enumeration. A MapUnit in any other
prefix — DECA, HECTO, MICRO, NANO, MEGA, GIGA and the rest — matched no
entry and fell through to the base-metre default, so `mapUnitScale` read
back as `1` and the georeference was wrong by that prefix's own factor
(100x for a hectometre MapUnit). The same private table was used to scale an
`IfcMeasureWithUnit` component, so a conversion factor expressed in a
prefixed SI unit was mis-scaled the same way.

Both call sites now use the shared table, matching the Rust extractor
(`ifc_lite_core::GeoRefExtractor`), which already resolved the full set. A
new cross-language harness pins both halves to one shared fixture whose
expectations come from the EXPRESS schema rather than from either
implementation.
