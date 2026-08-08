---
'@ifc-lite/sandbox': patch
---

Fix the grammar of the `bim.clash.group` doc string ("By default, grouping uses \"cluster\"."). The string is user-visible: it feeds the script editor's completions, the generated `bim` type surface, and the LLM system prompt. No API change.
