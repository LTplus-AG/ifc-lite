---
'@ifc-lite/sdk': minor
---

`bim.mutate.batchAsync(label, fn)`: the asynchronous form of `batch` — the undo batch stays open across awaits and closes when the promise settles, so a flow run or a fetch-then-write reverts as one undo step. A `batchAsync` started while another is in flight (nested or overlapping) joins it: one marker, closed when the last settles.
