---
'@ifc-lite/parser': patch
'@ifc-lite/wasm': patch
---

Every entity scanner now treats a STEP `/* ... */` comment as trivia INSIDE a record, not only between records.

ISO 10303-21 allows a comment anywhere whitespace is allowed, and real exporters emit them mid-record. Two spec-legal shapes misparsed, silently:

- `#1 /* was #7 */ = IFCWALL(...);` — the scanners wanted `=` straight after the instance name, so the record produced no entity at all.
- `#1=IFCWALL('a', /* pending; revise */ $);` — the semicolon-terminated scanners ended the record at the `;` inside the comment, so the byte span handed to every downstream decoder was truncated. An apostrophe inside a comment (`/* don't reuse */`) flipped the same scanners' quote parity and swallowed the terminator entirely, dropping the record.

The fix lands on all four scanners at once, because they must agree on what a record is: `StepTokenizer.scanEntities`, `StepTokenizer.scanEntitiesFast`, the inline scan worker, and Rust's `EntityScanner` (which feeds `build_entity_index`, the sharded pre-pass, and the wasm `scanEntitiesFast`/`scanEntitiesFastBytes` entry points). The three TypeScript scanners share one `skipTrivia` helper in `step-lexing.ts`; Rust mirrors it as `skip_step_trivia`, and each side's comment names the other as its matched pair.

The two skips compose in one direction only, and both directions are now pinned by tests: a string literal is taken first, so a `/*` inside one is literal text; a comment is then taken as a whole region, so a quote, a semicolon or a parenthesis inside it is comment text. `Rust`'s record-terminator scan widens `memchr2` to `memchr3` to see comment openers; a comment-free file costs one extra comparison per SIMD block there, and one extra byte test per whitespace run in the TypeScript scanners. Measured on `schependomlaan.ifc` (714,485 records) and `ISSUE_068_ARK_NUS_skolebygg.ifc` (945,194 records), entity counts, mesh counts, vertex and triangle counts are identical and the parse-phase timings move in both directions within run-to-run noise.

An unterminated comment is still refused rather than run to end of input, unchanged on both sides.
