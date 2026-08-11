---
"@ifc-lite/geometry": patch
---

Fixes to the STEP/IFC exporters' shared `FILE_SCHEMA` detection and header re-serialization, reached from `exportMerged` and the STEP re-export path (`ifc-lite-bridge.ts` defaults `schema` to `''`, which resolves to auto-detect on both):

- `detect_schema` now scans the whole HEADER section instead of only the first 4096 bytes, so a long earlier header field (e.g. a lengthy `FILE_DESCRIPTION`) no longer pushes `FILE_SCHEMA` out of range and silently defaults the output to IFC4.
- The `FILE_SCHEMA` search — and the HEADER-section boundary scan that bounds it — are now quote-aware, so a header string value that happens to contain the literal text `FILE_SCHEMA` or `ENDSEC;` is no longer mistaken for the real entry.
- `detect_schema` un-doubles a `\\` in the detected label before it is re-escaped on write, so a schema label carrying a literal `\` (synthetic, but reachable through the same code path as the labels above) round-trips instead of compounding.
- `exportMerged`'s `#`-reference rewriter now copies non-`#`-reference bytes through unchanged instead of widening each byte to a `char`, which corrupted every non-ASCII (UTF-8 multi-byte) character in a merged model's string literals.
- `exportMerged`'s header-string escaping now maps every ASCII control byte (not just `\n`/`\r`/`\t`) to a space, matching the STEP exporter and ISO 10303-21's basic graphic range.

`merged.rs`'s private forks of `detect_schema` and `escape` are removed; it now shares the hardened primitives in `step_text.rs` with the STEP exporter.
