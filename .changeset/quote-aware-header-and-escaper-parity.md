---
"@ifc-lite/parser": patch
"@ifc-lite/data": patch
---

Header keyword searches skip quoted text, and the control-character escaper matches the Rust half.

`parseSourceHeader` located `ENDSEC` and each `FILE_*` keyword with a raw `indexOf`, which cannot tell a record keyword or the section terminator from the same text inside a header field's VALUE. A `FILE_DESCRIPTION` mentioning `ENDSEC;` truncated the header before any record was read and the whole header came back `undefined`; one mentioning `FILE_NAME` shadowed the real record and every name, author, organization and originating-system field was lost. Both searches are now quote-aware, matching `step_text::find_unquoted` on the Rust side rather than introducing a second approach.

`escapeStepString` collapsed a run of control characters to one space while `rust/export/src/step_text.rs::escape` emitted one space each, so `"a\t\t\tb"` serialised as `'a b'` from TypeScript and `'a   b'` from Rust — from two functions whose doc comments each claimed to match the other. The TypeScript side now emits one space per character. ISO 10303-21 6.3.3.4 mandates neither, so the tie-break is that preserving the count keeps information the collapse discards.
