---
'@ifc-lite/wasm': patch
---

`EntityScanner`'s HEADER skip (`rust/core/src/parser/scanner_header.rs`) matched the `DATA;` section marker inside a STEP `/* ... */` comment. ISO 10303-21 allows a comment wherever whitespace is allowed, the HEADER included, so `HEADER; /* DATA; #99=IFCWALL($); */ ENDSEC; DATA; #1=IFCWALL($);` ended the marker search inside the comment and started the entity scan there: `#99`, a record the file does not declare, came back alongside the real `#1`. The search already skipped quoted strings for exactly this reason; it now skips complete comments the same way, through the shared `skip_step_comment`.

An unterminated `/*` in the HEADER gets the same answer as a missing marker, so the scan starts at the top and `next_entity` meets the same comment, which reports it through the `malformed_record_start` channel rather than silently returning nothing. A headerless partial file whose records precede a bad comment still scans those records.
