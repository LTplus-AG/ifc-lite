---
"@ifc-lite/parser": patch
---

Add the missing `"'FEET'"` entry to `CONVERSION_BASED_UNIT_FACTORS` in `unit-extractor.ts`.

Every other imperial spelling in the table (`FOOT`, `INCH`, `YARD`, `MILE`) has both a bare and a quoted key; `FEET` only had the bare one. The quoted key is a real, reachable lookup: a STEP name attribute written as `''FEET''` in a file decodes, through STEP's doubled-quote escaping, to the four-character string `'FEET'` (embedded quote marks included), and both `extractLengthUnitScale` and the georeferencing extractor look that string up verbatim. A file spelling its length unit that way previously fell through to the `?? 1.0` default and silently read as metres; it now resolves to 0.3048 like every other FEET/FOOT spelling.
