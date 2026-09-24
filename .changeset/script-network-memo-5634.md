---
"@ifc-lite/flow": minor
"@ifc-lite/flow-nodes": patch
"@ifc-lite/sandbox": minor
---

A Script node that calls `bim.network.fetch` is no longer served a stale memoised result on a rerun (#5634). `NodeRunContext` gains an optional `markVolatile()`: a node calls it when a run's result came from outside the graph, and the scheduler then does not memoise that run. `script.run` / `script.list` call it only when the evaluation actually sent a request, so a script that never touches the network stays memoised. The sandbox's `SandboxConfig.network` accepts a `transport`, and the Script node now routes `bim.network.fetch` through the host's `networkTransport`, as `HttpRequest` already did.
