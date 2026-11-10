---
"@ifc-lite/export": minor
---

New `renumberStepIds(text, { random, reorder? })`: gives every entity instance of a STEP file a new `#id` from a seeded permutation and rewrites every reference to match, using the merged exporter's string-literal-aware `remapEntityText` rule (so `'Room #205'` and `\S\'` PAGE operands survive). Statements are split outside string literals and comments; the HEADER and non-record statements are copied verbatim. New ids skip any id used by a dangling reference, so a dangling reference never starts pointing at a real instance. Returns `{ text, idMap, danglingReferences }`.
