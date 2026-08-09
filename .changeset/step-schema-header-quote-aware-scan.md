---
"@ifc-lite/geometry": patch
---

`exportStep`'s source-schema detection (`detect_schema`) located the HEADER section's closing `ENDSEC;` and the `FILE_SCHEMA` entry with a raw byte search that did not know about STEP string literals. A header field whose string value happened to contain the literal text `ENDSEC;` or `FILE_SCHEMA` (e.g. inside a `FILE_DESCRIPTION`) could therefore produce a false match and detect the wrong schema. The scan is now quote-aware, tracking whether it is inside a single-quoted string (including the `''`-doubled-apostrophe escape) so text inside a string value can no longer be mistaken for header structure.
