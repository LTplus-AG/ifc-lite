---
"@ifc-lite/ai": minor
"@ifc-lite/viewer": patch
---

New `@ifc-lite/ai` package (#6923): the provider-independent AI request core the viewer, Flow AI nodes and headless hosts share. `runModelRequest` takes a host-supplied transport and resolves to a typed outcome (`completed`, `truncated`, `cancelled`, `timeout`, `error`, `refused`) with an overall deadline and caller cancellation; root budgets (`createRootBudget`, `reserveRequest`, `settleRequest`, `restoreRootBudget`) cap a task's requests and output tokens across retries, chunks, lanes and resumed runs; one usage receipt per dispatched request carries only provider-reported counts; `onStart` announces a dispatched request (its receipt id and a `cancel`) for activity lists; `parseJsonOutput` accepts one bounded JSON reply and refuses truncated output. The viewer's Assistant request service now runs on this core with unchanged behaviour.
