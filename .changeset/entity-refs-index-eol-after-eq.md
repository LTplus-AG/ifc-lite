---
'@ifc-lite/parser': patch
---

Fix `buildEntityRefsFromIndex` dropping the entity type when a line break
follows `#id=` directly (`#1=\nIFCWALL($);`).

This is legal STEP — a newline directly after `#id=` appears in real
fixtures — and the tokenizer's own `scanEntitiesFast` / `scanEntities`
already handle it. `buildEntityRefsFromIndex` is the fast path taken when
the streaming geometry pre-pass has already built the entity index; its
whitespace skip after `=` only recognised space and tab, so a record
starting with a newline resolved to `type: ''` and the entity was silently
misclassified. The skip now also recognises `LF` and `CR`, matching the
type-end scan a few lines below it in the same function.
