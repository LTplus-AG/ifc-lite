---
"@ifc-lite/parser": patch
"@ifc-lite/viewer": patch
---

Selecting an element on a large model no longer reads every typing relationship from the source on the way to the Properties panel (#9192). `readCurrentTypeQuantities` now takes them from the parsed relationship graph, and reads a relationship's record only when an edit touched it, the parser recorded no edge for it, or it names the element or type being read. One more case is read only when it decides the answer: a definition relationship whose graph count can exceed what a read counts (it names a non-definition, or a definition an edit removed) is read when that bound would cross the reference budget. Answers are unchanged, with one narrowing: a relationship whose list holds both valid references and unreadable values now refuses only the elements and types it names, rather than every read in the file. A refusal now holds for the edit revision like an answer does (model-wide, per relationship and per type), instead of being worked out again on every click.
