---
"@ifc-lite/parser": minor
---

New `@ifc-lite/parser` exports resolve a file's declared `IfcUnitAssignment` into per-unit-type display symbols + SI scale factors, and map a property's IFC measure value type onto the unit it's shown in (issue #1573):

- `extractProjectUnits(source, entityIndex) -> ProjectUnits` — reads `IfcSIUnit` (with prefixes), `IfcDerivedUnit` (composed, e.g. `m³/s`), `IfcConversionBasedUnit` (°, ft, ...) and `IfcMonetaryUnit` from `IFCPROJECT.UnitsInContext`. Never throws: an absent/malformed assignment yields an empty `ProjectUnits` (every measure falls back to its SI default symbol).
- `ProjectUnits.unitForMeasure(measureType)` / `.resolvedForUnitType(unitType)` / `.monetary()` — the per-measure and per-unit-type display resolvers.
- `measureUnit(measureType) -> MeasureUnit | undefined` — maps an IFC measure value type name (e.g. `"IFCVOLUMETRICFLOWRATEMEASURE"`) to its unit-type token, or `{kind: 'monetary'}` / `{kind: 'dimensionless'}` for currency and unit-less measures.
- `ResolvedUnit` (`{symbol, siScale}`) and `MeasureUnit` types.

The viewer uses this to show property/quantity values with the file's actual declared unit instead of always assuming SI, and (issue #1573 proposal 2) to power a non-destructive per-unit-type display-unit converter. The implementation is pinned to shared parity test vectors against the Rust mirror in `rust/core/src/project_units/` (`packages/parser/src/project-units.parity.test.ts`), so the two can't drift.
