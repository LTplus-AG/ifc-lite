---
"@ifc-lite/geometry": patch
---

`exportStep`'s source-schema detection (`detect_schema`) used to scan only the first 4096 bytes of a STEP file looking for `FILE_SCHEMA`. A real HEADER section can push `FILE_SCHEMA` past that fixed cutoff when an earlier header field (e.g. a long `FILE_DESCRIPTION`) carries enough text, silently falling back to the `IFC4` default and applying the wrong schema conversion to the export. Schema detection now scans through the HEADER section's closing `ENDSEC;` instead of a fixed byte budget.
