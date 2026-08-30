---
'@ifc-lite/ids': patch
---

Fix IDS `<property>` requirements against `IFCAREAMEASURE`/`IFCVOLUMEMEASURE` values (both `Pset_*` and `Qto_*`) comparing the raw author-unit value instead of the base-SI value the IDS literal is always expressed in.

`applyUnitConversion` gated unit conversion on `IFCLENGTHMEASURE`/`IFCPOSITIVELENGTHMEASURE` alone, so an area or volume measure was compared raw — the same defect #3458 fixes for length, one measure over. Area now converts by the SQUARE of the project's length scale and volume by the CUBE (not the length scale itself), preferring the file's explicitly declared `AREAUNIT`/`VOLUMEUNIT` (via `@ifc-lite/parser`'s `ProjectUnits` resolver) and falling back to `lengthScale ** 2` / `lengthScale ** 3` only when no such unit is declared. `IFCCOUNTMEASURE`, `IFCMASSMEASURE` and `IFCTIMEMEASURE` remain unconverted.
