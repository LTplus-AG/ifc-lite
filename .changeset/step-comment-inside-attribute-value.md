---
'@ifc-lite/parser': patch
'@ifc-lite/wasm': patch
---

A STEP `/* ... */` comment preceding an attribute value is now trivia when the value is decoded, not just when the entity's byte span is scanned.

PR #3675 fixed the SCANNER: a comment inside a record no longer truncates or drops the entity. It deliberately left the ATTRIBUTE-DECODE layer unfixed (issue #3673) — with a correct span, decoding still read the comment's own text as part of the value it precedes. `#1=IFCWALL('a', /* rev; b */ $)` decoded the second attribute as the string `"/* rev; b */ $"` instead of `null`, and a comment before a genuinely unset `$` made `has_non_null_attribute` report it as set.

Fixed on every decoder PR #3675 named as comment-blind:

- The TypeScript `EntityExtractor`'s attribute splitter and its nested-list parser, reusing `StepTextScan` (`step-lexing.ts`) rather than a third hand-rolled comment skip.
- Rust's nom tokenizer (`parse_entity`): its whitespace combinator now shares `skip_step_trivia` with the scanners, so a comment between attributes is skipped the same way whitespace always was.
- Rust's `EntityScanner::has_non_null_attribute`: the leading-whitespace probe and the comma-separator walk both now treat a comment as a region, so a `,`, `'` or `(` inside one no longer moves the attribute index or looks like the value.

Composition is unchanged in both directions: a `/*` inside a string literal is still text, and a `'`, `;`, `(` or `,` inside a comment is still text, never structure. A comment-free record decodes byte-identically to before.
