---
"@ifc-lite/parser": patch
---

`parseSourceHeader` reads the HEADER with the same rules as the Rust header reader: square brackets are ordinary text and no longer nest an argument, a keyword must be a whole identifier followed by `(` (or `;` for `ENDSEC`), a `/*` that never closes hides every later record, and the scan window is 256 KiB, matching the native scanner's `DATA;` search.
