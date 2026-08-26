---
"@ifc-lite/parser": patch
---

Read the IFC schema version from the header's `FILE_SCHEMA` declaration instead of substring-scanning the raw header bytes.

The old scan looked for `IFC4`, `IFC4X3`, `IFC2X3` anywhere in the first 2000 bytes, which also covers the free-text author, organisation and originating-system fields of `FILE_DESCRIPTION`/`FILE_NAME`. An IFC2X3 file exported by an application whose name contains `IFC4` was reported as IFC4, and because ISO 10303-21 places `FILE_SCHEMA` after `FILE_NAME`, a long author list could push the real declaration past the 2000-byte window so that even an unambiguous file fell through to the IFC4 default. The schema version selects attribute layouts downstream — schedule extraction reads IfcTask fields at IFC4 offsets — so a misdetection shifted output values.

The declaration is now read from the already-parsed source header (matched by prefix, so `IFC4X3_ADD2` and `IFC4X1` still resolve correctly), and the previous raw scan remains as the fallback for files that declare no schema.
