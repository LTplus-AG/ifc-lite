# @ifc-lite/flow-nodes

## 0.5.0

### Minor Changes

- [#5933](https://github.com/LTplus-AG/ifc-lite/pull/5933) [`a51dd3d`](https://github.com/LTplus-AG/ifc-lite/commit/a51dd3de40b0921f552d0c4a8ba8b9195511d114) Thanks [@louistrue](https://github.com/louistrue)! - Add Autodesk Platform Services receive nodes for flow graphs ([#5634](https://github.com/LTplus-AG/ifc-lite/issues/5634)): `aps.token` mints a 2-legged client-credentials token (or wraps a provided 3-legged one) as an opaque handle that is never output, logged or serialised, and `aps.modelProperties` reads Model Derivative metadata and properties of a translated model (derivative URN or Docs/ACC version id) into a table keyed by `externalId`, with `category`, `IfcGUID` and every property as a `Group.Property` column, ready for `table.joinByKey`. All requests go through the gated `coreNetworkRequest` (`network.fetch:developer.api.autodesk.com`), and APS's `202` "still processing" answer is retried a bounded number of times.

- [#5935](https://github.com/LTplus-AG/ifc-lite/pull/5935) [`dff671e`](https://github.com/LTplus-AG/ifc-lite/commit/dff671efe29d9bbc4a1f455fc6b0526d85fb461b) Thanks [@louistrue](https://github.com/louistrue)! - Add OpenCDE Documents API flow nodes and `model.openFromSource` ([#5634](https://github.com/LTplus-AG/ifc-lite/issues/5634), [#5167](https://github.com/LTplus-AG/ifc-lite/issues/5167) phase 3.4).
  
  `@ifc-lite/flow-nodes` gains `documents.queryVersions` (polls `POST /document-versions` with the previous ETag; outputs a versions table, the new ETag and `changed`, which is `false` on a 304), `documents.download` (downloads a version's file as base64 with its name, size and content type) and `model.openFromSource` (opens downloaded bytes as a model through the new optional `FlowHost.openModel`, gated by the `openModel` backend feature). Every Documents API request goes through `coreNetworkRequest` with the graph's `network.fetch:<host>` grants; the bearer token param takes `{{secret:NAME}}`. `model.select` and `model.byType` gain an optional `modelId` input, so a read can be wired to run after, and on, an opened model.
  
  `@ifc-lite/sandbox`: `coreNetworkRequest` accepts `responseType: 'bytes'` and then returns the capped body as `NetworkResponse.bytes`, unmangled by a text decode. A new `allowNotModified: true` option returns a 304 Not Modified as a response; without it a 304 is still refused like every other 3xx, so existing `http.request` and `bim.network.fetch` behaviour is unchanged.
  
  `ifc-lite flow run` (`@ifc-lite/cli`) and MCP's `run_flow` (`@ifc-lite/mcp`) implement `openModel` with their own loaders: the opened model becomes the one the rest of the run (and the CLI's `--out`) works on, and MCP registers it for later tool calls. The viewer loads it through `addModel`, the same path as a dropped file.

- [#5925](https://github.com/LTplus-AG/ifc-lite/pull/5925) [`d85e898`](https://github.com/LTplus-AG/ifc-lite/commit/d85e8980fcebe59a2b6886b117056790023cb81b) Thanks [@louistrue](https://github.com/louistrue)! - Add the `speckle.receive` flow node: fetches a Speckle model version (modern `/projects/<p>/models/<m>[@<v>]` URLs and legacy stream commit/object URLs) through the gated network request path, and writes its walls, floors, flat roofs, columns and beams into a target storey with Revit parameters as property sets. Anything the v1 mapping cannot reproduce is reported by type, reason and count. Display meshes are not written, and bodies are rebuilt parametrically.

### Patch Changes

- Updated dependencies [[`66f3d7e`](https://github.com/LTplus-AG/ifc-lite/commit/66f3d7eb085e77a27e4a0bae096daa70b43620c9), [`dff671e`](https://github.com/LTplus-AG/ifc-lite/commit/dff671efe29d9bbc4a1f455fc6b0526d85fb461b), [`43f40a1`](https://github.com/LTplus-AG/ifc-lite/commit/43f40a12c9bad0cc3515819b204a9b41339367dc)]:
  - @ifc-lite/mutations@2.8.0
  - @ifc-lite/sandbox@2.8.0
  - @ifc-lite/export@4.7.4
  - @ifc-lite/bcf-api@0.2.4
  - @ifc-lite/sdk@7.1.3

## 0.4.0

### Minor Changes

- [#5921](https://github.com/LTplus-AG/ifc-lite/pull/5921) [`ca5ff8d`](https://github.com/LTplus-AG/ifc-lite/commit/ca5ff8d98979cbcadd1644e32ddad4990d178eb4) Thanks [@louistrue](https://github.com/louistrue)! - Add BCF API flow nodes: `bcf.listTopics` (topics as a table plus the raw list, with OData filter/orderby/top), `bcf.createTopic` (from params or one topic per table row) and `bcf.addComment`. They use `@ifc-lite/bcf-api`'s client over the gated `coreNetworkRequest` transport, so every request needs a declared `network.fetch:<host>` grant, and the bearer token can come from a `{{secret:NAME}}` reference. The nodes are never memoised.

- [#5446](https://github.com/LTplus-AG/ifc-lite/pull/5446) [`e40213f`](https://github.com/LTplus-AG/ifc-lite/commit/e40213f0806bf40fcbd1a93bce68fb7ad791bcef) Thanks [@louistrue](https://github.com/louistrue)! - Add outbound network requests and environment secrets to flow graphs ([#5167](https://github.com/LTplus-AG/ifc-lite/issues/5167) phases 3.3/3.5), deny-by-default throughout.
  
  `@ifc-lite/extensions` gains a `secret` capability scope: `secret.read:<NAME>` grants a graph read access to one named env var, with a strict exact-match target (`[A-Z][A-Z0-9_]*`, no glob, no universal wildcard) — the one capability target grammar stricter than the general pattern grammar.
  
  `@ifc-lite/sandbox` gains `bim.network.fetch`, gated by a new `network` permission (off by default) plus an exact-host allow-list re-checked on every call against the running graph's actual `network.fetch:<host>` grants. Requests are restricted to `https:`, matched against `new URL(url).hostname` (never the raw URL string, so userinfo/suffix spoofing is rejected by construction), refuse every redirect, cap the response body mid-stream, enforce a combined timeout/abort signal, and strip `Host`/`Cookie`/hop-by-hop headers. The core request logic (`network-request.ts`) is the single implementation shared by the sandbox bridge and the new `HttpRequest` flow node.
  
  `@ifc-lite/flow-nodes` gains the `http.request` node and a `secrets.ts` module: a node param may reference `{{secret:NAME}}`, validated against the graph's declared `secret.read:<NAME>` capabilities and the real environment BEFORE a run starts (an undeclared or unset reference is a validation error, never a silently empty string), then substituted into a throwaway copy of the document. Every resolved secret at least 6 characters long is redacted (`<secret:NAME>`) from run logs, node outputs, and errors — applied at the outer boundary, so a secret that comes back inside a fetched response body is still caught.
  
  Secrets resolve from `process.env` ONLY in `ifc-lite flow run` (`@ifc-lite/cli`) and MCP's `run_flow` (`@ifc-lite/mcp`), which now also redact their `--json`/tool-result output. The viewer's `HostFeatures.secrets` stays always-empty (the browser has no `process.env`), so a graph referencing a secret is reported `unavailable` before it runs, not mid-run; `HostFeatures.network` is `true` there too, so `http.request` runs subject to the browser's own CORS enforcement, surfacing a blocked cross-origin request as an explicit CORS-likely error rather than a silent empty result.
  
  `@ifc-lite/flow` now owns the `{{secret:NAME}}` grammar (`referencedSecrets`, `replaceSecretRefs`), and `checkAvailability` reports a node whose params reference a secret the host lacks as `unavailable`, so `flow validate` no longer calls such a graph runnable.

### Patch Changes

- [#5928](https://github.com/LTplus-AG/ifc-lite/pull/5928) [`4c7bd47`](https://github.com/LTplus-AG/ifc-lite/commit/4c7bd47e5e8c9bf62d88af6260cc6384a77e0cdf) Thanks [@louistrue](https://github.com/louistrue)! - A Script node that calls `bim.network.fetch` is no longer served a stale memoised result on a rerun ([#5634](https://github.com/LTplus-AG/ifc-lite/issues/5634)). `NodeRunContext` gains an optional `markVolatile()`: a node calls it when a run's result came from outside the graph, and the scheduler then does not memoise that run. `script.run` / `script.list` call it only when the evaluation actually sent a request, so a script that never touches the network stays memoised. The sandbox's `SandboxConfig.network` accepts a `transport`, and the Script node now routes `bim.network.fetch` through the host's `networkTransport`, as `HttpRequest` already did.
- Updated dependencies [[`ccc491e`](https://github.com/LTplus-AG/ifc-lite/commit/ccc491efac18ce496af47c91b1ef4fc04ebecca5), [`7215c2a`](https://github.com/LTplus-AG/ifc-lite/commit/7215c2a9344ede37c90680e1eb2a6c2b70c0ee3d), [`e6ebbef`](https://github.com/LTplus-AG/ifc-lite/commit/e6ebbefde52670adbdb0c35bc19baed0453ca42f), [`e40213f`](https://github.com/LTplus-AG/ifc-lite/commit/e40213f0806bf40fcbd1a93bce68fb7ad791bcef), [`5c02af8`](https://github.com/LTplus-AG/ifc-lite/commit/5c02af8b7fda4d2fe53f79d3f00b9d192fc664d9), [`42b3f21`](https://github.com/LTplus-AG/ifc-lite/commit/42b3f214290d6c7d5fb27f697ec8451b323aabd4), [`a0e1bfe`](https://github.com/LTplus-AG/ifc-lite/commit/a0e1bfe567e3a892287faa8ee3e1b3610b59511d), [`11478f7`](https://github.com/LTplus-AG/ifc-lite/commit/11478f7b7e3b530a6111874bb233fada1a36d785), [`4c7bd47`](https://github.com/LTplus-AG/ifc-lite/commit/4c7bd47e5e8c9bf62d88af6260cc6384a77e0cdf), [`a3dfacb`](https://github.com/LTplus-AG/ifc-lite/commit/a3dfacb2862d1db09267ebe52707193630c35ff7)]:
  - @ifc-lite/data@6.0.0
  - @ifc-lite/export@4.7.3
  - @ifc-lite/extensions@0.10.0
  - @ifc-lite/sandbox@2.7.0
  - @ifc-lite/flow@0.4.0
  - @ifc-lite/mutations@2.7.1
  - @ifc-lite/sdk@7.1.2
  - @ifc-lite/query@2.5.1

## 0.3.1

### Patch Changes

- Updated dependencies [[`90221d2`](https://github.com/LTplus-AG/ifc-lite/commit/90221d2f2928e8580050ddf9c26b5165f26af183), [`1909a6a`](https://github.com/LTplus-AG/ifc-lite/commit/1909a6ac6b9934c8793b6e6be8f80dfece3fd44e), [`0d25941`](https://github.com/LTplus-AG/ifc-lite/commit/0d25941ceadd2d5842bcd8a3d15fc21793ecfc63), [`00d6837`](https://github.com/LTplus-AG/ifc-lite/commit/00d68371ac6ab87fafa4bc5f0add2468a7e8a398)]:
  - @ifc-lite/export@4.7.2
  - @ifc-lite/extensions@0.9.0
  - @ifc-lite/sdk@7.1.1
  - @ifc-lite/data@5.3.0

## 0.3.0

### Minor Changes

- [#5377](https://github.com/LTplus-AG/ifc-lite/pull/5377) [`2dd677d`](https://github.com/LTplus-AG/ifc-lite/commit/2dd677d7307d87f3b433256bd00647a2a3ee06df) Thanks [@louistrue](https://github.com/louistrue)! - Add the spreadsheet connector nodes for the flow-graph pilot workflow (issue [#5167](https://github.com/LTplus-AG/ifc-lite/issues/5167) phase 3.2): `table.readCsv`, `table.writeCsv`, `table.readXlsx`, `table.writeXlsx`, `table.joinByKey` (GlobalId/Tag/Name/indexed-property matching, with matched/unmatched/ambiguous outputs — ambiguity is reported, never resolved to the first match), and `model.applyTable` (typed columns to property mutations through the existing `bim.mutate` write path; a cell that does not parse as its column's declared type is reported per row and not written). `table.joinByKey`'s `tag`/`property` strategies reuse `@ifc-lite/mutations`' `csv-match.ts` index builder rather than re-implementing matching, through a new optional `FlowHost.tables()` accessor (`TableAccess`). `readXlsxTable`/`writeXlsxTable` are exported as a shared `exceljs`-backed module usable by both the CLI and the viewer.

### Patch Changes

- [#5517](https://github.com/LTplus-AG/ifc-lite/pull/5517) [`e66c849`](https://github.com/LTplus-AG/ifc-lite/commit/e66c849b6a79de9691a1e70ee3b2b593c5327fa1) Thanks [@louistrue](https://github.com/louistrue)! - `parseValue` and `CsvConnector` now accept a Real, Integer, Boolean or Logical cell only when the whole cell is a value of that type ([#5427](https://github.com/LTplus-AG/ifc-lite/issues/5427)). Values that were silently coerced before are now reported per cell and left unwritten: `12,5` or `60abc` in a Real column (previously written as 12 and 60), `2.7` in an Integer column (previously 2), and any word other than true/false/yes/no/1/0 in a Boolean or Logical column, such as `ja` or `UNKNOWN` (previously `false`). A property match on such a cell no longer selects entities either. `generateMutations` reports each skipped cell through its `warnings` array. Surrounding whitespace and exponent notation (`1.2E-05`) are still accepted; a decimal comma is refused rather than guessed. The flow table nodes already applied this check and now share the same function, so their behaviour is unchanged.
- Updated dependencies [[`35b8b23`](https://github.com/LTplus-AG/ifc-lite/commit/35b8b238821138d6c5bc94d3ad51abf832677a88), [`83284a9`](https://github.com/LTplus-AG/ifc-lite/commit/83284a947d9adb9e1ece28f9d5ee7166722be1e5), [`992f553`](https://github.com/LTplus-AG/ifc-lite/commit/992f55304ca0ec8ed5be3b4eabab429c68808a7e), [`7bab13a`](https://github.com/LTplus-AG/ifc-lite/commit/7bab13af06b8d8778f6cdb513ad299e760e55074), [`e66c849`](https://github.com/LTplus-AG/ifc-lite/commit/e66c849b6a79de9691a1e70ee3b2b593c5327fa1), [`eb8c3d6`](https://github.com/LTplus-AG/ifc-lite/commit/eb8c3d66a8a9091aecb947ceeb2b2dcae189d533), [`52d30de`](https://github.com/LTplus-AG/ifc-lite/commit/52d30de0ae3fc8ef6322191bd1831483b93d485f), [`a250a92`](https://github.com/LTplus-AG/ifc-lite/commit/a250a928b1c8c64ac6153136772fe6c71398eee9), [`617da29`](https://github.com/LTplus-AG/ifc-lite/commit/617da29bc17326105dd1143385c967210e529a43), [`73c0c5d`](https://github.com/LTplus-AG/ifc-lite/commit/73c0c5de3981987d6672de19cef2c64d61259277), [`dabc489`](https://github.com/LTplus-AG/ifc-lite/commit/dabc48987aca1392685218dd31641f8dbadf9590), [`dabc489`](https://github.com/LTplus-AG/ifc-lite/commit/dabc48987aca1392685218dd31641f8dbadf9590), [`60f70f9`](https://github.com/LTplus-AG/ifc-lite/commit/60f70f93c9cdf9948f1a7325efb1e157a09d3a60), [`bd15b3f`](https://github.com/LTplus-AG/ifc-lite/commit/bd15b3f607f43ab47c8f4d530ed95231f802e15c), [`eebb00e`](https://github.com/LTplus-AG/ifc-lite/commit/eebb00e52719e0254d1626f791740ce7fe7489a9), [`94324e2`](https://github.com/LTplus-AG/ifc-lite/commit/94324e2a69a6cf41cf23488ccdc56b2b7d2c069f), [`46f79e3`](https://github.com/LTplus-AG/ifc-lite/commit/46f79e38649c6d78753587aeaefbf3d5bbef0d95), [`1c12066`](https://github.com/LTplus-AG/ifc-lite/commit/1c12066f096f52389277b5fce738fc7e03a5334d), [`f942fb6`](https://github.com/LTplus-AG/ifc-lite/commit/f942fb6c48ac9be1464e49fd963340835a72945d), [`5665917`](https://github.com/LTplus-AG/ifc-lite/commit/566591746eead289fcc5aa60258ef96b30366456), [`80c6a38`](https://github.com/LTplus-AG/ifc-lite/commit/80c6a38a3efc8783965e94d309bcc2f984cef71d), [`2dd677d`](https://github.com/LTplus-AG/ifc-lite/commit/2dd677d7307d87f3b433256bd00647a2a3ee06df), [`24b7921`](https://github.com/LTplus-AG/ifc-lite/commit/24b79210c442f44614d5786ff2986ee3a2b9c0d7), [`71ace41`](https://github.com/LTplus-AG/ifc-lite/commit/71ace41b0ccfde286fe7fc1074011a91c9c8d5b1), [`f66adb5`](https://github.com/LTplus-AG/ifc-lite/commit/f66adb5fa9a35bf4ae4a9a9e9f36e477f815ad35), [`decff6b`](https://github.com/LTplus-AG/ifc-lite/commit/decff6bc31589df65bdd8dd20e72a0b840a4be7a), [`affda87`](https://github.com/LTplus-AG/ifc-lite/commit/affda87e1b892b608d5790387a3ab3315d47ae8c), [`316c0bf`](https://github.com/LTplus-AG/ifc-lite/commit/316c0bf248ca2573cc63acf421e4ccba4c7638c7), [`07ed0dd`](https://github.com/LTplus-AG/ifc-lite/commit/07ed0ddaf4e527f1fff3704cc0d36e700fcde1a7), [`b0f3b80`](https://github.com/LTplus-AG/ifc-lite/commit/b0f3b803d70442307b6741b78b85adef976e6f63), [`1d71f36`](https://github.com/LTplus-AG/ifc-lite/commit/1d71f366e11043a80fa81055323b5118d84d213e), [`0d9cbc0`](https://github.com/LTplus-AG/ifc-lite/commit/0d9cbc0072baa634923623c6772500d57a63f412), [`621de01`](https://github.com/LTplus-AG/ifc-lite/commit/621de015a52e65493fcda331ccaf9ffcfb626a47), [`80c6a38`](https://github.com/LTplus-AG/ifc-lite/commit/80c6a38a3efc8783965e94d309bcc2f984cef71d), [`18b082f`](https://github.com/LTplus-AG/ifc-lite/commit/18b082ff95eedf847d29108726d4fee63c93057e)]:
  - @ifc-lite/mutations@2.7.0
  - @ifc-lite/data@5.1.0
  - @ifc-lite/export@4.7.0
  - @ifc-lite/flow@0.3.0
  - @ifc-lite/sdk@7.1.0

## 0.2.0

### Minor Changes

- [#5233](https://github.com/LTplus-AG/ifc-lite/pull/5233) [`04b5467`](https://github.com/LTplus-AG/ifc-lite/commit/04b54673aa1a888ebf8f5d2f48b27558d3e6c4f0) Thanks [@louistrue](https://github.com/louistrue)! - Make the Flow Script node usable over a list, and give its source a real editor.
  
  `ParamKind` gains `'code'` (with an optional `language`), which tells a host that the parameter needs a multi-line editor rather than the single-line `<input>` a `'string'` gets. `script.run`'s `code` parameter now declares it. The value is still a plain string, so a host without a code editor degrades to the string field.
  
  **Fixed: a Script node laced over a list only ever computed its first lane.** Every lane shares one sandbox and QuickJS evaluates a program in the *global* lexical scope, so the second lane's `const inputs = …` — and any `const` in the user's own code — threw "redeclaration of 'x'". The lane error was logged and that lane yielded `null`, which a downstream `core.filter` reads as a legitimate answer, so a per-element script silently produced wrong results for every element but the first. The source is now evaluated through a direct `eval` inside a function, giving each lane its own variable environment while keeping both contract points: `inputs` in scope, and the last expression as the value.
  
  New node `script.list` ("Script (list)"): the same sandbox with `list` ports instead of `item` ports, so the code sees whole lists and returns an array. Sorting, ranking, top-N and de-duplication are not expressible per element; they are three lines here. A result that is not an array is rejected rather than handed to a list port.

- [#5168](https://github.com/LTplus-AG/ifc-lite/pull/5168) [`0ee73f7`](https://github.com/LTplus-AG/ifc-lite/commit/0ee73f70b0aa08c811e37fe3b2c20fe176d3d8f1) Thanks [@louistrue](https://github.com/louistrue)! - New package: the standard node library for `@ifc-lite/flow` over the ifc-lite SDK — `core.*` values and restructuring, `model.*` reads (selector, properties, quantities, relationships, storey grouping), typed `table.*` nodes, `viewer.*` feedback that is a no-op headlessly, capability-gated `model.setProperty`/`model.setAttribute`, parametric `element.*` specs with the tracked `model.addElement` and `model.delete`, and a sandboxed `script.run` node.

### Patch Changes

- Updated dependencies [[`0eafae1`](https://github.com/LTplus-AG/ifc-lite/commit/0eafae1cb19e70828815c658a6ee3c14f9c4c8a8), [`04b5467`](https://github.com/LTplus-AG/ifc-lite/commit/04b54673aa1a888ebf8f5d2f48b27558d3e6c4f0), [`0ee73f7`](https://github.com/LTplus-AG/ifc-lite/commit/0ee73f70b0aa08c811e37fe3b2c20fe176d3d8f1), [`0eafae1`](https://github.com/LTplus-AG/ifc-lite/commit/0eafae1cb19e70828815c658a6ee3c14f9c4c8a8), [`b0d489e`](https://github.com/LTplus-AG/ifc-lite/commit/b0d489ea7270b84c1d373b5e340fc09ba0c798e6)]:
  - @ifc-lite/sdk@7.0.0
  - @ifc-lite/flow@0.2.0
  - @ifc-lite/sandbox@2.6.1
