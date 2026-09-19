---
"@ifc-lite/query": minor
---

Export `trimSelectorWhitespace` (`selector/tokenize.ts`): trims only the six characters the selector tokenizer treats as whitespace (space, tab, LF, CR, FF, VT), unlike `String.trim()` which also strips U+00A0 (no-break space) — a character the tokenizer reads as ordinary word content. Used by the chart source filter (#4946) so a selector carrying an NBSP is never silently rewritten before it reaches the parser.
