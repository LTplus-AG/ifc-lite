---
"@ifc-lite/export": patch
"@ifc-lite/cli": patch
---

Reading a STEP record's argument list for a by-index edit now follows the grammar the tokenizer reads, the same one the Rust exporter uses: STEP whitespace only (a no-break space is not padding), `.5`, `+1` and `1.E5` are numbers while `1..2` and a bare word are not, a binary literal is `[0-3]` plus hex digits in either case, an empty list element or a comment that never closes refuses the list, and nesting is bounded at 256. `serializeAttributeValue` recognises the same number spellings, so a slot already written as `.5` is no longer rewritten quoted.
