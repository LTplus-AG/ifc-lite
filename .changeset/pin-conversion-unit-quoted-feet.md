---
"@ifc-lite/parser": patch
---

Add the missing `"'FEET'"` entry to `CONVERSION_BASED_UNIT_FACTORS` in `unit-extractor.ts`, and the matching `"'FEET'"` arm to `get_conversion_based_unit_factor` in `rust/core/src/units.rs`.

Every other imperial spelling in the table (`FOOT`, `INCH`, `YARD`, `MILE`) has both a bare and a quoted key; `FEET` only had the bare one, on both sides. The quoted key is a real, reachable lookup: a STEP name attribute written as `''FEET''` in a file decodes, through STEP's doubled-quote escaping, to the four-character string `'FEET'` (embedded quote marks included), and `extractLengthUnitScale` looks that string up verbatim — it upper-cases the name but does not strip quotes. (The georeferencing extractor strips the surrounding quotes before the lookup, so it reached the bare `FEET` key already; it is the length-unit path that was affected.)

A file spelling its length unit that way resolved as if the name were unknown. Where the file also carried no usable `ConversionFactor` that meant the `?? 1.0` default and a silent read as metres; where it did carry one, it meant the file's own declared factor was used in place of the defined 0.3048. It now resolves to 0.3048 like every other FEET/FOOT spelling, and identically in both readers.
