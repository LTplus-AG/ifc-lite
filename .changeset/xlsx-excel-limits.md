---
"@ifc-lite/export": minor
"@ifc-lite/flow-nodes": patch
---

XLSX exports sanitize worksheet names and cap them at 31 UTF-16 units. Text cells over 32,767 UTF-16 units end in a visible ellipsis, including headers and list titles.
