---
"@ifc-lite/parser": patch
"@ifc-lite/wasm": patch
---

Fix the fast STEP entity scan swallowing the next record when one is missing its own `;`. `#2=IFCB(2)` with no terminator used to run on to the *next* record's `;`, so `#1=IFCA(1);\n#2=IFCB(2)\n#3=IFCC(3);\n#4=IFCD(4);` yielded `#1`, `#2` (with a byte span covering all of `#3`), and `#4`, with `#3` gone and `malformedRecordCount` still `0`. The same shape with a truncated last record absorbed the file's `ENDSEC;` footer into that record and still reported success.

The scan is now bounded to the record's own body by two ISO 10303-21 grammar rules: the last significant byte before the terminator must be the `)` closing the parameter list, and no `=` may appear before it outside a string or comment (`=` occurs only in `entity_instance_name '=' record`). A record that fails either rule is dropped and reported, and the scan resumes at the `)` closing its own parameter list, so one bad record costs one record. Stopping instead would have cost far more: a shard whose scanner stops hands back no handoff, and the stitch then discards every later shard, turning one missing `;` into the loss of the whole tail of the model on the sharded viewer path (measured: 40 records in, 19 out). An unterminated string or comment still has nothing to resume from, so that case stops exactly as before.

Applied to all three hand-duplicated copies of the scan: `tokenizer.ts`, the Web Worker's `scan-worker-source.ts`, and the Rust `EntityScanner` behind the wasm path, which is why `@ifc-lite/wasm` is bumped alongside the parser.

A record with no closing `)` at all is dropped the same way rather than ending the scan: its literals and comments all closed, so the bytes after it are still readable and the scan re-hunts from past its `#`. Only a literal or comment that never closes leaves nothing to resume from, and that still stops the scan as before.
