---
"@ifc-lite/sandbox": minor
"@ifc-lite/flow-nodes": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
"@ifc-lite/viewer": minor
---

Add OpenCDE Documents API flow nodes and `model.openFromSource` (#5634, #5167 phase 3.4).

`@ifc-lite/flow-nodes` gains `documents.queryVersions` (polls `POST /document-versions` with the previous ETag; outputs a versions table, the new ETag and `changed`, which is `false` on a 304), `documents.download` (downloads a version's file as base64 with its name, size and content type) and `model.openFromSource` (opens downloaded bytes as a model through the new optional `FlowHost.openModel`, gated by the `openModel` backend feature). Every Documents API request goes through `coreNetworkRequest` with the graph's `network.fetch:<host>` grants; the bearer token param takes `{{secret:NAME}}`. `model.select` and `model.byType` gain an optional `modelId` input, so a read can be wired to run after, and on, an opened model.

`@ifc-lite/sandbox`: `coreNetworkRequest` accepts `responseType: 'bytes'` and then returns the capped body as `NetworkResponse.bytes`, unmangled by a text decode. A new `allowNotModified: true` option returns a 304 Not Modified as a response; without it a 304 is still refused like every other 3xx, so existing `http.request` and `bim.network.fetch` behaviour is unchanged.

`ifc-lite flow run` (`@ifc-lite/cli`) and MCP's `run_flow` (`@ifc-lite/mcp`) implement `openModel` with their own loaders: the opened model becomes the one the rest of the run (and the CLI's `--out`) works on, and MCP registers it for later tool calls. The viewer loads it through `addModel`, the same path as a dropped file.
