---
'@ifc-lite/parser': patch
---

Skip `/* */` comments when scanning for entities, so a commented-out record stays commented out

The entity scanners looked for `#` anywhere in the buffer, including inside a
STEP comment. A record that has been commented out is still a well-formed
`#id = TYPE(...);`, so every shape check downstream accepted it and it was
parsed as a live entity. Round-tripped through `StepExporter`, those revived
records are written into the output as real ones, taking express ids from gaps
in the source numbering.

The guard added in #856 cannot catch this. It requires a `#<digits>` to be
followed by `=`, which rejects a bare `#1` in prose and accepts a commented-out
record, because that record has its `=`. The comment has to be skipped as a
region, which is what the Rust `EntityScanner` already does.

All three copies of the scan loop are fixed, not just the one: `scanEntities`,
`scanEntitiesFast`, and the string-embedded `WORKER_CODE` in
`scan-worker-inline.ts`. The worker matters most, because `scanIfcEntities`
tries it before the wasm scan and before the tokenizer, so in a browser it is
the copy that runs. Each skips comment regions, counts the newlines it jumps so
line numbers stay right, stops at an unterminated comment rather than resuming
inside it, and leaves a lone `/` alone. Comments do not nest, per ISO 10303-21,
so the first `*/` closes the region.

`scanEntities` additionally now advances past a record it has matched. It used
to leave its cursor at the record's opening parenthesis and re-walk the body
with no string state, which was harmless while an interior `#` merely failed
the `=` guard and would not have been once the same loop began reacting to
`/*`: a slash-star inside a string literal would have opened a comment and
swallowed the rest of the file. The Rust scanner advances for the same reason.
