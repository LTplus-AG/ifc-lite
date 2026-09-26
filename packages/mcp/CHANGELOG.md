# @ifc-lite/mcp

## 0.22.0

### Minor Changes

- [#5935](https://github.com/LTplus-AG/ifc-lite/pull/5935) [`dff671e`](https://github.com/LTplus-AG/ifc-lite/commit/dff671efe29d9bbc4a1f455fc6b0526d85fb461b) Thanks [@louistrue](https://github.com/louistrue)! - Add OpenCDE Documents API flow nodes and `model.openFromSource` ([#5634](https://github.com/LTplus-AG/ifc-lite/issues/5634), [#5167](https://github.com/LTplus-AG/ifc-lite/issues/5167) phase 3.4).
  
  `@ifc-lite/flow-nodes` gains `documents.queryVersions` (polls `POST /document-versions` with the previous ETag; outputs a versions table, the new ETag and `changed`, which is `false` on a 304), `documents.download` (downloads a version's file as base64 with its name, size and content type) and `model.openFromSource` (opens downloaded bytes as a model through the new optional `FlowHost.openModel`, gated by the `openModel` backend feature). Every Documents API request goes through `coreNetworkRequest` with the graph's `network.fetch:<host>` grants; the bearer token param takes `{{secret:NAME}}`. `model.select` and `model.byType` gain an optional `modelId` input, so a read can be wired to run after, and on, an opened model.
  
  `@ifc-lite/sandbox`: `coreNetworkRequest` accepts `responseType: 'bytes'` and then returns the capped body as `NetworkResponse.bytes`, unmangled by a text decode. A new `allowNotModified: true` option returns a 304 Not Modified as a response; without it a 304 is still refused like every other 3xx, so existing `http.request` and `bim.network.fetch` behaviour is unchanged.
  
  `ifc-lite flow run` (`@ifc-lite/cli`) and MCP's `run_flow` (`@ifc-lite/mcp`) implement `openModel` with their own loaders: the opened model becomes the one the rest of the run (and the CLI's `--out`) works on, and MCP registers it for later tool calls. The viewer loads it through `addModel`, the same path as a dropped file.

### Patch Changes

- Updated dependencies [[`a51dd3d`](https://github.com/LTplus-AG/ifc-lite/commit/a51dd3de40b0921f552d0c4a8ba8b9195511d114), [`f64353f`](https://github.com/LTplus-AG/ifc-lite/commit/f64353f10fb643a664a9f3f485ef009b1d2622f8), [`66f3d7e`](https://github.com/LTplus-AG/ifc-lite/commit/66f3d7eb085e77a27e4a0bae096daa70b43620c9), [`dff671e`](https://github.com/LTplus-AG/ifc-lite/commit/dff671efe29d9bbc4a1f455fc6b0526d85fb461b), [`f34299c`](https://github.com/LTplus-AG/ifc-lite/commit/f34299ca63a368dbaa68ad911f628eabb49dbcde), [`96b0404`](https://github.com/LTplus-AG/ifc-lite/commit/96b04045f0f3708a453ed18f23c54a1a0745ed42), [`43f40a1`](https://github.com/LTplus-AG/ifc-lite/commit/43f40a12c9bad0cc3515819b204a9b41339367dc), [`d85e898`](https://github.com/LTplus-AG/ifc-lite/commit/d85e8980fcebe59a2b6886b117056790023cb81b)]:
  - @ifc-lite/flow-nodes@0.5.0
  - @ifc-lite/bcf@5.0.0
  - @ifc-lite/mutations@2.8.0
  - @ifc-lite/create@3.1.0
  - @ifc-lite/export@4.7.4
  - @ifc-lite/clash@2.4.2
  - @ifc-lite/sdk@7.1.3
  - @ifc-lite/rules@0.4.1

## 0.21.0

### Minor Changes

- [#5446](https://github.com/LTplus-AG/ifc-lite/pull/5446) [`e40213f`](https://github.com/LTplus-AG/ifc-lite/commit/e40213f0806bf40fcbd1a93bce68fb7ad791bcef) Thanks [@louistrue](https://github.com/louistrue)! - Add outbound network requests and environment secrets to flow graphs ([#5167](https://github.com/LTplus-AG/ifc-lite/issues/5167) phases 3.3/3.5), deny-by-default throughout.
  
  `@ifc-lite/extensions` gains a `secret` capability scope: `secret.read:<NAME>` grants a graph read access to one named env var, with a strict exact-match target (`[A-Z][A-Z0-9_]*`, no glob, no universal wildcard) — the one capability target grammar stricter than the general pattern grammar.
  
  `@ifc-lite/sandbox` gains `bim.network.fetch`, gated by a new `network` permission (off by default) plus an exact-host allow-list re-checked on every call against the running graph's actual `network.fetch:<host>` grants. Requests are restricted to `https:`, matched against `new URL(url).hostname` (never the raw URL string, so userinfo/suffix spoofing is rejected by construction), refuse every redirect, cap the response body mid-stream, enforce a combined timeout/abort signal, and strip `Host`/`Cookie`/hop-by-hop headers. The core request logic (`network-request.ts`) is the single implementation shared by the sandbox bridge and the new `HttpRequest` flow node.
  
  `@ifc-lite/flow-nodes` gains the `http.request` node and a `secrets.ts` module: a node param may reference `{{secret:NAME}}`, validated against the graph's declared `secret.read:<NAME>` capabilities and the real environment BEFORE a run starts (an undeclared or unset reference is a validation error, never a silently empty string), then substituted into a throwaway copy of the document. Every resolved secret at least 6 characters long is redacted (`<secret:NAME>`) from run logs, node outputs, and errors — applied at the outer boundary, so a secret that comes back inside a fetched response body is still caught.
  
  Secrets resolve from `process.env` ONLY in `ifc-lite flow run` (`@ifc-lite/cli`) and MCP's `run_flow` (`@ifc-lite/mcp`), which now also redact their `--json`/tool-result output. The viewer's `HostFeatures.secrets` stays always-empty (the browser has no `process.env`), so a graph referencing a secret is reported `unavailable` before it runs, not mid-run; `HostFeatures.network` is `true` there too, so `http.request` runs subject to the browser's own CORS enforcement, surfacing a blocked cross-origin request as an explicit CORS-likely error rather than a silent empty result.
  
  `@ifc-lite/flow` now owns the `{{secret:NAME}}` grammar (`referencedSecrets`, `replaceSecretRefs`), and `checkAvailability` reports a node whose params reference a secret the host lacks as `unavailable`, so `flow validate` no longer calls such a graph runnable.

- [#5934](https://github.com/LTplus-AG/ifc-lite/pull/5934) [`356e151`](https://github.com/LTplus-AG/ifc-lite/commit/356e151813f37be4ceaf8699251be09c1149ffca) Thanks [@louistrue](https://github.com/louistrue)! - `entity_create` accepts an optional `global_id`, the MCP counterpart of the `GlobalId` the in-store builders and `bim.store.add*` take. It is validated as a 22-character IFC GUID, applies to IfcRoot subtypes only (written to attribute 0), and a GlobalId already carried by an entity in the model (parsed or created this session) is refused with `INVALID_INPUT` instead of authoring a duplicate.

### Patch Changes

- [#5945](https://github.com/LTplus-AG/ifc-lite/pull/5945) [`ccc491e`](https://github.com/LTplus-AG/ifc-lite/commit/ccc491efac18ce496af47c91b1ef4fc04ebecca5) Thanks [@louistrue](https://github.com/louistrue)! - `@ifc-lite/data` builds for the browser again. 5.3.0 exported `readPackageVersion` and `UNKNOWN_VERSION` from the package root with a static `node:fs` import, so every Vite app that bundles `@ifc-lite/data` failed its production build on `"readFileSync" is not exported by "__vite-browser-external"` ([#5767](https://github.com/LTplus-AG/ifc-lite/issues/5767)). Both now live on a Node-only subpath, `@ifc-lite/data/node`, and are no longer exported from the root (breaking: import them from `@ifc-lite/data/node`). `@ifc-lite/cli` and `@ifc-lite/mcp` import from there. A test bundles the package root for the browser and fails on any Node builtin reaching it.
- Updated dependencies [[`ca5ff8d`](https://github.com/LTplus-AG/ifc-lite/commit/ca5ff8d98979cbcadd1644e32ddad4990d178eb4), [`7fae2b8`](https://github.com/LTplus-AG/ifc-lite/commit/7fae2b8b2d6264a90af3235d95e0a4f6c257b9d7), [`bf32c6a`](https://github.com/LTplus-AG/ifc-lite/commit/bf32c6a128d9ce1c8d9d2a0efcfe7f8754c3d01c), [`d376d2c`](https://github.com/LTplus-AG/ifc-lite/commit/d376d2c02ff35ea25efca5983626fa0b8073bc90), [`f947f8e`](https://github.com/LTplus-AG/ifc-lite/commit/f947f8e92e23535fe4e6ba21c2ebd2a854540ce5), [`e095908`](https://github.com/LTplus-AG/ifc-lite/commit/e0959083fa58854ce536c0a68d7b0c52f824f5ef), [`d83d9fe`](https://github.com/LTplus-AG/ifc-lite/commit/d83d9fe4138e0d6ae64a3ed439c8a5c9a280878a), [`91b1340`](https://github.com/LTplus-AG/ifc-lite/commit/91b1340bbba42abc42d9842169e422b540aa96eb), [`dcdc8df`](https://github.com/LTplus-AG/ifc-lite/commit/dcdc8dff3ea9e0588ffcce802b0f3ec781082f2e), [`ccc491e`](https://github.com/LTplus-AG/ifc-lite/commit/ccc491efac18ce496af47c91b1ef4fc04ebecca5), [`7215c2a`](https://github.com/LTplus-AG/ifc-lite/commit/7215c2a9344ede37c90680e1eb2a6c2b70c0ee3d), [`e6ebbef`](https://github.com/LTplus-AG/ifc-lite/commit/e6ebbefde52670adbdb0c35bc19baed0453ca42f), [`e40213f`](https://github.com/LTplus-AG/ifc-lite/commit/e40213f0806bf40fcbd1a93bce68fb7ad791bcef), [`a2e5d2d`](https://github.com/LTplus-AG/ifc-lite/commit/a2e5d2d9aa578efeb6d3becdc94335650b89f67d), [`5c02af8`](https://github.com/LTplus-AG/ifc-lite/commit/5c02af8b7fda4d2fe53f79d3f00b9d192fc664d9), [`42b3f21`](https://github.com/LTplus-AG/ifc-lite/commit/42b3f214290d6c7d5fb27f697ec8451b323aabd4), [`a0e1bfe`](https://github.com/LTplus-AG/ifc-lite/commit/a0e1bfe567e3a892287faa8ee3e1b3610b59511d), [`11478f7`](https://github.com/LTplus-AG/ifc-lite/commit/11478f7b7e3b530a6111874bb233fada1a36d785), [`ddebcd9`](https://github.com/LTplus-AG/ifc-lite/commit/ddebcd91b999d6304e19358f90d142cd439a420a), [`cddb321`](https://github.com/LTplus-AG/ifc-lite/commit/cddb32122c9d628b635910158a06fa5a94c0071a), [`4c7bd47`](https://github.com/LTplus-AG/ifc-lite/commit/4c7bd47e5e8c9bf62d88af6260cc6384a77e0cdf), [`a3dfacb`](https://github.com/LTplus-AG/ifc-lite/commit/a3dfacb2862d1db09267ebe52707193630c35ff7)]:
  - @ifc-lite/flow-nodes@0.4.0
  - @ifc-lite/bcf@4.2.1
  - @ifc-lite/clash@2.4.1
  - @ifc-lite/create@3.0.0
  - @ifc-lite/data@6.0.0
  - @ifc-lite/parser@9.0.0
  - @ifc-lite/rules@0.4.0
  - @ifc-lite/export@4.7.3
  - @ifc-lite/extensions@0.10.0
  - @ifc-lite/flow@0.4.0
  - @ifc-lite/ids@3.0.3
  - @ifc-lite/mutations@2.7.1
  - @ifc-lite/sdk@7.1.2
  - @ifc-lite/viewer-core@0.2.23
  - @ifc-lite/cache@3.6.1
  - @ifc-lite/collab@0.9.1
  - @ifc-lite/geometry@7.5.2
  - @ifc-lite/ifcx@4.2.1
  - @ifc-lite/query@2.5.1

## 0.20.2

### Patch Changes

- [#5586](https://github.com/LTplus-AG/ifc-lite/pull/5586) [`00d6837`](https://github.com/LTplus-AG/ifc-lite/commit/00d68371ac6ab87fafa4bc5f0add2468a7e8a398) Thanks [@louistrue](https://github.com/louistrue)! - The MCP server reports the version you can actually install. `VERSION` was the literal `'0.1.0'`, so `--version`, `--help` and the `serverInfo` block of every MCP `initialize` handshake announced 0.1.0 while the package was at 0.19.0 — in the one field a client UI puts in front of an operator.
  
  The CLI had already paid for this exact mistake (a hard-coded `'0.4.0'` that `--version` still reported at 0.22.0) and fixed it with a `readCliVersion` helper. Rather than copy that helper into a second package, it moves to `@ifc-lite/data` as `readPackageVersion`, which both already depend on, so the two shipped servers cannot drift apart on how they answer `--version`. Its behaviour is unchanged: a broken install reports `0.0.0-unknown` on stderr rather than inventing a plausible number.
- Updated dependencies [[`90221d2`](https://github.com/LTplus-AG/ifc-lite/commit/90221d2f2928e8580050ddf9c26b5165f26af183), [`e682e6d`](https://github.com/LTplus-AG/ifc-lite/commit/e682e6da5f939aeca5940a65dd1cd338955e9c0f), [`e48f59b`](https://github.com/LTplus-AG/ifc-lite/commit/e48f59b0cadf092335a84ce85b4d970e653b7d2c), [`1909a6a`](https://github.com/LTplus-AG/ifc-lite/commit/1909a6ac6b9934c8793b6e6be8f80dfece3fd44e), [`0d25941`](https://github.com/LTplus-AG/ifc-lite/commit/0d25941ceadd2d5842bcd8a3d15fc21793ecfc63), [`00d6837`](https://github.com/LTplus-AG/ifc-lite/commit/00d68371ac6ab87fafa4bc5f0add2468a7e8a398)]:
  - @ifc-lite/export@4.7.2
  - @ifc-lite/clash@2.4.0
  - @ifc-lite/create@2.9.2
  - @ifc-lite/extensions@0.9.0
  - @ifc-lite/sdk@7.1.1
  - @ifc-lite/data@5.3.0
  - @ifc-lite/flow-nodes@0.3.1
  - @ifc-lite/ids@3.0.2
  - @ifc-lite/rules@0.3.2

## 0.20.1

### Patch Changes

- [#5574](https://github.com/LTplus-AG/ifc-lite/pull/5574) [`4d19160`](https://github.com/LTplus-AG/ifc-lite/commit/4d19160676b6c9b1cb3e2d5b183486aa5c0e5450) Thanks [@louistrue](https://github.com/louistrue)! - Make model_audit score effective session entities and edited identity and names.

- [#5556](https://github.com/LTplus-AG/ifc-lite/pull/5556) [`8cf2887`](https://github.com/LTplus-AG/ifc-lite/commit/8cf288755fdf9c0c5ceefd48913b2686b84f27e7) Thanks [@louistrue](https://github.com/louistrue)! - MCP model_diff now counts created entities in authored-key collisions and follows queued retypes through the shared effective-entity iterator.
- Updated dependencies [[`2bae848`](https://github.com/LTplus-AG/ifc-lite/commit/2bae8482ffc606951ebb3626ba1910ea15630395), [`223f4d7`](https://github.com/LTplus-AG/ifc-lite/commit/223f4d71f26d074ba949f77031dc24f559da34ca), [`0576221`](https://github.com/LTplus-AG/ifc-lite/commit/0576221cbd57276bce8da8d709045e2ae398a0df), [`0f5d174`](https://github.com/LTplus-AG/ifc-lite/commit/0f5d174d2fb726536d1a3a30c7e5415603db72c0), [`579b759`](https://github.com/LTplus-AG/ifc-lite/commit/579b7590bfe79cad5689cc89ab8082f95b5d6ea3)]:
  - @ifc-lite/export@4.7.1
  - @ifc-lite/clash@2.3.3
  - @ifc-lite/data@5.2.0
  - @ifc-lite/create@2.9.1
  - @ifc-lite/parser@8.2.0
  - @ifc-lite/ids@3.0.1
  - @ifc-lite/rules@0.3.1

## 0.20.0

### Minor Changes

- [#5359](https://github.com/LTplus-AG/ifc-lite/pull/5359) [`94324e2`](https://github.com/LTplus-AG/ifc-lite/commit/94324e2a69a6cf41cf23488ccdc56b2b7d2c069f) Thanks [@louistrue](https://github.com/louistrue)! - Add `describe_flow` and `run_flow` MCP tools ([#5167](https://github.com/LTplus-AG/ifc-lite/issues/5167) Phase 4.3): agents can now discover and execute a `.flow.json` graph headlessly through MCP, exactly as `ifc-lite flow run` does. `describe_flow` returns a graph's declared inputs/outputs with types and registry-aware wiring diagnostics (`validateFlowWiring`, not just the registry-free `parseFlowDocument`) without throwing on an invalid graph. `run_flow` executes a graph against a loaded model, rejects `inputs` keys naming no declared parameter, and reports the run status plus a summary of tracked writes. `@ifc-lite/flow` gains `describeFlowIO`, `resolveDeclaredParam`, `unknownInputKeys`, and `declaredInputKeys` — the introspection/input-validation helpers now shared between `@ifc-lite/cli`'s `flow` command and the new MCP tools, so the two callers cannot independently drift on what counts as a declared parameter.

- [#5288](https://github.com/LTplus-AG/ifc-lite/pull/5288) [`82fffa3`](https://github.com/LTplus-AG/ifc-lite/commit/82fffa36637e14c9457b631e3e9aa9599c410c5b) Thanks [@louistrue](https://github.com/louistrue)! - The MCP input validator now enforces `anyOf`, which it previously accepted in the schema type and documented as supported but never read, and its error names what each branch wanted. `entity_set_property`, `entity_delete_property`, `entity_set_attribute` and `entity_delete` use it to declare their existing `global_id`-or-`express_id` requirement, so a call missing both is rejected at validation instead of inside the handler. `required` is now also honoured on a schema that declares no `properties`, and treats a `null` value as missing (handlers read null and absent alike). An `anyOf` branch no longer matches on the strength of its own defaults. `oneOf`, documented but equally unimplemented and used by no schema, is removed from the doc comment and from the exported `JsonSchema` type (a type-surface removal, hence minor: a consumer reading `schema.oneOf` now sees `unknown`).
  
  `tools/list` does not publish a root-level `anyOf`: the Anthropic Messages API rejects a tool `input_schema` with a root `anyOf`/`oneOf`/`allOf`, failing the whole request, so the rule is stated in the `global_id`/`express_id` descriptions and enforced server-side. A call naming neither id (or only a null one) was already bound to fail in the handler; it now fails at validation, with the same `INVALID_INPUT` code. A `null` passed for a required field is now rejected.

- [#5377](https://github.com/LTplus-AG/ifc-lite/pull/5377) [`2dd677d`](https://github.com/LTplus-AG/ifc-lite/commit/2dd677d7307d87f3b433256bd00647a2a3ee06df) Thanks [@louistrue](https://github.com/louistrue)! - `run_flow` now provides the model's entity table to flow graphs, so `table.joinByKey`'s `tag` and `property` strategies run over MCP as they do in the viewer and `ifc-lite flow run`. `HeadlessLikeBackend.getOrCreateMutationView()` is public: it is the view `bim.mutate` writes through, and a join must read the same overlay.

### Patch Changes

- [#5546](https://github.com/LTplus-AG/ifc-lite/pull/5546) [`617da29`](https://github.com/LTplus-AG/ifc-lite/commit/617da29bc17326105dd1143385c967210e529a43) Thanks [@louistrue](https://github.com/louistrue)! - Add an effective entity type-count accessor and report queued retypes under their current class in MCP model summaries, audits, and diffs.

- [#5295](https://github.com/LTplus-AG/ifc-lite/pull/5295) [`dabc489`](https://github.com/LTplus-AG/ifc-lite/commit/dabc48987aca1392685218dd31641f8dbadf9590) Thanks [@louistrue](https://github.com/louistrue)! - Every schema-specific reader of the IFC4 entity table now uses `ENTITIES_IFC4_EXPRESS`, a new `@ifc-lite/data` export ([#5204](https://github.com/LTplus-AG/ifc-lite/issues/5204)). It is `ENTITIES_IFC4` checked against the IFC4 EXPRESS schema:
  - Rows IFC4 does not declare are dropped. These are the draft alignment-extension entities such as `IfcAlignment2DHorizontal` and `IfcLinearPlacement`.
  - Attribute lists follow EXPRESS, so `IfcCartesianPointList2D`/`3D` lose the IFC4X3-only `TagList`.
  - The attribute-less defined-type rows are kept.
  
  The corrections are generated from `@ifc-lite/parser`'s EXPRESS registry by `scripts/generate-ifc4-express-corrections.mjs`, and CI checks that they are up to date. This fixes:
  - `@ifc-lite/data`: `getEntities('IFC4')`, `findEntity('IFC4', …)` and `expandTypeNamesToDescendants`, which is what the IDS auditor reads;
  - `@ifc-lite/parser`: `getAttributeNamesAcrossSchemas` / `isKnownType`;
  - `@ifc-lite/mcp`: the schema tables;
  - `@ifc-lite/export`: the subset-export attribute reader, the product/root type sets and the STEP retype re-layout. The retype re-layout could previously write a class IFC4 lacks, or a spurious `TagList` argument, into a file declaring `FILE_SCHEMA(('IFC4'))`;
  - `@ifc-lite/ifcx`: the building-element family.

- [#5260](https://github.com/LTplus-AG/ifc-lite/pull/5260) [`7ac41e9`](https://github.com/LTplus-AG/ifc-lite/commit/7ac41e9c1899763be20d4f7fa501f8b9f955ec96) Thanks [@louistrue](https://github.com/louistrue)! - Route MCP GlobalId and spatial scans through the effective entity iterator.

- [#5276](https://github.com/LTplus-AG/ifc-lite/pull/5276) [`52d30de`](https://github.com/LTplus-AG/ifc-lite/commit/52d30de0ae3fc8ef6322191bd1831483b93d485f) Thanks [@louistrue](https://github.com/louistrue)! - IDS validation of a live, edited model now validates the session's effective model instead of the file as parsed ([#5184](https://github.com/LTplus-AG/ifc-lite/issues/5184)). `createDataAccessor` takes an optional third `entityVisibility` argument (`EntityVisibilityView`). A `MutablePropertyView` satisfies it structurally, and so does a plain structured-clone snapshot. When it is supplied:
  
  - `getAllEntityIds()` and `getEntitiesByType()` enumerate through the shared `@ifc-lite/data` effective-entity accessor. A deleted entity is no longer counted, validated or reported. An entity created this session is validated under its class, and a retyped entity under its new class. `getEntitiesByType()` is the dominant path, because every specification whose applicability names an entity type resolves through it.
  - `getEntityType()` answers the same effective class. A created entity's authored attributes (Name, GlobalId, Description, …) are read from its creation payload, because it has no source bytes.
  
  Omitting the argument leaves the accessor answering for the parsed file, unchanged. Attribute and quantity edits are still not reflected. The MCP `ids_validate` tool now passes its model's mutation view.

- [#5264](https://github.com/LTplus-AG/ifc-lite/pull/5264) [`9f7dddb`](https://github.com/LTplus-AG/ifc-lite/commit/9f7dddb8ac649de09b271856ec3ba826fa034f56) Thanks [@louistrue](https://github.com/louistrue)! - Use effective entity enumeration for MCP typed and unfiltered queries.

- [#5462](https://github.com/LTplus-AG/ifc-lite/pull/5462) [`337aab4`](https://github.com/LTplus-AG/ifc-lite/commit/337aab4f4f7dbb37834502414eac69561ccae932) Thanks [@louistrue](https://github.com/louistrue)! - Honor history-free relationship endpoint edits in CLI and MCP reads.

- [#5303](https://github.com/LTplus-AG/ifc-lite/pull/5303) [`71ace41`](https://github.com/LTplus-AG/ifc-lite/commit/71ace41b0ccfde286fe7fc1074011a91c9c8d5b1) Thanks [@louistrue](https://github.com/louistrue)! - Fix `StoreEditor.removeEntity()` returning `false` and deleting nothing for a property or quantity atom the parser deferred out of `entityIndex.byId` (`deferPropertyAtomIndex: true`, the canonical example in the parsing guide), even though `StoreEditor.hasEntity()` reported that entity present. Callers that ignore the returned boolean silently kept the entity. The source-index membership test is now one shared predicate, `storeHasSourceEntity(store, expressId)` (new export), used by `StoreEditor`'s `addEntity`, `removeEntity` and `hasEntity` and by the CLI and MCP headless backends, so these checks can no longer disagree about whether an entity exists.

- [#5242](https://github.com/LTplus-AG/ifc-lite/pull/5242) [`a1a7f32`](https://github.com/LTplus-AG/ifc-lite/commit/a1a7f32bc5ecb9a9aed9432c575afa5191791737) Thanks [@louistrue](https://github.com/louistrue)! - Resolve MCP viewer GlobalIds through the live mutation overlay.
- Updated dependencies [[`77f5e16`](https://github.com/LTplus-AG/ifc-lite/commit/77f5e16e939aac5d28301c56a29c04472aa90792), [`610c3a1`](https://github.com/LTplus-AG/ifc-lite/commit/610c3a1d60c76850c2d2cc839e176f97ec0e2ca6), [`35b8b23`](https://github.com/LTplus-AG/ifc-lite/commit/35b8b238821138d6c5bc94d3ad51abf832677a88), [`8d45322`](https://github.com/LTplus-AG/ifc-lite/commit/8d45322f544ba1c3a6352303dfb048cc5d3836a6), [`dec98a2`](https://github.com/LTplus-AG/ifc-lite/commit/dec98a2c97e03e70e8b78c55bb27e87b5b4013a6), [`83284a9`](https://github.com/LTplus-AG/ifc-lite/commit/83284a947d9adb9e1ece28f9d5ee7166722be1e5), [`992f553`](https://github.com/LTplus-AG/ifc-lite/commit/992f55304ca0ec8ed5be3b4eabab429c68808a7e), [`bc22259`](https://github.com/LTplus-AG/ifc-lite/commit/bc222597e04bfa46d8fc331913615ec72d25bc64), [`32ac1f9`](https://github.com/LTplus-AG/ifc-lite/commit/32ac1f9846a5703c63ea859e5aeaf224f164db0c), [`0ddc31a`](https://github.com/LTplus-AG/ifc-lite/commit/0ddc31a0d4f321e4f4f43dd3e95572972c7937bb), [`45ddd91`](https://github.com/LTplus-AG/ifc-lite/commit/45ddd91d1cee1c261ca5f1b1d0087fb2e070690f), [`7bab13a`](https://github.com/LTplus-AG/ifc-lite/commit/7bab13af06b8d8778f6cdb513ad299e760e55074), [`809e2ba`](https://github.com/LTplus-AG/ifc-lite/commit/809e2baa4b796a91ea2a2dbd52ae29e7dd4ef5ff), [`d8f7c64`](https://github.com/LTplus-AG/ifc-lite/commit/d8f7c643703012c55a41a1e8224db6e21a0c66b3), [`e66c849`](https://github.com/LTplus-AG/ifc-lite/commit/e66c849b6a79de9691a1e70ee3b2b593c5327fa1), [`51cb84d`](https://github.com/LTplus-AG/ifc-lite/commit/51cb84d29c5d6add21d94ffd9947f7c6884f5b39), [`eb8c3d6`](https://github.com/LTplus-AG/ifc-lite/commit/eb8c3d66a8a9091aecb947ceeb2b2dcae189d533), [`52d30de`](https://github.com/LTplus-AG/ifc-lite/commit/52d30de0ae3fc8ef6322191bd1831483b93d485f), [`a250a92`](https://github.com/LTplus-AG/ifc-lite/commit/a250a928b1c8c64ac6153136772fe6c71398eee9), [`b8a9cde`](https://github.com/LTplus-AG/ifc-lite/commit/b8a9cde0a7dfe40137632bf083875961efb57c1a), [`617da29`](https://github.com/LTplus-AG/ifc-lite/commit/617da29bc17326105dd1143385c967210e529a43), [`73c0c5d`](https://github.com/LTplus-AG/ifc-lite/commit/73c0c5de3981987d6672de19cef2c64d61259277), [`074178f`](https://github.com/LTplus-AG/ifc-lite/commit/074178f651c21dacbfbec33534701a59a7e81ace), [`dabc489`](https://github.com/LTplus-AG/ifc-lite/commit/dabc48987aca1392685218dd31641f8dbadf9590), [`dabc489`](https://github.com/LTplus-AG/ifc-lite/commit/dabc48987aca1392685218dd31641f8dbadf9590), [`60f70f9`](https://github.com/LTplus-AG/ifc-lite/commit/60f70f93c9cdf9948f1a7325efb1e157a09d3a60), [`bd15b3f`](https://github.com/LTplus-AG/ifc-lite/commit/bd15b3f607f43ab47c8f4d530ed95231f802e15c), [`eebb00e`](https://github.com/LTplus-AG/ifc-lite/commit/eebb00e52719e0254d1626f791740ce7fe7489a9), [`94324e2`](https://github.com/LTplus-AG/ifc-lite/commit/94324e2a69a6cf41cf23488ccdc56b2b7d2c069f), [`2dd677d`](https://github.com/LTplus-AG/ifc-lite/commit/2dd677d7307d87f3b433256bd00647a2a3ee06df), [`46f79e3`](https://github.com/LTplus-AG/ifc-lite/commit/46f79e38649c6d78753587aeaefbf3d5bbef0d95), [`29688df`](https://github.com/LTplus-AG/ifc-lite/commit/29688df238998baea77b3fe55afe113b40c13eae), [`d6f65a0`](https://github.com/LTplus-AG/ifc-lite/commit/d6f65a009b72bef2f11c65e2b577b4d621abd0eb), [`4041f2f`](https://github.com/LTplus-AG/ifc-lite/commit/4041f2f75ae136a400e11de5c546bb136e97e8ef), [`a341dc9`](https://github.com/LTplus-AG/ifc-lite/commit/a341dc9512531a353c12d264b806a527d8de63f6), [`b9206c9`](https://github.com/LTplus-AG/ifc-lite/commit/b9206c94dceef0041dcf37e4cfe44cf09f4b4d7b), [`70ad6a7`](https://github.com/LTplus-AG/ifc-lite/commit/70ad6a7c77b73d6a04a7d842a64ce4a014451e68), [`52d30de`](https://github.com/LTplus-AG/ifc-lite/commit/52d30de0ae3fc8ef6322191bd1831483b93d485f), [`1c12066`](https://github.com/LTplus-AG/ifc-lite/commit/1c12066f096f52389277b5fce738fc7e03a5334d), [`f942fb6`](https://github.com/LTplus-AG/ifc-lite/commit/f942fb6c48ac9be1464e49fd963340835a72945d), [`79716f9`](https://github.com/LTplus-AG/ifc-lite/commit/79716f9828e4f57bedeaef66292233806b15edf7), [`d05f542`](https://github.com/LTplus-AG/ifc-lite/commit/d05f5423a7caf761f0a2e12d064d85e84355d031), [`9132f7a`](https://github.com/LTplus-AG/ifc-lite/commit/9132f7ab81939eb145e8fe1b26eb1e9048321638), [`58691b3`](https://github.com/LTplus-AG/ifc-lite/commit/58691b362d67ab87f666d76d6ee27e39d1ec45f9), [`610d7f2`](https://github.com/LTplus-AG/ifc-lite/commit/610d7f29708bb4febf7dd9a8d716a8e5e0b4dba4), [`5665917`](https://github.com/LTplus-AG/ifc-lite/commit/566591746eead289fcc5aa60258ef96b30366456), [`80c6a38`](https://github.com/LTplus-AG/ifc-lite/commit/80c6a38a3efc8783965e94d309bcc2f984cef71d), [`253cc3e`](https://github.com/LTplus-AG/ifc-lite/commit/253cc3e96ff001b3514f182a61b1be70f6a89fa5), [`253cc3e`](https://github.com/LTplus-AG/ifc-lite/commit/253cc3e96ff001b3514f182a61b1be70f6a89fa5), [`94bd946`](https://github.com/LTplus-AG/ifc-lite/commit/94bd946d7a4e9ab98c5e9a950fa6e8a8e39b5316), [`2dd677d`](https://github.com/LTplus-AG/ifc-lite/commit/2dd677d7307d87f3b433256bd00647a2a3ee06df), [`becc9dc`](https://github.com/LTplus-AG/ifc-lite/commit/becc9dc4bd33267dbe8522f788fb8936dd349b70), [`24b7921`](https://github.com/LTplus-AG/ifc-lite/commit/24b79210c442f44614d5786ff2986ee3a2b9c0d7), [`0d9cbc0`](https://github.com/LTplus-AG/ifc-lite/commit/0d9cbc0072baa634923623c6772500d57a63f412), [`685b541`](https://github.com/LTplus-AG/ifc-lite/commit/685b5414f57eec64c74e056b9b51b6b8ffe3a88f), [`71ace41`](https://github.com/LTplus-AG/ifc-lite/commit/71ace41b0ccfde286fe7fc1074011a91c9c8d5b1), [`7e8d225`](https://github.com/LTplus-AG/ifc-lite/commit/7e8d225273d3f20d727dac879e31ac4e6ce165bb), [`fc6f49c`](https://github.com/LTplus-AG/ifc-lite/commit/fc6f49c79485640073b924df86a0973c691b7a5f), [`6314cbe`](https://github.com/LTplus-AG/ifc-lite/commit/6314cbed245efb39552487307be55b6884fd0b97), [`fbda35b`](https://github.com/LTplus-AG/ifc-lite/commit/fbda35b5bbf5475fe99d85301aff728624058f8d), [`f66adb5`](https://github.com/LTplus-AG/ifc-lite/commit/f66adb5fa9a35bf4ae4a9a9e9f36e477f815ad35), [`decff6b`](https://github.com/LTplus-AG/ifc-lite/commit/decff6bc31589df65bdd8dd20e72a0b840a4be7a), [`affda87`](https://github.com/LTplus-AG/ifc-lite/commit/affda87e1b892b608d5790387a3ab3315d47ae8c), [`316c0bf`](https://github.com/LTplus-AG/ifc-lite/commit/316c0bf248ca2573cc63acf421e4ccba4c7638c7), [`24b7921`](https://github.com/LTplus-AG/ifc-lite/commit/24b79210c442f44614d5786ff2986ee3a2b9c0d7), [`07ed0dd`](https://github.com/LTplus-AG/ifc-lite/commit/07ed0ddaf4e527f1fff3704cc0d36e700fcde1a7), [`b0f3b80`](https://github.com/LTplus-AG/ifc-lite/commit/b0f3b803d70442307b6741b78b85adef976e6f63), [`1d71f36`](https://github.com/LTplus-AG/ifc-lite/commit/1d71f366e11043a80fa81055323b5118d84d213e), [`0d9cbc0`](https://github.com/LTplus-AG/ifc-lite/commit/0d9cbc0072baa634923623c6772500d57a63f412), [`9f48e65`](https://github.com/LTplus-AG/ifc-lite/commit/9f48e653f8264d303f70f47370be727ebca6049a), [`2e13572`](https://github.com/LTplus-AG/ifc-lite/commit/2e135720996f3a3d48ec830f6895ac304f69e5dd), [`621de01`](https://github.com/LTplus-AG/ifc-lite/commit/621de015a52e65493fcda331ccaf9ffcfb626a47), [`80c6a38`](https://github.com/LTplus-AG/ifc-lite/commit/80c6a38a3efc8783965e94d309bcc2f984cef71d), [`18b082f`](https://github.com/LTplus-AG/ifc-lite/commit/18b082ff95eedf847d29108726d4fee63c93057e), [`4175a1e`](https://github.com/LTplus-AG/ifc-lite/commit/4175a1e0e8b055de2a5c58288a87b84c3c85c610), [`18650b0`](https://github.com/LTplus-AG/ifc-lite/commit/18650b0c67973833f675c6b8128ab55250a47efd)]:
  - @ifc-lite/bcf@4.2.0
  - @ifc-lite/mutations@2.7.0
  - @ifc-lite/geometry@7.5.1
  - @ifc-lite/collab@0.9.0
  - @ifc-lite/data@5.1.0
  - @ifc-lite/clash@2.3.2
  - @ifc-lite/parser@8.1.0
  - @ifc-lite/ids@3.0.0
  - @ifc-lite/export@4.7.0
  - @ifc-lite/create@2.9.0
  - @ifc-lite/flow-nodes@0.3.0
  - @ifc-lite/ifcx@4.2.0
  - @ifc-lite/flow@0.3.0
  - @ifc-lite/rules@0.3.0
  - @ifc-lite/sdk@7.1.0
  - @ifc-lite/diff@0.10.0
  - @ifc-lite/viewer-core@0.2.22
  - @ifc-lite/merge@0.4.7

## 0.19.0

### Minor Changes

- [#5171](https://github.com/LTplus-AG/ifc-lite/pull/5171) [`9739441`](https://github.com/LTplus-AG/ifc-lite/commit/9739441c1d0bd36c92bd492013c141b8a8f4a990) Thanks [@louistrue](https://github.com/louistrue)! - CLI/MCP parity for `.rules.json` information-validation rule sets ([#5138](https://github.com/LTplus-AG/ifc-lite/issues/5138) PR 7b), running the same `@ifc-lite/rules` engine (`runRuleSet`) the viewer's Data Validation panel runs — no second evaluator, no parity fixture. New `ifc-lite check <model.ifc>... --rules <file.rules.json> [--format json|table] [--fail-on error|warning]`, exit `0` all pass / `1` any fail / `2` any rule error or unreadable input. `ifc-lite delivery` recipes gain an additive `rules: string[]` field (tri-state `pass`/`fail`/`error`, mirroring `ids`). New MCP tool `check_rules` wraps the same engine against every model in scope.
  
  `@ifc-lite/cache` gains `computeSourceFingerprint`/`computeSourceFingerprintFromBlob` plus `sourceModelIdentity(name, bytes)` — the single definition of the `${name}:${hex}` string a rule set's targets are matched against, shared by the CLI and the MCP tool so they cannot drift (moved from the viewer's `hooks/sourceFingerprint.ts`, review finding on [#5171](https://github.com/LTplus-AG/ifc-lite/issues/5171)): a rule set's `targets.modelFingerprints` is saved from the viewer's `FederatedModel.sourceFingerprint`, so a headless caller (the CLI, the MCP server) needs the SAME spread-sampled xxhash64 to resolve it — a SHA-256 of the full bytes, what `ifc-lite check`/`delivery` used before this fix, can never match it. `@ifc-lite/viewer` is a private, unpublished app and gets no changeset entry of its own — its import of this code moved from a local hook to `@ifc-lite/cache`, an internal refactor with no published-API surface of its own.

- [#5090](https://github.com/LTplus-AG/ifc-lite/pull/5090) [`3a2b62f`](https://github.com/LTplus-AG/ifc-lite/commit/3a2b62f2d36bfb740c3551e86e8641d7e8f596b5) Thanks [@louistrue](https://github.com/louistrue)! - Fix silent structural-analysis data loss on IFC4 → IFC2X3 conversion: `IfcStructuralLoadCase`, `IfcStructuralCurveAction` and `IfcStructuralSurfaceAction` now map to their real IFC2X3 targets (`IfcStructuralLoadGroup`, `IfcStructuralLinearAction`, `IfcStructuralPlanarAction`) instead of becoming generic `IFCPROXY` placeholders. Add `analyzeConversionLoss`/`classifyEntityTypeConversion` (`@ifc-lite/export`), a per-type schema-conversion loss report computed without attempting the export, so a type with no representation at all in the target schema is named — with its express ids and the attributes it cannot carry — instead of surfacing as an uncaught exception from the middle of a full export. `ifc-lite convert` now prints this report and refuses cleanly, before writing any file, when the source contains a type the target schema cannot represent at all. Add the missing `structural_data` MCP tool so an MCP client can read the structural analysis model, matching the CLI/SDK/viewer coverage `bim.structural` already had.

### Patch Changes

- [#5231](https://github.com/LTplus-AG/ifc-lite/pull/5231) [`b0d489e`](https://github.com/LTplus-AG/ifc-lite/commit/b0d489ea7270b84c1d373b5e340fc09ba0c798e6) Thanks [@louistrue](https://github.com/louistrue)! - Structural analysis authoring ([#5167](https://github.com/LTplus-AG/ifc-lite/issues/5167)).
  
  `@ifc-lite/create` gains in-store builders for `IfcStructuralAnalysisModel`, `IfcStructuralCurveMember`, `IfcStructuralPointConnection`, `IfcStructuralLoadGroup`/`IfcStructuralLoadCase`, `IfcStructuralPointAction` and `IfcStructuralLinearAction`, plus `IfcRelConnectsStructuralMember`, `IfcRelConnectsStructuralActivity` and `IfcRelAssignsToGroup`. Each entity owns its representation outright — nothing is shared between entities — and every build result exposes the express ids it owns.
  
  **Breaking for SDK backend implementers:** `StoreBackendMethods` now extends `StructuralStoreBackendMethods`, adding nine required members. Any external implementation of that interface stops compiling until it supplies them (the in-repo CLI, viewer and MCP backends are updated here). Nothing else in the SDK surface changed shape.
  
  `bim.store.addStructural*` reaches them through a shared `createStructuralStoreBackend` factory, wired into the CLI backend and the viewer store adapter from the same per-call resolution the cost surface uses, so an entity authored through either is visible to the next call on the other. MCP v0.1 authors through `entity_create` and refuses these explicitly.
- Updated dependencies [[`9739441`](https://github.com/LTplus-AG/ifc-lite/commit/9739441c1d0bd36c92bd492013c141b8a8f4a990), [`0eafae1`](https://github.com/LTplus-AG/ifc-lite/commit/0eafae1cb19e70828815c658a6ee3c14f9c4c8a8), [`f87bed2`](https://github.com/LTplus-AG/ifc-lite/commit/f87bed29a52610b66b3d0ee510406ce087a66621), [`bef4149`](https://github.com/LTplus-AG/ifc-lite/commit/bef41495ccdcf1dbc8e5024f633c74b44ccef137), [`04ef10f`](https://github.com/LTplus-AG/ifc-lite/commit/04ef10fef50f8e53e96430741afc27a69ebff906), [`8356b8e`](https://github.com/LTplus-AG/ifc-lite/commit/8356b8ea43968a291cb8117736bf8cb4e9c4cdfa), [`35e54fc`](https://github.com/LTplus-AG/ifc-lite/commit/35e54fc20bc8a7632b9caec26cdb820e1ee0c0b7), [`06a336d`](https://github.com/LTplus-AG/ifc-lite/commit/06a336d512fc4470cb7372b33a5f8eea2aa1c070), [`0eafae1`](https://github.com/LTplus-AG/ifc-lite/commit/0eafae1cb19e70828815c658a6ee3c14f9c4c8a8), [`3a2b62f`](https://github.com/LTplus-AG/ifc-lite/commit/3a2b62f2d36bfb740c3551e86e8641d7e8f596b5), [`b0d489e`](https://github.com/LTplus-AG/ifc-lite/commit/b0d489ea7270b84c1d373b5e340fc09ba0c798e6)]:
  - @ifc-lite/cache@3.6.0
  - @ifc-lite/create@2.8.0
  - @ifc-lite/sdk@7.0.0
  - @ifc-lite/mutations@2.6.0
  - @ifc-lite/ids@2.0.0
  - @ifc-lite/export@4.6.0
  - @ifc-lite/geometry@7.5.0
  - @ifc-lite/rules@0.2.0
  - @ifc-lite/viewer-core@0.2.21
  - @ifc-lite/ifcx@4.1.3

## 0.18.0

### Minor Changes

- [#4977](https://github.com/LTplus-AG/ifc-lite/pull/4977) [`7556ce5`](https://github.com/LTplus-AG/ifc-lite/commit/7556ce5bb330ae37d089226f28e5c3049346c0a7) Thanks [@louistrue](https://github.com/louistrue)! - `ifc-lite diff --by-content --geometry` runs the wasm mesh pass in Node (`setComputeGeometryHashes`, `geometryHashValues` / `geometryAabbValues` / `geometryVolumeValues`) and attaches world geometry hashes, bounding boxes and volumes to both files' fingerprints, promoting the comparison from `scope: 'data'` to `scope: 'both'` — so re-GUIDed elements are told apart by world geometry when their data alone is ambiguous, and moved/reshaped pairs are reported as such instead of a bare `renamed`. Skips gracefully with a stderr warning (pointing at `pnpm build:wasm:fetch`) when the wasm runtime is not built on the host, rather than failing the diff. New `--split-merge` / `--successors` flags opt into the two geometry-only detection stages, effective together with `--geometry`.
  
  `model_diff`'s `by_content` mode gains matching `split_merge` / `successors` boolean params; this server has no geometry pipeline yet, so both currently produce no claims (the engine's abstention, not an error) — the plumbing is in place for when one lands ([#4956](https://github.com/LTplus-AG/ifc-lite/issues/4956)).

- [#5009](https://github.com/LTplus-AG/ifc-lite/pull/5009) [`d38af5a`](https://github.com/LTplus-AG/ifc-lite/commit/d38af5afd36f12329fe6f33bf905d28fca65ba43) Thanks [@louistrue](https://github.com/louistrue)! - Index every schema-resolvable `IfcRelationship` subtype as an exact typed edge, expose exact inbound/outbound relationship rows through the SDK, MCP, and viewer, and allow `related()` queries for every indexed `IfcRel*` name. Bump the cache format so graphs cached before the expanded indexing are reparsed instead of silently omitting the new edge buckets. `@ifc-lite/parser` also exports `resolveEffectiveEntityRecord`, the one place a read model folds a queued retype (name-based re-layout), named and positional edits into an entity record exactly as export writes it; the CLI, MCP and viewer read surfaces use it.

- [#4967](https://github.com/LTplus-AG/ifc-lite/pull/4967) [`65ea107`](https://github.com/LTplus-AG/ifc-lite/commit/65ea107b83e3d543b410721c74195562ca50bcca) Thanks [@louistrue](https://github.com/louistrue)! - Adapters for the successor-matching work (issue [#4955](https://github.com/LTplus-AG/ifc-lite/issues/4955)). **parser**: `spatialContainerPath` (an element's nearest spatial container as a name path, never GlobalIds) and `authoredKeyValue` / `parseAuthoredKeySpec` (an authored identifier: `Tag`, or `Pset.Prop`), shared by every diff adapter so three copies cannot drift. **cli**: `diff --key-from Tag|Pset.Prop` keys the comparison on an authored identifier (`prop:<value>` where present and unique, GlobalId elsewhere, shared values refused with a warning); `--lineage-out` / `--lineage-in` write and replay the 1:k lineage; `--accept <map.json>` folds a reviewed identity map into it as `replaced`; `--lineage-out` refuses to overwrite an input model like `--identity-out` does; and a new `ifc-lite rekey <table.csv|json> --lineage F --out F [--key-column] [--policy] [--orphans]` carries an external table across a revision. Every fingerprint now carries `container`. **mcp**: `model_diff` gains `key_from` and echoes `keyProperty` / `duplicateAuthoredKeys`. **viewer**: the compare adapter accepts `keyProperty` and fills `container`; a report row compared on an authored key exports it in a `Key` column (present only when one was used, so existing CSVs are byte-identical) and never in the GlobalId column; BCF text prints `Key:` for it.

### Patch Changes

- [#5017](https://github.com/LTplus-AG/ifc-lite/pull/5017) [`55d4354`](https://github.com/LTplus-AG/ifc-lite/commit/55d43541c7dfce6006d391a5034169ea54014d5f) Thanks [@louistrue](https://github.com/louistrue)! - Expose loaded-model cost authoring through `bim.store`, wire it into the CLI headless backend, and make headless cost reads observe the active mutation overlay.

- [#4957](https://github.com/LTplus-AG/ifc-lite/pull/4957) [`ab8380e`](https://github.com/LTplus-AG/ifc-lite/commit/ab8380e6b9edf1ca1f05abf343ae6040ac8aee77) Thanks [@louistrue](https://github.com/louistrue)! - `EntityTable.getTypeName()` returns the literal string `'Unknown'`, not `null`/`undefined`, for rows it can't resolve, so `getTypeName(id) || fallback` silently kept `'Unknown'` instead of falling back — breaking element duplication on imported models ([#4933](https://github.com/LTplus-AG/ifc-lite/issues/4933)) among other call sites. Added `resolvedTypeName()` to `@ifc-lite/data` (returns `undefined` for the sentinel) and switched every affected lookup in `create`/`parser`/`cli`/`mcp` to use it.

- [#5005](https://github.com/LTplus-AG/ifc-lite/pull/5005) [`794986e`](https://github.com/LTplus-AG/ifc-lite/commit/794986e8fa5acec057429b49302274ac8046eefe) Thanks [@louistrue](https://github.com/louistrue)! - `lineageOfDiff` now classifies an identity-map alias whose reason carries the `successor:` prefix as `replaced`, instead of always `identity`, while `--lineage-in` preserves the incoming artifact's explicit relation even when its free-form reason suggests otherwise (issue [#4989](https://github.com/LTplus-AG/ifc-lite/issues/4989)). This fixes replay without rewriting valid version-1 lineage semantics. Keyed lineage sidecars now use version 2, matching keyed identity maps, so old readers refuse authored keys instead of mistaking them for GlobalIds. The CLI also persists case-insensitive `--key-from tag` as canonical `Tag`, keeping its sidecars compatible with the viewer. CLI and MCP comparisons now fall back on both revisions when an authored key collides on either side, and shared `Pset.Property` identity lookup searches every same-named property set.

- [#4963](https://github.com/LTplus-AG/ifc-lite/pull/4963) [`62a57f7`](https://github.com/LTplus-AG/ifc-lite/commit/62a57f7e991202500b2e9c3d553376f9c45fd2c5) Thanks [@louistrue](https://github.com/louistrue)! - **diff**: content matching gains a geometry-only step (issue [#4955](https://github.com/LTplus-AG/ifc-lite/issues/4955)) that pairs an element deleted and redrawn in the same place with the same shape whose data changed — the wall an authoring tool auto-renamed on redraw. Tier 1 only fires inside a (`ifcType`, `dataHash`) bucket, so a renamed redraw landed in a different bucket from its previous revision and read as an add plus a delete. The new step re-buckets the residue by (`ifcType`, world geometry hash) between tier 1 and tiers 2–3 and retires a 1:1 bucket whose bounding boxes agree as a new retiring kind, `respecified`, tier `geometry-only`, with `ContentMatch.changedComponents` naming the data slices that moved and `ContentMatch.geometryHash` carrying the shared hash. An N:N geometry bucket is reported as `ambiguous` and retires nothing. Ordering is load-bearing: run after the positional tier, a slightly moved same-data neighbour would be paired to the stranded element on weaker evidence. `identityMapFromContentMatches` mints `content-match:respecified`. Existing callers get byte-identical results wherever no such pair exists. The viewer Compare panel, the MCP `model_diff` listing order and the CLI `--by-content` hint know the new kind.
- Updated dependencies [[`873a648`](https://github.com/LTplus-AG/ifc-lite/commit/873a6481af34f1a494e9667ab1f77c3328125077), [`d38af5a`](https://github.com/LTplus-AG/ifc-lite/commit/d38af5afd36f12329fe6f33bf905d28fca65ba43), [`b399a49`](https://github.com/LTplus-AG/ifc-lite/commit/b399a49cbccc0456eae50cc50521674336632d1a), [`0100a54`](https://github.com/LTplus-AG/ifc-lite/commit/0100a544d0446d2f19b5f76f37d6dc45d31da837), [`55d4354`](https://github.com/LTplus-AG/ifc-lite/commit/55d43541c7dfce6006d391a5034169ea54014d5f), [`e2ca87d`](https://github.com/LTplus-AG/ifc-lite/commit/e2ca87d9b8f25be2ffeabd5843cbadc4154471c0), [`e1ace4f`](https://github.com/LTplus-AG/ifc-lite/commit/e1ace4f05a45a252d502bf72a506336185d2b157), [`9c41278`](https://github.com/LTplus-AG/ifc-lite/commit/9c412786c4fa21f4ace497e7408bad7d742bdf24), [`ab8380e`](https://github.com/LTplus-AG/ifc-lite/commit/ab8380e6b9edf1ca1f05abf343ae6040ac8aee77), [`794986e`](https://github.com/LTplus-AG/ifc-lite/commit/794986e8fa5acec057429b49302274ac8046eefe), [`6a5f3f2`](https://github.com/LTplus-AG/ifc-lite/commit/6a5f3f2ae703ce170b890f85535af846251d3ab7), [`65ea107`](https://github.com/LTplus-AG/ifc-lite/commit/65ea107b83e3d543b410721c74195562ca50bcca), [`0a62c19`](https://github.com/LTplus-AG/ifc-lite/commit/0a62c196a05fb47fc2bf6c0c083ea32ed20dd1d8), [`873a648`](https://github.com/LTplus-AG/ifc-lite/commit/873a6481af34f1a494e9667ab1f77c3328125077), [`ec114fe`](https://github.com/LTplus-AG/ifc-lite/commit/ec114fefabfd1b3a23d6a25545610652db6c5342), [`62a57f7`](https://github.com/LTplus-AG/ifc-lite/commit/62a57f7e991202500b2e9c3d553376f9c45fd2c5), [`e30b86c`](https://github.com/LTplus-AG/ifc-lite/commit/e30b86cacf142c64a3bdbf310861ac7bf12a3f1b), [`e211790`](https://github.com/LTplus-AG/ifc-lite/commit/e211790ff4d7070d908fb519652158089652dd9c), [`fc72af0`](https://github.com/LTplus-AG/ifc-lite/commit/fc72af07fab21f0359002346ae5be60e085b8a41)]:
  - @ifc-lite/query@2.5.0
  - @ifc-lite/data@5.0.0
  - @ifc-lite/parser@8.0.0
  - @ifc-lite/sdk@6.4.0
  - @ifc-lite/extensions@0.8.0
  - @ifc-lite/export@4.5.0
  - @ifc-lite/create@2.7.0
  - @ifc-lite/mutations@2.5.0
  - @ifc-lite/geometry@7.4.0
  - @ifc-lite/diff@0.9.0
  - @ifc-lite/collab@0.8.1
  - @ifc-lite/ids@1.17.4
  - @ifc-lite/ifcx@4.1.2
  - @ifc-lite/clash@2.3.1
  - @ifc-lite/merge@0.4.6

## 0.17.0

### Minor Changes

- [#4867](https://github.com/LTplus-AG/ifc-lite/pull/4867) [`e43c455`](https://github.com/LTplus-AG/ifc-lite/commit/e43c455711d4070b530436413db948fedcc34053) Thanks [@louistrue](https://github.com/louistrue)! - Expose the canonical IFC 5D cost read model and decimal evaluation through
  `bim.cost`, CLI/headless and MCP backends, MCP tools, viewer-local SDK calls,
  remote capability reporting, and the sandbox bridge.
  
  Bound public cost-evaluation precision to 1 through 10,000 significant digits
  so caller-controlled division cannot request impractical decimal output.

### Patch Changes

- Updated dependencies [[`1cc533f`](https://github.com/LTplus-AG/ifc-lite/commit/1cc533f5ca326a8d574ca5e870dfdafec7df32d0), [`35c0517`](https://github.com/LTplus-AG/ifc-lite/commit/35c0517d9779297704979131f451a4ae704bf744), [`e43c455`](https://github.com/LTplus-AG/ifc-lite/commit/e43c455711d4070b530436413db948fedcc34053), [`8733dc9`](https://github.com/LTplus-AG/ifc-lite/commit/8733dc9cb391344606b9bc59beb00a6f9d1de135), [`20bff7c`](https://github.com/LTplus-AG/ifc-lite/commit/20bff7c4069d267aa2662266b6213c3b2b406753)]:
  - @ifc-lite/bcf@4.1.0
  - @ifc-lite/clash@2.3.0
  - @ifc-lite/geometry@7.2.0
  - @ifc-lite/sdk@6.2.0
  - @ifc-lite/parser@7.0.0
  - @ifc-lite/create@2.6.0
  - @ifc-lite/export@4.3.5
  - @ifc-lite/ids@1.17.2
  - @ifc-lite/query@2.4.1

## 0.16.0

### Minor Changes

- [#4774](https://github.com/LTplus-AG/ifc-lite/pull/4774) [`7b34e97`](https://github.com/LTplus-AG/ifc-lite/commit/7b34e97f2abdc49be3eef78031d52d1107622544) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `query_entities` gains an optional `selector` input, an IfcOpenShell-style selector string (e.g. `"IfcWall, Pset_WallCommon.FireRating=2HR"`). Selector classes union with `type`/`types`; selector property comparisons and `property` narrow the result together. Reuses the SDK's `QueryBuilder.select()` (`@ifc-lite/query`'s shared translator), so it cannot read selector text differently than the CLI's `--select` flag. A selector construct outside the supported lossless subset (see the SDK/query changeset) surfaces as a clean `isError` result naming it, rather than a silently empty or partial result.
  
  Also fixes a pre-existing gap in `descriptor.filters` matching (shared with `property`/`.where()`): a `Qto_` filter previously matched zero entities even when the quantity was present, because the query backend only checked property sets, never quantity sets. It now falls back to quantity sets when no property set matches.

### Patch Changes

- [#4776](https://github.com/LTplus-AG/ifc-lite/pull/4776) [`b1f9519`](https://github.com/LTplus-AG/ifc-lite/commit/b1f95194150893d56b6955273cd540fccf2b16be) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Deduplicate `matchesPropertyFilter`: the CLI and MCP query backends each carried their own copy of this `entities()`/`query_entities` filter predicate (`packages/cli/src/property-filter-match.ts`, `packages/mcp/src/property-filter-match.ts`) — functional twins differing only in comments, with nothing enforcing they stayed identical. One of the comments claimed a "can't drift" guarantee the code never actually enforced. Both packages already depend on `@ifc-lite/query` for the helpers this function is built from, so there is now exactly one implementation, exported from `@ifc-lite/query`, that both `HeadlessBackend` (CLI) and the MCP backend import. No behavior change.

- [#4748](https://github.com/LTplus-AG/ifc-lite/pull/4748) [`36fa88e`](https://github.com/LTplus-AG/ifc-lite/commit/36fa88e8862416ac6a9f493135c6fdfca793d0eb) Thanks [@louistrue](https://github.com/louistrue)! - `bim.export.ifc()` no longer exports the whole model when an isolation filter matched nothing. The ref list carried two meanings on one argument: a non-empty array isolated to those entities, and an empty array meant "no filter, export everything". A caller whose filter matched zero entities passed the empty array and got every entity back, reported as success. That is the same null-vs-empty collapse [#4364](https://github.com/LTplus-AG/ifc-lite/issues/4364)/[#4386](https://github.com/LTplus-AG/ifc-lite/issues/4386) removed from the GLB and OBJ bindings and [#4659](https://github.com/LTplus-AG/ifc-lite/issues/4659) from the JSON-LD and STEP ones, and it is why every in-repo caller had to carry its own zero-match guard to stay safe. The viewer's MCP playground `export_ifc` had none, so `global_ids` that matched nothing staged the entire model as a download and described it as the requested subset.
  
  `refs` is now optional: omit it (or pass `undefined`/`null`) for "no isolation filter", and pass an array for an active one. An active filter that matched nothing is refused with an error instead of widened back to a whole-model export. The check lives in `ExportNamespace.ifc`, the one point every surface (CLI, MCP, playground, sandboxed scripts, viewer) reaches a STEP export through, and the absence travels down with the call: a backend now receives `undefined` for "no filter" and never an empty array. The viewer's export adapter, which needs a model id and so refuses an empty ref list, uses that to export the active model whole; the sandbox bridge keeps an omitted `entities` argument omitted rather than turning it into `[]` (`bim.export.csv()` still answers an empty list, unchanged).
  
  **Migration:** replace `bim.export.ifc([], options)` with `bim.export.ifc(undefined, options)` (or `bim.export.ifc()`), which is the same whole-model export. A call site that builds `refs` from a query keeps passing the array and now gets an error rather than the whole model when the query matched nothing. A custom `BimBackend` sees `undefined` where it used to see `[]` for an unfiltered export.
- Updated dependencies [[`e8e319f`](https://github.com/LTplus-AG/ifc-lite/commit/e8e319ff76e4dac5e0d0de3cc0a00b4d9f3c8e76), [`b1f9519`](https://github.com/LTplus-AG/ifc-lite/commit/b1f95194150893d56b6955273cd540fccf2b16be), [`f55d749`](https://github.com/LTplus-AG/ifc-lite/commit/f55d7492893406a59d86a6cba4b41a80aa2589d9), [`7b34e97`](https://github.com/LTplus-AG/ifc-lite/commit/7b34e97f2abdc49be3eef78031d52d1107622544), [`d342909`](https://github.com/LTplus-AG/ifc-lite/commit/d3429093f06cb8f5405ac9792ec2aadbcf69f140), [`7b34e97`](https://github.com/LTplus-AG/ifc-lite/commit/7b34e97f2abdc49be3eef78031d52d1107622544), [`36fa88e`](https://github.com/LTplus-AG/ifc-lite/commit/36fa88e8862416ac6a9f493135c6fdfca793d0eb)]:
  - @ifc-lite/export@4.3.3
  - @ifc-lite/query@2.4.0
  - @ifc-lite/geometry@7.0.1
  - @ifc-lite/sdk@6.0.0
  - @ifc-lite/ids@1.17.0
  - @ifc-lite/viewer-core@0.2.19

## 0.15.0

### Minor Changes

- [#4677](https://github.com/LTplus-AG/ifc-lite/pull/4677) [`4db9471`](https://github.com/LTplus-AG/ifc-lite/commit/4db9471098a42ed948c4920cce1cb71a99d60d6a) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Added `bim.structural` — a read-only query surface over the structural analysis data `extractStructuralOnDemand` already parses (analysis models, members, connections, actions/reactions, load groups, result groups). `bim.structural.data()` returns the full extraction plus `loadsTruncated`; `analysisModels()`, `members()`, `connections()`, `activities()`, `loadGroups()` and `resultGroups()` are convenience accessors over the same collections. Every consumer of `data()` — the SDK namespace, the sandbox script bridge, and both headless backends (CLI, MCP) plus the viewer's local backend — forwards `loadsTruncated` unchanged rather than defaulting it away, so a caller reading an applied load's configuration can tell a genuinely small load tree from one a reader bound (nesting depth, node budget, or a cycle guard) cut short.
  
  This is layer 3 of [#4206](https://github.com/LTplus-AG/ifc-lite/issues/4206)'s six-layer structural analysis stack (semantic extraction, the read model, this query surface). A properties-card / panel UI, geometry, and a write/round-trip serializer remain out of scope for this change.

### Patch Changes

- Updated dependencies [[`bb42608`](https://github.com/LTplus-AG/ifc-lite/commit/bb426086f8a3e07d1035f2baa3be973c41cba3e0), [`a1b2b77`](https://github.com/LTplus-AG/ifc-lite/commit/a1b2b77d7d3de6878d14e73d888e04b50295a5e2), [`b4bc7df`](https://github.com/LTplus-AG/ifc-lite/commit/b4bc7df25e9cdcd6c46f4affd289c0b3da7829fa), [`a2bc270`](https://github.com/LTplus-AG/ifc-lite/commit/a2bc270fb652466f4bd30511aa560997637ee83b), [`5a82260`](https://github.com/LTplus-AG/ifc-lite/commit/5a82260e3e0bf686851e724b24dbfa05d11d9c7c), [`6d8ebeb`](https://github.com/LTplus-AG/ifc-lite/commit/6d8ebebb7cd8722534ff1ad7817cf7a7d0191aaf), [`9b9f2df`](https://github.com/LTplus-AG/ifc-lite/commit/9b9f2df47e0b1192fe033ca36021499af532220b), [`2ecf0f0`](https://github.com/LTplus-AG/ifc-lite/commit/2ecf0f096d0f2d6079963040d3293e5964785486), [`4db9471`](https://github.com/LTplus-AG/ifc-lite/commit/4db9471098a42ed948c4920cce1cb71a99d60d6a), [`4986957`](https://github.com/LTplus-AG/ifc-lite/commit/4986957c383b88616f3807ee5fe27d41fb0380f4), [`be2fed0`](https://github.com/LTplus-AG/ifc-lite/commit/be2fed0945e7dff83e3fb5d9ba810f0b5a6339a7)]:
  - @ifc-lite/parser@6.4.0
  - @ifc-lite/export@4.3.2
  - @ifc-lite/geometry@7.0.0
  - @ifc-lite/data@4.4.0
  - @ifc-lite/query@2.3.4
  - @ifc-lite/sdk@5.1.0
  - @ifc-lite/clash@2.2.1
  - @ifc-lite/viewer-core@0.2.18
  - @ifc-lite/ids@1.16.6

## 0.14.2

### Patch Changes

- Updated dependencies [[`ec0fcfe`](https://github.com/LTplus-AG/ifc-lite/commit/ec0fcfe5cccec94b28fa1887822f0046b7522812), [`e18a434`](https://github.com/LTplus-AG/ifc-lite/commit/e18a434ec2258e474728bd9a90146486b38efedb), [`8d49593`](https://github.com/LTplus-AG/ifc-lite/commit/8d49593994df9a11b9d658397b70e9211496ce28), [`74aa364`](https://github.com/LTplus-AG/ifc-lite/commit/74aa364a14360f2af67a1902d7760b623d95c029), [`53003de`](https://github.com/LTplus-AG/ifc-lite/commit/53003de1e36a956b7f51e9dffc035218477d5d3c), [`315b5cc`](https://github.com/LTplus-AG/ifc-lite/commit/315b5cc5f2dc9b4add51c60bb891bfcf52f654da), [`5583362`](https://github.com/LTplus-AG/ifc-lite/commit/5583362ea8d7c988c84d44bf3b27c6c72fb6b798), [`4ab63cd`](https://github.com/LTplus-AG/ifc-lite/commit/4ab63cd72e374dbdc98b6f59599fb9d2050f0f85)]:
  - @ifc-lite/clash@2.2.0
  - @ifc-lite/export@4.3.0
  - @ifc-lite/collab@0.8.0
  - @ifc-lite/parser@6.2.0
  - @ifc-lite/mutations@2.3.0
  - @ifc-lite/geometry@6.0.0
  - @ifc-lite/viewer-core@0.2.17
  - @ifc-lite/ifcx@4.1.1
  - @ifc-lite/ids@1.16.3
  - @ifc-lite/query@2.3.2

## 0.14.1

### Patch Changes

- [#4364](https://github.com/LTplus-AG/ifc-lite/pull/4364) [`c952d49`](https://github.com/LTplus-AG/ifc-lite/commit/c952d497c424ec15b972d87b878b41bf0573460b) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix GLB export silently exporting the whole model when an active isolation filter matches zero elements (reachable through "Export Visible Only" after filtering the hierarchy panel's Class tab to a type present only in a federated model's other member — the [#4328](https://github.com/LTplus-AG/ifc-lite/issues/4328) scenario, for the GLB exporter specifically).
  
  `GltfOptions::isolated` (Rust) and `GeometryProcessor.exportGlb`'s `isolated` parameter (TS, across the wasm boundary) collapsed "no isolation filter" and "isolation active, zero matches" into the same empty value, so both read as "export everything". They now distinguish the two the way `packages/export/src/reference-collector.ts` and `packages/renderer/src/entity-visibility.ts` already do: `isolated: Option<Vec<u32>>` on the Rust side (`None` = no filter, `Some(ids)` = an active allowlist, empty or not), `Uint32Array | undefined` on the TS side (`undefined` = no filter, an empty array = active but matching nothing). `GLBExportDialog.tsx`'s two assemblers (from-meshes and the from-bytes/wasm fast path) both preserve this distinction end to end instead of collapsing it back to a boolean.
  
  Same-PR follow-up: `ifc-lite export --format glb`/`gltf` (`packages/cli/src/commands/export-rust-formats.ts`) and the MCP `export_glb` tool (`packages/mcp/src/tools/export.ts`) both pass an explicit empty `Uint32Array` to `exportGlb` whenever no `--type`/`type` filter is requested — under the new convention that reads as "isolation active, matches nothing" and made every unfiltered GLB export fail closed with a misleading "0 meshes" error. Both now pass `undefined` when their filter is inactive.

- [#4364](https://github.com/LTplus-AG/ifc-lite/pull/4364) [`c952d49`](https://github.com/LTplus-AG/ifc-lite/commit/c952d497c424ec15b972d87b878b41bf0573460b) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix OBJ export silently exporting the whole model when an active isolation filter matches zero elements — the OBJ twin of the GLB fix in [#4364](https://github.com/LTplus-AG/ifc-lite/issues/4364) (itself the [#4328](https://github.com/LTplus-AG/ifc-lite/issues/4328) scenario: filtering the hierarchy panel's Class tab to a type present only in a federated model's other member, then exporting "Visible Only").
  
  `ObjOptions::isolated` (Rust, `rust/export/src/obj.rs`) and the wasm `exportObj` binding (`rust/wasm-bindings/src/api/export_obj.rs`) collapsed "no isolation filter" and "isolation active, zero matches" into the same empty value via `Vec::is_empty()`, so both read as "export everything". They now distinguish the two the same way `GltfOptions::isolated` does after [#4364](https://github.com/LTplus-AG/ifc-lite/issues/4364): `isolated: Option<Vec<u32>>` on the Rust side (`None` = no filter, `Some(ids)` = an active allowlist, empty or not), `Uint32Array | undefined` on the TS side (`undefined` = no filter, an empty array = active but matching nothing) — `GeometryProcessor.exportObj` / `IfcLiteBridge.exportObj` in `packages/geometry/src`.
  
  Same-PR follow-up, mirroring the one [#4364](https://github.com/LTplus-AG/ifc-lite/issues/4364) needed for GLB: `ifc-lite export --format obj` (`packages/cli/src/commands/export-rust-formats.ts`) and the MCP `export_obj` tool (`packages/mcp/src/tools/export.ts`) both used to pass an explicit empty `Uint32Array` to `exportObj` whenever no `--type`/`type` filter was requested — under the new convention that reads as "isolation active, matches nothing" and would have made every unfiltered OBJ export fail closed with a misleading "0 meshes" error. Both now pass `undefined` when their filter is inactive.
  
  Also adds a zero-output guard to the CLI's OBJ export path, closing the asymmetry with GLB's `countGlbMeshes` defense-in-depth check: unlike `exportGlb`, the Rust OBJ exporter has no "no render geometry" error signal — it always returns a string, even a header-only one with zero vertices. `@ifc-lite/export` gains `countObjVertices` (`packages/export/src/obj.ts`), and `export-rust-formats.ts`'s OBJ branch now `fatal()`s when it comes back 0 rather than writing that small-but-non-zero-byte file as a reported success.
  
  `packages/geometry/src/index.ts`'s two isolation-semantics doc comments (added for `exportObj`, already present for `exportGlb`-adjacent code) are folded into the existing exporter docblock rather than left as a second block, to stay under `check-module-size.mjs`'s ratchet once `main`'s current budget for this file applies — no information lost, just consolidated.
- Updated dependencies [[`9a271dc`](https://github.com/LTplus-AG/ifc-lite/commit/9a271dcb19dff2f9bca72fc3505ce5a71b3e800b), [`3fdbc2b`](https://github.com/LTplus-AG/ifc-lite/commit/3fdbc2b599fad2b1c43ffe014d2bab5f8b8c576c), [`39d5158`](https://github.com/LTplus-AG/ifc-lite/commit/39d5158fd5192a14fc2552d73a531b1334831e5a), [`3a1a322`](https://github.com/LTplus-AG/ifc-lite/commit/3a1a3229412b7822438fa5dba653f6c4e1bd239f), [`7f80d53`](https://github.com/LTplus-AG/ifc-lite/commit/7f80d53d2a2c158a322ec541ce064365f3f3ca8a), [`4c9a88d`](https://github.com/LTplus-AG/ifc-lite/commit/4c9a88d80b9ba9631be97050d896b5f5834d3628), [`4c9a88d`](https://github.com/LTplus-AG/ifc-lite/commit/4c9a88d80b9ba9631be97050d896b5f5834d3628), [`dee75d8`](https://github.com/LTplus-AG/ifc-lite/commit/dee75d86d404e5a5ae15e71910704d970d2426a2), [`a53bd7f`](https://github.com/LTplus-AG/ifc-lite/commit/a53bd7fd4510b8d5c992eab26234084c5bb2387e), [`c952d49`](https://github.com/LTplus-AG/ifc-lite/commit/c952d497c424ec15b972d87b878b41bf0573460b), [`5e94b1a`](https://github.com/LTplus-AG/ifc-lite/commit/5e94b1a646d7e02c909b8835f3adf8e0bf4feb5f), [`1878436`](https://github.com/LTplus-AG/ifc-lite/commit/1878436f58d4b11b8cd69ea4d544373ca375b9eb), [`abda2d8`](https://github.com/LTplus-AG/ifc-lite/commit/abda2d8114ad17b0366f448100953d6e1972164c), [`c952d49`](https://github.com/LTplus-AG/ifc-lite/commit/c952d497c424ec15b972d87b878b41bf0573460b), [`511e488`](https://github.com/LTplus-AG/ifc-lite/commit/511e488a8de2b90f7d5f7663911873a92b3427c7), [`53c65fe`](https://github.com/LTplus-AG/ifc-lite/commit/53c65fecdac95b4c19a661be923c225d104a7be8), [`a53bd7f`](https://github.com/LTplus-AG/ifc-lite/commit/a53bd7fd4510b8d5c992eab26234084c5bb2387e)]:
  - @ifc-lite/bcf@4.0.0
  - @ifc-lite/sdk@5.0.0
  - @ifc-lite/parser@6.1.0
  - @ifc-lite/export@4.2.0
  - @ifc-lite/clash@2.1.2
  - @ifc-lite/geometry@5.0.0
  - @ifc-lite/create@2.4.0
  - @ifc-lite/extensions@0.7.0
  - @ifc-lite/data@4.2.0
  - @ifc-lite/query@2.3.1
  - @ifc-lite/viewer-core@0.2.16
  - @ifc-lite/ids@1.16.2

## 0.14.0

### Minor Changes

- [#4216](https://github.com/LTplus-AG/ifc-lite/pull/4216) [`04d7b3b`](https://github.com/LTplus-AG/ifc-lite/commit/04d7b3ba0ab64ae9e97420aa8d5c56a536272724) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Add a semantic drop census to the TypeScript parser ([#4208](https://github.com/LTplus-AG/ifc-lite/issues/4208)): every load now counts how many STEP records were scanned per class, how many entered the entity table, which classes the categoriser fell to `CAT_SKIP` for, which classes are unrecognised by the schema registry, and which `IFCREL*` classes were seen but never indexed as relationship-graph edges. The census is a pure, unit-testable computation (`buildDropCensus` in `@ifc-lite/parser`) built from counts collected during the existing single-pass categorisation, so it adds no extra scan of the file. It is always present on `store.dropCensus` after a parse — its absence, not a zero count, is what means the census did not run — and is now surfaced through `ifc-lite info` (table and `--json` output) and the MCP `model_audit` tool.
  
  Skipped classes are split into `expectedSkippedClasses` and `unexpectedSkippedClasses`, keyed on whether the class's EXPRESS inheritance chain includes `IfcRoot` (i.e. whether it carries a `GlobalId`). Geometry, placement, and style resource records (`IfcCartesianPoint`, `IfcAxis2Placement3D`, `IfcIndexedPolygonalFace`, …) have no `GlobalId`, are never `IfcRoot` descendants, and fall to `CAT_SKIP` on essentially every real IFC file — tessellated geometry alone can be the majority of a file's records. Reporting that at `model_audit`'s `warning` severity unconditionally, as the first cut of this census did, fires on every file and trains people to ignore the warning; `ifc-lite info`'s "In schema: yes" column gave no cue either, since these are all schema-known classes. `unexpectedSkippedClasses` (an `IfcRoot` descendant — something with its own identity — that still fell to `CAT_SKIP`) stays a `warning`; `expectedSkippedClasses` is now `info`. The split is derived from the schema's own inheritance chain, not a hand-maintained allowlist of class names, so it cannot drift as the schema grows and cannot silently reclassify a class that should have stayed loud.
  
  That inheritance-chain split had its own blind spot: `columnar-entity-preparation.ts`'s `RELEVANT_NON_PRODUCT_HELPERS` (`IFCMATERIAL`, `IFCSIUNIT`, `IFCCLASSIFICATION`, `IFCUNITASSIGNMENT`, and 19 other unit/material/classification/document helper classes) are retained by explicit set membership, not by `IfcRoot` descendancy — none of them reach `IfcRoot` in the schema's inheritance chain. If one were ever accidentally dropped from that set, `isRootDescendant` alone would file it under `expectedSkippedClasses` at `info` severity, worded "as expected" — indistinguishable from routine geometry noise, for the entire helper family. `buildDropCensus` now also takes `alwaysRelevantTypes` (the categoriser's own `RELEVANT_NON_PRODUCT_HELPERS` set, passed through rather than duplicated as a second hand-maintained list): a skipped class in that set now lands in `unexpectedSkippedClasses` regardless of `isRootDescendant`.
  
  `ifc-lite info`'s table output rendered `unexpectedSkippedClasses`, `expectedSkippedClasses`, and `unindexedRelClasses` but never `unknownClasses` (classes the bundled schema registry does not recognise at all — vendor extensions or a registry gap), even though the field was already in the `--json` payload. It is now rendered in the table output too; the JSON payload is unchanged.
  
  This instrument does not fix any of the drops it reveals; those are tracked as separate follow-up issues per [#4208](https://github.com/LTplus-AG/ifc-lite/issues/4208)'s scope.

- [#4250](https://github.com/LTplus-AG/ifc-lite/pull/4250) [`cabfd37`](https://github.com/LTplus-AG/ifc-lite/commit/cabfd3752d8dc221042990187669a5670be88df8) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Added `matches` (regex) to the shared property/quantity comparison operator ([#4094](https://github.com/LTplus-AG/ifc-lite/issues/4094), follow-up to [#4091](https://github.com/LTplus-AG/ifc-lite/issues/4091)). This is one of the three prerequisites [#4094](https://github.com/LTplus-AG/ifc-lite/issues/4094) names for honouring `/regex/` selector text end to end (GlobalId and `+` group support remain open); it now works everywhere `compareFilterValue` already backs `bim.query().where(...)` -- the CLI `HeadlessBackend`, the MCP backend, and the viewer's SDK adapter -- with no further plumbing, since all three already delegated to it.
  
  `expected` is a bare regex source with no `/.../ ` delimiters (the same shape `parseSelector`'s regex literal already carries), tested against `String(actual)`. It is case-sensitive and does not boolean-normalize its operands (unlike every other operator here).
  
  `expected` is caller-supplied and, via the MCP `query_entities` tool, can be agent/LLM-influenced -- `new RegExp(source).test(actual)` is not safe to run on untrusted input: a pattern like `^(a+)+$` is exponential in subject length in V8's backtracking engine (measured: a 35-character non-matching subject already exceeded 30s on a single synchronous call, which on the MCP server blocks every connected client, not just the offending query). Before compiling, a pattern is now rejected -- loudly, by throwing, not by silently returning `false` -- if it is over 200 characters, or if it contains a quantified group with another quantifier inside it (e.g. `(a+)+`), the shape this was measured against. This is a heuristic input constraint, not a proof of linear-time execution: it will reject some patterns that would in fact run fine, and it will not catch every ReDoS-capable shape (e.g. overlapping alternation like `(a|a)*`). A linear-time engine (e.g. RE2) was ruled out -- this environment cannot add a new dependency; a true wall-clock timeout was ruled out too -- `.test()` cannot be interrupted synchronously, and moving the match off the main thread is a much larger, separate change. Residual ReDoS risk from a pattern shape the heuristic does not recognise remains.
  
  A rejected or syntactically-invalid pattern now throws rather than returning `false` -- fixing an inconsistency with this repo's existing fail-loud precedent for caller-supplied input (`--limit`/`--offset` validate up front with `fatal()`). A pattern is also now compiled once and cached by its source string, rather than recompiled for every candidate entity a `where`/`--where` query evaluates.
  
  Reachable from:
  - `bim.query().where(pset, prop, 'matches', pattern)` (SDK, and every backend built on it).
  - The MCP `query_entities` tool's `property.op`.
  - `ifc-lite query --where "Pset.Prop~=pattern"` and `ifc-lite export --where "Pset.Prop~=pattern"` (new `~=` token; plain `~` still means `contains`).
  
  Not included here: `ifc-lite mutate --where` has its own separate, non-delegating comparator (`matchesFilter` in `mutate.ts`) and was left untouched; the CLI `--select`/selector flag, the MCP `selector` parameter, `bim.query().select()`, and the viewer's remaining unsupported selector constructs (`parent=`, `query:`, `+` group unions, material `Category`, GlobalId as a comparison, quantity rows through a property term) are all still open, tracked on [#4094](https://github.com/LTplus-AG/ifc-lite/issues/4094).

### Patch Changes

- Updated dependencies [[`ced8bb4`](https://github.com/LTplus-AG/ifc-lite/commit/ced8bb46c368648bd54a1bab716d049143faa036), [`b5cb19a`](https://github.com/LTplus-AG/ifc-lite/commit/b5cb19ae80610107f7b3b3914efa7234dfbe4999), [`098e241`](https://github.com/LTplus-AG/ifc-lite/commit/098e2419cac5bd72f5524c7cddfa1b4da7971696), [`f794750`](https://github.com/LTplus-AG/ifc-lite/commit/f79475055e9cfe0c7ee19a7732ded546c5a7796a), [`4c58993`](https://github.com/LTplus-AG/ifc-lite/commit/4c5899307dc1e9da62f7a827298d2eb8bb8ada47), [`e119819`](https://github.com/LTplus-AG/ifc-lite/commit/e1198197556375019c5a7820cc7c99da55e5c639), [`b0700f2`](https://github.com/LTplus-AG/ifc-lite/commit/b0700f25434d1cf1ec5f7438a8e27c09188208ec), [`12e69fe`](https://github.com/LTplus-AG/ifc-lite/commit/12e69feb363ea31fb2c3513436366b01c54251e9), [`83fb539`](https://github.com/LTplus-AG/ifc-lite/commit/83fb539395e3638eb4c72a5c0fb2c508a8746adb), [`f33ac74`](https://github.com/LTplus-AG/ifc-lite/commit/f33ac74dd0578792327f684ba5ca59f050458c65), [`92e5903`](https://github.com/LTplus-AG/ifc-lite/commit/92e59033708882e9d40eaad0cddc7aab1468d2b4), [`0581b28`](https://github.com/LTplus-AG/ifc-lite/commit/0581b28ff4cebf20de2d973b7a9b2f81dcf47275), [`85e0351`](https://github.com/LTplus-AG/ifc-lite/commit/85e0351c6bcbc350c404176e484320baa08a1366), [`6f0078b`](https://github.com/LTplus-AG/ifc-lite/commit/6f0078bc8ae697c9e6f91ae5b36546476b0fee5b), [`04d7b3b`](https://github.com/LTplus-AG/ifc-lite/commit/04d7b3ba0ab64ae9e97420aa8d5c56a536272724), [`7179a9c`](https://github.com/LTplus-AG/ifc-lite/commit/7179a9c6c2d0620f6bd3260e37b80c771697ce85), [`dbf513b`](https://github.com/LTplus-AG/ifc-lite/commit/dbf513b785f1dbc2f2dce5c173d28fd5ab65aa0c), [`637048a`](https://github.com/LTplus-AG/ifc-lite/commit/637048ad9a36c634670210bdf222c1764a2a2386), [`997ba26`](https://github.com/LTplus-AG/ifc-lite/commit/997ba26adcbc170666fc086289fd21edb78813b1), [`fc4b6ab`](https://github.com/LTplus-AG/ifc-lite/commit/fc4b6ab4a80a3bcd1a30027b45f30e25ebf2434f), [`8fbd804`](https://github.com/LTplus-AG/ifc-lite/commit/8fbd8045272e5cfdfa86518d8eeb92e8be1b1220), [`ed2a067`](https://github.com/LTplus-AG/ifc-lite/commit/ed2a067ca713b14cf0d9b658789d22f4c78c7731), [`aa73bb7`](https://github.com/LTplus-AG/ifc-lite/commit/aa73bb777ada7cec655621496401e4f8cf693a2f), [`8620be3`](https://github.com/LTplus-AG/ifc-lite/commit/8620be38be0162b7cbdbe23ae7bc924763b83612), [`1e09d1c`](https://github.com/LTplus-AG/ifc-lite/commit/1e09d1cec57a5c26e82b721a6451185c83c34eb2), [`be4fdb9`](https://github.com/LTplus-AG/ifc-lite/commit/be4fdb9ffe6995c74d3629887021c98b843beadb), [`f3efce7`](https://github.com/LTplus-AG/ifc-lite/commit/f3efce7382d9018a70740909a18ee87b043e5901), [`cabfd37`](https://github.com/LTplus-AG/ifc-lite/commit/cabfd3752d8dc221042990187669a5670be88df8), [`5a01e5a`](https://github.com/LTplus-AG/ifc-lite/commit/5a01e5abe220f21ae5233045c6e9cfc5aa37a4e3), [`49763b4`](https://github.com/LTplus-AG/ifc-lite/commit/49763b48cbc9a18d7bc8f090a3dcc1ca0dc718a2), [`7427343`](https://github.com/LTplus-AG/ifc-lite/commit/742734300487f78df8192dc6fd4126615b63b966), [`6110c0d`](https://github.com/LTplus-AG/ifc-lite/commit/6110c0d6bb0c1a96c4da4c056389ebc4dfe26631), [`be4fdb9`](https://github.com/LTplus-AG/ifc-lite/commit/be4fdb9ffe6995c74d3629887021c98b843beadb), [`b9c3aa1`](https://github.com/LTplus-AG/ifc-lite/commit/b9c3aa1b7da9b0c26742bacb6eb3c7c4b44ca80b), [`6af5d45`](https://github.com/LTplus-AG/ifc-lite/commit/6af5d455fec7cc5467fa565babd82be611242e02), [`6af5d45`](https://github.com/LTplus-AG/ifc-lite/commit/6af5d455fec7cc5467fa565babd82be611242e02), [`a6976b9`](https://github.com/LTplus-AG/ifc-lite/commit/a6976b9da44d13157533372a8def23995fcfb93f), [`591c593`](https://github.com/LTplus-AG/ifc-lite/commit/591c5938bdc4e8210c3b3158f22ecd78552bcdc2)]:
  - @ifc-lite/data@4.1.0
  - @ifc-lite/parser@6.0.0
  - @ifc-lite/query@2.3.0
  - @ifc-lite/export@4.1.0
  - @ifc-lite/ids@1.16.1
  - @ifc-lite/create@2.3.0
  - @ifc-lite/mutations@2.2.0
  - @ifc-lite/ifcx@4.1.0
  - @ifc-lite/geometry@4.4.0
  - @ifc-lite/collab@0.7.0
  - @ifc-lite/sdk@4.1.0
  - @ifc-lite/clash@2.1.1
  - @ifc-lite/extensions@0.6.1

## 0.13.1

### Patch Changes

- [#4097](https://github.com/LTplus-AG/ifc-lite/pull/4097) [`f48b803`](https://github.com/LTplus-AG/ifc-lite/commit/f48b803ee82824710b315cb768f8b02b658fa101) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Finish renaming the BCF "issues" language to "topics" across the app, docs, and package-facing text. Per the BCF-XML specification, `Topic` is the container element and `Issue` is only one `TopicType` value among several (Request, Comment, Error, Warning, Info); the previous patch fixed the BCF panel's own title, heading, empty-state copy, and topic-title placeholder, and left the rest of the product inconsistent.
  
  Remaining app-visible surfaces now fixed: the Analyze ribbon's "BCF issues" toggle button (a fourth site, alongside the command palette, main toolbar, and workspace-panel controls fixed previously), the compare panel's "Create BCF issue" affordance and "Issue for" header, the auto-created BCF project's default name (`<model>_Issues` → `<model>_Topics`, matching the BCF panel's own default), the landing-page hero animation's "Issue" step label, the MCP playground's BCF category blurb and example export path, and BCF-related copy across three in-app tours (`bcf`, `compare`, `clash`) — tour titles/descriptions plus five step titles/bodies.
  
  Docs updated to match: `docs/index.md`, `README.md`, `docs/guide/quickstart.md`, `docs/guide/bcf.md`, `docs/api/typescript.md`, and the CLI guide/reference's `bcf` examples (`--out topic.bcf`, `bcf list topics.bcf`), which also renamed the example filenames for consistency — they are illustrative only; the CLI has no default BCF filename.
  
  Also reworded now-inconsistent internal comments and JSDoc in the touched files, `@ifc-lite/bcf`'s package README and `createTopic` doc comment, `@ifc-lite/bcf-api`'s README, `@ifc-lite/sdk`'s `bim.bcf` namespace docs, `@ifc-lite/mcp`'s `bcf` tool docblock and fire-rating prompt template, and `@ifc-lite/sandbox`'s clash-to-BCF tool description — all comment/doc-only, no behavior change beyond the CLI's `bcf create` usage-message example (`--title "Issue"` → `--title "Missing door"`, matching the `--help` listing).
  
  Left deliberately unchanged: `bcfHelpers.tsx`'s `TOPIC_TYPES` list and every other real `TopicType` spec value (including the MCP `bcf` tool's `type` default and the sandbox playground's `topicType` default, both `'Issue'`), `ClashPanel`'s unrelated clash-detection "issues", GitHub issue-number references, and `registry.ts`'s `id: 'bcf'` panel key.
- Updated dependencies [[`8eb1c25`](https://github.com/LTplus-AG/ifc-lite/commit/8eb1c258fafc73bd9c83c7af95ba2feebf00fb34), [`49edb1e`](https://github.com/LTplus-AG/ifc-lite/commit/49edb1e62451fe48f799652b2ef95d0c980298d1), [`ad193bd`](https://github.com/LTplus-AG/ifc-lite/commit/ad193bd23fc97b2e7167d740c447ca87680c7c07), [`f48b803`](https://github.com/LTplus-AG/ifc-lite/commit/f48b803ee82824710b315cb768f8b02b658fa101), [`c6e4713`](https://github.com/LTplus-AG/ifc-lite/commit/c6e471329c1685e52277a8927da06c452756a4fd), [`a24b8cf`](https://github.com/LTplus-AG/ifc-lite/commit/a24b8cff9598e48c75c5f9fbebd036e72c09063e), [`90f4859`](https://github.com/LTplus-AG/ifc-lite/commit/90f4859b73f694114baec821721be498757b9c48), [`62e41d5`](https://github.com/LTplus-AG/ifc-lite/commit/62e41d57ec5a41769b91d01e35d10113de91900b), [`c7f59ce`](https://github.com/LTplus-AG/ifc-lite/commit/c7f59ce33c94d71a40db223d834cf236256a94f5), [`68c322f`](https://github.com/LTplus-AG/ifc-lite/commit/68c322f91195adcf5b206d020025e11824b80d08), [`2f2fb88`](https://github.com/LTplus-AG/ifc-lite/commit/2f2fb88cb59ef0f7ef938b3bea1afde35ceb7914), [`165ee1f`](https://github.com/LTplus-AG/ifc-lite/commit/165ee1fa486f799f59531fe332cad6bf67bd3f10), [`86c8c47`](https://github.com/LTplus-AG/ifc-lite/commit/86c8c477d96845b6564562b4209bc96b1dac878b), [`86c8c47`](https://github.com/LTplus-AG/ifc-lite/commit/86c8c477d96845b6564562b4209bc96b1dac878b), [`2f2fb88`](https://github.com/LTplus-AG/ifc-lite/commit/2f2fb88cb59ef0f7ef938b3bea1afde35ceb7914), [`2f2fb88`](https://github.com/LTplus-AG/ifc-lite/commit/2f2fb88cb59ef0f7ef938b3bea1afde35ceb7914), [`faf2946`](https://github.com/LTplus-AG/ifc-lite/commit/faf294674d88050501c3f0737cae555555b9ea5b), [`202e291`](https://github.com/LTplus-AG/ifc-lite/commit/202e291a030f1b40b120a69cb221afd8eab90e0f), [`5cbe8aa`](https://github.com/LTplus-AG/ifc-lite/commit/5cbe8aac32ee1b8871357c7dcd9c1154161322d5)]:
  - @ifc-lite/bcf@3.0.1
  - @ifc-lite/sdk@4.0.2
  - @ifc-lite/parser@5.2.0
  - @ifc-lite/geometry@4.3.0
  - @ifc-lite/export@4.0.1
  - @ifc-lite/ids@1.16.0
  - @ifc-lite/mutations@2.1.0
  - @ifc-lite/query@2.2.0

## 0.13.0

### Minor Changes

- [#3515](https://github.com/LTplus-AG/ifc-lite/pull/3515) [`0a372b7`](https://github.com/LTplus-AG/ifc-lite/commit/0a372b7f3d6cce197ef3e4772267236b570a4447) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `count_entities({ group_by: 'material' })` and `materials_list` reporting every `IfcMaterialList`-associated entity as materialless.
  
  A `MaterialData` of type `MaterialList` carries no `name` at all — the individual material names live under `.materials[]`. Both tools read `mat?.name` directly, so any entity whose material association resolved to an `IfcMaterialList` was silently bucketed as `'(no material)'` / `'(unnamed)'` instead of under a real material name, even though `ifc-lite stats`'s `computeMaterialSummary` (`packages/cli/src/commands/stats-aggregation.ts`) already resolves that case from the list's first member.
  
  Both tools now go through a shared `materialDisplayName()` helper (`packages/mcp/src/tools/util.ts`) that falls back through `.materials[]`, `.layers[]`, `.profiles[]`, and `.constituents[]` in turn. Only the `.materials[]` leg matches the CLI, and the CLI checks it before `.name` rather than after; the other three legs go beyond `computeMaterialSummary`, which names a layer/profile/constituent set only when the set itself is named.
  
  The `ifc-lite://model/{id}/materials` resource, fixed one patch earlier with a private copy of the same fallback chain, now imports this helper and drops that copy. The two function bodies were byte-identical, so the resource's output does not change; what changes is that there is one implementation left to keep correct instead of two that nothing compared.
  
  Observable change: `count_entities` and `materials_list` now report a real material name for an entity whose material is an `IfcMaterialList`, or an `IfcMaterialLayerSet` / `IfcMaterialProfileSet` / `IfcMaterialConstituentSet` that carries no set-level name of its own. All of those previously landed in the `'(no material)'` / `'(unnamed)'` bucket, so callers reading the group keys see different keys and different counts for such models.
  
  The fallback picks one name per entity, not all of them: for an `IfcMaterialList` holding several materials it reports the first member only, as the CLI does. A model that assigns a multi-material list therefore still under-reports how many distinct materials are in use, and this fix does not change that.

- [#3725](https://github.com/LTplus-AG/ifc-lite/pull/3725) [`cbbb409`](https://github.com/LTplus-AG/ifc-lite/commit/cbbb4090e357abffd57a80f874721d916188ce08) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `quantity_diff`'s group-by-storey grouping chained `model.bim.storey(e.ref)?.name ?? '(none)'`, which only falls through on null/undefined. A storey whose `Name` is present but blank (`IFCBUILDINGSTOREY('...','',...)`) or whitespace-only short-circuited the chain and was used verbatim as the group key instead of falling through to `(none)`. Same defect family as [#3515](https://github.com/LTplus-AG/ifc-lite/issues/3515) / `materialFallbackName` (`material-naming.ts`).
  
  Also exports `isBlank`/`firstNonBlank` from `@ifc-lite/mcp/browser` (the browser-safe entrypoint already re-exports the node-free kernel other in-browser MCP consumers need) so the web playground's dispatcher can reuse the same blank/whitespace-name handling instead of duplicating it.

- [#3701](https://github.com/LTplus-AG/ifc-lite/pull/3701) [`8368339`](https://github.com/LTplus-AG/ifc-lite/commit/83683393654d8c1b903f03b5c6e9e5ff111fdaf0) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `byType()`, shared by `ifc-lite query --type`, MCP's `query_entities`/`count_entities` and the viewer SDK, expanded a caller's type through a fixed nine-entry table that only aliased `*StandardCase`/`*ElementedCase` pairs. An abstract EXPRESS supertype (`IfcBuildingElement`, `IfcElement`, `IfcBuiltElement`) is never a literal STEP entity type, so that table had no row for it and the query silently answered zero on a model full of walls, slabs and columns.
  
  `@ifc-lite/data` gains `expandTypeNamesToDescendants`, a descendant-closure resolver over the bundled `ENTITIES_IFC2X3`/`ENTITIES_IFC4`/`ENTITIES_IFC4X3` tables, and `@ifc-lite/parser`'s `expandTypes` delegates to it. Both take the queried model's `schemaVersion`, and `validate`'s scanned type lists are computed per store for the same reason.
  
  Three things about the resolution are deliberate:
  
  - **It reads the file's own schema first, and the other tables only for spellings that schema does not have.** Three parts: (a) the descendants the file's own schema table declares; (b) plus names that table does not declare *at all* and that are descendants of the requested type in the table that does declare them, which is how an IFC4X3-headered file still carrying `IFCSLABSTANDARDCASE` is found (`entityIndex.byType` is keyed by the names a file contains, not by what its `FILE_SCHEMA` header claims, and re-headered files are common); (c) plus the two alias relations below. A name the file's own schema declares under a different parent is never added: buildingSMART re-parented entities between versions, so a plain union would answer `byType('IfcBuildingElement')` on an IFC4 file with reinforcing bars, `byType('IfcObject')` with the `IfcProject`, and `byType('IfcSystem')` on IFC2X3 with an `IfcZone`.
  - **Cross-schema renames and the aliased leaves resolve too.** `IfcBuildingElement` and `IfcBuiltElement` reach each other's subtypes, and `byType('IfcGeotechnicalStratum')` now finds `IfcSolidStratum`/`IfcVoidStratum`/`IfcWaterStratum`, which no bundled table declares.
  - **The expansion does not cross an `IfcRoot` branch.** Descending the whole hierarchy from `IfcRoot` or `IfcObjectDefinition` would answer with every rooted record in the file (property sets, relationships, type objects), which contradicts what the same backends answer for an unfiltered query and breaks `group_by: storey`. A type named explicitly is never gated, so `byType('IfcPropertySet')` still works.
  
  The expansion order is now the requested type followed by its descendants sorted, rather than depth-first traversal order: callers page these results with `offset`/`limit`, and traversal order would shift a caller's page whenever the generated schema tables were regenerated.
  
  `expandTypes` is a published export of `@ifc-lite/parser` and of `@ifc-lite/mcp/browser`, so its `schemaVersion` parameter is optional and `expandTypes(['IfcWall'])` still compiles. Omitted, it falls back to the union across the three bundled schemas, which finds every leaf spelling but cannot tell a re-parented entity from a real subtype. Passing the queried model's `store.schemaVersion` is what makes the answer exact, and every caller in this repository passes it.
  
  Those two packages are minor rather than patch. The signature is compatible, but the array a surviving export returns is not: `expandTypes(['IfcWall'])` answered `['IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCWALLELEMENTEDCASE']` and now answers `['IFCWALL', 'IFCWALLELEMENTEDCASE', 'IFCWALLSTANDARDCASE']`, and for an abstract supertype the set itself grows from empty to the whole closure. A consumer indexing into that array reads a different name at the same position. The old order cannot be kept — it was the nine-entry table's insertion order, and there is no table any more — so the release is labelled for what it does instead.
  
  IDS entity-facet matching is unchanged, per the buildingSMART IDS spec's no-automatic-inheritance rule (now cited in a code comment on `checkEntityFacet`).

### Patch Changes

- [#3704](https://github.com/LTplus-AG/ifc-lite/pull/3704) [`b0a6265`](https://github.com/LTplus-AG/ifc-lite/commit/b0a6265a804099b9cea7e55f26fc50825c1df07a) Thanks [@BIMvoice](https://github.com/BIMvoice)! - A model comparison did not carry an entity's classification (`IfcRelAssociatesClassification` -> `IfcClassificationReference`) in any channel at all: re-coding an element from one Uniclass group to another, with geometry and every property untouched, read as `unchanged` on `ifc-lite diff --by-content`, the MCP `model_diff` tool, and the viewer's compare panel alike — the same silent-drop shape [#1198](https://github.com/LTplus-AG/ifc-lite/issues/1198) fixed for quantity sets. `@ifc-lite/diff`'s `DataFingerprintInput` gains an optional `classifications` field (resolved reference labels, never entity references — an id is reassigned on every save), hashed the same way as the existing `materials` field: present only when the entity carries one, so an unclassified entity's fingerprint is unaffected, and exposed as its own `classification` component key for the content-matching collision guard. All three adapters now populate it.

- [#3468](https://github.com/LTplus-AG/ifc-lite/pull/3468) [`586fa29`](https://github.com/LTplus-AG/ifc-lite/commit/586fa292b69cdb3ba6e45764b4ff742b2fa7b9a9) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix queries, filters, and CSV/JSON exports that silently dropped or omitted data when an entity carried two property (or quantity) sets with the same name -- e.g. one from the type definition and one from the occurrence, which is valid IFC.
  
  Affected symptoms, now fixed:
  - MCP and CLI entity queries with a property filter (`query_entities`, `ifc-lite query --where`) could wrongly exclude a matching entity from the results, with no indication anything was omitted, when the filtered property lived ONLY on the entity's second same-named property set. (When both sets carry it, the filter still reads the first one's value -- see the closing paragraph.)
  - CSV/JSON export with a `Pset.Property` or `Qto.Quantity` column could emit an empty cell instead of the real value, for the same reason.
  - The viewer's advanced-filter query could likewise drop a matching entity from the result count/highlight.
  - `ifc-lite query`'s `--sort`, `--group-by` and `--unique` on a `Pset.Property` path, and `ifc-lite export`'s dotted columns, read only the first same-named set and so sorted, grouped, or exported a blank where a value existed.
  - Editing a quantity whose base value lived on a second same-named quantity set recorded the wrong "old value" and the wrong create-vs-update classification, which undo relied on.
  - Deleting a property or quantity set that the entity carried twice under the same name removed only the first one's members: the panel showed the whole set gone while the exported file still carried the second one's properties.
  
  All of these now scan every same-named set, not just the first, before deciding a property or quantity is absent.
  
  Which member they then use is still first-match, and that is the remaining gap: when two same-named sets both carry the property, only the first one's value is read. Emitting one cell wants exactly that, but a filter does not -- `ifc-lite query --where Pset_WallCommon.FireRating=REI60` still drops a wall whose first `Pset_WallCommon` says `REI30` and whose second says `REI60`. That behaviour predates this change and is tracked in [#3490](https://github.com/LTplus-AG/ifc-lite/issues/3490).

- [#3494](https://github.com/LTplus-AG/ifc-lite/pull/3494) [`df878b3`](https://github.com/LTplus-AG/ifc-lite/commit/df878b36fa8cf62878f25d177a15163fec354139) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `get_entities_bulk` silently ignoring `include: ['attributes']` (its own documented default): the handler checked `include` for `properties`/`quantities`/`classifications`/`materials` but never `attributes`, so the full EXPRESS attribute list `get_entity` attaches for the same request never appeared in the bulk response — no error, just a quietly incomplete payload.

- [#3783](https://github.com/LTplus-AG/ifc-lite/pull/3783) [`c1390f3`](https://github.com/LTplus-AG/ifc-lite/commit/c1390f38e32f7a345a4f2651b8a3b6d849e56af6) Thanks [@louistrue](https://github.com/louistrue)! - Fix `bim.mutate.setProperty`/`setAttribute`/`deleteProperty` silently accepting a write to an entity that is not in the model.
  
  In the headless backends (`ifc-lite run`/`eval` and the MCP session), the write methods took the express id on faith. `MutablePropertyView` created the overlay entry for it, `bim.properties()`/`bim.property()` read that overlay back and reported the edit as made, and the STEP exporter — which only ever visits entities the effective model holds — dropped it with no diagnostic. A script with a stale or mistyped express id had no point in the round trip where the mistake showed up: the obvious defensive check, reading the property back, returned a confident "it worked".
  
  `createHeadlessMutateAdapter` now takes an `EntityRefCheck` and every write method throws when the reference does not name an entity. The check runs against the **effective** model (the source store plus this session's overlay), so an id handed back by `bim.store.addEntity` is accepted and a removed one is refused, and against the **model id** as well, because the write methods forward only the express id to the backend's single overlay and a foreign model id would otherwise land as an edit to the active model. The two are reported as different failures: a missing entity names the express id and the model, an unknown model id says so and lists the ids the backend does answer for, because in that case the entity usually exists and calling it missing sends the caller after the wrong problem.
  
  The MCP mutation tools (`entity_set_property`, `entity_delete_property`, `entity_set_attribute`, and `mutation_batch` through them) do not go through `bim.mutate.*` (they write into the backend's mutation view directly), so they took `express_id` on faith and answered "Queued" for an id the export then dropped. `entity_delete` had the same hole from the other end: deleting an id nothing holds answered success with `deleted: false`, which `mutation_batch` counted as a succeeded step. All four now run the same check first and return an `ENTITY_NOT_FOUND` result naming the express id and the model. `entity_create` is the one write tool not routed through it, since it has no id to check yet.
  
  `bim.store.addEntity` and the `bim.store.add*` element helpers now refuse an unknown model id too, instead of echoing it back on the ref they mint. A ref accepted by the creator and refused by the very next write is worse than either rule alone, since the entity is already created by the time the caller finds out.
  
  **Breaking (`@ifc-lite/sdk`):** `createHeadlessMutateAdapter` takes a second, required argument, `checkRef: EntityRefCheck` (a function returning `null` for a writable reference, or the reason it is not). The parameter is required rather than optional on purpose: a backend that forgot to pass it would otherwise go back to accepting phantom writes with nothing to say it had. A new export, `createEffectiveEntityCheck({ acceptedModelIds, hasSourceEntity, overlay })`, builds the check both headless backends use, so a host adapter does not have to rediscover that the base entity index is the wrong thing to ask.

- [#3725](https://github.com/LTplus-AG/ifc-lite/pull/3725) [`cbbb409`](https://github.com/LTplus-AG/ifc-lite/commit/cbbb4090e357abffd57a80f874721d916188ce08) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `materialFallbackName` (shared by `materials_list`, `count_entities` group_by material, `query_entities`'s per-entity material label, `viewer_get_selection`'s text summary, and the `materials` resource) chained its candidates with `??`, which only falls through on `null`/`undefined`. A material whose `Name` is present but blank (`IFCMATERIAL('',$,$)`), or whitespace-only (a real shape — see [#3714](https://github.com/LTplus-AG/ifc-lite/issues/3714)), short-circuited the chain and was returned verbatim instead of falling through to the next candidate or the caller's own `(unnamed)`/`(no material)` placeholder — a blank row in a material schedule instead of a labelled unknown. Every candidate in the chain, including the layer/profile/constituent `.find()` predicates, is now checked against a blank/whitespace-only test; the function still returns `undefined` (not a hardcoded placeholder) when every candidate is absent, so each caller's own wording still applies.

- [#3519](https://github.com/LTplus-AG/ifc-lite/pull/3519) [`32c5172`](https://github.com/LTplus-AG/ifc-lite/commit/32c51722003e58947c922507bfa7457050025114) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix the `ifc-lite://model/{id}/materials` resource reporting every `IfcMaterialList`-associated entity as `'(unnamed)'`.
  
  `MaterialData.name` only exists for a plain `IfcMaterial` (and, when authored in the source file, a LayerSet/ProfileSet/ConstituentSet) — an `IfcMaterialList` never carries a list-level name at all, only `.materials[]` with the individual material names. `MaterialsProvider.read` read `mat.name` directly, so any entity whose material association resolved to an `IfcMaterialList` was silently bucketed under `'(unnamed)'` instead of its real material name(s).
  
  The resource now falls back through `.materials[]`, `.layers[]`, `.profiles[]`, and `.constituents[]` in turn. The CLI's `computeMaterialSummary` (`packages/cli/src/commands/stats-aggregation.ts`) already resolves the `IfcMaterialList` case from `.materials[0]`; the layer, profile and constituent fallbacks here go beyond what it does. Observable change: reading the `materials` resource for a model whose materials are assigned via `IfcMaterialList` (or an unnamed LayerSet/ProfileSet/ConstituentSet) now reports the real material names and counts instead of lumping those entities under `'(unnamed)'`.
  
  Note: this mirrors the same fix proposed for `count_entities`/`materials_list` in [#3515](https://github.com/LTplus-AG/ifc-lite/issues/3515) (open at the time of this patch). Once that PR's shared `materialDisplayName()` helper (`packages/mcp/src/tools/util.ts`) lands, this resource's local fallback should be replaced with it rather than kept as a second copy of the same logic.

- [#3703](https://github.com/LTplus-AG/ifc-lite/pull/3703) [`b964918`](https://github.com/LTplus-AG/ifc-lite/commit/b964918c53992b18ea3fc29be540e1ab28470371) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `bcf_topic_list`'s `status` filter using an exact, case-sensitive match against `topicStatus`. BCF status strings are conventionally Title Case (`'Open'`, `'Closed'`), but nothing tells a calling agent that, and a differently-cased filter (e.g. `'open'`) silently returned zero topics — indistinguishable from "there really are none". `@ifc-lite/bcf`'s own `computeMarkers3D` already lowercases both sides for its status filter; `bcf_topic_list` now matches that.

- [#3785](https://github.com/LTplus-AG/ifc-lite/pull/3785) [`a4a498b`](https://github.com/LTplus-AG/ifc-lite/commit/a4a498bcb84c927862ea5ffcd865465e4c3a1a5f) Thanks [@louistrue](https://github.com/louistrue)! - `count_entities` now counts BIM products on every grouping, the same universe `query_entities` returns and the CLI's `query --count` / `query --group-by type` use ([#3765](https://github.com/LTplus-AG/ifc-lite/issues/3765)). The ungrouped total and `group_by: 'type'` folded `store.entityIndex.byType` instead — every raw STEP record, so `IfcCartesianPoint`, `IfcPolyLoop` and `IfcPropertySingleValue` lines were counted as entities — while `group_by: 'storey'` and `group_by: 'material'` walked `bim.query()`. On `AC20-FZK-Haus.ifc` the same tool answered 44,249 by type and 128 by storey, and 128 is what the CLI and MCP's own `query_entities` report.
  
  **This is a behaviour change to the numbers `count_entities` returns.** An agent that read the ungrouped total as "how big is this file" now gets the product count. The raw STEP record count is unchanged and still available from `model_info` and `model_audit`, which are file-statistics tools (the MCP analogue of `ifc-lite info`) and keep `foldedTypeCounts`. The tool's description now says which universe it counts and points at `model_info` for the other one.
  
  `type` filtering, subtype expansion and the IfcPascalCase group keys are unchanged; the group keys now come from `EntityData.type`, the same field `query_entities` reports. A test asserts the three groupings and the ungrouped total agree with `query_entities` on the same fixture.
  
  The web playground's `count_entities` handler (`apps/viewer/src/components/mcp/playground-dispatcher.ts`) is a second implementation, not a caller of the one above — it re-executes the same tool client-side so the browser chat surface can run MCP tools without a server round-trip. Its `group_by: 'type'` branch had the identical bug (folding `store.entityIndex.byType`) and is fixed the same way, so the playground now agrees with the installed MCP server on the same model ([#3785](https://github.com/LTplus-AG/ifc-lite/issues/3785) review).

- [#3644](https://github.com/LTplus-AG/ifc-lite/pull/3644) [`2b594d2`](https://github.com/LTplus-AG/ifc-lite/commit/2b594d20616f957f7ef949aa8563274e5373a95b) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `model_diff` reporting a re-exported model as `modified · data` on every measure-propertied element when only the project's declared length/area/volume unit changed — the same fix as `@ifc-lite/cli`'s `ifc-lite diff --by-content`, applied to both the stored-entity and the overlay-created (`entity_create`) fingerprint paths, which this server's adapter is a documented byte-for-byte twin of.

- [#3549](https://github.com/LTplus-AG/ifc-lite/pull/3549) [`cb56282`](https://github.com/LTplus-AG/ifc-lite/commit/cb56282133a3349299665859b5507b739808d32e) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `model_diff` reporting a `Qto_` `IfcElementQuantity` (Length/Area/Volume) as `modified` when a model is re-authored in a different project length unit but no physical quantity actually changed — the same false positive `[#3458](https://github.com/LTplus-AG/ifc-lite/issues/3458)`-adjacent fix closed on the CLI's `ifc-lite diff` (see the `@ifc-lite/cli` changeset). `buildModelFingerprints`' `buildDataInput`/`createdFingerprint` now scale a Qto_ value to base SI with `quantitySiScale` (`@ifc-lite/parser`) before rounding and hashing, for both a stored and an overlay-queued quantity, keeping this adapter's fingerprints identical to the CLI's — the invariant `diff-fingerprints.test.ts`'s parity suite enforces.

- [#3513](https://github.com/LTplus-AG/ifc-lite/pull/3513) [`f326aa0`](https://github.com/LTplus-AG/ifc-lite/commit/f326aa03fd263b15b8188767520085fe635bf430) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `verifyLayerAgainstClaims` (publish-time scope verification for draft layers) now derives a `model.mutate:children` / `model.mutate:inherits` op when a published layer's node only changes its `children` or `inherits` slots, matching the CLI's `deriveScopeOps`. Previously `deriveLayerDescriptors` only walked a node's `attributes`, so a layer that reparented an entity (or changed its type inheritance) without touching any Pset/attribute produced zero ops and verified as in-scope under any claim, including one that covered nothing at all — a pure structural edit could bypass scope enforcement entirely. No shipped entry point produces such a layer today: `verifyLayerAgainstClaims` has one caller, `publish_layer`, and the only writer of the layer workspace is `draft_apply_ops`, which exposes no op that writes `children`/`inherits`. So this is a guard against a layer reaching the verifier from somewhere that does not exist yet, not the closing of a reachable bypass.

- [#3408](https://github.com/LTplus-AG/ifc-lite/pull/3408) [`89c4cf2`](https://github.com/LTplus-AG/ifc-lite/commit/89c4cf22e83d76115035f7dcbf6e34f9c06dd091) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `viewer_isolate` (and the same gap in `viewer_hide`/`viewer_show`/`viewer_colorize`) resolving a `global_id`/`global_ids`/`express_id`/`express_ids` selector by direct lookup only, with no `IfcRelAggregates` expansion. An `IfcElementAssembly` (or any other decomposition container — a wall's `IfcBuildingElementPart`s, a stair used as a container, …) carries no mesh of its own; its parts do. `packages/viewer`'s renderer keys every color/visibility override off actually-rendered mesh ids, so an unexpanded container id in `viewer_isolate` matched nothing, and every rendered entity got dimmed to near-invisible — isolating a geometry-less assembly appeared to blank the whole model. `viewer_hide`/`viewer_show`/`viewer_colorize` had the quieter version of the same bug: a silent no-op on the container id.
  
  `packages/mcp`'s viewer tools now expand any ref with `IfcRelAggregates` children into itself plus every decomposition descendant before it reaches the viewer. A plain element id with no decomposition children passes through unchanged.
  
  `@ifc-lite/data` gains `getAggregatedChildren` and `collectAggregatedDescendants`, the `IfcRelAggregates` traversal this expansion is built on — moved out of `apps/viewer`'s `utils/aggregation.ts` (which re-exports them under their existing names) so both that app and `packages/mcp` share one traversal instead of each carrying its own copy.

- [#3410](https://github.com/LTplus-AG/ifc-lite/pull/3410) [`f41116a`](https://github.com/LTplus-AG/ifc-lite/commit/f41116af2bc41b349053c0eeeff7a276e0915879) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `viewer_fly_to` resolving a `global_id`/`global_ids`/`express_id`/`express_ids` selector by direct lookup only, with no `IfcRelAggregates` expansion — the same gap already fixed in `viewer_isolate`/`viewer_hide`/`viewer_show`/`viewer_colorize`. An `IfcElementAssembly` (or any other decomposition container) carries no mesh of its own; its parts do. `packages/viewer`'s renderer computes the fly-to camera target's bounding box only from actually-rendered mesh ids, so an unexpanded container id matched nothing and the camera silently did not move.
  
  `viewer_fly_to` now expands any ref with `IfcRelAggregates` children into itself plus every decomposition descendant before it reaches the viewer, using the same `expandAssemblyRefs` helper as the other viewer tools. A plain element id with no decomposition children passes through unchanged.

- [#3532](https://github.com/LTplus-AG/ifc-lite/pull/3532) [`fc40d01`](https://github.com/LTplus-AG/ifc-lite/commit/fc40d013a739c8921aa9cd8d7d56644a6c18af6c) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `viewer_get_selection`'s text summary silently dropping the "Materials:" line for a selected entity whose material association resolves to an unnamed `IfcMaterialProfileSet` or `IfcMaterialConstituentSet`.
  
  The formatting chain in `viewer.ts` checked `.layers[]` and `.materials[]` (the `IfcMaterialList` case fixed for the `materials` resource in [#3519](https://github.com/LTplus-AG/ifc-lite/issues/3519)) before falling back to a single `mat.name ?? mat.materialName` check. A `MaterialProfileSet`/`ConstituentSet` with no set-level `Name` has neither of those, so the whole line disappeared instead of naming the member material(s) — worse than the `IfcMaterialList` case, which at least listed member names.
  
  Extracted the formatting into a new sibling module (`packages/mcp/src/tools/material-summary.ts`, `viewer.ts` sits at its module-size budget) that lists every multi-material shape (`.layers[]`, `.profiles[]`, `.constituents[]`, `.materials[]`) by member name, falling back to the set-level `Name` when the members name nothing at all (`IfcMaterialProfile.Material` is optional, so an all-unnamed set is valid IFC and its `Name` says more than a row of `?` placeholders), and reusing a new shared `materialFallbackName()` helper (`packages/mcp/src/material-naming.ts`, lifted out of `providers.ts`'s local copy from [#3519](https://github.com/LTplus-AG/ifc-lite/issues/3519)) for that last fallback. Once [#3515](https://github.com/LTplus-AG/ifc-lite/issues/3515)'s proposed `materialDisplayName()` lands in `packages/mcp/src/tools/util.ts`, this local helper should be replaced with it.

- [#3861](https://github.com/LTplus-AG/ifc-lite/pull/3861) [`adc5fab`](https://github.com/LTplus-AG/ifc-lite/commit/adc5fab7fe9208019dccf890589fb5fa5637ea63) Thanks [@louistrue](https://github.com/louistrue)! - Fix `hide()`, `show()`, `colorize()`, `colorizeAll()` and `resetColors()` doing nothing when given a geometry-less `IfcElementAssembly`, over both the SDK and the embed's postMessage bridge ([#3338](https://github.com/LTplus-AG/ifc-lite/issues/3338)).
  
  Isolation already expanded such an id to its `IfcRelAggregates` parts. Its sibling channels did not, and they fail the same way for the same reason: the renderer matches `hiddenEntities` and the mesh colour map against ids it saw on a MESH, and an assembly carries no mesh of its own. So `hide([assemblyRef])` left every part visible, `colorize([assemblyRef], red)` repainted nothing, and both reported success. The embed bridge's `HIDE`, `SHOW` and `SET_COLORS` commands had the identical gap.
  
  All of them now route through the shared expansion policy, which moved from `lib/isolation/resolveIsolationIds.ts` to `lib/presentation/resolvePresentationIds.ts`. The old name was part of the problem: a `hide` handler author reading "isolation ids" concludes the module is not theirs and hand-rolls the id list, which is exactly the "one call site every channel must remember to use" failure [#3338](https://github.com/LTplus-AG/ifc-lite/issues/3338) is about. The colour channel gets `resolvePresentationColorMap`, which keeps each id paired with its own colour, calls the resolver once per distinct colour rather than once per id, and lets an explicitly named part outrank the colour it would inherit as some assembly's part.
  
  On the MCP side the same expansion moved from the five viewer tools that each remembered to call it into the one `resolveTargetRefs` they all share, so a sixth tool gets it by construction. No behaviour change there.
  
  One consequence worth knowing when scripting: because `colorize` now paints an assembly's parts, `resetColors([assemblyRef])` clears those parts' colours whoever set them — including a colour an earlier, independent `colorize([partRef])` applied. The adapter keeps a flat id-to-colour map with no record of which call wrote each entry, so it cannot tell the two apart. Reset by part rather than by assembly where that matters.

- [#3782](https://github.com/LTplus-AG/ifc-lite/pull/3782) [`a1069f8`](https://github.com/LTplus-AG/ifc-lite/commit/a1069f8f096fcfc5771200a2748466096c3463d5) Thanks [@louistrue](https://github.com/louistrue)! - Fix `RelationshipGraphBuilder.addEdge` double-counting a relationship that a file declares twice.
  
  Nothing in EXPRESS forbids two `IfcRel*` instances from naming the same (relating, related) pair — two `IfcRelContainedInSpatialStructure` records can re-relate the same element to the same storey, and `IfcRelDefinesByProperties` carries only a `NoRelatedTypeObject` WHERE rule. The builder pushed both edges, so every consumer that walks the raw edge list saw the target twice: `store.spatialHierarchy.byStorey` listed the element twice, the viewer's generated schedule reported one product too many, and `SpatialHierarchy.parquet` emitted a duplicate row (which a `GROUP BY` in an external BI tool inherits).
  
  `addEdge` now folds a repeat of a `(source, target, type)` triple into the surviving edge instead of dropping it: the first instance's express id becomes `relationshipId`, later repeats are kept on `shadowedRelationshipIds`. Edges that differ in source, target, or type are untouched. The parser's on-demand property/quantity/classification/document maps — which a query reads in preference to the graph — now dedup the same way, so a redundant `IfcRel*` no longer duplicates a pset, qset, classification, or document either. `onDemandMaterialMap` is deliberately left as-is: `buildMaterialUsageIndex` already dedupes per (material, entity) downstream via its own `seenPerMaterial` set, a contract pinned by `material-fraction-and-associations.test.ts` (`onDemandMaterialMap.get(100)` for two redundant `IfcRelAssociatesMaterial` records is expected to equal `[300, 300, 999]`, not `[300, 999]`) — deduping upstream too would duplicate that work, not fix a gap.
  
  `shadowedRelationshipIds` is stored on the wire as three small, Transferable typed arrays (`shadowedEdgeIndex`/`shadowedGroupOffsets`/`shadowedRelIds`) rather than one slot per edge, because the obvious dense shape structured-clones (instead of transferring) across the parser worker boundary — measured +1.2s / +190MB on a 12M-edge model for a field that's empty on almost every edge. The fields are optional on `RelationshipEdges`/`RelationshipEdgesColumns`: absent entirely on a graph that tracks no duplicates, read via `?.`.
  
  Four places needed the extra ids, not just the deduped edge itself:
  - `related()` in both the CLI and MCP backends now treats a connection as alive as long as any one of `relationshipId` or `shadowedRelationshipIds` still exists (via a shared `edgeSurvives` helper), so deleting the surviving `IfcRel*` doesn't erase a connection a sibling instance still names.
  - `getRelationshipsBetween` reports `shadowedRelationshipIds` on each `RelationshipInfo`.
  - `Relationships.parquet` and the DuckDB `relationships` table (via a shared `flattenRelationshipEdges` helper) and the anonymized-subset exporter's `collectRelatedEntities` all emit one row/closure entry per shadowed id too, not just the survivor — each is a real STEP record in the source file.
  - The on-disk model cache (`@ifc-lite/cache`, FORMAT_VERSION 17 -> 18) persists the shadowed-id columns, so a model reloaded from cache gets the same delete-then-query behavior as a fresh parse. A v17 cache entry (written before this change) is read as having no shadowed ids rather than being treated as corrupt — matches the pre-fix in-memory behaviour exactly, since those graphs never tracked them either — and the cache lookup key already embeds `FORMAT_VERSION`, so an old entry simply misses and re-parses on next load.
  
  `Relationships.parquet` also drops a row whose own `IfcRel*` record has been deleted through the overlay, not only rows whose source or target endpoint was — an `IfcRel*` line is a row in `Entities.parquet` too, so a `RelId` for a deleted one was a dangling reference. Because each shadowed id is its own row, a deleted survivor drops while a live sibling keeps the connection, matching `edgeSurvives`.
  
  One consequence to note: `Relationships.parquet` is still built from the deduped graph, so a redundant second `IfcRel*` instance appears as its own row again (via `shadowedRelationshipIds`) rather than being silently dropped — every `IfcRel*` record that backs a surviving edge appears at least once, including deduplicated duplicates. (Not a 1:1 row-to-record count: a deleted endpoint still drops rows, and one `IfcRel*` with N `RelatedObjects` has always produced N rows, one per target — unchanged by this fix.)

- [#3541](https://github.com/LTplus-AG/ifc-lite/pull/3541) [`cfee9b2`](https://github.com/LTplus-AG/ifc-lite/commit/cfee9b28f5e6bec2040a29cbf7917be4696f407e) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `query --where` (and `query_entities`'s `property` filter over MCP) tested only the first same-named property or quantity set, so an entity was wrongly excluded when the value it should have matched lived on a later same-named set ([#3490](https://github.com/LTplus-AG/ifc-lite/issues/3490)) — two `IfcPropertySet`/`IfcElementQuantity` entities sharing one name is legitimate (e.g. one from the type definition, one from the occurrence).
  
  A filter is a predicate over the entity, so it now passes when ANY same-named set satisfies the operator, not just the first one found — uniformly across every operator, `!=` included. `@ifc-lite/query` adds `findAllPropertiesInSets`/`findAllQuantitiesInSets` (alongside the existing first-match `findPropertyInSets`/`findQuantityInSets`, which stay correct for value extraction — export, aggregation, display); `@ifc-lite/cli`'s `query --where` and the shared `HeadlessBackend.query.entities()` filter, and `@ifc-lite/mcp`'s `query_entities` filter, all switch to the any-match lookup. The viewer SDK's `entities()` filter now matches a property/quantity in ANY same-named set, not only the first.
- Updated dependencies [[`1f657d5`](https://github.com/LTplus-AG/ifc-lite/commit/1f657d5e7f82de890b27b10bc1b7c40d8d31203e), [`44a3c95`](https://github.com/LTplus-AG/ifc-lite/commit/44a3c95ac99c46d5eb800c3ff067477329d7bca9), [`8bdb7fe`](https://github.com/LTplus-AG/ifc-lite/commit/8bdb7fef31b8fafd9341bdc59725cacb8983195e), [`b02da88`](https://github.com/LTplus-AG/ifc-lite/commit/b02da889d60f720f1b4a868b48be12a95027f6e6), [`142b84c`](https://github.com/LTplus-AG/ifc-lite/commit/142b84c41036b749e7b64418a882424b9c386edb), [`142b84c`](https://github.com/LTplus-AG/ifc-lite/commit/142b84c41036b749e7b64418a882424b9c386edb), [`3284390`](https://github.com/LTplus-AG/ifc-lite/commit/328439014322dafaecb1bc930cd66ce5192c3c74), [`bbcb476`](https://github.com/LTplus-AG/ifc-lite/commit/bbcb476209a96b3c8a97f11751f4540cdaf41919), [`bbcb476`](https://github.com/LTplus-AG/ifc-lite/commit/bbcb476209a96b3c8a97f11751f4540cdaf41919), [`bbcb476`](https://github.com/LTplus-AG/ifc-lite/commit/bbcb476209a96b3c8a97f11751f4540cdaf41919), [`1d51937`](https://github.com/LTplus-AG/ifc-lite/commit/1d519376392e405645166761cc537bfbed9083cf), [`18e4de8`](https://github.com/LTplus-AG/ifc-lite/commit/18e4de865884d3126f478a9081cf56178fefcd00), [`80398a9`](https://github.com/LTplus-AG/ifc-lite/commit/80398a944093e3607944c70803b82d64fc372cba), [`9e45546`](https://github.com/LTplus-AG/ifc-lite/commit/9e455460f81f4bd463ef65116cbd89000e5539f7), [`06f81fe`](https://github.com/LTplus-AG/ifc-lite/commit/06f81fe10ba35a5b8edc7848017017f1f4d045ea), [`3e117c2`](https://github.com/LTplus-AG/ifc-lite/commit/3e117c249e792362ee5ec7eb722cf400ee18940a), [`f98e601`](https://github.com/LTplus-AG/ifc-lite/commit/f98e601e5efc749088949665e41efd44f1b889c4), [`56a0e01`](https://github.com/LTplus-AG/ifc-lite/commit/56a0e0112a22f58ac779534427781500c2256826), [`c5da727`](https://github.com/LTplus-AG/ifc-lite/commit/c5da72799a1832d7040942fa621c50973896b7fd), [`53a92b1`](https://github.com/LTplus-AG/ifc-lite/commit/53a92b1f7cc5770f164dc4867fc2adc33470e245), [`bcbe7b9`](https://github.com/LTplus-AG/ifc-lite/commit/bcbe7b9afa38e8dafb5900e73575c71a8fd96012), [`36719c2`](https://github.com/LTplus-AG/ifc-lite/commit/36719c22f2cbd6027d8afc73c660cda5c994fdf4), [`b9c8fdf`](https://github.com/LTplus-AG/ifc-lite/commit/b9c8fdfbc5e224003fa2094f7b9703aa71600dbf), [`793fce2`](https://github.com/LTplus-AG/ifc-lite/commit/793fce217039f11d6b74f898daed03f48c33809d), [`b0a6265`](https://github.com/LTplus-AG/ifc-lite/commit/b0a6265a804099b9cea7e55f26fc50825c1df07a), [`eb142e0`](https://github.com/LTplus-AG/ifc-lite/commit/eb142e00bc8ad1d6c699ea42fdbc35a9281d8133), [`2b594d2`](https://github.com/LTplus-AG/ifc-lite/commit/2b594d20616f957f7ef949aa8563274e5373a95b), [`2b594d2`](https://github.com/LTplus-AG/ifc-lite/commit/2b594d20616f957f7ef949aa8563274e5373a95b), [`586fa29`](https://github.com/LTplus-AG/ifc-lite/commit/586fa292b69cdb3ba6e45764b4ff742b2fa7b9a9), [`10b45b5`](https://github.com/LTplus-AG/ifc-lite/commit/10b45b571e2c2832bd938bb2a89e6d85d80aed5d), [`3efe762`](https://github.com/LTplus-AG/ifc-lite/commit/3efe762a993897fc3ddc029a8de1e5914e27df3f), [`e8682d5`](https://github.com/LTplus-AG/ifc-lite/commit/e8682d5add8bf0fb08c6cafcfbdf3b6784e3b47e), [`d08e420`](https://github.com/LTplus-AG/ifc-lite/commit/d08e420c9f39e9c0427aba47966cc6acf12642cc), [`b264887`](https://github.com/LTplus-AG/ifc-lite/commit/b26488758f481c489e7f596568adfe237dd444da), [`62399a4`](https://github.com/LTplus-AG/ifc-lite/commit/62399a456661d3db7dd3f86f01a26f4fe8ca594c), [`140a6d8`](https://github.com/LTplus-AG/ifc-lite/commit/140a6d8541224341835c98028dc75e6a5ccd605d), [`5f44fec`](https://github.com/LTplus-AG/ifc-lite/commit/5f44fec2630bff04fde00dac0eeeb520854dcde1), [`49581d6`](https://github.com/LTplus-AG/ifc-lite/commit/49581d6f3a622d34f677661651c778a36a01e88b), [`e09b5c3`](https://github.com/LTplus-AG/ifc-lite/commit/e09b5c364138d56816e45452622078e951e051ee), [`5297514`](https://github.com/LTplus-AG/ifc-lite/commit/52975142846390bb1eb12b723d53c0e275289a90), [`f76b3a1`](https://github.com/LTplus-AG/ifc-lite/commit/f76b3a1fe729acbf8fea40766ba8d068721f09df), [`6aa2b76`](https://github.com/LTplus-AG/ifc-lite/commit/6aa2b76d4a988e7ee1fd6bcad7c46a41650704b3), [`9ffdb35`](https://github.com/LTplus-AG/ifc-lite/commit/9ffdb35a9282adf3334a8df26f4a3c80f7f41582), [`1000dce`](https://github.com/LTplus-AG/ifc-lite/commit/1000dce72e9ec75c59848efefc1f709d01172e72), [`499ccf2`](https://github.com/LTplus-AG/ifc-lite/commit/499ccf2f97fe1e24728eb4eb99f895044c36f7b2), [`c1390f3`](https://github.com/LTplus-AG/ifc-lite/commit/c1390f38e32f7a345a4f2651b8a3b6d849e56af6), [`5dbc51d`](https://github.com/LTplus-AG/ifc-lite/commit/5dbc51d053b3a5d7ffa833374215c336c60548cc), [`abae27b`](https://github.com/LTplus-AG/ifc-lite/commit/abae27b5a08c3c5c8a706d144f3f5a08de096d93), [`2329b20`](https://github.com/LTplus-AG/ifc-lite/commit/2329b20506160171da97af7d4dd0cd76ab85f13f), [`d733175`](https://github.com/LTplus-AG/ifc-lite/commit/d733175d4ac2e8a2e94fc0bf9804d7bc03627cc1), [`6bd2550`](https://github.com/LTplus-AG/ifc-lite/commit/6bd25508dadd14fee97ee1f7393212cdcc086fdc), [`15d6d96`](https://github.com/LTplus-AG/ifc-lite/commit/15d6d96adbc4b36a3f787c2d111aaa199403193e), [`32104cb`](https://github.com/LTplus-AG/ifc-lite/commit/32104cbb5c59ea7af0b7b69d27fce15d17627723), [`f7a17ca`](https://github.com/LTplus-AG/ifc-lite/commit/f7a17ca6bedff238ac22315278657801ac41ede0), [`233da61`](https://github.com/LTplus-AG/ifc-lite/commit/233da6172abd3f79cbcde6e827e503fe8eb3ac3e), [`15d6d96`](https://github.com/LTplus-AG/ifc-lite/commit/15d6d96adbc4b36a3f787c2d111aaa199403193e), [`32b31bc`](https://github.com/LTplus-AG/ifc-lite/commit/32b31bc8501f04e110733289bde0389b9899bc76), [`d46732e`](https://github.com/LTplus-AG/ifc-lite/commit/d46732ec22638a5391aa2c04f473795a12c4ab55), [`7f670f9`](https://github.com/LTplus-AG/ifc-lite/commit/7f670f934d52f789ef7800badb3bb74bad56681c), [`cebcb21`](https://github.com/LTplus-AG/ifc-lite/commit/cebcb2133ef672e9199ee2f158578499d449d9e0), [`e986c81`](https://github.com/LTplus-AG/ifc-lite/commit/e986c81bf6d28fec57f1953fa53bf315dbd80a3a), [`8c181c9`](https://github.com/LTplus-AG/ifc-lite/commit/8c181c99f91964402ad352aead36d9619af5b427), [`6e48c4c`](https://github.com/LTplus-AG/ifc-lite/commit/6e48c4c5f441e8a42e4cc55440cf747ad8679f0a), [`8f08715`](https://github.com/LTplus-AG/ifc-lite/commit/8f087158a662a02c01a21dd2546fb863bb24e665), [`9b709c5`](https://github.com/LTplus-AG/ifc-lite/commit/9b709c51480fbabb68167aa4892f7e4c87b0e4e6), [`f8e03d4`](https://github.com/LTplus-AG/ifc-lite/commit/f8e03d4d5bb620fc9e807d5233091d145a201165), [`32b31bc`](https://github.com/LTplus-AG/ifc-lite/commit/32b31bc8501f04e110733289bde0389b9899bc76), [`843aefb`](https://github.com/LTplus-AG/ifc-lite/commit/843aefb9333ae1ad2af24a26fdec889b83de48ed), [`b777dbb`](https://github.com/LTplus-AG/ifc-lite/commit/b777dbb085d70f7f56c15c50b48e3c8e57c889a7), [`62bb58f`](https://github.com/LTplus-AG/ifc-lite/commit/62bb58fc8364c27bcf8452ab8edbde26727f527c), [`ea81645`](https://github.com/LTplus-AG/ifc-lite/commit/ea81645f7cd47d9e62718a6687f9e780794c2aa2), [`96d8f41`](https://github.com/LTplus-AG/ifc-lite/commit/96d8f4126073250e079d7cdc8f77b409e70400e7), [`c6ffda4`](https://github.com/LTplus-AG/ifc-lite/commit/c6ffda4789099a45fafdb5fe237c33c6edd9884c), [`3b266b9`](https://github.com/LTplus-AG/ifc-lite/commit/3b266b99dac5e384c48a410df7074803b01ef20f), [`d2fb0e4`](https://github.com/LTplus-AG/ifc-lite/commit/d2fb0e4121ccd19f326837ea574b189ee2a5f6c8), [`89c4cf2`](https://github.com/LTplus-AG/ifc-lite/commit/89c4cf22e83d76115035f7dcbf6e34f9c06dd091), [`c78ce8c`](https://github.com/LTplus-AG/ifc-lite/commit/c78ce8c3f1da3b8b2c6fa0f982595adc8c48b7d6), [`4246aaa`](https://github.com/LTplus-AG/ifc-lite/commit/4246aaa2035124dbe827827155dbbac2851fda4e), [`eb3000a`](https://github.com/LTplus-AG/ifc-lite/commit/eb3000aa21f13528bb75861f0f810bfc93c91fcc), [`b45180b`](https://github.com/LTplus-AG/ifc-lite/commit/b45180b7821014c1be6835201fa7a45b528c6377), [`a3d5a3a`](https://github.com/LTplus-AG/ifc-lite/commit/a3d5a3a23b6638a4cc68d9bb0da55035d4176bd0), [`858b75a`](https://github.com/LTplus-AG/ifc-lite/commit/858b75a0ef5636098452a2297277767efdc956a2), [`19f1312`](https://github.com/LTplus-AG/ifc-lite/commit/19f13120a05cd3a3b729eeaf5550cff71b7506d9), [`82c77c1`](https://github.com/LTplus-AG/ifc-lite/commit/82c77c118d5a4be8e5ee5b7f7e0648514e9fb74e), [`b7efeac`](https://github.com/LTplus-AG/ifc-lite/commit/b7efeac2195908729d1bf571839e2607f43c8ff7), [`4735f1c`](https://github.com/LTplus-AG/ifc-lite/commit/4735f1cbb6635016e83c7890f670e615bbdc48c3), [`4475e58`](https://github.com/LTplus-AG/ifc-lite/commit/4475e583ea35def444fb6d7ba92410629bd89096), [`182215a`](https://github.com/LTplus-AG/ifc-lite/commit/182215a835c4beac6a776bcb4eb1d019cab9063e), [`f1a006a`](https://github.com/LTplus-AG/ifc-lite/commit/f1a006af952dd670c6486cdb4ef0e8e1e0e280d7), [`4c00738`](https://github.com/LTplus-AG/ifc-lite/commit/4c007381bf14b3a4885adfea9b921beb105a8cc3), [`4475e58`](https://github.com/LTplus-AG/ifc-lite/commit/4475e583ea35def444fb6d7ba92410629bd89096), [`afa717b`](https://github.com/LTplus-AG/ifc-lite/commit/afa717bcf6041ad34085626fcfac321207ce4b81), [`6bd2550`](https://github.com/LTplus-AG/ifc-lite/commit/6bd25508dadd14fee97ee1f7393212cdcc086fdc), [`cb56282`](https://github.com/LTplus-AG/ifc-lite/commit/cb56282133a3349299665859b5507b739808d32e), [`d733175`](https://github.com/LTplus-AG/ifc-lite/commit/d733175d4ac2e8a2e94fc0bf9804d7bc03627cc1), [`fdac473`](https://github.com/LTplus-AG/ifc-lite/commit/fdac4734ce04758d2cd12b365f8b6de624713de6), [`902768e`](https://github.com/LTplus-AG/ifc-lite/commit/902768e138b595b26a47389bcea536f3f9e25b6d), [`a1aebc8`](https://github.com/LTplus-AG/ifc-lite/commit/a1aebc822b819221258f4759edf4c82ff0d140f7), [`a21f271`](https://github.com/LTplus-AG/ifc-lite/commit/a21f2718e93cd6bb432591ab006a9ecbb0cb648d), [`f8e03d4`](https://github.com/LTplus-AG/ifc-lite/commit/f8e03d4d5bb620fc9e807d5233091d145a201165), [`f8e03d4`](https://github.com/LTplus-AG/ifc-lite/commit/f8e03d4d5bb620fc9e807d5233091d145a201165), [`9368b2d`](https://github.com/LTplus-AG/ifc-lite/commit/9368b2dcdc8df61afe790e671de95317e0418c21), [`2c84b15`](https://github.com/LTplus-AG/ifc-lite/commit/2c84b15526456ad57ba93a77f669208174efbed3), [`3cd1647`](https://github.com/LTplus-AG/ifc-lite/commit/3cd1647a2918ac27b903cb82bc797c2d2b288ac3), [`a1069f8`](https://github.com/LTplus-AG/ifc-lite/commit/a1069f8f096fcfc5771200a2748466096c3463d5), [`dc8198c`](https://github.com/LTplus-AG/ifc-lite/commit/dc8198ce3f9b9be4b2420dce90343822e0079465), [`b331b49`](https://github.com/LTplus-AG/ifc-lite/commit/b331b4921ff0927ee18bb78f00d2bb6e496219d8), [`de3c82d`](https://github.com/LTplus-AG/ifc-lite/commit/de3c82d03047737fc4b870477b2cc0b61ffc56dc), [`cb9dad2`](https://github.com/LTplus-AG/ifc-lite/commit/cb9dad2df38f1796ab8cb6eefe881ad795876cc9), [`c65ec91`](https://github.com/LTplus-AG/ifc-lite/commit/c65ec91b411754b73c6317455873f771a15ba9f7), [`c3bdc8f`](https://github.com/LTplus-AG/ifc-lite/commit/c3bdc8fe55536a9b27adaa7ed92fb214c975fe2e), [`c3bdc8f`](https://github.com/LTplus-AG/ifc-lite/commit/c3bdc8fe55536a9b27adaa7ed92fb214c975fe2e), [`1060a30`](https://github.com/LTplus-AG/ifc-lite/commit/1060a30187c8f6bb327f9e356056f2364568e8ff), [`3460785`](https://github.com/LTplus-AG/ifc-lite/commit/3460785652f251f3161aa8dd6f1d247750df2715), [`a2488e8`](https://github.com/LTplus-AG/ifc-lite/commit/a2488e858bc7792cdcc818f7759c0a6e46e7d892), [`b135862`](https://github.com/LTplus-AG/ifc-lite/commit/b1358623210867daba42ff56e97ff05733bff646), [`0add82c`](https://github.com/LTplus-AG/ifc-lite/commit/0add82cb1692f98528f6d9d5f6be5e99a46bfed1), [`3ef0460`](https://github.com/LTplus-AG/ifc-lite/commit/3ef0460d3bea57ea7e3257289c87dc1d0311e502), [`d401b85`](https://github.com/LTplus-AG/ifc-lite/commit/d401b85a59b30a4223e291f6388800499a47954b), [`d401b85`](https://github.com/LTplus-AG/ifc-lite/commit/d401b85a59b30a4223e291f6388800499a47954b), [`8368339`](https://github.com/LTplus-AG/ifc-lite/commit/83683393654d8c1b903f03b5c6e9e5ff111fdaf0), [`2edd144`](https://github.com/LTplus-AG/ifc-lite/commit/2edd14432999ceeed4c0bb0baf6b2000c1c5b041), [`f8e03d4`](https://github.com/LTplus-AG/ifc-lite/commit/f8e03d4d5bb620fc9e807d5233091d145a201165), [`f76b3a1`](https://github.com/LTplus-AG/ifc-lite/commit/f76b3a1fe729acbf8fea40766ba8d068721f09df), [`3ccb417`](https://github.com/LTplus-AG/ifc-lite/commit/3ccb4176f3a61a227bcfc302c3e0b1fb43a6f0ec), [`7eaed2a`](https://github.com/LTplus-AG/ifc-lite/commit/7eaed2a98a8cd60bd402c0a9d79940739eabb331), [`a99ecd9`](https://github.com/LTplus-AG/ifc-lite/commit/a99ecd9998dada941dc66e8bcc85ce3864b44065), [`cfee9b2`](https://github.com/LTplus-AG/ifc-lite/commit/cfee9b28f5e6bec2040a29cbf7917be4696f407e), [`ff292b6`](https://github.com/LTplus-AG/ifc-lite/commit/ff292b685a7c663ef3e79928a754667bb919066a), [`2b87396`](https://github.com/LTplus-AG/ifc-lite/commit/2b87396553df0f3c11a930e3dae8b8600d70a23f)]:
  - @ifc-lite/export@4.0.0
  - @ifc-lite/parser@5.0.0
  - @ifc-lite/bcf@3.0.0
  - @ifc-lite/clash@2.0.0
  - @ifc-lite/sdk@4.0.0
  - @ifc-lite/collab@0.6.1
  - @ifc-lite/data@4.0.0
  - @ifc-lite/create@2.2.1
  - @ifc-lite/mutations@2.0.0
  - @ifc-lite/diff@0.8.0
  - @ifc-lite/query@2.1.0
  - @ifc-lite/geometry@4.2.0
  - @ifc-lite/ids@1.15.53
  - @ifc-lite/ifcx@4.0.0
  - @ifc-lite/extensions@0.6.0
  - @ifc-lite/merge@0.4.5
  - @ifc-lite/viewer-core@0.2.15

## 0.12.0

### Minor Changes

- [#3088](https://github.com/LTplus-AG/ifc-lite/pull/3088) [`93b450c`](https://github.com/LTplus-AG/ifc-lite/commit/93b450c1cc0c3cee811625989edb82cf522c70c4) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Four places where two things had to agree and nothing made them.
  
  **BCF `<Component>` read back none of what it wrote.** BCF 2.1 and 3.0 both model `OriginatingSystem` and `AuthoringToolId` as child ELEMENTS of `<Component>` — only `IfcGuid` is an attribute. `writeComponent` emits the element form and its docstring says so; `parseComponent` matched `AuthoringToolId="…"` and `OriginatingSystem="…"` as attributes, which the element form never produces. Both fields were dropped from every archive read, whether ifc-lite wrote it or another tool did. Worse, the guard `if (!ifcGuidMatch && !authoringToolIdMatch) return undefined` used a match that could never fire, so a component identified only by its authoring-tool id — legal, `IfcGuid` is optional — was discarded whole rather than losing one field.
  
  The existing writer tests could not see it: no fixture set either field, so the reader's `undefined` looked like a faithful round-trip of an empty input rather than a dropped value. A writer and a reader that only ever meet each other agree with each other, not with the format. The reader now reads the element form (unescaping entities, like every other element it parses) and still accepts the attribute spelling as a fallback, so files from tools that emit the non-spec form keep working.
  
  **`ifc-lite clash`'s "Top 20" was not the top 20.** The engine returns `result.clashes` in `byKeyThenRule` grouping order. Both cap sites sliced that directly — `slice(0, 20)` for the human summary, `slice(0, 1000)` for `--json` — under a header reading `Top N of M clashes`, so on any run above the cap the deepest penetrations could sit past the cut and never be printed. `@ifc-lite/clash` has exported `sortClashes(clashes, 'distance')` for this the whole time, and the viewer's clash panel uses it; the MCP `clash_check` tool had independently hit the same problem and grown a local copy of the sort, minus the deterministic id tie-break. All three now call the one helper, so "top N" means the same N rows on every surface and equal-distance rows stop reshuffling between runs.
  
  **`ifc-lite mcp --allow-origin <origin>` loaded the origin as a model file.** The standalone `ifc-lite-mcp` binary reads a flag and consumes its value in one branch, so it cannot disagree with itself. The `ifc-lite mcp` subcommand only needs to know WHICH flags carry a value, so it can skip them while collecting positional `.ifc` paths — and it kept a hand-written copy of that list. The copy drifted: `--allow-origin` reached the binary and never the list, so the subcommand skipped the flag, failed to skip the origin after it, and called `resolve('https://…')` as a model path. The flag tables now live in `@ifc-lite/mcp/cli-args` next to the binary's parser, which a test drives against them, and the subcommand imports them. Flags the subcommand cannot act on (`--allow-origin`, `--federate`) are now reported on stderr instead of silently appearing to work. `parseArgs` also stopped calling `process.exit` for `--help`/`--version` — it reports them and the binary acts — so it can be tested at all.
  
  **Three query backends, three copies of the same two lookup tables.** `IFC_SUBTYPES`, `expandTypes` and the `related()` relationship map were byte-identical in the viewer's `query-adapter`, `@ifc-lite/cli`'s `HeadlessBackend` and `@ifc-lite/mcp`'s `backend-query`, behind one SDK query API. Only the CLI copy had tests, so the other two were free to drift: deleting `IFCSLABELEMENTEDCASE` from the MCP copy left all 272 of its tests green, meaning `byType('IfcSlab')` could answer differently depending on which surface a caller reached. They now come from `@ifc-lite/parser`, the same home PR [#3009](https://github.com/LTplus-AG/ifc-lite/issues/3009)'s `isProductType` move used, and are covered there rather than by one consumer; that mutation now fails. `@ifc-lite/cli` and `@ifc-lite/mcp` keep publishing `expandTypes` under its old name, so no consumer surface changes.
  
  Putting the SDK's five-entry relationship map next to the parser's eighteen-entry `REL_TYPE_MAP` also makes visible, for the first time, that `related()` exposes five of the relationships the parser indexes — previously that narrowing was invisible in all three copies. Behaviour is unchanged; widening it is now a deliberate edit to one table.
  
  Also documented a near-miss: `harvestUpdatePaths` in `@ifc-lite/collab-server` pre-creates four of the five `TOP` shared types, omitting `annotations`, and reads like an enumeration missing an entry — which would make an `annotations/…` path lock unenforceable. It is not: `Y.applyUpdate` registers any top-level type the update names and `topLevelKeyOf` scans `doc.share`, so the path is harvested regardless. Verified by running, and pinned by two tests so a later "tidy-up" into a fixed list cannot quietly create the hole.
  
  **A fifth pair, found reviewing the fourth: the `<Component>` splitter read two components as one.** Fixing the field parsing above made this reachable, so it belongs in the same change rather than after it. The splitter was `<Component[^>]*(?:\/>|>[\s\S]*?<\/Component>)`, and `[^>]*` is greedy: it eats the `/` of a self-closing tag, so the `\/>` branch can never fire. A uniform list still parsed, because the engine backtracks and gives the `/` back when no later `</Component>` exists. A MIXED list did not.
  
  `writeComponent` emits `<Component .../>` for a component with no child elements and the full form for one with them, so an ordinary selection holding one of each produces exactly that mixed list. The pair matched as ONE element spanning both, and the first component silently inherited the second's `AuthoringToolId` and `OriginatingSystem`. Before this change that was data loss; with the field parsing working it is misattribution, which nothing downstream can detect.
  
  Every fixture in the suite held one shape, which is the one shape the defect cannot reach. There is now one splitter instead of two identical copies, in `parseComponentElements`, with fixtures for the mixed selection, the mixed coloring entry, and a uniform control.
  
  **The attribute fallback did not decode entities.** `AuthoringToolId="A &amp; B"` came back as the literal `A &amp; B` while `<AuthoringToolId>A &amp; B</AuthoringToolId>` came back as `A & B`. Which spelling a file happens to use is not supposed to change the value. All three attribute reads now decode the same way `extractElement` does.
  
  **`reader.ts` was split.** The component, visibility and colouring parsers move to `reader-components.ts` and the XML text helpers to `xml-text.ts`. That is what put one splitter where there were two, and it takes `reader.ts` from 1204 lines to 1045. The module-size gate was genuinely RED before it (1204 against a 1190 budget), and the freed budget is banked rather than left as slack: the row drops to 1045 in the same commit that shrank the file. 1045 is still far above the ~400-line house guideline, so this pays a gate, not the rule behind it.
  
  **Two smaller ones in `@ifc-lite/mcp`.** `--help`/`--version` set `process.exitCode` and return instead of calling `process.exit(0)`, which can truncate stdout when it is a pipe. That makes `ifc-lite-mcp` match its sibling binary, `packages/cli/src/index.ts`, which already returns rather than exits. The same write-then-exit shape survives at about ten sites in `@ifc-lite/cli`'s subcommands; widening to those changes control flow (several exit non-zero) in a package this change does not otherwise open, so they are deliberately left. And four user-facing strings advertised the top clashes "by |distance|" while the code sorts by signed distance. The file's own docstring already warned that an absolute-value sort inverts the hard-clash order, so the text contradicted both the implementation and the comment beside it.
  
  **Reviewing the splitter fix turned up four more in the same file, three of them the same shape.** Fixing them here rather than filing them, because they live in the function the split just moved and the remedy is the one already applied.
  
  `<Visibility DefaultVisibility="false"/>` is schema-legal, since `<Exceptions>` and `<ViewSetupHints>` are both optional. Matching only the paired form returned `undefined` for the WHOLE `<Components>` block, dropping the selection and colouring with it. That is the same missing self-closing branch as the component splitter, twenty lines away.
  
  `DefaultVisibility` was matched against the entire `<Components>` string rather than the `<Visibility>` element, so the attribute on any earlier element won. A file whose `<Visibility>` says `true` with a `DefaultVisibility="false"` anywhere ahead of it hid every element: the exact opposite of what it asked for.
  
  Attribute fallbacks were read from the whole element rather than its opening tag, so `<Component IfcGuid="G"><Child OriginatingSystem="x"/></Component>` reported the child's `x` as the component's own. They also lacked the `\b` name anchor that `reader.ts`'s own `extractAttr` has, so `XAuthoringToolId="sneaky"` satisfied a search for `AuthoringToolId`.
  
  And an EMPTY value now reads as absent whichever spelling carries it. `<AuthoringToolId></AuthoringToolId>` returned `''`, which passed the "a component needs some identity" guard with no identity, and `writeComponent` then wrote it back as a bare `<Component/>` that the reader discards. Three spellings of nothing disagreeing is the defect this changeset opens with.
  
  `IfcGuid` is now entity-decoded like every other field, matching `writeComponent`, which already escapes it. A real IFC GUID contains no `&`, which is why nothing reached it.
  
  Each of these is pinned by a fixture that fails without its fix; all six were checked by reverting the fix and watching the fixture go red.
  
  **`unescapeXml` decodes numeric character references**, not only the five named entities `escapeXml` writes. Other authoring tools emit `&[#38](https://github.com/LTplus-AG/ifc-lite/issues/38);` and `&#x26;`, both legal XML, and those stayed encoded in the data.
  
  It is now a single pass rather than a chain of five `replace` calls. The chain had to decode `&amp;` last, or a literal `&lt;` written as `&amp;lt;` was corrupted into `<` by the earlier pass; adding numeric forms to that chain reintroduces the same hazard from a second direction, since `&[#38](https://github.com/LTplus-AG/ifc-lite/issues/38);lt;` decodes to `&lt;` and would be swept again. A single pass never looks at its own output, so the ordering question stops existing. An unrecognised or out-of-range reference is left untouched, because losing a character from someone else's archive is worse than leaving one encoded.
  
  **`clash_review` asked for something the data could not support.** The prompt requested a top-20 list "ordered by severity", but `clash_matrix` selects `sampleClashes` with `sortClashes(clashes, 'distance')` and caps it, so a high-severity clash with a large distance is not in the sample at all. A severity-ranked list built from it would silently omit exactly the items it claims to rank. The prompt now orders by distance and points at `bySeverity` for the severity picture, which is a complete count over every clash. The tool's own description says which half is complete and which is capped, and `clashReview.description` no longer says "prioritize by severity".

- [#3115](https://github.com/LTplus-AG/ifc-lite/pull/3115) [`8ba612f`](https://github.com/LTplus-AG/ifc-lite/commit/8ba612f90d3bb0ad41f756d6fdef6b3250e8d330) Thanks [@louistrue](https://github.com/louistrue)! - CSV: numeric cells export as numbers. **The formula guard's default changed.**
  Pass `exemptNumbers: false` to `escapeCsvCell` / `guardSpreadsheetFormula` to
  keep the old behaviour.
  
  **Read this first if you consume `@ifc-lite/export`.** The CWE-1236 guard
  prefixes a leading `=`, `+`, `-`, `@`, TAB or CR with `'` so a spreadsheet reads
  the cell as text. It now makes one exception by default: a cell that is *wholly*
  a signed number is left alone. Nothing in your code has to change for the
  behaviour to change, which is why this is called out here rather than in a
  footnote.
  
  The exception cannot weaken the guard. The exempted language contains only
  `+ - . e E` and the digits `0-9`, which cannot spell a function name, a cell
  reference or a `(`. `=`, `@`, TAB and CR are never exempted, `-0.35=cmd` is not
  wholly a number and stays guarded, and a leading invisible character defeats the
  exemption rather than the guard, so `<ZWSP>-1` is still prefixed.
  
  **What it costs.** The default has to guess from the text, because most callers
  hand it a bare string, and guessing gets identifiers wrong: a `+`-prefixed phone
  number is wholly numeric as text, so it is written bare and Excel renders
  `4.1791E+10` with the `+` gone. `-007` becomes `-7`. Both were previously kept
  exactly, as `'`-prefixed text.
  
  The viewer's Lists CSV does not guess, because it has the value itself: it
  exempts a cell when the value really is a number and guards it otherwise, so a
  phone number stays text there and a measure stays summable even in a column that
  also holds text. So this cost applies to the writers that only ever see strings,
  which is the CLI, the SDK, MCP, the compare report, search results, zone tables
  and `@ifc-lite/lists`' own CSV. Pass `exemptNumbers: false` to opt any of them
  out.
  
  **Why the exception exists.** `@ifc-lite/lists` had exempted numbers since [#1772](https://github.com/LTplus-AG/ifc-lite/issues/1772)
  ("`-0.35` exported as `'-0.35` and broke Excel SUM()") while every other writer
  guarded them, so the same list exported two ways did not match. The policy is
  now one default rather than eleven call-site decisions that drift.
  
  **The viewer's Lists CSV stopped formatting numbers before writing them.** It
  ran every value through the display formatter, which calls `toLocaleString()` on
  integers. Under en-US that wrote `"-1,000"`, quoted because of the comma, so the
  column stopped summing. Under a locale that groups with `.` it wrote a bare
  `-3.000`, which a spreadsheet in a `,`-grouping locale reads back as **-3**, a
  silent 1000x error in a quantity column. Exempting numbers fixes neither, since
  neither string is wholly numeric in the locale that produced it. CSV is
  machine-readable output, so it now writes the number, matching what the XLSX
  writer always did. PDF, which a human reads, is unchanged.
  
  Two consequences of that, both deliberate. Unit-converted values now show their
  full double precision (3 ft in metres is `0.9144000000000001`, not `0.9144`),
  which is the same value the XLSX export already carried, so the two agree. And grouping a
  list by a numeric column used to hard-code that column as non-numeric in the
  schedule/pivot export, where the grouping value is the *only* place the value
  appears; it wrote `"'-3,000"` and nothing else for -3000. Schedule grouping
  columns now inherit `numeric` and carry the raw value, falling back to the group
  label where a bucket holds values that merely format alike.
  
  **The numeric test no longer backtracks.** It was
  `/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/`, quadratic on a failing match and
  reached only after a trigger matched, so `-` plus 60k digits took ~1.8s. IFC
  property text is attacker-controllable, which made that a denial of service on
  an export. It is a linear scan now, and lives in `@ifc-lite/encoding` (no
  dependencies, already depended on by both callers) as the new `isWhollyNumeric`
  export, so there is one copy per language rather than one per package. The
  accepted language is unchanged, checked by sweeping every string up to four
  characters over the alphabet it is built from against the old regex.

- [#3034](https://github.com/LTplus-AG/ifc-lite/pull/3034) [`75867a7`](https://github.com/LTplus-AG/ifc-lite/commit/75867a7e6ebf51b2da47cab14242bcd71787ba3b) Thanks [@louistrue](https://github.com/louistrue)! - Stop dropping entities from an unfiltered query, and stop reporting their class as `Unknown`, when the curated `IfcTypeEnum` does not carry it.
  
  **`isProductType` now keys on the inheritance chain.** It gated on `IfcTypeEnumFromString(type) !== Unknown`, and `TYPE_STRING_TO_ENUM` is a curated 138-entry subset — the same table PR [#3009](https://github.com/LTplus-AG/ifc-lite/issues/3009) found rejecting standard buildingSMART classes. An unfiltered `bim.query()` walks `store.entityIndex.byType` and keeps only entries this predicate accepts, so every class outside those 138 was absent from the result with nothing to say so. On a 176k-entity MEP model that was every `IfcAirTerminal` (139), every `IfcDuctFitting` (383) and every `IfcDistributionPort` (2,053): 2,575 real elements, reported as not present rather than as unclassified.
  
  The gate is now `isQueryableObjectType` in `@ifc-lite/parser`: `getInheritanceChain(type).includes('IfcObjectDefinition')`, minus `IfcTypeObject` descendants. It lives in the parser rather than in each backend because `isProductType` was a verbatim copy in `packages/cli` and `packages/mcp` and only the CLI copy had tests — a predicate that had just diverged once should not be left in two places to diverge again. Both backends now alias the single implementation and keep publishing it under the old name. That is the exact line the four prefix tests were approximating: `IfcObjectDefinition` covers products, type objects, groups, systems and `IfcContext`, and excludes the other two `IfcRoot` branches, `IfcPropertyDefinition` and `IfcRelationship`. The chain resolves across the bundled schema union, so it answers for classes the pin omits. `IFC_ENTITY_NAMES` alone would not work here: it carries all ~880 classes, so keying on "is a known IFC name" floods the same query with that model's 42,024 `IfcCartesianPoint`.
  
  The MCP `dataQuality` audit counts the same set, so its score moves for an unchanged file: ports, groups, systems and annotations now enter the naming denominator that the 138-entry table kept out, and most of them are unnamed.
  
  **Behaviour change worth planning for:** on that model an unfiltered `bim.query()` returns 3,090 entities where it returned 515. The growth is real elements that were missing, and it is dominated by ports on MEP models. Callers that want the narrower set should filter with `byType`.
  
  **`EntityNode.type` no longer answers `Unknown` for an entity the product table does not index.** `store.entities` indexes products, so `getTypeName` has no row for `IfcPropertySet`, `IfcElementQuantity`, `IfcRelDefinesByProperties` or `IfcRelAssociatesMaterial` and answered `'Unknown'` for all four, while `entityIndex.byId` carried the class the whole time as the raw uppercase STEP token. `type` is what callers key passes on, so iterating a model's classes by it skipped 8,928 entities on that same model. It now falls back to the index and canonicalises through `normalizeIfcTypeName`, which resolves against the bundled schema union. `IFC_ENTITY_NAMES` would have been the same curated-subset trap one file over: it is ~880 hand-maintained entries whose generator script no longer exists, so an `IfcMove` on an IFC2X3 model came back as the raw `IFCMOVE` token — a second wrong answer.
  
  `QueryResultEntity.type`, which is what `EntityQuery.execute()` returns, carried the identical getter and is fixed with it. Both now call one `resolveEntityTypeName`; fixing only `EntityNode` would have left the two disagreeing on the same entity.
  
  Verified against the real columnar parser, not only against the query package's mock store. With both changes reverted, 3 of the 5 new CLI tests fail and 1 of the 4 new query tests fails; the two CLI tests that still pass are the ones asserting what stays excluded.

- [#3034](https://github.com/LTplus-AG/ifc-lite/pull/3034) [`75867a7`](https://github.com/LTplus-AG/ifc-lite/commit/75867a7e6ebf51b2da47cab14242bcd71787ba3b) Thanks [@louistrue](https://github.com/louistrue)! - Add `bim.style`, colour that ends up in the exported IFC.
  
  `bim.viewer.colorize` paints the current view. The colour is an overlay and is gone the moment the model is written out, so a script that wanted a coloured file had to hand-build the `IfcColourRgb → IfcSurfaceStyleShading → IfcSurfaceStyle → IfcStyledItem` chain itself and walk `IfcProductDefinitionShape → IfcShapeRepresentation → Items` to find something to attach it to. `StepExporter` already builds that chain internally for demeshed output; nothing exposed it.
  
  `bim.style.apply(refs, color)` and `bim.style.applyAll(batches)` take any hex form `bim.viewer.colorize` takes — they share its `hexToRgba` — or channels in 0..1. The one deliberate difference is the failure mode: `hexToRgba` degrades an unparseable string to black, which is right for a transient overlay and wrong for something written into the file, so a non-hex string throws instead of being baked in as black.
  
  The work lives in `applyStylesInStore` in `@ifc-lite/create`, beside the other in-store builders, and writes through the same `StoreEditor` overlay as `bim.spaces.generate`. Both headless backends implement it; a backend without direct store access, including the browser viewer's, throws.
  
  Four things the call site no longer has to get right:
  
  **Mapped geometry.** An `IfcMappedItem` is followed through to the `IfcRepresentationMap` and the mapped representation's items are styled, so one style covers every occurrence of a type. On a real MEP model, 139 air terminals share 63 geometry items; styling per occurrence would write a second `IfcStyledItem` on geometry that already had one, which IFC does not allow.
  
  **Geometry that already has a style, including geometry this session styled.** IFC permits at most one `IfcStyledItem` per representation item. The index of existing styles covers both the source file and the overlay: `StoreEditor.addEntity` does not insert into `store.entityIndex`, so a source-only check could not see the session's own writes and a second `apply` over the same products emitted two styled items on one solid — a schema-invalid file, from the very machinery meant to prevent it. That index is also built once per pass rather than per batch, which was 87 ms per batch on a 92k-styled-item model, about two thirds of a colour-by-class run.
  
  **Entities created in the same session.** Reads fall back to the overlay, so `bim.store.addWall(...)` followed by `bim.style.apply` colours the new wall instead of reporting it as geometry-less and leaving an orphan `IfcSurfaceStyle` in the file.
  
  **Schema differences.** `Representation` is resolved by attribute name rather than by a hardcoded index 6, because that slot is `RepresentationMaps` on `IfcTypeProduct` — a list, so a constant index turned a type object into a silent no-op. IFC2X3 gets the `IfcPresentationStyleAssignment` wrapper that IFC4 deprecated. Transparency is rounded, since `1 - 0.9` otherwise reaches the STEP text as `0.09999999999999998`.
  
  A style chain is only left in the file while something references it. Colour a wall red and recolour it green — in a later batch or a later call — and the red chain goes with the styled item it belonged to. What gets swept is tracked as it is authored, per editor, rather than inferred from the overlay: inference could not see `setPositionalAttribute` edits (`getNewEntities` reports attributes as created, while the exporter applies positional mutations on top), so it removed live styles and left the real garbage; it took a chain's shading and colour without checking whether anything else used them; and it collected any overlay `IfcSurfaceStyle` at all, including one a caller had authored with `bim.store.addEntity` and not yet attached. Only chains `bim.style` created are its to remove, and a chain whose styled items were repointed elsewhere is kept rather than risked. A batch that styles nothing writes nothing at all: `surfaceStyleId` is `null`. A caller colouring by IFC class hands in one batch per class, and most classes in a real model — types, ports, spatial structure — reach no geometry, so emitting the style up front left an orphan `IfcColourRgb` / `IfcSurfaceStyleShading` / `IfcSurfaceStyle` per such batch. Found by using the API for a colour-by-class pass: 16 styles in the file where 5 were referenced.
  
  `productsWithoutGeometry` counts a product only when its own walk reached nothing. Deciding it from the growth of the shared item set instead would report every occurrence after the first as geometry-less whenever a type's occurrences share one mapped representation — which is most of them, and was wrong in the first cut of this.
  
  `followMappedItems: false` styles the `IfcMappedItem` per occurrence instead. Following the representation map is right for colouring by IFC class and wrong for any other grouping — by system, storey or property value, shared geometry takes whichever colour ran last and drags unrelated occurrences with it.
  
  `schema` names the schema the chain is built for, defaulting to the store's. The style shape is decided when the style is authored and the export schema is chosen later, so an IFC4 model exported as IFC2X3 otherwise emits `IfcStyledItem.Styles` pointing straight at an `IfcSurfaceStyle`, which that schema does not allow. Converting existing style records during a schema change is a separate job for `StepExporter` and is not attempted here.
  
  An `#rrggbbaa` string's alpha pair is honoured. `hexToRgba` discards those digits and takes alpha from its own argument, which is right for the viewer; here they are the only way the string form can ask for transparency, and dropping them silently wrote an opaque style.
  
  Verified on the export rather than on the overlay, against a fixture carrying direct geometry, two occurrences behind one representation map, a product with no representation, and geometry that already carries a style.

### Patch Changes

- [#3102](https://github.com/LTplus-AG/ifc-lite/pull/3102) [`7ff31ba`](https://github.com/LTplus-AG/ifc-lite/commit/7ff31ba854671a9ca3ebbf30b15e928e1b52a8b9) Thanks [@BIMvoice](https://github.com/BIMvoice)! - CSV cell escaping now has one implementation per language
  
  `@ifc-lite/export` gains `escapeCsvCell` and `guardSpreadsheetFormula`. Every
  CSV writer in the SDK, CLI and MCP now calls them instead of carrying its own
  copy of the RFC 4180 quoting and the CWE-1236 spreadsheet formula-injection
  guard.
  
  Two behaviour changes come with that, in the copies that were behind:
  
  - The formula trigger is looked for **past** any leading invisible characters
    (Unicode `Cf` + `Z`: BOM, zero-width space, LTR mark, non-breaking space,
    U+2028/U+2029, ordinary spaces). The copies in the CLI, MCP and the SDK's
    CSV export tested it anchored at offset 0, so a crafted IFC value such as
    `﻿=HYPERLINK(...)` was exported unguarded.
  - Those invisibles are looked past, not deleted. The one hardened copy removed
    them, and its character class included U+0020, so leading spaces were stripped
    from exported cells — RFC 4180 §2.4 says spaces are part of the field.
  
  Cells with no leading invisible and no formula trigger are unchanged.
  
  The Rust exporter (`ifc_lite_export::csv_cell`) carries the matching
  implementation, and both are pinned to one shared table of test vectors so the
  two languages cannot drift apart.

- [#3034](https://github.com/LTplus-AG/ifc-lite/pull/3034) [`75867a7`](https://github.com/LTplus-AG/ifc-lite/commit/75867a7e6ebf51b2da47cab14242bcd71787ba3b) Thanks [@louistrue](https://github.com/louistrue)! - Make `bim.mutate.*` persist in the headless CLI and MCP backends instead of silently discarding every edit.
  
  `HeadlessBackend.createMutateAdapter` answered `setProperty`, `setAttribute` and `deleteProperty` with no-ops in both `packages/cli` and `packages/mcp`. Nothing threw and nothing returned a failure, so an `ifc-lite run` script could call `bim.mutate.setProperty` six thousand times, report six thousand edits, and get an export back byte-for-byte identical to its input. The write path that does persist was already present — `MutablePropertyView`, which `StepExporter` reads when `applyMutations` is on, and which `bim.store.*` and `bim.spaces.*` already routed into — nothing connected `bim.mutate` to it.
  
  Both backends now share `createHeadlessMutateAdapter` from `@ifc-lite/sdk`, which owns `MutateBackendMethods` and already depends on `@ifc-lite/mutations`. The adapter takes a thunk rather than a view so the overlay is still built on first write and a read-only session pays nothing.
  
  Values are classified before they are stored. `MutablePropertyView.setProperty` defaults to `PropertyValueType.String`, so forwarding a raw JavaScript value wrote `IFCLABEL('true')` where the caller passed `true`; `propertyValueTypeOf` maps boolean to `IFCBOOLEAN`, whole numbers to `IFCINTEGER` and the rest to `IFCREAL`.
  
  `undo` and `redo` still answer `false` and `batchBegin`/`batchEnd` are still accepted and ignored: the mutation history they would walk belongs to the viewer's store, and a headless session has none. That is now documented at the adapter rather than implied by a bare stub.
  
  The browser viewer's adapter had the same defect from the other direction: it forwarded the raw value to `mutationSlice.setProperty`, whose `valueType` also defaults to `String`, so `bim.mutate.setProperty(ref, pset, prop, true)` wrote `IFCLABEL('true')` there too. It now passes `propertyValueTypeOf`, which is also why that helper is exported. The two other character-identical copies of the classifier — `detectValueType` in the MCP mutation tool and `inferValueType` in the CLI gym ops — now alias it, so the paths cannot diverge on a future correction.
  
  Verified on the export, not on the overlay — reading the view back passes against the broken adapter too. With the original no-ops restored, 5 of the 6 new CLI tests fail; the sixth is the control that asserts an unmutated re-export still contains the original name.

- [#2988](https://github.com/LTplus-AG/ifc-lite/pull/2988) [`f135c02`](https://github.com/LTplus-AG/ifc-lite/commit/f135c02624b8a7aa1915068405545d108f55fce4) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `ids_validate`'s summary reporting a specification as failed when it legitimately passed while matching zero entities.
  
  `summarizeIdsReport` cast the report to a hand-written minimal shape,
  ignored `spec.status` entirely, and used `entityResults.length > 0` as the
  pass condition for a specification. A specification with an explicit
  `minOccurs="0"` (or a prohibited spec that correctly matches nothing) is a
  legitimate pass with zero matched entities -- the validator's own
  `report.summary` already gets this right, but the tool never read it.
  
  `summarizeIdsReport` now projects `report.summary` directly instead of
  re-deriving the counts, and the report parameter is typed as the real
  `IDSValidationReport` rather than `unknown`, so there is no longer a
  hand-written shape for the two to drift apart on.
- Updated dependencies [[`93b450c`](https://github.com/LTplus-AG/ifc-lite/commit/93b450c1cc0c3cee811625989edb82cf522c70c4), [`ddf9f1d`](https://github.com/LTplus-AG/ifc-lite/commit/ddf9f1da830cef5f941ea09e8aee19624e9def3a), [`f7e26e4`](https://github.com/LTplus-AG/ifc-lite/commit/f7e26e4200e1475728d4976142b49cb408400a8e), [`e19aa0e`](https://github.com/LTplus-AG/ifc-lite/commit/e19aa0ef271eccc7f2f6862b8580e9f98dbd1a66), [`66697fc`](https://github.com/LTplus-AG/ifc-lite/commit/66697fc57de1de4475a2c5eed4361e0e378e0f7a), [`447f02e`](https://github.com/LTplus-AG/ifc-lite/commit/447f02eefc2933c63c03aea6c7793343df20fcd7), [`228bbe7`](https://github.com/LTplus-AG/ifc-lite/commit/228bbe730522148ea797780c5acd08502b18a3a3), [`e6caf11`](https://github.com/LTplus-AG/ifc-lite/commit/e6caf11a8f8d9d8634a6811b6705ab3367cd02e0), [`2580830`](https://github.com/LTplus-AG/ifc-lite/commit/25808308bbbc63eb0fd8b25e6dd0c08864adb6a8), [`b25b2e7`](https://github.com/LTplus-AG/ifc-lite/commit/b25b2e7387bd365fda02d48095266f16b4f05cd7), [`7ff31ba`](https://github.com/LTplus-AG/ifc-lite/commit/7ff31ba854671a9ca3ebbf30b15e928e1b52a8b9), [`8ba612f`](https://github.com/LTplus-AG/ifc-lite/commit/8ba612f90d3bb0ad41f756d6fdef6b3250e8d330), [`9359bc4`](https://github.com/LTplus-AG/ifc-lite/commit/9359bc488173585b2b90e124cc66dcf8292c4be9), [`8571d70`](https://github.com/LTplus-AG/ifc-lite/commit/8571d70270d072170fc4e204e8b0d11a424d2330), [`f6febcc`](https://github.com/LTplus-AG/ifc-lite/commit/f6febcc2d4986e79b3c44d63853bb72a16475c65), [`bc2e5e5`](https://github.com/LTplus-AG/ifc-lite/commit/bc2e5e56d7324f605b15b6e6f939849859a5d0ad), [`1118399`](https://github.com/LTplus-AG/ifc-lite/commit/11183991d9fb042221d20f1ca432dc0b2293c928), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`063a140`](https://github.com/LTplus-AG/ifc-lite/commit/063a1408e4c54ebc874618f8d68fe298ed3f3a6f), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`f7e26e4`](https://github.com/LTplus-AG/ifc-lite/commit/f7e26e4200e1475728d4976142b49cb408400a8e), [`f76c805`](https://github.com/LTplus-AG/ifc-lite/commit/f76c80511dce5ffc1756365b786042c4bc64808d), [`75867a7`](https://github.com/LTplus-AG/ifc-lite/commit/75867a7e6ebf51b2da47cab14242bcd71787ba3b), [`75867a7`](https://github.com/LTplus-AG/ifc-lite/commit/75867a7e6ebf51b2da47cab14242bcd71787ba3b), [`4a8fe77`](https://github.com/LTplus-AG/ifc-lite/commit/4a8fe77707127d251702610490f53430610e4ef7), [`ffcc9e6`](https://github.com/LTplus-AG/ifc-lite/commit/ffcc9e6f048cd263a5b70946417c9b6aceec1bec), [`4a8fe77`](https://github.com/LTplus-AG/ifc-lite/commit/4a8fe77707127d251702610490f53430610e4ef7), [`f7e26e4`](https://github.com/LTplus-AG/ifc-lite/commit/f7e26e4200e1475728d4976142b49cb408400a8e), [`0146f0a`](https://github.com/LTplus-AG/ifc-lite/commit/0146f0a3b2ed36313f7f91236bcc95587cdcc8d3), [`f449776`](https://github.com/LTplus-AG/ifc-lite/commit/f4497765cb4e17828ff6ca6b52fb8a96caa2f81f), [`5ea5f99`](https://github.com/LTplus-AG/ifc-lite/commit/5ea5f9969f3a4a3f8b21eb2a90a1df2be48eb7b0), [`412f78c`](https://github.com/LTplus-AG/ifc-lite/commit/412f78c1bf4907f8c230fc149bbb00e0711b6689), [`487866d`](https://github.com/LTplus-AG/ifc-lite/commit/487866dac131bf50a0b3008ddce5db933768dca2), [`932f043`](https://github.com/LTplus-AG/ifc-lite/commit/932f0439fc1625419aae3cf2d9f81a614fb2273c), [`f1ee3e8`](https://github.com/LTplus-AG/ifc-lite/commit/f1ee3e88889281af34f0e382cef7ea57ee9d47c1), [`24c0d75`](https://github.com/LTplus-AG/ifc-lite/commit/24c0d75c5e5f1f162737e82e1ff24f7958b9f9b6), [`754837b`](https://github.com/LTplus-AG/ifc-lite/commit/754837b066172dad8afcdf1a0104f1a021b5f6e5), [`2273a73`](https://github.com/LTplus-AG/ifc-lite/commit/2273a73127d03ec36d667544da6237479737881a), [`131e3dc`](https://github.com/LTplus-AG/ifc-lite/commit/131e3dc84244d9dd24859a5923ef0aef4d6119c4), [`a8587cc`](https://github.com/LTplus-AG/ifc-lite/commit/a8587cc21c309ebd6c87119cb0d1cd6d1005c281), [`945c4d7`](https://github.com/LTplus-AG/ifc-lite/commit/945c4d7a773614dd664feb9490e13372782a543b), [`fdd6121`](https://github.com/LTplus-AG/ifc-lite/commit/fdd61211e41d3e563a7604ac5e0630a9daae2de1), [`b59c520`](https://github.com/LTplus-AG/ifc-lite/commit/b59c5206a154728139d1307bf823e5c5d7c4786a), [`870ec9e`](https://github.com/LTplus-AG/ifc-lite/commit/870ec9ee9a35f798196c59ce82e65e210eddd429), [`00f6e79`](https://github.com/LTplus-AG/ifc-lite/commit/00f6e79c22641ff59bfb3327d910b04f9a164d8b), [`116a3e9`](https://github.com/LTplus-AG/ifc-lite/commit/116a3e94de753b95fa94b2d6c41a0171cd254729), [`75867a7`](https://github.com/LTplus-AG/ifc-lite/commit/75867a7e6ebf51b2da47cab14242bcd71787ba3b), [`147693a`](https://github.com/LTplus-AG/ifc-lite/commit/147693a7a8fd0778ddb71839199b75bf1d622327), [`af48854`](https://github.com/LTplus-AG/ifc-lite/commit/af488542a19a8559065cfd450d0eaad5ba2f7489), [`3969c52`](https://github.com/LTplus-AG/ifc-lite/commit/3969c523063d02e501f421e6b42d1a9a516dc2e4), [`bb734da`](https://github.com/LTplus-AG/ifc-lite/commit/bb734da27afbea4b6e595714950cdb195cddeb1f), [`043e06a`](https://github.com/LTplus-AG/ifc-lite/commit/043e06a05c6625fef91bb17d84e3a3447f1379e3)]:
  - @ifc-lite/bcf@2.0.0
  - @ifc-lite/parser@4.3.0
  - @ifc-lite/collab@0.6.0
  - @ifc-lite/extensions@0.5.0
  - @ifc-lite/ifcx@3.0.0
  - @ifc-lite/merge@0.4.4
  - @ifc-lite/export@3.0.0
  - @ifc-lite/sdk@3.0.0
  - @ifc-lite/data@3.4.1
  - @ifc-lite/geometry@4.0.0
  - @ifc-lite/query@2.0.0
  - @ifc-lite/ids@1.15.49
  - @ifc-lite/clash@1.9.1
  - @ifc-lite/mutations@1.27.0
  - @ifc-lite/viewer-core@0.2.14
  - @ifc-lite/create@2.2.0

## 0.11.3

### Patch Changes

- [#2845](https://github.com/LTplus-AG/ifc-lite/pull/2845) [`8226c0a`](https://github.com/LTplus-AG/ifc-lite/commit/8226c0aae9c4ca641b970873c0a0adf648429205) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix two declared-but-ignored MCP tool inputs.
  
  `ids_validate`'s `locale` field (`en`/`de`/`fr`) was read into a variable and immediately discarded (`void input.locale`); no translator was ever built, so every call produced English `failureReason` / requirement-description text regardless of the requested locale. It now builds a `@ifc-lite/ids` translation service from `locale` and passes it into `validateIDS`, so `de`/`fr` actually translate the report.
  
  `geometry_bbox` / `geometry_volume` / `geometry_area`'s `global_id` / `global_ids` selectors resolved by scanning the parsed store directly, never consulting the session's pending-mutation overlay. That put them out of step with every other GlobalId-keyed tool (`get_entity`, `query_entities`, `bsdd_match`, `entity_delete`, ...), which all fold the overlay per the [#2014](https://github.com/LTplus-AG/ifc-lite/issues/2014)/[#2015](https://github.com/LTplus-AG/ifc-lite/issues/2015) one-resolution-rule: an entity created this session (`entity_create`) was invisible to the geometry tools by GlobalId even though `get_entity` found it immediately, and an entity queued for deletion (`entity_delete`) stayed resolvable there after `get_entity` already reported it gone. `resolveExpressIds` now resolves `global_id`/`global_ids` through the same overlay-aware `resolveGlobalIds` helper `get_entity` and `entity_delete` use.

- [#2734](https://github.com/LTplus-AG/ifc-lite/pull/2734) [`2edf1c6`](https://github.com/LTplus-AG/ifc-lite/commit/2edf1c60023832a7a9a3629e9d5aaa40e4be1e35) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `ServerConfig.autoOpenViewer` / `.viewerPort` being declared on the public
  `MCPServer` config type but never read by the server (issue [#2731](https://github.com/LTplus-AG/ifc-lite/issues/2731), finding 4).
  
  `MCPServer` takes `config: Partial<ServerConfig>` in its constructor, and the
  sibling fields `readOnly`, `bsddEndpoint`, `samplingEnabled` and
  `allowedPaths` are honoured via `ctx.config.*` — but `autoOpenViewer` and
  `viewerPort` were not. The CLI's own `--viewer` / `--viewer-port` auto-open
  behaviour came entirely from separate local variables (`opts.autoViewer`,
  `opts.viewerPort`) that happened to be written into `config` but never read
  back out of it. An embedder constructing `MCPServer` directly with
  `config: { autoOpenViewer: true }` got nothing, silently.
  
  Adds `MCPServer.maybeAutoOpenViewer(overrides?)`, which opens the in-process
  viewer for the first loaded model when configured to do so and no-ops
  otherwise. Precedence: an explicit `overrides` argument (what a CLI flag
  represents) beats `this.config` (set at construction, e.g. by an embedder)
  beats the built-in default (no auto-open, port 0). The CLI now calls this
  method with `{ autoOpen: opts.autoViewer, port: opts.viewerPort }` instead of
  calling `server.viewer.open()` directly, so its `--viewer` / `--viewer-port`
  behaviour is unchanged but now goes through the same config-aware path any
  other caller gets.

- [#2850](https://github.com/LTplus-AG/ifc-lite/pull/2850) [`5660d53`](https://github.com/LTplus-AG/ifc-lite/commit/5660d53f5326188c474bb0c31d3e1ff6b104426c) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `mutation_batch` dispatching each sub-op with its raw, pre-validation `args` instead of `validateInput`'s validated result.
  
  Same shape as the collab-server bug in [#2846](https://github.com/LTplus-AG/ifc-lite/issues/2846): `mutation_batch`'s per-op loop already calls `validateInput(tool.inputSchema, subArgs)` and checks `validation.valid`, but then handed `subArgs` — the original, unvalidated object — to `tool.handler`, discarding `validation.value`. A single, non-batched call to the same tool goes through `MCPServer.handleToolCall`, which correctly dispatches with `validation.value` (the schema-default-filled result).
  
  No sub-tool on the batch whitelist (`entity_set_property`, `entity_delete_property`, `entity_set_attribute`, `entity_create`, `entity_delete`) currently declares a schema `default`, so this had no observable effect today — but the moment one does, a batched call and a single call would silently disagree about what an omitted field means, exactly like the `handleMessage`/`verifyWithReplayProtector` divergence, and the mismatch would be invisible to any test that only exercises `validateInput` in isolation or only exercises the reject path through `mutation_batch`.
  
  `mutation_batch` now dispatches with `validation.value`, matching the single-call path.
- Updated dependencies [[`b9faf82`](https://github.com/LTplus-AG/ifc-lite/commit/b9faf8296f86943914c30550af8131fee250d4c8), [`8f89331`](https://github.com/LTplus-AG/ifc-lite/commit/8f893311b170a983e160737bd9479c3caf961911), [`bc179f6`](https://github.com/LTplus-AG/ifc-lite/commit/bc179f6a1091c8c307a07b31d8c30fbba140e4a9), [`b9faf82`](https://github.com/LTplus-AG/ifc-lite/commit/b9faf8296f86943914c30550af8131fee250d4c8), [`48b204b`](https://github.com/LTplus-AG/ifc-lite/commit/48b204b868016aad29b694b53ac8ace5e76a0542), [`b14e710`](https://github.com/LTplus-AG/ifc-lite/commit/b14e710ae8d56f518f84abb4d4ec8d1f98aacad8), [`05592f8`](https://github.com/LTplus-AG/ifc-lite/commit/05592f8c1ef5b34a00c2ea077542dc68107a7ae5), [`432fdb8`](https://github.com/LTplus-AG/ifc-lite/commit/432fdb8dd12dd90af17d1ca3ce24a2fd5b7168b0), [`6a43522`](https://github.com/LTplus-AG/ifc-lite/commit/6a43522cdf3b0a9b0f7ce303b59f479dca2a2aca), [`b699875`](https://github.com/LTplus-AG/ifc-lite/commit/b6998754039676def950735335147556afcb2977), [`b3a4d30`](https://github.com/LTplus-AG/ifc-lite/commit/b3a4d307c50c9b0a8b8bb0e29952c4a98e417c16), [`0a10389`](https://github.com/LTplus-AG/ifc-lite/commit/0a1038972a72b27bda99c8793055efe39d623f10), [`5334bd1`](https://github.com/LTplus-AG/ifc-lite/commit/5334bd1589acb1c4b81a1f255d1a9171530b1467), [`b1ac6be`](https://github.com/LTplus-AG/ifc-lite/commit/b1ac6be425cd89ff90eaab02636211f0d928b3e6), [`c688a12`](https://github.com/LTplus-AG/ifc-lite/commit/c688a1272ec72d575e8ecf78072e0a0084b517ca), [`4ce3879`](https://github.com/LTplus-AG/ifc-lite/commit/4ce38798211b6b5f84e5b21ed335aa80fe1514c4), [`79322b6`](https://github.com/LTplus-AG/ifc-lite/commit/79322b6e76049be0df3b07149c711414bd80863e), [`2156528`](https://github.com/LTplus-AG/ifc-lite/commit/2156528c926114233c79ba74925c0c8656f1ea65), [`7869a90`](https://github.com/LTplus-AG/ifc-lite/commit/7869a90f35384ceba40b7ce4f3e9fadbe6990fa8), [`be6b43c`](https://github.com/LTplus-AG/ifc-lite/commit/be6b43c2b334811422c1cbfbea5d6e6d1b9a401d), [`989ee2c`](https://github.com/LTplus-AG/ifc-lite/commit/989ee2c4e396575529488c17b73e1a884e4e8b9d), [`1cda2d0`](https://github.com/LTplus-AG/ifc-lite/commit/1cda2d04dc66542892dd0181768c027b3d1b4e6f), [`b4740a1`](https://github.com/LTplus-AG/ifc-lite/commit/b4740a1fb18050c065e8fbd58714626bdf852f00), [`5a9ecfb`](https://github.com/LTplus-AG/ifc-lite/commit/5a9ecfb6bcd3190eae4463bd8926cf38a2143496), [`9fb50eb`](https://github.com/LTplus-AG/ifc-lite/commit/9fb50ebcfaaf2926b2badd4d4d8dfc6ca55b762f), [`969cff9`](https://github.com/LTplus-AG/ifc-lite/commit/969cff95a77ce4c17a949a93632c8a0378fd3ede), [`a29b040`](https://github.com/LTplus-AG/ifc-lite/commit/a29b04069fec3c6b726f49fc58054e535c255034), [`cc19a8d`](https://github.com/LTplus-AG/ifc-lite/commit/cc19a8d4a79a5e8563a90ab663b28e1b93ef9c18), [`36e4eca`](https://github.com/LTplus-AG/ifc-lite/commit/36e4eca3b19a2fe02f1679acc9a2a43cd90aa163), [`a7b8a20`](https://github.com/LTplus-AG/ifc-lite/commit/a7b8a201eaecd411a4246421893e887bf55aafd3), [`ad50aa9`](https://github.com/LTplus-AG/ifc-lite/commit/ad50aa9751c31f6895944e26ce19fe8cbbf3018e), [`ccc38b0`](https://github.com/LTplus-AG/ifc-lite/commit/ccc38b0de9925a3de1106893a5785117e0e7551d), [`105eb31`](https://github.com/LTplus-AG/ifc-lite/commit/105eb31e7ccdd697f74db3bc9fac41396cdc6faa), [`679c7cb`](https://github.com/LTplus-AG/ifc-lite/commit/679c7cb680ab0d8f17e8f5c267fdb424049ec0d0), [`ae14cd3`](https://github.com/LTplus-AG/ifc-lite/commit/ae14cd3036f11c039d9b7cd786acf51a68b884dc), [`f31822b`](https://github.com/LTplus-AG/ifc-lite/commit/f31822b0833e1bcd76c43736daf1d76cb3e59914), [`4d1c611`](https://github.com/LTplus-AG/ifc-lite/commit/4d1c611b822e80a6123b040887a31cdb43c460da), [`5254699`](https://github.com/LTplus-AG/ifc-lite/commit/52546994268440a468de81ce6ac0b385e6ef73d7), [`c233d48`](https://github.com/LTplus-AG/ifc-lite/commit/c233d48a935a70851271b61a305f43dd9261dcca), [`b28a629`](https://github.com/LTplus-AG/ifc-lite/commit/b28a629d49f279ce01537cb06ae4c28f32beb2bb), [`1900a1a`](https://github.com/LTplus-AG/ifc-lite/commit/1900a1a9f8174ef874dddbd1541ccadd9a89415e), [`6ce17fa`](https://github.com/LTplus-AG/ifc-lite/commit/6ce17fa903d38ab8ee3e6ebaf6da8453726d3ce2), [`b7d2a11`](https://github.com/LTplus-AG/ifc-lite/commit/b7d2a11345add8acdf0926ade5d4c1ca19ccecf7), [`c849b13`](https://github.com/LTplus-AG/ifc-lite/commit/c849b1395511e48ed6c8b6bd01bc0b1a66d60bfa), [`adc37ca`](https://github.com/LTplus-AG/ifc-lite/commit/adc37cac288e53be88796fddf06b0a7ae179f451), [`2affb53`](https://github.com/LTplus-AG/ifc-lite/commit/2affb534e8ed7b339dc52984789638d4ea4774bc), [`adc37ca`](https://github.com/LTplus-AG/ifc-lite/commit/adc37cac288e53be88796fddf06b0a7ae179f451), [`f19206b`](https://github.com/LTplus-AG/ifc-lite/commit/f19206b8912ba418627373e147c1699019450ebf), [`c49c7f6`](https://github.com/LTplus-AG/ifc-lite/commit/c49c7f644cd7930bd3937ed850f3864aa516934b)]:
  - @ifc-lite/bcf@1.18.2
  - @ifc-lite/collab@0.5.0
  - @ifc-lite/mutations@1.26.1
  - @ifc-lite/clash@1.9.0
  - @ifc-lite/geometry@3.8.4
  - @ifc-lite/parser@4.2.0
  - @ifc-lite/query@1.14.17
  - @ifc-lite/data@3.4.0
  - @ifc-lite/ids@1.15.48
  - @ifc-lite/create@2.1.2
  - @ifc-lite/ifcx@2.3.7
  - @ifc-lite/sdk@2.1.3
  - @ifc-lite/export@2.9.4
  - @ifc-lite/merge@0.4.3
  - @ifc-lite/viewer-core@0.2.13

## 0.11.2

### Patch Changes

- Updated dependencies [[`7f2d9cf`](https://github.com/LTplus-AG/ifc-lite/commit/7f2d9cf1fdcf8facd9bf3f1445ddf3c665206b76), [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6), [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6), [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6), [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6), [`8324512`](https://github.com/LTplus-AG/ifc-lite/commit/8324512daee39a018056aa88a148f72791db89c4), [`5cf117d`](https://github.com/LTplus-AG/ifc-lite/commit/5cf117d1eb16dba7f3e7be67114e26ce3ec44a8f), [`5086c57`](https://github.com/LTplus-AG/ifc-lite/commit/5086c5729b6ae8ad967aafa91d96dfdb37327599), [`307693c`](https://github.com/LTplus-AG/ifc-lite/commit/307693c678d525ab007773f74e13a308bfe63b34), [`649aa0c`](https://github.com/LTplus-AG/ifc-lite/commit/649aa0ccbc4e67c233b9175a6a2f9c8e1ff310ec), [`2d87b39`](https://github.com/LTplus-AG/ifc-lite/commit/2d87b3919c0ca5afff03e205c5f598142bbc980d), [`5086c57`](https://github.com/LTplus-AG/ifc-lite/commit/5086c5729b6ae8ad967aafa91d96dfdb37327599), [`7cd8193`](https://github.com/LTplus-AG/ifc-lite/commit/7cd81939ed4acf9e93686d1d96dddcf7606fb59a)]:
  - @ifc-lite/clash@1.7.0
  - @ifc-lite/parser@4.1.0
  - @ifc-lite/geometry@3.8.3
  - @ifc-lite/diff@0.7.0
  - @ifc-lite/export@2.9.2
  - @ifc-lite/ids@1.15.47
  - @ifc-lite/sdk@2.1.2
  - @ifc-lite/ifcx@2.3.6
  - @ifc-lite/merge@0.4.2

## 0.11.1

### Patch Changes

- [#2389](https://github.com/LTplus-AG/ifc-lite/pull/2389) [`e20c520`](https://github.com/LTplus-AG/ifc-lite/commit/e20c520b0c898ecd3c418e338e3684d6f9f39fed) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Move `await gp.init()` inside the `try` in `export_glb`, `export_obj`, `export_ifcx`, and `export_usd`, so an `init()` rejection reaches `dispose()` instead of skipping it.

  All four handlers in `packages/mcp/src/tools/export.ts` called `await gp.init()` before the `try { ... } finally { gp.dispose(); }` block, so an `init()` rejection bypassed `dispose()` entirely. `packages/mcp/src/tools/clash.ts` already used the correct shape; all four export tools now match it.

  Scope, stated precisely: this makes the cleanup path _reachable_, which is the shape the codebase already standardises on, but on today's code the recovered `dispose()` is a no-op. `IfcLiteBridge.init()` catches its own failures and calls `reset()`, which nulls `ifcApi` without calling `free()` (`packages/geometry/src/ifc-lite-bridge.ts:229`), and `dispose()` is optional-chained on that now-null handle. So a WASM handle allocated before a late `init()` throw is still not freed after this change — the leak lives one layer down, in the bridge's own error path, and is tracked separately. This change is correct and defensive, but it should not be read as closing that leak.

- [#2328](https://github.com/LTplus-AG/ifc-lite/pull/2328) [`d27d043`](https://github.com/LTplus-AG/ifc-lite/commit/d27d043c62a0243ac95c4b25d7262e96622f3e3e) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `descriptor.limit` / `descriptor.offset` in the read backend (`backend-query.ts`) silently ignoring a non-numeric, negative, or `Infinity` value instead of rejecting it. `descriptor.offset && descriptor.offset > 0` (and the equivalent for `limit`) is falsy for `NaN` — every comparison with `NaN` is false — so a caller that computed a bad value from e.g. `Number(userInput)` got back every matching row instead of an error, silently returning more than it asked for. The same falsy-zero shape made `limit: 0` ("no rows") a no-op instead, silently returning every row.

  No built-in MCP tool reaches this today: `query_entities` validates `limit`/`offset` as JSON-Schema integers before its handler runs and paginates separately via its own `paginate()` helper rather than the query builder's `.limit()/.offset()`. The live path is the public SDK surface — `HeadlessLikeBackend` is exported from both `./index.js` and `./browser.js` for embedders, and driving it through `@ifc-lite/sdk`'s fluent `QueryBuilder` (`bim.query().limit(n).offset(m).toArray()`) reaches `descriptor.limit`/`descriptor.offset` directly, unguarded by any tool schema.

  `entities()` now throws on a non-finite or negative `limit`/`offset` instead of quietly serving the wrong slice. `limit: 0` is now a deliberate empty result rather than being silently ignored — a behaviour change, not just a bugfix, and nothing in this package uses `0` as an "unlimited" sentinel.

  Same defect shape as the CLI's `headless-backend.ts` fix ([#2298](https://github.com/LTplus-AG/ifc-lite/issues/2298)); `packages/mcp` has its own parallel implementation of this adapter (not a shared import), with its own tests and release cadence, so it needed its own fix.

- [#2297](https://github.com/LTplus-AG/ifc-lite/pull/2297) [`4565cf3`](https://github.com/LTplus-AG/ifc-lite/commit/4565cf3bf8e04a289cf066a8858ded7c972c1c21) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `mutation_undo` reporting mutations as reverted while leaving the overlay untouched. It only trimmed `MutablePropertyView`'s append-only mutation-history array (documented in `@ifc-lite/mutations` as _not_ poppable for undo) and never reverted the actual property/attribute/entity overlay state, so a caller that undid an edit and then read the entity back still saw the edited value — the tool claimed success on an operation that did nothing. `mutation_undo` now applies the inverse of each reverted mutation (property set/create/delete, attribute set, entity create/delete) to the live overlay, mirroring the viewer's undo-stack dispatch.

  Also fixes `entity_set_attribute` never recording the attribute's prior value in its mutation record, so any consumer of `Mutation.oldValue` (including the undo above) restored to an empty value instead of the true original.

- [#2158](https://github.com/LTplus-AG/ifc-lite/pull/2158) [`15f3c23`](https://github.com/LTplus-AG/ifc-lite/commit/15f3c23a417d3af29a0a8302ce68173b016c6369) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `fullScope()` and `readOnlyScope()` now copy the `scopes` array as well as the
  wrapper object. The shallow spread handed every caller the same array instance
  as the exported `FULL_ACCESS` / `READ_ONLY` constants, so an in-place mutation
  (`readOnlyScope().scopes.push('mutate')`) widened the constant itself and every
  token minted afterwards in the same process carried the extra scope.

- [#2339](https://github.com/LTplus-AG/ifc-lite/pull/2339) [`de7bd04`](https://github.com/LTplus-AG/ifc-lite/commit/de7bd04619a43a32900b188e0507b95e7542d8c8) Thanks [@louistrue](https://github.com/louistrue)! - **Breaking:** `IfcDataStore.source` is now an `IfcSourceBytes` accessor instead of a `Uint8Array` ([#2183](https://github.com/LTplus-AG/ifc-lite/issues/2183)).

  On a 342 MB model the source is 327 MB of the ~671 MB the viewer's main thread holds, and it is resident for the model's whole lifetime because property and attribute reads slice it synchronously during render. The contract "here are all the bytes, contiguous, forever" is what blocks any cheaper representation; the accessor replaces it with "ask for the range you need", which makes every whole-file consumer an explicit `materialize()` call you can see and count.

  This release is behaviour-neutral: the only implementation shipped is the contiguous one, whose `slice` is a `subarray`. STEP export is byte-identical across the default, header-fallback, `visibleOnly`, merged and merged-`visibleOnly` paths (verified against a 44,249-entity model, both new reads mutation-checked). The compressed block-backed implementation lands behind the same interface.

  **Migrating.** Most guards need no change: `byteLength`, `length` and truthiness behave exactly as they did, so the existing `!store.source?.length` shape still compiles and still means the same thing.

  - Reading a range — `store.source.slice(a, b)` and `new TextDecoder().decode(...)` become `store.source.decodeUtf8(a, b)`. `slice` still returns a view.
  - Needing the whole file — `store.source.withMaterialized(bytes => ...)` (or `withMaterializedAsync`), which scopes the buffer so it cannot outlive the call. `materialize()` exists for the cases where scoping is impractical.
  - Constructing a store — wrap with `contiguousSourceBytes(bytes)`, or `EMPTY_SOURCE_BYTES` for stores with no source (server-parsed, synthetic, GLB, point cloud). Helpers that must accept both shapes can normalise with `asSourceBytes`.
  - `parseSourceHeader` now accepts either shape and reads only the first 64 KiB, so exporters no longer materialise a whole file to read its header.
  - `fromTransport` passes an `IfcSourceBytes` argument straight through rather than re-wrapping it. Hydrating several stores from one source (the streaming parser's partial + final pair) should share one accessor, so the memoised `contentKey` is computed once.
  - `toTransferable()` no longer forces the `contentKey` hash. Describing a source for a worker is meant to be cheap; computing the key there would walk the whole file on the sending thread. It now carries the key only when something has already computed it, and `sourceBytesFromTransferable` reads a `null` key as "not computed yet" so the receiver hashes lazily to the same value.

  New exports from `@ifc-lite/parser`: `contiguousSourceBytes`, `EMPTY_SOURCE_BYTES`, `isSourceBytes`, `sourceBytesFromTransferable`, and the `IfcSourceTransfer` type. (`toTransferable` is on the public interface, so its inverse belongs in the same surface -- otherwise a consumer can produce a transfer envelope with no supported way to rehydrate one.) (`asSourceBytes` and the `IfcSourceBytes` type were already exported by the widening step above.)

  `isSourceBytes` is exported because a store built behind an `as unknown as` cast cannot be type-checked on this field, so the contract has to be assertable at runtime -- which is how a producer that kept handing over a raw `Uint8Array` was found.

- Updated dependencies [[`1843d9f`](https://github.com/LTplus-AG/ifc-lite/commit/1843d9f13a7a10183f780ae0a1df9dd225938e73), [`8b09cfd`](https://github.com/LTplus-AG/ifc-lite/commit/8b09cfdadafaea9806e79b73deb9119ea66b5aa4), [`160bf1f`](https://github.com/LTplus-AG/ifc-lite/commit/160bf1fda7ad5f2c7921b833982a53acd1ee79ad), [`a220406`](https://github.com/LTplus-AG/ifc-lite/commit/a2204062ba1fc555e4529896cbc82efccc7a5146), [`29409e5`](https://github.com/LTplus-AG/ifc-lite/commit/29409e57227d3c458707dbc2cf0cb2e8ae8fcf7b), [`5dd1d18`](https://github.com/LTplus-AG/ifc-lite/commit/5dd1d181437bf0d1d357f3c5505049f802beb2cf), [`6635ddf`](https://github.com/LTplus-AG/ifc-lite/commit/6635ddfa91911b0fbc489452c02cf19e232201c3), [`6f5566f`](https://github.com/LTplus-AG/ifc-lite/commit/6f5566fa761f25a02818a750351b0b0db785ef9b), [`55f7591`](https://github.com/LTplus-AG/ifc-lite/commit/55f759154421bd002d0bdc171e82aa93b574470d), [`d260a35`](https://github.com/LTplus-AG/ifc-lite/commit/d260a35669e379e5f465861294391c95ee48cb3d), [`d75786f`](https://github.com/LTplus-AG/ifc-lite/commit/d75786f631047d234f204289426f708f0be8674b), [`51cd3ab`](https://github.com/LTplus-AG/ifc-lite/commit/51cd3ab46c7f9d40588e319e7b2c24ce66e99c29), [`79781f5`](https://github.com/LTplus-AG/ifc-lite/commit/79781f57c50bbc9641516a42d0de53e5b9d89932), [`403f448`](https://github.com/LTplus-AG/ifc-lite/commit/403f4485c21b9928f16566fa482c170f230852b0), [`58fbc63`](https://github.com/LTplus-AG/ifc-lite/commit/58fbc634994742c79375830c1983508752fd78e9), [`a220406`](https://github.com/LTplus-AG/ifc-lite/commit/a2204062ba1fc555e4529896cbc82efccc7a5146), [`c866bee`](https://github.com/LTplus-AG/ifc-lite/commit/c866bee62a7d6e40b15a7de63948354cbbe049a7), [`262b9df`](https://github.com/LTplus-AG/ifc-lite/commit/262b9df485e4bfd3760f73c30d93bb518e599b72), [`2e16736`](https://github.com/LTplus-AG/ifc-lite/commit/2e167367037fa3b5d1d2d5d26dd4fb7ac169e2f5), [`710fd83`](https://github.com/LTplus-AG/ifc-lite/commit/710fd83638b51b2e4744a1ac364827a27dc0fc73), [`d9490e6`](https://github.com/LTplus-AG/ifc-lite/commit/d9490e6e2ecacb65aea42fcaef73fd292a4c3095), [`55f7591`](https://github.com/LTplus-AG/ifc-lite/commit/55f759154421bd002d0bdc171e82aa93b574470d), [`d89960a`](https://github.com/LTplus-AG/ifc-lite/commit/d89960aaab08387fbd2307c0f238bd112c684933), [`f67c622`](https://github.com/LTplus-AG/ifc-lite/commit/f67c622147ea51f2b04b93a7b7a9b485160b3e9c), [`33f11a8`](https://github.com/LTplus-AG/ifc-lite/commit/33f11a82d34b622c9d6d2c417e9fb38a7ace816e), [`8751ba4`](https://github.com/LTplus-AG/ifc-lite/commit/8751ba41dc4d1893530b0f1db6ad0f8fa0d5d3fd), [`deb54d3`](https://github.com/LTplus-AG/ifc-lite/commit/deb54d3ff75f35c3c9206c8ea9a1e875426352c6), [`51ec81b`](https://github.com/LTplus-AG/ifc-lite/commit/51ec81b125532cd0efe4f004c7ab01f4efe55cb8), [`35e37ac`](https://github.com/LTplus-AG/ifc-lite/commit/35e37ac99ab444773bfec669cfc5cf3937443942), [`dae94e2`](https://github.com/LTplus-AG/ifc-lite/commit/dae94e23f7514945ca60f7074f50f196a90dfc5d), [`8d1972d`](https://github.com/LTplus-AG/ifc-lite/commit/8d1972d059fe5e8725fffbf661cc56bb6a23767b), [`6d52ca3`](https://github.com/LTplus-AG/ifc-lite/commit/6d52ca369fa7cece428a15bedd69ae1d933b888f), [`958aef1`](https://github.com/LTplus-AG/ifc-lite/commit/958aef125743682da75c3da7b41991abd9d36d32), [`de7bd04`](https://github.com/LTplus-AG/ifc-lite/commit/de7bd04619a43a32900b188e0507b95e7542d8c8), [`09d67c7`](https://github.com/LTplus-AG/ifc-lite/commit/09d67c780bf68f58dec3f77920927857c752f8da), [`72bf949`](https://github.com/LTplus-AG/ifc-lite/commit/72bf949bd3a58dfb460c2c445e546d930a248e02), [`512406f`](https://github.com/LTplus-AG/ifc-lite/commit/512406f0d21c7e33b8c84a83865ffaff299e7cc1), [`5d763d6`](https://github.com/LTplus-AG/ifc-lite/commit/5d763d6bde10c0232cbf28e7d8e4e956ebaf4ff1)]:
  - @ifc-lite/bcf@1.17.0
  - @ifc-lite/viewer-core@0.2.12
  - @ifc-lite/collab@0.4.2
  - @ifc-lite/create@2.0.2
  - @ifc-lite/merge@0.4.1
  - @ifc-lite/export@2.8.3
  - @ifc-lite/query@1.14.16
  - @ifc-lite/data@3.2.2
  - @ifc-lite/ids@1.15.42
  - @ifc-lite/ifcx@2.3.4
  - @ifc-lite/parser@4.0.0
  - @ifc-lite/mutations@1.24.2
  - @ifc-lite/geometry@3.7.1
  - @ifc-lite/clash@1.6.5
  - @ifc-lite/sdk@2.0.3

## 0.11.0

### Minor Changes

- [#2052](https://github.com/LTplus-AG/ifc-lite/pull/2052) [`d44b6c1`](https://github.com/LTplus-AG/ifc-lite/commit/d44b6c1710ee86596e96e0204785d2bf7c0940a9) Thanks [@louistrue](https://github.com/louistrue)! - Add OpenUSD ASCII (`.usda`) export — a real Z-up USD stage, distinct from the existing IFCX (USD-flavored JSON) export.

  The stage mirrors the IFC spatial hierarchy as `Xform` prims with `UsdGeomMesh` geometry, `UsdPreviewSurface` materials, and IFC metadata (`ifc:class`, `ifc:GlobalId`, property/quantity sets) as custom attributes; it opens in usdview / Blender / Omniverse. Geometry outside the spatial tree (opening elements, type-product meshes) is placed under a synthetic `Unassigned` prim rather than dropped, and each mesh carries its placement as a `double3 xformOp:translate` so georeferenced models keep full precision.

  - `@ifc-lite/geometry`: `GeometryProcessor.exportUsd(bytes)` (and `IfcLiteBridge.exportUsd`) returning the `.usda` bytes.
  - `@ifc-lite/cli`: `ifc-lite export --format usd` (whole-model; entity filters do not apply).
  - `@ifc-lite/mcp`: the `export_usd` tool.

### Patch Changes

- [#2125](https://github.com/LTplus-AG/ifc-lite/pull/2125) [`07c0b4c`](https://github.com/LTplus-AG/ifc-lite/commit/07c0b4cc5a0b5617ed6ad300639e5c52ce225d44) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `ViewerManager` now warns once per session when an SSE frame from the viewer fails to parse as JSON, or when GlobalId enrichment fails for a picked selection ([#2100](https://github.com/LTplus-AG/ifc-lite/issues/2100) follow-up). Both paths still degrade the same way as before — a bad frame is dropped, a selection without a GlobalId is still reported — but they no longer swallow the failure with no diagnostic at all. Both triggers are viewer-client controlled and can repeat at high frequency (once per frame, once per pick), so the warning is a once-per-session latch rather than a per-occurrence log, reset the next time `open()` starts a session.

- Updated dependencies [[`2c47277`](https://github.com/LTplus-AG/ifc-lite/commit/2c47277ee6dfbd9779eb4948d1f2e7b0ea61d00e), [`5371d7d`](https://github.com/LTplus-AG/ifc-lite/commit/5371d7def2671f6568c838879b8be058bb6247c9), [`bdeb80d`](https://github.com/LTplus-AG/ifc-lite/commit/bdeb80d79443d89027a4d96879116e99dcc989a4), [`b3742d9`](https://github.com/LTplus-AG/ifc-lite/commit/b3742d9d29c3adfcbf67f573c62194547d7d172d), [`803005f`](https://github.com/LTplus-AG/ifc-lite/commit/803005f1c8d976350111c2f52a6b41b584393ca6), [`4c739be`](https://github.com/LTplus-AG/ifc-lite/commit/4c739be2aba74ad6868b6dca51dad441c6fa9903), [`f493930`](https://github.com/LTplus-AG/ifc-lite/commit/f4939309aed136979bd5cc1f95a25c2a0ebe779f), [`befc108`](https://github.com/LTplus-AG/ifc-lite/commit/befc1083e377315231006352cb3fe95949e92b47), [`6722e08`](https://github.com/LTplus-AG/ifc-lite/commit/6722e08b76c4cd89d8e7e1bbd06c768a36ae93ac), [`6cbf69a`](https://github.com/LTplus-AG/ifc-lite/commit/6cbf69acb2163ab671c41df36878f4d4e490e244), [`0ceb99a`](https://github.com/LTplus-AG/ifc-lite/commit/0ceb99a36125a2dfc8775e762d9f4f9ddb69d733), [`3c2ffa6`](https://github.com/LTplus-AG/ifc-lite/commit/3c2ffa6a1bd0a04d3d73e2ea7c0fb1a2233599a9), [`d44b6c1`](https://github.com/LTplus-AG/ifc-lite/commit/d44b6c1710ee86596e96e0204785d2bf7c0940a9)]:
  - @ifc-lite/geometry@3.7.0
  - @ifc-lite/export@2.8.2
  - @ifc-lite/mutations@1.24.1
  - @ifc-lite/data@3.2.1
  - @ifc-lite/create@2.0.1
  - @ifc-lite/extensions@0.4.1
  - @ifc-lite/sdk@2.0.2
  - @ifc-lite/parser@3.15.1
  - @ifc-lite/ifcx@2.3.3
  - @ifc-lite/ids@1.15.41

## 0.10.0

### Minor Changes

- [#2036](https://github.com/LTplus-AG/ifc-lite/pull/2036) [`a8e58a2`](https://github.com/LTplus-AG/ifc-lite/commit/a8e58a2b5e75db8388835c77b2688240667f68ab) Thanks [@louistrue](https://github.com/louistrue)! - `export_ifc`'s `global_ids` allowlist reaches entities the session created, and fails closed when it matches nothing ([#2012](https://github.com/LTplus-AG/ifc-lite/issues/2012)).

  Two problems, and the second was the worse one. A mixed allowlist naming both a created and a parsed entity exported only the parsed one, because the exporter's visible-only closure could not see an overlay-created id — fixed in `@ifc-lite/export`. And an allowlist that matched **nothing** produced an empty ref set, which the export adapter reads as "no filter": asking to export one created entity wrote the entire model to disk and reported success. That now raises `ENTITY_NOT_FOUND` instead. Ids that match nothing while others do are reported in `unmatchedGlobalIds`, and the matched ones still export.

  `foldedEntityCount` also stopped double-subtracting: with created-then-deleted entities now tombstoned, only tombstones that name a store entity are deducted.

- [#2000](https://github.com/LTplus-AG/ifc-lite/pull/2000) [`084c32c`](https://github.com/LTplus-AG/ifc-lite/commit/084c32c26c82dedb32ef62d38fc60c4965c741e1) Thanks [@louistrue](https://github.com/louistrue)! - `model_diff` gains `by_content`, putting the MCP surface on the real `@ifc-lite/diff` engine ([#1891](https://github.com/LTplus-AG/ifc-lite/issues/1891)).

  Until now `model_diff` was a GlobalId set intersection: it built two sets of `node.globalId` and diffed them. It predates `@ifc-lite/diff` and never imported it, so a model re-exported from scratch read as **the entire model deleted and added** — on the surface least able to notice a wrong answer, and most likely to act on it unsupervised. On the bundled FZK-Haus fixture and its re-GUIDed re-export, that pass reports 1304 added and 1304 removed; the engine reports 117 renamed, 4 ambiguous groups, and 29 entities genuinely unresolved.

  `by_content: true` runs the engine's content-keyed matching pass and adds a `contentDiff` to the result: `scope`, the `added`/`modified`/`deleted`/`unchanged` `counts`, whole per-kind totals in `contentMatchCounts`, and the matches themselves. `duplicated`, `deduplicated` and `ambiguous` matches list every candidate on each side rather than being flattened to a number — silently collapsing "we could not tell" into a count is the one failure an unsupervised agent cannot recover from. Two caps bound the payload and neither can hide anything: `max_matches` (default 200) caps how many matches are listed, with unresolved kinds listed first and `truncatedMatches` reporting what was left out; `max_group_members` (default 20) caps how many GlobalIds each _side of one match_ lists, because a single ambiguous group in a repetitive model can hold thousands and would otherwise overflow the very context window the first cap protects. Every group reports `baseCount` / `headCount` and `baseTruncated` / `headTruncated`, computed before either cap.

  **`model_diff` now answers about the session, not about the file as parsed.** A `model_id` names a loaded session, and `entity_set_property` / `entity_set_attribute` / `entity_create` / `entity_delete` queue their edits in a mutation overlay the parsed store never sees. All three passes — per-type counts, `entityDiff`, and the new `contentDiff` — read straight through it now: tombstoned entities leave, created ones join, and edited names, descriptions, object types and property values are hashed at their new values. A created entity is read through the overlay like any other, so create-then-rename — an ordinary two-step for an agent — is hashed at the name the session ended up with, not at the one the `entity_create` payload carried. `contentDiff.pendingMutations` reports how many queued edits are in play per side (absent when there are none) and the text summary says so too. Before this, an agent that had just edited a model and asked what changed was told nothing had — created entities were missing, deleted ones were still reported as present and unchanged, and edited ones kept their old hashes. The rest of the read surface (`entity_get`, `entity_query`, …) still answers from the parsed store; `model_diff` is the tool where a pre-edit answer is not recoverable.

  **Fixes a data-loss bug in `export_ifc` / `model_save` on the way.** The MCP mutation overlay had no base to merge against — the columnar parser leaves `store.properties` empty and serves properties on demand — so `MutablePropertyView.getForEntity` answered with the edited property set and nothing else. `StepExporter` re-emits exactly that set and skips the original records, so editing one property in a pset dropped every sibling property in it on save. The overlay is now wired to the parser's on-demand extractors, as the viewer's already is.

  Deliberate limits, all reported rather than assumed:

  - **Opt-in, default off.** An `ambiguous` group has no honest scalar form, so enabling this by default would change what `counts` means for agent scripts that already call the tool. What `typeDiffs` and `entityDiff` measure is unchanged; they are only read through the mutation overlay now, as above.
  - **Data scope.** Node has no geometry pipeline here, so there is no world geometry hash and no bounding box; the handler passes `scope: 'data'` and echoes it back. Every unambiguous 1:1 match therefore reports as `renamed`, and `moved`/`reshaped` are not available.
  - **`components` is supplied**, so the engine's collision guard against a `dataHash` collision retiring an unrelated add/delete pair is live rather than inert.

  The comparison covers every `IfcObjectDefinition`, decided from the inheritance chain of every bundled schema (IFC2X3 + IFC4 + IFC4X3) rather than from whether the columnar parser's `EntityTable` happened to hold the entity — the same chain-checked extraction the CLI's `diff` uses. That is what lets `IfcTask`, `IfcActor` and other non-product objects participate at all (the table answers an empty GlobalId for them), and what keeps `IfcMaterial` and friends out, whose Name sits in the table's GlobalId column and would otherwise enter the comparison as a colliding key.

  Reading the chain from the parser's IFC4 codegen pin instead would get an IFC2X3 file wrong in both directions at once, so it does not: the pin carries no chain for the 23 IFC2X3 and 77 IFC4X3 `IfcObjectDefinition` classes outside it, which silently drops every one the `EntityTable` does not hold (`IfcMove`, `IfcSpaceProgram`, `IfcScheduleTimeControl`, …) while leaving an IFC2X3-only _resource_ class the table does hold — an `IfcSymbolStyle`, taken in because its name ends in `STYLE` — keyed on the Name in slot 0. For all 776 classes the pin does carry, both lookups agree on every verdict and on the leaf name, so no IFC4 model changes behaviour.

- [#2014](https://github.com/LTplus-AG/ifc-lite/pull/2014) [`678e90d`](https://github.com/LTplus-AG/ifc-lite/commit/678e90d93e97d2b9ec3c8de9f2713e83361cab18) Thanks [@louistrue](https://github.com/louistrue)! - **read surface**: `get_entity`, `query_entities`, `model_info` and the rest of the read tools now answer about the model as the _session_ has it, not as the file was parsed (the MCP read-after-write half of issue [#2004](https://github.com/LTplus-AG/ifc-lite/issues/2004); the playground viewer's staleness is a separate surface and that issue stays open for it).

  `MutablePropertyView` is an overlay: the parsed store's buffer and index are never touched, and the queued edits only materialise in `StepExporter` at `export_ifc` / `model_save`. Every read went straight to the store, so an agent that edited and then read back to confirm was told its edit had not happened — and the natural recovery from that is to edit again. `model_diff` was fixed in [#2000](https://github.com/LTplus-AG/ifc-lite/issues/2000); this is the rest of the surface.

  What changed, in the order an agent hits it:

  - `get_entity` / `get_entities_bulk` return the attribute and property values that were just written, resolve a created entity by the GlobalId it was given, and report a deleted one as not found instead of as present. A created entity's `attributes` are the authored positional list named from the schema, so it reads as a real entity rather than an empty one.
  - `query_entities` includes created entities, excludes deleted ones, and — the part that made folding rather than reporting the only workable answer — **matches its property filters against written values**. A query for the value an agent just wrote has to find it; a tool that merely reported "1 mutation pending" next to an empty row set would not have fixed anything.
  - `count_entities` and `model_info` count creations in and deletions out. A created `IfcWall` lands on the existing `IFCWALL` row rather than opening a second one.
  - `properties_unique` and everything else routed through `bim.*` folds too, because the fold lives in the query backend rather than in each tool.
  - `entity_set_property` / `entity_set_attribute` / `entity_delete` also resolve `global_id` against queued entities, so a `mutation_batch` can create an entity in one step and address it by GlobalId in the next.

  **Every folding payload gains `pendingMutations`** — the same number `mutation_diff` reports — and the field is _absent_, not zero, on a session with no queued edits, so a read-only caller's response shape is untouched. Folding answers "what is there now"; the field is what still separates that from "what is on disk", and nothing is written until `export_ifc` or `model_save`.

  Containment folds through the same seam. `bim.storey`, `bim.path`, `bim.contains` and `bim.decomposes` are all thin wrappers over the backend's `related()`, so folding there fixed `in_storey`, `count_entities(group_by: 'storey')`, `containment_chain` and `spatial_hierarchy` at once: a queued `IfcRelContainedInSpatialStructure` places its `RelatedElements` inside its `RelatingStructure`, a deleted relationship record stops relating its two ends (the graph carries a `relationshipId` per edge, so that is exact), and a deleted spatial entity stops containing anything. The tools that were broken were exactly the ones bypassing `bim.*` with a raw `EntityNode` on the parsed store; they no longer do.

  `model_audit` folds too — it is the tool an agent is most likely to trust, and scoring a model clean on identity while a queued `entity_create` has just duplicated a GlobalId is a pass that was never earned. Its structure, identity and naming rules all read the session.

  The MCP resources (`ifc-lite://model/{id}/manifest`, `…/entity/{globalId}`, `…/spatial-tree`) fold as well. The entity resource used to read its header off the parsed store and fill the rest from `bim.*`, so one payload reported a stale name beside freshly-written properties.

  **Deliberately not folded, and they never carry `pendingMutations` so you can tell:** `relationships` (voids, fills, groups and connections come from a parser-side extractor with no overlay seam, unlike containment), `units` and `georeferencing` (header data no mutation tool writes), and the geometry, clash and viewer tools (parsed geometry, which queued edits do not regenerate).

  `get_entities_bulk` keys its result map by GlobalId, and used to let whichever row it visited last win — the parsed store's. That contradicted `get_entity`, which prefers the entity the session created, so reading one entity and reading a hundred disagreed about the same entity after a duplicate. Both now go through one documented precedence (queued first, tombstoned never), stated once beside `findByGlobalId` and pinned by a test that fails if the two implementations drift. A GlobalId that names more than one live entity is reported in a new `ambiguousGlobalIds` array — `globalId`, every `expressIds` seen, and which one was `returned` — rather than silently resolved; the field is absent when there is no ambiguity.

  Review follow-ups in the same area, several pre-existing:

  - **Created entities are only read positionally when they are `IfcRoot` subtypes.** `entity_create` accepts any IFC class, and slots 0/2/3 are `GlobalId`/`Name`/`Description` only for a root. `entity_create('IfcPropertySingleValue', ["'Width'", …])` therefore produced an entity whose GlobalId was `Width`, which then joined the cross-model identity list: `get_entity(global_id: 'Width')` resolved to a property value and `model_diff` reported `Width` as an added entity. The header is now read only when the class derives from `IfcRoot`, resolved cross-schema.
  - **The spatial tree is one walk.** `spatial_hierarchy` and the `…/spatial-tree` resource had two, which disagreed about which `IfcProject` to hang from and about whether contained elements are children. Neither carried a visited set, so a cyclic aggregation recursed until the stack gave out — a malformed file could hang the server. Children now come from aggregation only (contained elements are reported in `elements`, once), and the walk is cycle-safe.
  - **A deleted entity answers nothing about itself.** `related`, `attributes`, `properties` and `quantities` filtered the far end of a relationship but never checked whether the _queried_ entity was tombstoned.
  - **`model_audit`'s naming score uses a product denominator.** It counted every type that was not a relationship or a property set, so `IfcCartesianPoint`, `IfcLocalPlacement` and every other geometry primitive were scored for having no Name. `dataQuality` measured how much geometry a file had rather than how well its products were named; it now uses the same "is a product" rule an untyped `query_entities` does, and reads names off the store's fast path instead of reparsing every entity.
  - **`schema_describe` resolves a class's parent in the schema that declares the class.** Subtracting the merged union's parent attribute count for `include_inherited: false` cut one attribute too many from 67 bundled classes — `IfcScheduleTimeControl` lost `ActualStart`, because IFC4 added `Identification` to `IfcControl`.
  - **Type names are IfcPascalCase** in `model_info.typeCountsTop20` and `count_entities(group_by: 'type')`, matching `model_diff.typeDiffs`; `count_entities` also honours `type` on that branch (previously ignored) and expands subtypes.
  - **`pendingMutations` is a number at every level.** `model_diff.contentDiff` published a `{ base, head }` object under the same name; the split moved to `contentDiff.pendingMutationsBySide`.
  - `bim.attributes` no longer invents `Attribute7`-style names for a created entity whose payload runs past what the schema declares.
  - The overlay is rebuilt per read — there is no revision counter to cache against, and a stale overlay is a correctness bug where a rebuild is not — so the rebuild was made cheap instead: nothing is derived in the constructor and the per-entity lookup goes straight to the view's id map. A 1,000-id `get_entities_bulk` against a 20k-entity model with 2,000 queued creates went from ~1,960ms to ~7ms (median of five).

- [#2014](https://github.com/LTplus-AG/ifc-lite/pull/2014) [`678e90d`](https://github.com/LTplus-AG/ifc-lite/commit/678e90d93e97d2b9ec3c8de9f2713e83361cab18) Thanks [@louistrue](https://github.com/louistrue)! - **model_audit / schema_describe**: both now read the IFC schema across every bundled version instead of the IFC4_ADD2_TC1 codegen pin alone (issue [#2003](https://github.com/LTplus-AG/ifc-lite/issues/2003)).

  `model_audit`'s GlobalId-uniqueness check skips any type whose inheritance chain does not reach `IfcRoot`, and the pinned lookup answers an **empty** chain for any class it has no row for: 39 IFC2X3 classes (`IfcScheduleTimeControl`, `IfcSpaceProgram`, `IfcServiceLife`, `IfcMove`, …), 80 IFC4X3 ones (`IfcCourse`, `IfcBorehole`, …) and 4 post-ADD2 IFC4 ones. The audit skipped every one of them and still scored the file on identity, so an agent was told a file was clean on a rule that had not run. It now checks them, and `duplicate-globalid` can fire on files where it previously stayed silent.

  `schema_describe` rejected those same classes with `INVALID_INPUT: Unknown IFC entity type` — for a class an agent may have just found with `query_entities` on the file it is holding. It now answers from the bundled schema union when the pin has no row, and the payload gains a `schemaSource` field: `IFC4_ADD2_TC1` when the pinned registry answered (attributes carry their EXPRESS type as before) or `bundled-schema-union` when it did not (attribute _names_ in positional order, no types — the union does not carry them, and inventing them would be worse than saying so).

  For every class the pin does carry, `schema_describe`'s answer is unchanged, `inheritanceChain` included. That is deliberate rather than incidental: the two lookups disagree on chain _content_ for 62 pinned classes because the union lets IFC4X3 win a name collision (`IfcBeam`'s supertype is `IfcBuildingElement` in IFC4 and `IfcBuiltElement` in IFC4X3, and IFC4X3 inserts `IfcFacility` above `IfcBuilding`), so the pin stays primary and the union only fills the gap. They also return their chains in opposite order — the pinned one root→leaf, the union one leaf→root, differing at `chain[0]` on 717 of the 776 — so the chain is normalised by finding the leaf by name, never by index.

- [#2033](https://github.com/LTplus-AG/ifc-lite/pull/2033) [`2716893`](https://github.com/LTplus-AG/ifc-lite/commit/2716893ac9d825fc529f3fd8164d9a6f766e87f8) Thanks [@louistrue](https://github.com/louistrue)! - **diff**: `buildDataFingerprint` and `buildComponentFingerprints` now hash a new optional `DataFingerprintInput.tag`, and it belongs to **type objects only**. A type object carries no geometry hash, so its data fingerprint is the whole of the evidence a content match has about it — and same-named types are ordinary: the Duplex sample has eight `IfcFurnitureType` entities all named `800 mm`, identical in every other hashed attribute and separable only by `Tag`. They shared one content bucket and `matchUnpairedByContent` correctly abstained on all eight. Measured on the content-matching fixture (`scripts/xmatch`), recall on geometry-less objects went from 0.468 to 1 on Duplex, 0.680 to 0.880 on AC20-FZK-Haus and 0.718 to 0.768 on a Revit export, with precision staying at 1.000 and zero false pairs throughout.

  Supply `tag` for an `IfcTypeObject` subtype and **not** for an occurrence — that is what the CLI, MCP and viewer adapters do, deciding it from the cross-schema inheritance chain. `IfcElement.Tag` is the authoring tool's own element id (Revit writes its `ElementId`), so two tools exporting one design disagree on it for every element; since `dataHash` is the content bucket key, hashing it on occurrences would break exactly the re-export matching this pass exists for. Re-tagging a type does not move the fingerprint of any element assigned to it: type assignments still project the assigned type's name and IFC class only.

  **Every cached fingerprint is invalidated.** `buildDataFingerprint` and `buildComponentFingerprints` (its `attr:core` sub-hash) return different strings for the same input than they did before, whether or not you supply a `tag` — the projection now always carries a `Tag` field. Nothing in this repo persists these values, and base and head are always fingerprinted by the same build, so a normal diff, merge or compare is unaffected. Any caller that has stored fingerprints across sessions must recompute them; comparing a pre-upgrade hash with a post-upgrade one reports everything as changed. Stored identity-map sidecars are not affected: they carry GlobalId aliases and model digests, no fingerprint values.

  **cli**: `ifc-lite diff --by-content` now tells two same-named type objects apart when they differ only in `Tag`, so a re-export whose furniture, door and window _types_ share a name no longer reports them as an unresolved ambiguous group. On the Duplex sample the command abstained on 25 of 47 geometry-less objects and now pairs all 47. Two consequences to expect: pairs you previously had to resolve by hand are now reported as `renamed`, and a type object whose `Tag` genuinely changed between the two files now reports as added and deleted rather than matched, because its content really did change. An ordinary element's `Tag` is still not compared, so nothing about occurrence matching moves. Fingerprints from this version do not compare against fingerprints from an older one; replaying an existing identity-map sidecar is unaffected, since a sidecar stores GlobalIds rather than hashes.

  The lookup also spans every bundled schema, so `Tag` is now found on IFC4X3-only type objects (`IfcRailType`, `IfcTrackElementType`, `IfcSignalType`, …). Routed through the IFC4 codegen pin it silently found nothing on those classes, which meant infrastructure models got none of the benefit above while IFC2X3 and IFC4 models got all of it.

  **mcp**: the same change to `model_diff` with `by_content: true`, from the same adapter — same-named type objects are separated by `Tag`, so an agent gets `renamed` pairs where it used to get an ambiguous group it could not act on, including on IFC4X3 infrastructure classes. `entity_set_attribute` on `Tag` now moves the fingerprint of a queued-edit **type object** (and only a type object), so `model_diff` reflects that edit instead of ignoring it. Hash values differ from previous versions, so anything an agent stored and compares across an upgrade must be recomputed.

- [#1979](https://github.com/LTplus-AG/ifc-lite/pull/1979) [`8f139a8`](https://github.com/LTplus-AG/ifc-lite/commit/8f139a8ef44235b68c2f97c032419fa586111b62) Thanks [@louistrue](https://github.com/louistrue)! - **BREAKING:** every `IfcCreator` element constructor now places its product relative to the storey it is added to. Element coordinates are storey-relative across the whole API.

  ## What was wrong

  `IfcCreator` chained the product's `IfcLocalPlacement` to a different parent depending on which method you called. Seven methods — `addIfcWall`, `addIfcSlab`, `addIfcColumn`, `addIfcBeam`, `addIfcStair`, `addIfcRoof`, `addIfcGableRoof` — chained to the storey placement, which carries `[0, 0, Elevation]`. The other 21 — `addIfcDoor`, `addIfcWindow`, `addIfcRamp`, `addIfcRailing`, `addIfcPlate`, `addIfcMember`, `addIfcFooting`, `addIfcPile`, `addIfcSpace`, `addIfcCurtainWall`, `addIfcFurnishingElement`, `addIfcBuildingElementProxy`, `addIfcCircularColumn`, `addIfcIShapeBeam`, `addIfcLShapeMember`, `addIfcTShapeMember`, `addIfcUShapeMember`, `addIfcHollowCircularColumn`, `addIfcRectangleHollowBeam`, `addElement`, `addAxisElement` — chained to the world.

  On a storey with a non-zero `Elevation`, a caller mixing the two families got two datums in one model, with no error and nothing downstream to notice. Measured on a real scan-to-IFC run: the storey and its spaces at −1.368653 m, the walls at −2.737307 m — exactly 2 × the elevation, standing 1.37 m below the spaces they bounded.

  Every one of these methods already took the storey as its first argument and already emitted an `IfcRelContainedInSpatialStructure` into it. Only the placement disagreed.

  ## Why storey-relative, and not world-relative

  The placement hierarchy has to agree with the containment hierarchy. A product contained in a storey whose placement chains past that storey to the world is not a coherent IFC product: moving the storey leaves its own contents behind, and `IfcBuildingStorey.Elevation` and the storey's `ObjectPlacement` become decoration that no geometry honours. The world-relative alternative would have meant deleting the storey's `[0, 0, Elevation]` placement or leaving it as a transform nothing chains to — the wrong half of the schema to surrender.

  It is also what the rest of this package already did: the `*ToStore` builders (`addWallToStore`, `addSpaceToStore`, `addDoorToStore`, …) have always chained from `anchor.storeyPlacementId`. Choosing world would have split `@ifc-lite/create` against itself.

  ## Migrating

  If your storeys all have `Elevation: 0`, nothing moves — the storey placement is the identity and the two parents were already the same point.

  Otherwise, for the 21 methods listed above: **stop adding the storey elevation to element coordinates.** Pass the height above that storey's floor.

  ```ts
  const storey = creator.addIfcBuildingStorey({
    Name: "Level 1",
    Elevation: 3.2,
  });

  // before — absolute Z, because addIfcSpace ignored the storey
  creator.addIfcSpace(storey, {
    Position: [0, 0, 3.2],
    Width: 4,
    Depth: 4,
    Height: 2.6,
  });

  // after — storey-relative Z, like addIfcWall always was
  creator.addIfcSpace(storey, {
    Position: [0, 0, 0],
    Width: 4,
    Depth: 4,
    Height: 2.6,
  });
  ```

  If you compensated for the asymmetry — passing absolute Z to the world-parented methods and storey-relative Z to the storey-parented ones, so the two families lined up — remove the compensation from the world-parented calls only. The storey-parented calls were already correct and must not change. A caller that had settled on `Z = 0` for walls and `Z = elevation` for spaces now passes `Z = 0` to both.

  `addIfcWallDoor` and `addIfcWallWindow` are unaffected: they were and remain wall-local, and inherit the storey datum through their host.

  Also in this release: `getStoreyPlacement` throws `Unknown storeyId #N` instead of silently falling back to the world placement. This is a strictly earlier version of the error `trackElement` already threw a few lines later, so no working call changes — it just means a bogus storey id no longer emits orphan placement entities before failing.

  ## `@ifc-lite/sandbox`

  The `llmSemantics.placement` metadata in `NAMESPACE_SCHEMAS` is corrected to match: the seven methods previously tagged `'world'` (`addIfcMember`, `addIfcPlate`, `addIfcCurtainWall`, `addIfcRailing`, `addIfcDoor`, `addIfcWindow`, `addAxisElement`) are now `'storey-relative'`, and the `useWhen`/`cautions` prose that described them as world-placement is rewritten. The `MethodPlacementKind` union is unchanged and no export was added or removed. Consumers that read `placement` to generate guidance will see different values for those seven methods — which is the point: the old values now describe behaviour that no longer exists.

  Thirteen constructors that carried no `llmSemantics` at all — `addIfcRamp`, `addIfcFooting`, `addIfcPile`, `addIfcSpace`, `addIfcFurnishingElement`, `addIfcBuildingElementProxy`, `addIfcCircularColumn`, `addIfcHollowCircularColumn`, `addIfcIShapeBeam`, `addIfcLShapeMember`, `addIfcTShapeMember`, `addIfcUShapeMember`, `addIfcRectangleHollowBeam` — now declare `placement: 'storey-relative'` with their coordinate keys. They were invisible to every consumer that groups methods by placement frame, so nothing generated from this schema said which datum their coordinates were in. `NAMESPACE_SCHEMAS.create` now tags all 30 coordinate-taking constructors (27 storey-relative, `addElement` explicit-placement, and the two wall-local hosted inserts).

  ## Downstream packages carrying the break

  The behaviour change is not confined to `@ifc-lite/create`: four packages re-expose `IfcCreator` and therefore ship it to their own consumers. Each is versioned to say so, rather than letting a caller pick the change up through a range they believed was compatible.

  - **`@ifc-lite/sdk` (major)** — re-exports the class directly (`packages/sdk/src/index.ts`: `export { IfcCreator } from '@ifc-lite/create'`). Without a major, a consumer on `^1.21` accepts the release and gets storey-relative placement with no signal.
  - **`@ifc-lite/sandbox` (major, was minor)** — `buildCreateMethods()` auto-discovers `IfcCreator.prototype` and dispatches to it, so every affected constructor is reachable from sandbox scripts. A script passing absolute coordinates against a non-zero-elevation storey now emits geometry one elevation off. That is breaking for the script author even though the sandbox's own surface is unchanged.
  - **`@ifc-lite/cli` (minor)** — `create` constructs `IfcCreator` and passes `--elevation` straight through, so the same shift reaches CLI users following the previous absolute-coordinate convention. Minor rather than major because the package is pre-1.0, where the house rule maps a breaking change to a minor bump.
  - **`@ifc-lite/mcp` (minor)** — exposure is indirect but real: `loadIfcModel()` (`src/index.ts`) returns a `LoadedModel` carrying `bim: BimContext` (`src/loader.ts`), whose `create` namespace constructs the class (`@ifc-lite/sdk` `namespaces/create.ts`: `project()` returns `new IfcCreator(params)`, `building()` takes a `StoreyElevation`). A library consumer calling `model.bim.create.building({ StoreyElevation })` gets the new datum. Minor for the same pre-1.0 reason as the CLI.

  `@ifc-lite/wasm` is unaffected — it neither constructs nor re-exports `IfcCreator`, directly or through a namespace. The viewer apps are private and unpublished.

### Patch Changes

- [#2024](https://github.com/LTplus-AG/ifc-lite/pull/2024) [`63905dc`](https://github.com/LTplus-AG/ifc-lite/commit/63905dc3993ad227500a0f68c406276c909eb6f5) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fixed the remaining `GeometryProcessor` WASM handle leaks tracked in issue [#1959](https://github.com/LTplus-AG/ifc-lite/issues/1959), beyond the viewer P0 sites fixed separately. Each site now frees its handle in a `try/finally` covering every early-return and throw path, not just the happy path:

  - `@ifc-lite/mcp`: `clash_check` / `clash_matrix`'s model meshing (long-lived MCP server process, one handle per never-before-clashed model).
  - `@ifc-lite/export`: `generateLod1`'s primary and fallback processors, including the forced-meshing-failure fallback path.
  - `@ifc-lite/cli`: `diagnose-geometry`, `extract-entities --detect`, and `gym`'s lazily-created clash-channel processor — all reachable more than once per process from a long-lived host (a test harness, a REPL session) even though each is a one-shot CLI command in normal use.
  - `create-ifc-lite`: the generated React + WebGPU template's mount effect now disposes its `GeometryProcessor` on both the mid-init cancellation path and on unmount, so scaffolded projects don't inherit the leak.

  `apps/viewer/src/hooks/useIfcLoader.ts` is intentionally untouched: its processor's WASM handle is shared with `IfcParser.parseColumnar` via `getApi()`, and disposal there needs a design decision (owned-and-reused vs. freed-per-call) that has not been made yet.

- Updated dependencies [[`d42fbf1`](https://github.com/LTplus-AG/ifc-lite/commit/d42fbf1c7a4abed637b7e80e28cbed69088bc943), [`e651699`](https://github.com/LTplus-AG/ifc-lite/commit/e651699180b791b95cbd721ad66d5f38e03eca2b), [`0adb741`](https://github.com/LTplus-AG/ifc-lite/commit/0adb7413b869c9d50bdcdae5c00a730d17c2823f), [`0adb741`](https://github.com/LTplus-AG/ifc-lite/commit/0adb7413b869c9d50bdcdae5c00a730d17c2823f), [`63905dc`](https://github.com/LTplus-AG/ifc-lite/commit/63905dc3993ad227500a0f68c406276c909eb6f5), [`a8e58a2`](https://github.com/LTplus-AG/ifc-lite/commit/a8e58a2b5e75db8388835c77b2688240667f68ab), [`0adb741`](https://github.com/LTplus-AG/ifc-lite/commit/0adb7413b869c9d50bdcdae5c00a730d17c2823f), [`263c3ef`](https://github.com/LTplus-AG/ifc-lite/commit/263c3efba5baf503f192700ba7f70ce08a1dafc8), [`a2ca053`](https://github.com/LTplus-AG/ifc-lite/commit/a2ca0535c14cd1bf9d55713584766dff55430158), [`e4d2db5`](https://github.com/LTplus-AG/ifc-lite/commit/e4d2db5f11798e3ec78f45249139d69aa1e65275), [`a5cc568`](https://github.com/LTplus-AG/ifc-lite/commit/a5cc568a642d7dd8d17f1ed7858844f9289bc841), [`a8e58a2`](https://github.com/LTplus-AG/ifc-lite/commit/a8e58a2b5e75db8388835c77b2688240667f68ab), [`a5cc568`](https://github.com/LTplus-AG/ifc-lite/commit/a5cc568a642d7dd8d17f1ed7858844f9289bc841), [`dc000cf`](https://github.com/LTplus-AG/ifc-lite/commit/dc000cff25a647d2a224f34a063f84b3d2d84ca8), [`e4d2db5`](https://github.com/LTplus-AG/ifc-lite/commit/e4d2db5f11798e3ec78f45249139d69aa1e65275), [`2716893`](https://github.com/LTplus-AG/ifc-lite/commit/2716893ac9d825fc529f3fd8164d9a6f766e87f8), [`620f4d2`](https://github.com/LTplus-AG/ifc-lite/commit/620f4d2100b397d33d2e61440950b7a31660dbb8), [`7261f1a`](https://github.com/LTplus-AG/ifc-lite/commit/7261f1a6a8595350d3ec400212e293a8924d57bf), [`8f139a8`](https://github.com/LTplus-AG/ifc-lite/commit/8f139a8ef44235b68c2f97c032419fa586111b62), [`ed63063`](https://github.com/LTplus-AG/ifc-lite/commit/ed63063c952bd1804ce83922da80635f03c77193)]:
  - @ifc-lite/diff@0.6.0
  - @ifc-lite/export@2.8.0
  - @ifc-lite/geometry@3.6.0
  - @ifc-lite/parser@3.13.0
  - @ifc-lite/data@3.2.0
  - @ifc-lite/mutations@1.23.0
  - @ifc-lite/sdk@2.0.0
  - @ifc-lite/create@2.0.0
  - @ifc-lite/merge@0.4.0
  - @ifc-lite/ids@1.15.38
  - @ifc-lite/viewer-core@0.2.11

## 0.9.2

### Patch Changes

- Updated dependencies [[`0cfb88b`](https://github.com/LTplus-AG/ifc-lite/commit/0cfb88b3ac3e5615c7e125c5076ea75cf2039a09), [`382fa7c`](https://github.com/LTplus-AG/ifc-lite/commit/382fa7cf97c04bad07963e25052cbaeb6c2ba7e3), [`6792dd1`](https://github.com/LTplus-AG/ifc-lite/commit/6792dd11ad7049acb7329221ea8809d6333aefb7), [`87f3507`](https://github.com/LTplus-AG/ifc-lite/commit/87f3507f6fb67a3fd834a190737ea33d7e9ad661), [`6842c56`](https://github.com/LTplus-AG/ifc-lite/commit/6842c56c72065fd9f43ac282cacb766b7808c282), [`6869d5c`](https://github.com/LTplus-AG/ifc-lite/commit/6869d5ced2d19ac4ab8b2591847f3ffd52236d14), [`8799484`](https://github.com/LTplus-AG/ifc-lite/commit/87994844a5edb66404fa12b0719c89f5ec026c4d), [`22bffac`](https://github.com/LTplus-AG/ifc-lite/commit/22bffac737efa9bdd6ca583518f637593cb4d4bc), [`87f3507`](https://github.com/LTplus-AG/ifc-lite/commit/87f3507f6fb67a3fd834a190737ea33d7e9ad661), [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f), [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f), [`428c5ae`](https://github.com/LTplus-AG/ifc-lite/commit/428c5ae54bac236a3950f451ee12a0dc23226336), [`3dc3eb5`](https://github.com/LTplus-AG/ifc-lite/commit/3dc3eb56bd372ddd0e317347db1cad888dffd609)]:
  - @ifc-lite/clash@1.6.4
  - @ifc-lite/create@1.17.0
  - @ifc-lite/data@3.0.0
  - @ifc-lite/parser@3.11.0
  - @ifc-lite/export@2.7.0
  - @ifc-lite/mutations@1.21.1
  - @ifc-lite/ifcx@2.3.2
  - @ifc-lite/geometry@3.5.0
  - @ifc-lite/collab@0.4.1
  - @ifc-lite/ids@1.15.35
  - @ifc-lite/query@1.14.14
  - @ifc-lite/sdk@1.21.3

## 0.9.1

### Patch Changes

- [#1774](https://github.com/LTplus-AG/ifc-lite/pull/1774) [`8a0b09f`](https://github.com/LTplus-AG/ifc-lite/commit/8a0b09f161fffbc3302e173bd639a5aa85074e59) Thanks [@louistrue](https://github.com/louistrue)! - Harden the collab server, MCP path guard, and point-cloud decoders against abuse and hostile input.

  - collab-server: rate-limit the unauthenticated fresh-room token-mint path per client IP (authenticated admin re-mints are exempt) and cap `claimedRooms` growth (`COLLAB_MAX_CLAIMED_ROOMS`, default 100k). `X-Forwarded-For` is IGNORED by default when deriving the rate-limit IP (a spoofable header would hand every request its own bucket); set `COLLAB_TRUST_PROXY=1` (or `tokenEndpoint.trustForwardedFor`) behind a trusted reverse proxy, which then uses the LAST header entry (the hop the proxy itself appended).
  - collab-server: access-control persistence (revocations + claimed rooms) is now debounced, written atomically (temp file + rename, no torn state file on crash), and flushed on SIGINT/SIGTERM; `flush()` rejects (and the CLI exits non-zero, loudly) when the state never reached disk. Startup is fail-closed: a present-but-unreadable or malformed state file throws instead of running open, and a MISSING state file on a data dir that already has persisted rooms marks those rooms claimed (admins re-mint with their still-valid admin bearers; squatters cannot first-claim them). Revocations now persist as `jti -> exp` (the legacy `revoked: string[]` shape still loads) and are pruned once the revoked token would have expired anyway, so the deny-list stays bounded without ever evicting a live revocation. The policy moved from `bin.ts` into an exported `createAccessControl` for reuse and testing.
  - collab-server: a ref that requires human approval now refuses approvals when its reviewer allowlist is empty (previously any non-author principal could self-approve past the merge gate).
  - collab-server: metrics-token comparison hashes both sides to fixed-length digests before `timingSafeEqual`, removing the length oracle; startup without `COLLAB_TOKEN_SECRET` on a non-loopback host logs an explicit OPEN-server warning; idle rooms unload after `COLLAB_IDLE_UNLOAD_MS` (default 5 min) so long-lived deployments can't wedge at `maxRooms`.
  - mcp: the safe-path guard now also refuses shell startup/persistence files (`.bashrc`, `.zshrc`, `.profile`, `.gitconfig`, …) and the `~/.config` tree for both read and write.
  - pointcloud: E57/PCD/PLY decoders reject header-declared record/point/vertex counts (and LZF uncompressed sizes) that the actual body bytes cannot back, so a small hostile file can no longer force multi-GB allocations before the first read fails; ascii floors allow EOF-terminated final records. The PCD LZF expansion bound is format-derived (90x, above LZF's real 88x back-reference maximum, so genuinely repetitive valid files decode) plus an absolute 1 GiB uncompressed ceiling; PCD field SIZE/COUNT must be positive safe integers and the accumulated stride may not overflow. PLY element counts are parsed strictly, and list-valued properties on the vertex element (variable-length records the fixed-stride readers cannot walk) are rejected up front.

- Updated dependencies [[`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7), [`7ef3622`](https://github.com/LTplus-AG/ifc-lite/commit/7ef36225d863ec64dfb254cf0767d4ab9d034849), [`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7), [`0d400ed`](https://github.com/LTplus-AG/ifc-lite/commit/0d400edd61a71108c2affd0923fb561affbfe9fe), [`564a800`](https://github.com/LTplus-AG/ifc-lite/commit/564a800e997322d863aac84127497ef4f8310ac3), [`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7), [`a42b8a9`](https://github.com/LTplus-AG/ifc-lite/commit/a42b8a9cfc559781575dde893b2116a5dc493732)]:
  - @ifc-lite/bcf@1.16.3
  - @ifc-lite/parser@3.9.1
  - @ifc-lite/data@2.6.0
  - @ifc-lite/export@2.5.3
  - @ifc-lite/geometry@3.2.1
  - @ifc-lite/ids@1.15.32

## 0.9.0

### Minor Changes

- [#1729](https://github.com/LTplus-AG/ifc-lite/pull/1729) [`b54f704`](https://github.com/LTplus-AG/ifc-lite/commit/b54f70478a7b92055750f11267ffe7fa47ed7da1) Thanks [@louistrue](https://github.com/louistrue)! - Review comments as BCF topics (08-review.md §8.6): registry reviews gain `GET/POST /api/v1/reviews/:id/topics` — topics bound to (entity, componentKey?) with server-derived authors, optional viewpoints, and the named-reviewers write gate. The MCP review loop matches: new `add_review_topic` tool, and `get_review_feedback` returns the topics.

### Patch Changes

- Updated dependencies [[`c1695d7`](https://github.com/LTplus-AG/ifc-lite/commit/c1695d777263483110460df767ec86ca691048ab), [`5e90494`](https://github.com/LTplus-AG/ifc-lite/commit/5e904942e3fd167d0d0e1a9c37b391d638eb6932), [`cd6c9bd`](https://github.com/LTplus-AG/ifc-lite/commit/cd6c9bda1066b7c7cda19e164d787d15b57e3483)]:
  - @ifc-lite/collab@0.4.0
  - @ifc-lite/merge@0.3.0
  - @ifc-lite/mutations@1.20.0

## 0.8.0

### Minor Changes

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Layer PRs surfaces:

  - **cli**: new `layer` namespace (`create`, `status`, `publish`, `diff`, `merge --preview`, `log`, `bake`, `revert`, `rebase`) and `ref` namespace (`list`, `create`, `move`, `protect`) over a local content-addressed layer store, with stable exit codes (0 clean, 2 conflicts, 3 required-check/policy failure, 4 scope violation).
  - **mcp**: draft-layer tool family — `create_draft_layer`, `draft_apply_ops` (write-time scope enforcement), `publish_layer` (publish-time claim-vs-ops verification), `diff_layer`, `dry_run_merge`, `list_conflicts`, `request_review`, `add_review_feedback`, `get_review_feedback`, `respond_to_review`.

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Layer store and merge hardening:

  - **cli**: `loadLayer` verifies the blake3 content address on every read (a tampered or corrupted layer file fails loudly instead of composing silently); refs.json, layer files, and draft.json are written atomically (temp file + rename); `layer publish --check <spec.ids>=<report.json>` stamps verified check evidence into the provenance manifest — pass/fail derived from the `ifc-lite ids --json` report, spec and report content-addressed; `layer merge` refuses a candidate whose declared base matches nothing on the target ref (exit 5) unless `--allow-unrelated` is passed.
  - **mcp**: `diff_layer`, `dry_run_merge`, and `list_conflicts` report `base_resolved` so agents can tell when a preview ran against an empty ancestor (the placeholder `would_fail_checks` field is gone).

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Session-scoped layer workspaces and ownership checks ([#1030](https://github.com/LTplus-AG/ifc-lite/issues/1030)): layer drafts are keyed by transport session id (private per Streamable HTTP session, disposed on session end; stdio keeps the local draft space) while published layers, refs, and reviews are process-shared so reviewers can act on them from their own sessions. `ToolContext` carries a `SessionIdentity`, drafts/reviews record their creating principal, mutating layer tools are owner-gated (reviews also visible to listed reviewers), and unknown-id error details only enumerate ids visible to the caller. `HttpTransport` enforces the same scope identity on DELETE/SSE-attach as on POST and rejects session factories that don't bind the provided session id; both in-repo factories (`@ifc-lite/mcp` CLI and `ifc-lite mcp`) bind it.

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Serialize structured entity branches (psets, quantities, classifications, materials, geometryRef) through the IFCX snapshot pipeline ([#1031](https://github.com/LTplus-AG/ifc-lite/issues/1031)): `snapshotToIfcx` folds them into namespaced attributes (`bsi::ifc::v5a::<Set>::<Name>` for psets/quantities, `ifclite::` carriers for the rest), `seedFromIfcx` re-inflates them, and `extractMinimalLayer` diffs the same flattened view so structured edits and deletions survive snapshot → seed round-trips and minimal layers. The typed `TypedPropertyValue` record is the canonical wire shape: the MCP `set_property` draft op emits it, property extraction decodes it (and skips `ifclite::` carriers), composition resolves `null` attribute opinions as removals, and `bakeLayers` preserves the persistent carriers while stripping bookkeeping.

### Patch Changes

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - The layer-diff JSON is now one shared contract: `diffStackStates`/`diffLayerStacks` (`StackDiff` shape, deterministically ordered) live in `@ifc-lite/merge`, and the CLI `layer diff` command and the MCP `diff_layer` tool consume the identical implementation — the two previously separate copies had already drifted on ordering. A byte-exact contract test pins the wire shape the review UI will consume.

- Updated dependencies [[`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`8f3fafd`](https://github.com/LTplus-AG/ifc-lite/commit/8f3fafd7cc777e60cdc006956f8336680723c440), [`a2c31a1`](https://github.com/LTplus-AG/ifc-lite/commit/a2c31a185e868d15183df8360badb001789bd978), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`a1bbd6c`](https://github.com/LTplus-AG/ifc-lite/commit/a1bbd6c209ded2da1405a8d1c816a193601ae625)]:
  - @ifc-lite/ifcx@2.3.0
  - @ifc-lite/extensions@0.4.0
  - @ifc-lite/mutations@1.19.0
  - @ifc-lite/collab@0.3.0
  - @ifc-lite/merge@0.2.0
  - @ifc-lite/geometry@3.2.0
  - @ifc-lite/clash@1.6.3
  - @ifc-lite/parser@3.8.5
  - @ifc-lite/viewer-core@0.2.10
  - @ifc-lite/ids@1.15.30

## 0.7.2

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

- Updated dependencies [[`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a), [`d0647c9`](https://github.com/LTplus-AG/ifc-lite/commit/d0647c9a1801fc03b7c5d32314e53ef922c56f2f), [`3267aaf`](https://github.com/LTplus-AG/ifc-lite/commit/3267aaf5dfe98f9550695d44c1d12644f2c04b88), [`26de705`](https://github.com/LTplus-AG/ifc-lite/commit/26de705b8608b9cd75e90411288c7ada96b3352b), [`bc1531f`](https://github.com/LTplus-AG/ifc-lite/commit/bc1531f899e5f8d18d1a6ff1ef6d997236a01243)]:
  - @ifc-lite/bcf@1.16.2
  - @ifc-lite/clash@1.6.2
  - @ifc-lite/create@1.16.4
  - @ifc-lite/data@2.5.2
  - @ifc-lite/export@2.5.2
  - @ifc-lite/geometry@3.1.4
  - @ifc-lite/ids@1.15.27
  - @ifc-lite/mutations@1.18.1
  - @ifc-lite/parser@3.8.2
  - @ifc-lite/query@1.14.13
  - @ifc-lite/sdk@1.21.2
  - @ifc-lite/viewer-core@0.2.9

## 0.7.1

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

- Updated dependencies [[`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39)]:
  - @ifc-lite/bcf@1.16.1
  - @ifc-lite/clash@1.6.1
  - @ifc-lite/create@1.16.3
  - @ifc-lite/data@2.5.1
  - @ifc-lite/export@2.5.1
  - @ifc-lite/ids@1.15.26
  - @ifc-lite/parser@3.8.1
  - @ifc-lite/query@1.14.12
  - @ifc-lite/sdk@1.21.1
  - @ifc-lite/viewer-core@0.2.8

## 0.7.0

### Minor Changes

- [#1580](https://github.com/LTplus-AG/ifc-lite/pull/1580) [`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47) Thanks [@louistrue](https://github.com/louistrue)! - Plumb the IFC measure type through the property pipeline so consumers can show units (issue [#1573](https://github.com/LTplus-AG/ifc-lite/issues/1573)):

  - `@ifc-lite/data`: `Property` gains an optional `dataType?: string` carrying the raw IFC measure value type (e.g. `"IFCVOLUMETRICFLOWRATEMEASURE"`) of a typed nominal value. Additive and optional; existing consumers are unaffected.
  - `@ifc-lite/mutations`: the `PropertyExtractor` function type now carries the same optional `dataType?` per property, and `MutablePropertyView.getForEntity` preserves it through the base and mutation-merge paths, so a property's measure type survives the merge for unit display.
  - `@ifc-lite/mcp`: `geometry_volume` / `geometry_area` now resolve the volume/area symbol from the file's declared `IfcUnitAssignment` (via `@ifc-lite/parser`'s `extractProjectUnits`) instead of hardcoding `m³` / `m²`, and report the resolved symbol in a new `unit` response field. Falls back to the SI default when the store has no source buffer or declares no such unit.

### Patch Changes

- Updated dependencies [[`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47), [`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47)]:
  - @ifc-lite/parser@3.7.0
  - @ifc-lite/data@2.4.0
  - @ifc-lite/mutations@1.18.0
  - @ifc-lite/ids@1.15.24

## 0.6.0

### Minor Changes

- [#1497](https://github.com/LTplus-AG/ifc-lite/pull/1497) [`d7a3205`](https://github.com/LTplus-AG/ifc-lite/commit/d7a3205524e023f936b29ee1bc113d1d10e3b0b1) Thanks [@Blogbotana](https://github.com/Blogbotana)! - feat(parser): support opening `.ifcZIP` containers (issue [#1494](https://github.com/LTplus-AG/ifc-lite/issues/1494))

  The buildingSMART IFC container format — a zip archive wrapping a single
  `.ifc`/`.ifcxml` file — is now unwrapped transparently. New `@ifc-lite/parser`
  exports:

  - `isZipBuffer(buffer)` — cheap magic-byte check.
  - `unwrapIfcZip(buffer)` — returns the model file's bytes if `buffer` is a
    zip container, or `buffer` unchanged otherwise (safe to call
    unconditionally on every load). Throws if the archive has zero or more
    than one `.ifc`/`.ifcxml` entry rather than guessing which to load, or if
    the entry's declared uncompressed size exceeds 4 GiB (a zip-bomb guard,
    checked from the zip central directory — no decompression needed to check).
  - `unwrapIfcZipView(view)` — same contract for a Node `Buffer`/`Uint8Array`.

  `parseAuto` calls it automatically. The CLI and MCP loaders (`loadIfcFile`,
  `loadIfcModel`) unwrap before their STEP-signature check, so `ifc-lite info
model.ifcZIP` and MCP's `model_load` just work. The viewer's file picker and
  drag-and-drop now accept `.ifczip` alongside `.ifc`/`.ifcx`/`.glb`.

  The hosted Rust parsing server (`apps/server`) unwraps `.ifcZIP` too, in its
  multipart `extract_file` path (alongside the existing gzip handling), so an
  uploaded container is decompressed server-side before parsing and the viewer's
  multi-core server fast-path works for zipped uploads. It applies the same
  single-`.ifc`/`.ifcxml`-entry rule and bounds the decompressed size against the
  server's max-file-size ceiling (zip-bomb guard).

  Referenced resources inside the container (textures, documents) are not
  extracted in this pass — only the model file's bytes.

### Patch Changes

- Updated dependencies [[`218e613`](https://github.com/LTplus-AG/ifc-lite/commit/218e613b06cc5ca2a74c84f72e039b430be6caee), [`0762522`](https://github.com/LTplus-AG/ifc-lite/commit/076252241ec4201462f7fcf0555c83606de5fecd), [`d7a3205`](https://github.com/LTplus-AG/ifc-lite/commit/d7a3205524e023f936b29ee1bc113d1d10e3b0b1), [`52dd7a1`](https://github.com/LTplus-AG/ifc-lite/commit/52dd7a16788375a9507c40fbde106b78236801db), [`47bde10`](https://github.com/LTplus-AG/ifc-lite/commit/47bde10dcacddf8f99e1e6b2bf036c78c192c5ff), [`b157b48`](https://github.com/LTplus-AG/ifc-lite/commit/b157b4841bfa795f8a937a9be20c21b645757fbe)]:
  - @ifc-lite/clash@1.5.0
  - @ifc-lite/geometry@3.1.0
  - @ifc-lite/parser@3.6.0
  - @ifc-lite/export@2.5.0
  - @ifc-lite/ids@1.15.23

## 0.5.0

### Minor Changes

- [#1491](https://github.com/LTplus-AG/ifc-lite/pull/1491) [`6d2cb21`](https://github.com/LTplus-AG/ifc-lite/commit/6d2cb21a170413c6c98aadf10d254667b2ed2b53) Thanks [@louistrue](https://github.com/louistrue)! - feat(export): large-model GLB reliability - bounded memory, fail-closed, byte returns

  Three related hardening changes on the export surface:

  - **Bounded-memory GLB.** Inputs at or above 64 MB (native override
    `IFC_LITE_GLB_STREAM_THRESHOLD_MB`, `0` disables) are exported through a
    two-pass streaming assembler: pass 1 records per-mesh metadata only, pass 2
    re-streams and bakes vertex bytes directly into an exactly-preallocated GLB.
    Peak memory is the final artifact plus one mesh batch instead of the whole
    model's meshes plus multiple full-buffer copies - this fixes the wasm
    `RuntimeError: unreachable` / OOM on large in-browser exports. Models without
    instanceable groups produce byte-identical output; instanced models keep
    identical world geometry (rep-identity instancing is skipped above the
    threshold, content-hash dedup is kept).

  - **Fail-closed empty GLB at the boundary.** `exportGlb` now throws a typed
    `Error` whose message starts with `NO_RENDER_GEOMETRY` when the visible mesh
    set is empty, instead of returning a structurally valid but empty GLB.
    `@ifc-lite/geometry` exports `NO_RENDER_GEOMETRY` and
    `isNoRenderGeometryError(err)` to match it; the CLI and MCP map it to their
    existing tailored messages.

  - **BREAKING: sibling exporters return bytes.** `exportObj`, `exportCsv`,
    `exportJson`, `exportJsonld`, `exportIfcx`, `exportStep`, `exportMerged` and
    `exportHbjson` (wasm boundary, `IfcLiteBridge`, and `GeometryProcessor`) now
    return `Uint8Array` (UTF-8) instead of `string`, so output is no longer capped
    by the V8 max-string ceiling (~512 MB) - the same escape GLB already had.
    Decode with `TextDecoder` where a string is genuinely needed; file writers
    should write the bytes directly.

### Patch Changes

- Updated dependencies [[`8e43ecf`](https://github.com/LTplus-AG/ifc-lite/commit/8e43ecf540b88b942a4ec2127dd9bcf24ec244fa), [`d1e16f9`](https://github.com/LTplus-AG/ifc-lite/commit/d1e16f944ea9f3a35a7153959f13db168a35c229), [`6d2cb21`](https://github.com/LTplus-AG/ifc-lite/commit/6d2cb21a170413c6c98aadf10d254667b2ed2b53), [`204cab4`](https://github.com/LTplus-AG/ifc-lite/commit/204cab48f8e3b6326a8005628ed5b7174d9d694c), [`a48abac`](https://github.com/LTplus-AG/ifc-lite/commit/a48abacfacdf226702f2454859afe9abe018e029), [`3d25765`](https://github.com/LTplus-AG/ifc-lite/commit/3d25765edc2cee40268a6d5a27d4055f88f76489), [`b66ff1d`](https://github.com/LTplus-AG/ifc-lite/commit/b66ff1dd915a0ff4f60198a511adb7ed7f714079)]:
  - @ifc-lite/geometry@3.0.0
  - @ifc-lite/data@2.3.0
  - @ifc-lite/query@1.14.11
  - @ifc-lite/export@2.4.0
  - @ifc-lite/clash@1.4.1
  - @ifc-lite/parser@3.5.2
  - @ifc-lite/viewer-core@0.2.7
  - @ifc-lite/ids@1.15.22

## 0.4.1

### Patch Changes

- 24e1648: Make the Rust-backed exporters reliable on large and degenerate inputs.

  Remove the ~512 MB input cap on GLB/glTF (and the sibling OBJ, CSV, JSON, JSON-LD,
  STEP, IFCX, HBJSON exporters). They decoded the entire input IFC byte buffer into a
  single JS string via `safeUtf8Decode` before crossing into WASM, where the binding
  immediately turned it back into bytes (`content.as_bytes()`). For an input over V8's
  `0x1fffffe8` (~512 MB) string ceiling that decode threw "Cannot create a string longer
  than 0x1fffffe8 characters", so files in the 0.5 GB+ range failed before any geometry
  ran. The boundary now passes the raw `Uint8Array`/`&[u8]` straight through (matching the
  existing `exportMerged` path), which removes the cap, drops a redundant full-buffer copy
  and a UTF-8 re-encode, and is byte-faithful for non-UTF-8 input.

  Scope: this lifts the cap on the INPUT side for all exporters. GLB returns a
  `Uint8Array`, so its output also escapes the V8 ceiling; the string-returning
  exporters (OBJ/CSV/JSON/JSON-LD/STEP/IFCX/HBJSON) still cap their serialized OUTPUT
  at the same ~512 MB string limit. In-browser, the wasm32 linear-memory heap (not the
  string cap) is the practical ceiling for the very largest models.

  Fail loud on an empty GLB export. A malformed-but-parseable model (or a filter whose
  matched entities carry no triangulated geometry) produced a structurally valid GLB with
  zero meshes, which the CLI and MCP tools wrote to disk and reported as success. Both now
  reject a zero-mesh GLB with a clear error (new `countGlbMeshes` helper in
  `@ifc-lite/export`).

  Guard the GLB assembler against the glTF 32-bit buffer limit. The assembler cast every
  buffer offset and byteLength `as u32`; past 4 GiB those casts silently wrapped (release
  builds disable overflow checks) and emitted a corrupt GLB. It now sums the binary buffer
  length in `usize` and asserts the 4 GiB ceiling with a clear message instead of wrapping.

- 7c45192: Instance repeated geometry in GLB/glTF export (50-85% smaller on repetitive models).

  The from-bytes GLB assembler baked every element occurrence in full, so a model with
  hundreds of identical windows, doors, or steel parts (one IFC `RepresentationMap`
  referenced by many `IfcMappedItem`s) emitted that geometry hundreds of times. The
  exporter now reuses the same representation-identity collation the GPU/native
  instancing path uses: each repeated shape is emitted ONCE and every occurrence is
  placed with a glTF node matrix carrying its world pose.

  Each occurrence's node matrix is recomputed in f64 from the per-occurrence world
  placement, the model RTC / site-local offset the baker subtracted, and the Z-up to Y-up
  basis change, then folded against the model-wide scene centre before the single f32
  downcast. Doing the relative transform in the post-RTC baked frame (not the placement's
  pre-RTC frame) is what keeps a ROTATED occurrence correct under a non-zero site/georef
  offset — otherwise it is mis-translated by `(R - I) * rtc`, kilometres at national-grid
  coordinates. The f64 composition keeps the absolute-magnitude terms cancelling to a
  model-relative, f32-precise translation even at national-grid scale.

  Only exact-bit groups are instanced (the template's local geometry IS each occurrence's),
  so the exported per-occurrence geometry is byte-faithful; rigid-tier and any
  singular-placement groups fall back to the flat path. Two round-trip tests reconstruct
  every instanced occurrence's world geometry from `root.translation * node.matrix *
template_local` and match the baked geometry to under a millimetre — one on a real model,
  one synthetic with a rotated instance at national-grid coordinates.

  Non-instanced occurrences keep the existing self-contained `world - scene_center` vertex
  bake (no node transform), so a consumer that ignores node transforms still sees them
  correctly placed. The flat remainder is additionally content-hash deduped (byte-identical
  baked meshes share one mesh placed by a node translation), so the output never regresses
  below the prior per-occurrence baseline on models without representation-level repeats.

  Measured GLB size: C20-Institute 4.0 -> 1.3 MB (-68%), AC20-Smiley 13.0 -> 2.4 MB (-82%),
  schependomlaan 15.5 -> 7.6 MB (-51%); models with no repeats are unchanged. Output is
  byte-deterministic. The viewer's from-meshes GLB path is unaffected (it carries no
  instancing side-channel and falls back to the flat content-hash dedup).

- Updated dependencies [e6bd2dd]
- Updated dependencies [24e1648]
- Updated dependencies [f9f0784]
- Updated dependencies [7c45192]
- Updated dependencies [6eb46f1]
- Updated dependencies [775e479]
- Updated dependencies [4f76955]
- Updated dependencies [909c1b0]
- Updated dependencies [3f25a72]
  - @ifc-lite/geometry@2.13.0
  - @ifc-lite/export@2.3.0

## 0.4.0

### Minor Changes

- [#1242](https://github.com/LTplus-AG/ifc-lite/pull/1242) [`fec82b9`](https://github.com/LTplus-AG/ifc-lite/commit/fec82b9f3eea3655f92413fce82387ddce2f9722) Thanks [@louistrue](https://github.com/louistrue)! - Add Rust-backed domain-format exporters. The new `ifc-lite-export` crate is the
  source of truth for Wavefront OBJ, glTF/GLB, CSV, JSON and JSON-LD (plus a
  native-only ara3d BOS/Parquet path). They are exposed via wasm
  (`exportObj`/`exportGlb`/`exportCsv`/`exportJson`/`exportJsonld`) and
  reachable from TypeScript through `GeometryProcessor.export*` and
  `IfcLiteBridge.export*`. Geometry exporters fold per-mesh RTC origin correctly (glTF
  emits it as a node translation, keeping f32 vertex precision at georef scale).

  STEP export also supports schema conversion (`IFC2X3`/`IFC4`/`IFC4X3`/`IFC5` entity-type
  renames + attribute trimming) and a mutation bridge — `exportStep` takes a `mutations_json`
  payload (`MutablePropertyView` attribute edits + property-set synthesis: new
  `IfcPropertySingleValue`/`IfcPropertySet`/`IfcRelDefinesByProperties` entities). New Rust exporters:
  **IFC5/IFCX** (`exportIfcx` — USD-style node graph: spatial hierarchy + classes + known
  IFC5 properties) and **Merged** (`exportMerged` — combine several models into one STEP,
  id-offset + project unification).

  The CLI `export` command gains `--format obj|gltf|glb|jsonld|step|ifcx` (Rust-backed;
  `--type`/`--storey`/`--where`/`--limit` act as the isolation set — for `step` the forward
  `#`-reference closure is added so a filtered export never dangles a reference; `--schema`
  converts entity types). The MCP `export_glb` tool is unstubbed, `export_ifcx` is unstubbed,
  and a new `export_obj` tool is added (all honour an optional `type` filter).

  Also makes the wasm geometry engine usable under Node: `IfcLiteBridge.init()` now reads
  the `.wasm` bytes itself when running in Node (whose `fetch()` cannot load `file://`),
  strictly Node-gated so the browser/worker path is unchanged. This additionally fixes
  headless `clash`/geometry commands that previously failed to initialize wasm in Node.

  The viewer's GLB export now assembles the binary in Rust over the meshes it already
  holds (`GeometryProcessor.exportGlbFromMeshes`, wasm `exportGlbFromMeshes`) instead of the
  TypeScript GLTFExporter — no re-meshing, and the per-element RTC origin rides a glTF node
  translation so georef-scale models keep vertex precision.

  **BREAKING (`@ifc-lite/export`):** `GLTFExporter`, `JSONLDExporter`, and `CSVExporter`
  (+ their option types) are removed — glTF/GLB, JSON-LD, and CSV are now produced in Rust. Use
  `GeometryProcessor.exportGlb` / `exportGlbFromMeshes`, `exportJsonld`, and
  `exportCsv(bytes, mode, …)` (mode ∈ `entities`|`properties`|`quantities`|`spatial`). All in-repo
  callers (viewer GLB / command-palette / mobile / location-map / main-toolbar CSV exports, LOD1
  generator) are migrated; the Rust CSV gained the spatial-hierarchy mode to match.

### Patch Changes

- Updated dependencies [[`fec82b9`](https://github.com/LTplus-AG/ifc-lite/commit/fec82b9f3eea3655f92413fce82387ddce2f9722), [`0a0a922`](https://github.com/LTplus-AG/ifc-lite/commit/0a0a922adba1dabc56e97cc5ce0c553ab7356b3e)]:
  - @ifc-lite/geometry@2.9.0
  - @ifc-lite/export@2.0.0
  - @ifc-lite/sdk@1.20.1

## 0.3.3

### Patch Changes

- [#1071](https://github.com/LTplus-AG/ifc-lite/pull/1071) [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe) Thanks [@louistrue](https://github.com/louistrue)! - Dead-code and dependency hygiene: remove unused internal barrels/shims (clash engine-ts re-exports, collab doc barrel, sdk transport/types) and drop unused dependencies (renderer/cli: @ifc-lite/wasm; cli/mcp: @ifc-lite/encoding; mcp: @types/node out of runtime dependencies; collab: ws devDeps; data: @types/proj4). No public API changes.

- Updated dependencies [[`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`da1999f`](https://github.com/LTplus-AG/ifc-lite/commit/da1999fc6e482fa3d668b9aa98a840d2bb838112)]:
  - @ifc-lite/create@1.16.2
  - @ifc-lite/export@1.19.6
  - @ifc-lite/parser@3.2.0
  - @ifc-lite/geometry@2.6.1
  - @ifc-lite/clash@1.1.3
  - @ifc-lite/sdk@1.18.3
  - @ifc-lite/data@2.0.3
  - @ifc-lite/ids@1.15.10

## 0.3.2

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc), [`8d5bd67`](https://github.com/LTplus-AG/ifc-lite/commit/8d5bd6701dc9962c2de5e42a7462008b2b8c2885)]:
  - @ifc-lite/bcf@1.15.6
  - @ifc-lite/clash@1.1.2
  - @ifc-lite/create@1.16.1
  - @ifc-lite/data@2.0.2
  - @ifc-lite/encoding@1.14.7
  - @ifc-lite/export@1.19.5
  - @ifc-lite/geometry@2.4.1
  - @ifc-lite/ids@1.15.6
  - @ifc-lite/mutations@1.15.3
  - @ifc-lite/parser@3.1.1
  - @ifc-lite/query@1.14.10
  - @ifc-lite/sdk@1.18.1
  - @ifc-lite/viewer-core@0.2.6

## 0.3.1

### Patch Changes

- [#946](https://github.com/LTplus-AG/ifc-lite/pull/946) [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0) Thanks [@louistrue](https://github.com/louistrue)! - Fix a batch of verified findings from a full-codebase review (security, correctness,
  data-loss, and resource/memory leaks). Highlights:

  **Security**

  - collab-server: a malformed WebSocket frame no longer crashes the whole process
    (decode is wrapped; a bad frame is rejected/audited instead of throwing).
  - mcp: the local HTTP transport now validates `Host`/`Origin` and no longer sends a
    wildcard `Access-Control-Allow-Origin`, closing a DNS-rebinding/CSRF hole; the
    `AuthScope.modelIds` allowlist is now enforced at model resolution.
  - server-bin: `extractZip` uses `execFileSync` (argv, no shell), removing command
    injection via archive/destination paths.
  - export / sdk / cli / mcp / lists / viewer CSV exporters now neutralize spreadsheet
    formula injection (CWE-1236) consistently.
  - create-ifc-lite: validates the project name (no path traversal) and drops the
    unused `execSync`-based downloader.
  - embed-sdk: inbound `postMessage` now validates `event.origin`.

  **Correctness / data-loss**

  - parser: `lengthUnitScale` survives the worker transport; the nested STEP list
    parser is string-aware (commas/parens inside quoted values no longer mis-split).
  - mutations: deleting a property from a session-created pset and replaying
    `UPDATE_ATTRIBUTE` / `CREATE_PROPERTY_SET` mutations now work.
  - export: merged-export ID remapping no longer rewrites `#N` inside quoted strings.
  - drawing-2d: GPU section cutter triangle upload/readback use correct WGSL std-layout
    offsets and strides.
  - ifcx: cyclic children no longer abort the parse; spatial children round-trip; the
    mesh transform guards a zero/non-finite homogeneous `w`.
  - data / cache: a `NULL` string property value stays `null` instead of becoming `""`.
  - pointcloud, bcf, server-client, query, viewer-core, viewer store/federation: assorted
    decoding, federation-id, and selection-state fixes.

  **Resource / memory leaks**

  - geometry, query (DuckDB), renderer (GPU buffers), collab (federation presence),
    sandbox (host log capture + runtime), mcp (clash mesh cache), server-bin (signal
    listeners), and the viewer renderer on unmount now release resources deterministically.

  **Hardening (apps, not published)**

  - server: a dedicated `server-release` Cargo profile (`panic = "unwind"`) plus a
    `CatchPanicLayer` contain a malformed-IFC parse panic to the offending request
    instead of aborting the whole server.
  - desktop (Tauri): a Content-Security-Policy is set, and unused `shell:*` /
    `fs:allow-write|mkdir|remove` capabilities (and the unused shell plugin) are removed.

  **Second pass** (additional verified findings)

  - collab-server: S3 log load now follows `ListObjectsV2` pagination (no dropped frames);
    awareness frames are size-capped + rate-limited; path-lock verify runs after role/rate-limit;
    the blob route requires auth and `/metrics` can be token-gated.
  - server-bin: downloaded binaries are SHA-256 verified against a release sidecar (fail-closed on
    mismatch, warn-if-absent for older releases).
  - extensions: inner-ring capability check fails _closed_ for unknown namespaces; signing
    canonicalization is now injective (length-prefixed).
  - correctness/leaks: mutations quantity type+unit preserved on replay; `findByProperty` boolean
    comparisons; Parquet REAL columns kept as Float64; blob GC fail-safe on missing `uploadedAt`;
    spatial-hierarchy + codegen cycle guards; BVH NaN edge; bSDD/playground caches bounded;
    point-cloud GPU asset freed on federation error; mcp `parseColor` rejects non-hex; bcf/SVG/STEP
    output escaping; and more.

- Updated dependencies [[`b33e1f7`](https://github.com/LTplus-AG/ifc-lite/commit/b33e1f7c4706fe4b0d850d3da782ea84267dd525), [`55fd14e`](https://github.com/LTplus-AG/ifc-lite/commit/55fd14e5017f626567b10622bb41ddac3311e70c), [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0), [`ca293ed`](https://github.com/LTplus-AG/ifc-lite/commit/ca293ed7080495b29dd555b191ae0095ff267e4b)]:
  - @ifc-lite/parser@3.1.0
  - @ifc-lite/geometry@2.3.0
  - @ifc-lite/query@1.14.9
  - @ifc-lite/mutations@1.15.2
  - @ifc-lite/export@1.19.4
  - @ifc-lite/viewer-core@0.2.5
  - @ifc-lite/data@2.0.1
  - @ifc-lite/sdk@1.17.1
  - @ifc-lite/clash@1.1.1
  - @ifc-lite/bcf@1.15.5
  - @ifc-lite/ids@1.15.5

## 0.3.0

### Minor Changes

- [#891](https://github.com/LTplus-AG/ifc-lite/pull/891) [`d6b8986`](https://github.com/LTplus-AG/ifc-lite/commit/d6b89866b4c058531ce0c5c7472a297adc6580a8) Thanks [@louistrue](https://github.com/louistrue)! - Add representation-agnostic clash detection.

  `@ifc-lite/clash` is a new package: a source-agnostic clash core (STEP/IFCX
  adapters, BVH broad phase, exact triangle-intersection narrow phase, hard /
  clearance / touch classification) with a pluggable TS reference kernel and a
  Rust/WASM kernel kept in lockstep by a differential test. Results group into a
  _manageable_ set of BCF topics (deterministic topic GUIDs, caps-with-transparency,
  framing viewpoints, A/B coloring, optional snapshots) and round-trip status back.

  Surfaced through the existing tools:

  - `@ifc-lite/clash` — `rulesFromPresets(presets, mode, clearance?, reportTouch?)` builds
    runnable rules from any preset list (the discipline matrix is this over the built-ins),
    so hosts can run a user-curated rule set.
  - `@ifc-lite/viewer` — an interactive clash panel (run detection / discipline matrix /
    presets, A/B highlight + camera framing, configurable settings & custom rules, a
    controllable BCF export with optional rendered snapshots).
  - `@ifc-lite/sdk` — a `clash` namespace (`run`, `matrix`, `group`, presets).
  - `@ifc-lite/cli` — `ifc-lite clash <file>` with `--a/--b`, `--mode`, `--matrix`,
    `--clearance`, `--bcf`.
  - `@ifc-lite/mcp` — `clash_check` (omit selectors for a whole-model self-clash)
    and `clash_matrix`.

  The discipline matrix now threads a `clearance` value onto its rules, so
  `--matrix --mode clearance --clearance N` (and the SDK/MCP equivalents) report
  violations instead of silently dropping the override.

### Patch Changes

- Updated dependencies [[`d6b8986`](https://github.com/LTplus-AG/ifc-lite/commit/d6b89866b4c058531ce0c5c7472a297adc6580a8)]:
  - @ifc-lite/clash@1.1.0
  - @ifc-lite/sdk@1.17.0

## 0.2.1

### Patch Changes

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85), [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/parser@3.0.0
  - @ifc-lite/export@1.19.3
  - @ifc-lite/data@2.0.0
  - @ifc-lite/create@1.15.1
  - @ifc-lite/ids@1.15.4
  - @ifc-lite/query@1.14.8
  - @ifc-lite/sdk@1.16.1
  - @ifc-lite/viewer-core@0.2.4
  - @ifc-lite/mutations@1.15.1

## 0.2.0

### Minor Changes

- [#615](https://github.com/louistrue/ifc-lite/pull/615) [`7a7cf79`](https://github.com/louistrue/ifc-lite/commit/7a7cf79c181004f9974bd303181aeeaa97d6869d) Thanks [@louistrue](https://github.com/louistrue)! - Add `@ifc-lite/mcp` — Model Context Protocol server for ifc-lite, exposing
  the BIM runtime to any MCP-aware LLM agent (Claude Desktop, Cursor,
  ChatGPT, Goose, Windsurf, Zed, custom). v0.1 ships with stdio + Streamable
  HTTP transports, scope-gated tool surface across discovery / query /
  geometry / validation (IDS + audit) / mutation / BCF / bSDD / diff /
  export / viewer, an `ifc-lite://` resource scheme, eleven pre-baked
  prompt templates, and an `ifc-lite mcp` CLI subcommand.

  The 3D viewer is a first-class workflow:
  • `viewer_open` boots the WebGL viewer in-process and swaps streaming
  adapters into the headless backend so every `bim.viewer.*` /
  `bim.visibility.*` call drives the live scene.
  • `viewer_colorize`, `viewer_isolate`, `viewer_fly_to`,
  `viewer_color_by_property`, `viewer_set_section` make agent-driven
  visualization a single tool call.
  • User picks in the browser flow back to MCP via SSE and surface as
  `notifications/resources/updated` on `ifc-lite://viewer/selection`.
  `viewer_get_selection` reads the latest pick; `viewer_wait_for_selection`
  blocks until the next click.
  • `viewer_ask` emits agent-friendly wording so the agent can request
  user permission before opening a browser tab.
  • CLI flags `--viewer`, `--viewer-port`, and `--open` automate startup.

### Patch Changes

- Updated dependencies [[`7a7cf79`](https://github.com/louistrue/ifc-lite/commit/7a7cf79c181004f9974bd303181aeeaa97d6869d)]:
  - @ifc-lite/ids@1.14.11
