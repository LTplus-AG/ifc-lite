---
'@ifc-lite/parser': patch
'@ifc-lite/export': patch
---

Stop dropping an entity or typed value whose type name is wrapped across whitespace from its opening `(`.

`EntityExtractor.extractEntity`'s entity regex allowed whitespace around `=` but required the type name and `(` to be adjacent, so a record like `#5=IFCSURFACESTYLERENDERING\r\n(#4,0.);` returned `null` and the entity was invisible to every extractor keyed on it (properties, quantities, materials, units, georeferencing). The typed-value regex in the same file had the same gap one level down: `IFCPOSITIVELENGTHMEASURE\r\n(1.)` fell through to a plain-string attribute instead of a typed value, which then made a downstream conversion-unit reader default an unreadable `ValueComponent` to `conversionValue 1.0` — silently wrong scaling for an inch-based `IFCCONVERSIONBASEDUNIT`. `@ifc-lite/export`'s `scaleTypedMeasures` had the matching gap on the write side: a wrapped `IFC[POSITIVE|NONNEGATIVE]LENGTHMEASURE`/`IFCAREAMEASURE`/`IFCVOLUMEMEASURE` literal was skipped by the unit-rewrite pass, leaving the normalized file internally inconsistent.

All three regexes now allow whitespace between the type name and `(`, matching the Rust tokenizer's existing tolerance for the same STEP writer line-wrap pattern.
