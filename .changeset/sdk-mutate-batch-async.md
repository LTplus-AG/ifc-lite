---
'@ifc-lite/sdk': minor
---

`bim.mutate.batchAsync(label, fn)`: the asynchronous form of `batch` — the undo batch stays open across awaits and closes when the promise settles, so a flow run or a fetch-then-write reverts as one undo step.
