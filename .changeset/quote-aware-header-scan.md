---
'@ifc-lite/parser': patch
---

STEP header scanning now treats a `/* ... */` comment as trivia everywhere, not just when locating a record. A comment between a keyword and its `(` no longer loses the record, and a comma inside one no longer splits an argument in two. The three scanners in `source-header.ts` share one lexical rule instead of holding three copies of it.

Keyword matching folds ASCII case per character rather than uppercasing a copy of the text. Indexing a copy shifted every offset after a value whose uppercase is longer (`ß` uppercases to `SS`), and a full Unicode fold read `ENDſEC` as `ENDSEC` and truncated the header.
