---
"@ifc-lite/parser": minor
"@ifc-lite/ids": patch
---

Resolve `IfcConversionBasedUnitWithOffset` (a degree Fahrenheit over kelvin) with its `ConversionOffset`: `ResolvedUnit`, `ExplicitPropertyUnit` and `ExtractedProperty` gain an optional additive SI offset (`siOffset` / `unitSiOffset`), and IDS validation converts such temperatures to kelvin, offset included (68 °F is 293.15 K), for a project unit and for a property's own unit.
