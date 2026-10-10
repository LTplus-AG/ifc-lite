# @ifc-lite/flow-nodes

## 0.7.0

### Minor Changes

- [#7079](https://github.com/LTplus-AG/ifc-lite/pull/7079) [`fc024e3`](https://github.com/LTplus-AG/ifc-lite/commit/fc024e387d27b7ab21e5e6397a97976fafd46726) Thanks [@louistrue](https://github.com/louistrue)! - Expose the canonical portable model-change artifact parser through `@ifc-lite/ai/artifacts` and add a constrained, review-required `ai.propose` Flow node. Drafts preserve captured expected values, cite sent findings and obey explicit native field/value constraints before a separate native mutation preflight.

- [#7039](https://github.com/LTplus-AG/ifc-lite/pull/7039) [`0e2f612`](https://github.com/LTplus-AG/ifc-lite/commit/0e2f612fe205f08ab10314abd95f0319dba2cba5) Thanks [@louistrue](https://github.com/louistrue)! - Flow AI nodes with native CLI reviewed pause/resume ([#6923](https://github.com/LTplus-AG/ifc-lite/issues/6923)). Viewer approval controls ship in the next layer; MCP reports AI nodes as unavailable.
  
  - `@ifc-lite/flow-nodes`: new `@ifc-lite/flow-nodes/ai` entry with `ai.classify`, `ai.summarize` and `ai.extract`, which call the host's `FlowHost.ai` service, spend the run's root budget, validate every key, label, citation and span the model returns, report coverage, and pause the run for review.
  - `@ifc-lite/extensions`: the capability catalogue lists `network.ai` (send graph data to the host's AI model provider, red).
  - `@ifc-lite/cli`: `flow run --checkpoint`, `flow review --approve <digest> | --reject` and `flow resume`, with an OpenAI-compatible AI service configured by `IFC_LITE_AI_MODEL` / `IFC_LITE_AI_API_KEY` / `IFC_LITE_AI_BASE_URL` and a per-run budget (`--ai-max-requests`, `--ai-max-output-tokens`). A paused run exits 3.
  - `@ifc-lite/mcp`: `describe_flow` / `run_flow` report AI nodes as unavailable on this host instead of as unknown types.

- [#6911](https://github.com/LTplus-AG/ifc-lite/pull/6911) [`351ea6d`](https://github.com/LTplus-AG/ifc-lite/commit/351ea6d2de55c1121dcced1e6c36b22888707f66) Thanks [@louistrue](https://github.com/louistrue)! - `bcf.createTopic` and `bcf.addComment` send every write through `FlowHost.bcfWrites` when the host supplies one ([#6896](https://github.com/LTplus-AG/ifc-lite/issues/6896)). The new `BcfWriteGateway` records the intent before sending and the receipt after, and refuses to resend a write whose earlier attempt has an unknown outcome. Hosts without a gateway still write directly, but a lost connection is now reported as an unknown outcome ("check the project before running this node again") instead of a plain failure; nothing is retried.

- [#7250](https://github.com/LTplus-AG/ifc-lite/pull/7250) [`e8dce32`](https://github.com/LTplus-AG/ifc-lite/commit/e8dce320229c9e70bd54d8d627982f864ff54431) Thanks [@louistrue](https://github.com/louistrue)! - Retain dispatched request grants, deadlines, safe finish reasons, producer-declared prompt versions and versioned logical-input/output-text SHA256 digests in canonical generation receipts. Flow hosts forward native producer versions without persisting raw prompts, responses, credentials or endpoints.
  
  Bind receipt model/route to the actual dispatched identities. Native JSON producers explicitly prepare one parsed snapshot for both dispatch and logical digest; generic opaque custom transports keep unknown input metadata without reflection or changed sent-input semantics.

- [#6710](https://github.com/LTplus-AG/ifc-lite/pull/6710) [`8a0a03a`](https://github.com/LTplus-AG/ifc-lite/commit/8a0a03a4f9e4ca9cfae457493f0eb50268052ecb) Thanks [@louistrue](https://github.com/louistrue)! - Add optional SDK and loaded-model MCP stair and railing authoring, with atomic tracked replacement and unique stair assembly removal. Reuse canonical builders and retain prior model work when creation or ownership checks refuse a replacement.

- [#7135](https://github.com/LTplus-AG/ifc-lite/pull/7135) [`5a8dd4e`](https://github.com/LTplus-AG/ifc-lite/commit/5a8dd4e9cbe8ca1f3f7fc4c78a0badc84e8d75d3) Thanks [@louistrue](https://github.com/louistrue)! - Carry native Flow AI response schemas through shared requests and host transports, recording whether the request used JSON Schema or text. Preserve native evidence checks and review checkpoints; compatible headless providers can explicitly enable schema requests.
  
  Add the typed unsupported-schema refusal for known host limitations. The viewer checks Anthropic grammar limits before spending the request budget, and native Flow nodes report the limitation without inventing sent evidence.

### Patch Changes

- [#6704](https://github.com/LTplus-AG/ifc-lite/pull/6704) [`9d07c95`](https://github.com/LTplus-AG/ifc-lite/commit/9d07c9521aa28827087d73959ba5087d974a6d19) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Malformed percent-escapes and unparseable request targets no longer escape as a bare `URIError` or `TypeError`. The collab server answers a request target `new URL` rejects with 400 instead of 500, closes a websocket with a malformed room path with 4400 instead of 1011, and the blob-GC scan reads each room log by its file name instead of decoding the name into a room id (a log with a malformed name is read, or named in the abort message, instead of stopping the sweep with `URI malformed`). The MCP entity resource answers a malformed GlobalId as "no such entity", and the Speckle URL parser refuses it with its named "no usable id" error, and the semantic relay's HTTPS listener answers an unparseable request target with 400 instead of 500.
  
  Add `FilePersistence.loadLogFile(file, requireComplete?)` for reading an enumerated log by its actual path. Blob GC requires complete framing and refuses incomplete frame bodies or trailing partial headers, while ordinary room loads retain complete-prefix recovery.
- Updated dependencies [[`667bd74`](https://github.com/LTplus-AG/ifc-lite/commit/667bd747e7aa50c3ca1cf688400517c33fd9b8f5), [`351ea6d`](https://github.com/LTplus-AG/ifc-lite/commit/351ea6d2de55c1121dcced1e6c36b22888707f66), [`fc024e3`](https://github.com/LTplus-AG/ifc-lite/commit/fc024e387d27b7ab21e5e6397a97976fafd46726), [`8f8fe3b`](https://github.com/LTplus-AG/ifc-lite/commit/8f8fe3b126f25201ebfd338f355eb3787e7ad908), [`3f681d9`](https://github.com/LTplus-AG/ifc-lite/commit/3f681d952dc2bae1dc715210354cf2705b1edac0), [`6a6714b`](https://github.com/LTplus-AG/ifc-lite/commit/6a6714b4e95f25ef43013be354a2ff62674ff07a), [`b4899b0`](https://github.com/LTplus-AG/ifc-lite/commit/b4899b017f037ad629ee2b8a5fa34cdf56e8af72), [`06c45b2`](https://github.com/LTplus-AG/ifc-lite/commit/06c45b21a478f62c5ea8c89a0a8dd0c09fc43e69), [`b2a5fb2`](https://github.com/LTplus-AG/ifc-lite/commit/b2a5fb2b97290bb39d2d36be81dd416c15c6a849), [`7d33d8c`](https://github.com/LTplus-AG/ifc-lite/commit/7d33d8cd6917c6a0df5d1b3e6aca741e554c8ba7), [`0e2f612`](https://github.com/LTplus-AG/ifc-lite/commit/0e2f612fe205f08ab10314abd95f0319dba2cba5), [`a11f9c6`](https://github.com/LTplus-AG/ifc-lite/commit/a11f9c6cbbff770b19edc013c67e1816517aebcb), [`a352a79`](https://github.com/LTplus-AG/ifc-lite/commit/a352a79ee372def56f79d0a331aaacfc896a95a9), [`e8dce32`](https://github.com/LTplus-AG/ifc-lite/commit/e8dce320229c9e70bd54d8d627982f864ff54431), [`b92dd05`](https://github.com/LTplus-AG/ifc-lite/commit/b92dd05495094a47c4a68eb1137a3a1906fc65cc), [`29a1648`](https://github.com/LTplus-AG/ifc-lite/commit/29a1648b3ea56a346012b65ab3b7e41ecd598e8f), [`09745f0`](https://github.com/LTplus-AG/ifc-lite/commit/09745f0f3bb99ac07802ae061f13df92e865683f), [`4b17e29`](https://github.com/LTplus-AG/ifc-lite/commit/4b17e29c730cb04a4012ed871139b70eb640f191), [`29e1088`](https://github.com/LTplus-AG/ifc-lite/commit/29e1088dda6777f7086bd122208ce7bda8db1d89), [`1dacd47`](https://github.com/LTplus-AG/ifc-lite/commit/1dacd47008744f1f9de48ab20aa4d871c4572ee7), [`2e2f65a`](https://github.com/LTplus-AG/ifc-lite/commit/2e2f65a66e1375ef6cc52b8a310526de1a36e1a0), [`b92dd05`](https://github.com/LTplus-AG/ifc-lite/commit/b92dd05495094a47c4a68eb1137a3a1906fc65cc), [`fd1f8f5`](https://github.com/LTplus-AG/ifc-lite/commit/fd1f8f52fabbde0ecee4d6a5c15635293ff1a15e), [`2499fdb`](https://github.com/LTplus-AG/ifc-lite/commit/2499fdb249eeffea22fa01c2f0fb12defe812e4a), [`1dacd47`](https://github.com/LTplus-AG/ifc-lite/commit/1dacd47008744f1f9de48ab20aa4d871c4572ee7), [`5a40ad8`](https://github.com/LTplus-AG/ifc-lite/commit/5a40ad89723df2dca70248c5caaba6d402ffc762), [`8a0a03a`](https://github.com/LTplus-AG/ifc-lite/commit/8a0a03a4f9e4ca9cfae457493f0eb50268052ecb), [`73070c2`](https://github.com/LTplus-AG/ifc-lite/commit/73070c2d67c2a0507e6bc5492c090f2df3736881), [`73070c2`](https://github.com/LTplus-AG/ifc-lite/commit/73070c2d67c2a0507e6bc5492c090f2df3736881), [`2e2f65a`](https://github.com/LTplus-AG/ifc-lite/commit/2e2f65a66e1375ef6cc52b8a310526de1a36e1a0), [`09745f0`](https://github.com/LTplus-AG/ifc-lite/commit/09745f0f3bb99ac07802ae061f13df92e865683f), [`5a8dd4e`](https://github.com/LTplus-AG/ifc-lite/commit/5a8dd4e9cbe8ca1f3f7fc4c78a0badc84e8d75d3), [`f04a972`](https://github.com/LTplus-AG/ifc-lite/commit/f04a97289d3130a1d7dc9df056c8b9c5b6d25791), [`3474bb6`](https://github.com/LTplus-AG/ifc-lite/commit/3474bb6e8be907d6bd1fa58652addf5728bfdee7), [`ed524ea`](https://github.com/LTplus-AG/ifc-lite/commit/ed524ea7e7efe8e22099b82677f580a3bcc1bb51), [`fe3070c`](https://github.com/LTplus-AG/ifc-lite/commit/fe3070cfb18853dd857554615160806a607dbae2), [`1bb0fe3`](https://github.com/LTplus-AG/ifc-lite/commit/1bb0fe34c8fc46acef6e51f3792f274e1e5be1b9), [`b92dd05`](https://github.com/LTplus-AG/ifc-lite/commit/b92dd05495094a47c4a68eb1137a3a1906fc65cc), [`525cfba`](https://github.com/LTplus-AG/ifc-lite/commit/525cfba75d3e124d3dae51134cb43a87c258a8d9)]:
  - @ifc-lite/ai@0.2.0
  - @ifc-lite/bcf-api@0.3.0
  - @ifc-lite/mutations@3.2.0
  - @ifc-lite/sdk@9.1.0
  - @ifc-lite/sandbox@2.11.0
  - @ifc-lite/extensions@0.11.0
  - @ifc-lite/flow@0.6.0
  - @ifc-lite/export@4.10.0
  - @ifc-lite/data@6.2.0
  - @ifc-lite/documents-api@0.2.1

## 0.6.0

### Minor Changes

- [#6618](https://github.com/LTplus-AG/ifc-lite/pull/6618) [`b13abd0`](https://github.com/LTplus-AG/ifc-lite/commit/b13abd0ef9f6419050f7a2496aa6874a02ef0276) Thanks [@louistrue](https://github.com/louistrue)! - Add portable Flow v2 local file slots and viewer-hosted session automation nodes for checks, retained report documents and PDF artifacts. Refuse missing automation services before headless execution.

### Patch Changes

- Updated dependencies [[`e8ced94`](https://github.com/LTplus-AG/ifc-lite/commit/e8ced940d5cd6c9789f1221c5aeb7cdae883da3b), [`b13abd0`](https://github.com/LTplus-AG/ifc-lite/commit/b13abd0ef9f6419050f7a2496aa6874a02ef0276), [`93098dc`](https://github.com/LTplus-AG/ifc-lite/commit/93098dcb7f4125326db5d602977c5b3f9e9083cb), [`7780cb0`](https://github.com/LTplus-AG/ifc-lite/commit/7780cb05878c574ebd2a9f631ca6757233e845d3), [`e8ced94`](https://github.com/LTplus-AG/ifc-lite/commit/e8ced940d5cd6c9789f1221c5aeb7cdae883da3b), [`4c0ebf2`](https://github.com/LTplus-AG/ifc-lite/commit/4c0ebf24c8c7b8470602300d56f0b1bd7c2a01e0)]:
  - @ifc-lite/sdk@9.0.0
  - @ifc-lite/flow@0.5.0
  - @ifc-lite/mutations@3.1.0
  - @ifc-lite/sandbox@2.10.0
  - @ifc-lite/export@4.9.0

## 0.5.1

### Patch Changes

- Updated dependencies [[`8901816`](https://github.com/LTplus-AG/ifc-lite/commit/8901816fa9171b1af0a9af5036105db0fa72cb24), [`48e64d4`](https://github.com/LTplus-AG/ifc-lite/commit/48e64d44d418c913860c21e457d9053690ebd66c), [`28ae5b0`](https://github.com/LTplus-AG/ifc-lite/commit/28ae5b0bf1ce37fd592651113f3e765caa980291), [`bffa875`](https://github.com/LTplus-AG/ifc-lite/commit/bffa875a07ed2b4e3e61e12bc25966278f346d6a), [`7b2f0f9`](https://github.com/LTplus-AG/ifc-lite/commit/7b2f0f9d8bf403bb5e7728498282e7565127b249), [`84cd157`](https://github.com/LTplus-AG/ifc-lite/commit/84cd157d5afe30572481bd3c2b96a57c92dbbe19), [`438f9f8`](https://github.com/LTplus-AG/ifc-lite/commit/438f9f89c86ee8d36fc51aa6affa1c400d0657b4), [`632d6f1`](https://github.com/LTplus-AG/ifc-lite/commit/632d6f1195453b76cc29c4ca3a0f1a7e743bd653), [`fe7f513`](https://github.com/LTplus-AG/ifc-lite/commit/fe7f5130cb1d1d84a694b98f11b734d9ed74e28e), [`1edec99`](https://github.com/LTplus-AG/ifc-lite/commit/1edec99fb723acf61863cb6cf30d480dcb69786f), [`c34a4b3`](https://github.com/LTplus-AG/ifc-lite/commit/c34a4b32795eaeaa76e35e5b26c6140b05c230c2), [`09c1970`](https://github.com/LTplus-AG/ifc-lite/commit/09c19701c4373bdda931b52d86fb4c910cfc6e2e), [`a52b5b6`](https://github.com/LTplus-AG/ifc-lite/commit/a52b5b6d7da9a4184e9d4a7d80cdebd16f457161), [`0476281`](https://github.com/LTplus-AG/ifc-lite/commit/0476281b0476ec65564e65b6fc7cfe729a3982bb), [`1eb821b`](https://github.com/LTplus-AG/ifc-lite/commit/1eb821b9e6223fdf0243d3ad3dd7e0ca14e84e13), [`b8b8c8f`](https://github.com/LTplus-AG/ifc-lite/commit/b8b8c8fd231df458c1a1af411c98c6d8ee316b77), [`0f52c72`](https://github.com/LTplus-AG/ifc-lite/commit/0f52c72f1ff739ba9f8dc061e45223e9a1307761), [`efc652c`](https://github.com/LTplus-AG/ifc-lite/commit/efc652c475f71b0d884d5c746b3156516618d1e3), [`c94feac`](https://github.com/LTplus-AG/ifc-lite/commit/c94feacf6684a27b99876cc48f1e569bc98d09d2), [`0943da2`](https://github.com/LTplus-AG/ifc-lite/commit/0943da2a068efd24847cdb1282a4c55f766563e4)]:
  - @ifc-lite/data@6.1.0
  - @ifc-lite/export@4.8.0
  - @ifc-lite/mutations@3.0.0
  - @ifc-lite/sdk@8.0.0
  - @ifc-lite/query@2.5.2
  - @ifc-lite/sandbox@2.9.0
  - @ifc-lite/extensions@0.10.1
  - @ifc-lite/flow@0.4.1

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
