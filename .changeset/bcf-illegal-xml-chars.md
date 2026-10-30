---
"@ifc-lite/bcf": patch
---

A BCF export no longer writes characters XML 1.0 forbids (a vertical tab pasted from a word processor, a backspace). They made markup.bcf not well-formed and other BCF tools refused the whole file; they are now dropped (with unpaired surrogates) when the text is escaped.
