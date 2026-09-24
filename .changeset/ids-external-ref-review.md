---
"@ifc-lite/ids": patch
---

IDS external-reference classifications on a live model (#5249 follow-up): the session's relationship list and record reader are built once per accessor instead of on every `getClassifications` call; an authored string attribute is read as the literal value (it was un-quoted, disagreeing with the STEP writer), and an authored typed value is unwrapped.
