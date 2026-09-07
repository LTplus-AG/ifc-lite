# @ifc-lite/viewer

## 1.40.1

### Patch Changes

- [#3998](https://github.com/LTplus-AG/ifc-lite/pull/3998) [`7ad6dc1`](https://github.com/LTplus-AG/ifc-lite/commit/7ad6dc1dd7f347d9dc5c51ee2decab81519b79c0) Thanks [@louistrue](https://github.com/louistrue)! - Flip the BCF panel's arrows so import points into the panel and export points out.
- Updated dependencies [[`8eb1c25`](https://github.com/LTplus-AG/ifc-lite/commit/8eb1c258fafc73bd9c83c7af95ba2feebf00fb34), [`a24b8cf`](https://github.com/LTplus-AG/ifc-lite/commit/a24b8cff9598e48c75c5f9fbebd036e72c09063e), [`ae886b4`](https://github.com/LTplus-AG/ifc-lite/commit/ae886b4d113a227826fdec535a3d66f6d963beb9), [`58504e7`](https://github.com/LTplus-AG/ifc-lite/commit/58504e7ad1cb5377e2ab48fe212a5d14998fccf9), [`9dd8ba1`](https://github.com/LTplus-AG/ifc-lite/commit/9dd8ba133f4d261b3ebc9d37fbf8962a63890b8c), [`2ac2d03`](https://github.com/LTplus-AG/ifc-lite/commit/2ac2d03b874bd9f58637c8c8d194b8f8a9e563af), [`90f4859`](https://github.com/LTplus-AG/ifc-lite/commit/90f4859b73f694114baec821721be498757b9c48), [`62e41d5`](https://github.com/LTplus-AG/ifc-lite/commit/62e41d57ec5a41769b91d01e35d10113de91900b), [`85089b1`](https://github.com/LTplus-AG/ifc-lite/commit/85089b1ccbf43d7d9982cd8a2f7c31de8e2207df), [`dfc543b`](https://github.com/LTplus-AG/ifc-lite/commit/dfc543b58306b7e457628365e75afb18e1fcfde4), [`2f2fb88`](https://github.com/LTplus-AG/ifc-lite/commit/2f2fb88cb59ef0f7ef938b3bea1afde35ceb7914), [`165ee1f`](https://github.com/LTplus-AG/ifc-lite/commit/165ee1fa486f799f59531fe332cad6bf67bd3f10), [`2f2fb88`](https://github.com/LTplus-AG/ifc-lite/commit/2f2fb88cb59ef0f7ef938b3bea1afde35ceb7914), [`2f2fb88`](https://github.com/LTplus-AG/ifc-lite/commit/2f2fb88cb59ef0f7ef938b3bea1afde35ceb7914), [`e409924`](https://github.com/LTplus-AG/ifc-lite/commit/e40992485dd2a0c845225be237c65fd12603d689), [`96ea5f0`](https://github.com/LTplus-AG/ifc-lite/commit/96ea5f08e4872cb50fe9eac7a9878ff607eb3f4a), [`5cbe8aa`](https://github.com/LTplus-AG/ifc-lite/commit/5cbe8aac32ee1b8871357c7dcd9c1154161322d5)]:
  - @ifc-lite/bcf@3.0.1
  - @ifc-lite/parser@5.2.0
  - @ifc-lite/cache@3.3.0
  - @ifc-lite/wasm@6.4.0
  - @ifc-lite/geometry@4.3.0
  - @ifc-lite/renderer@2.0.1
  - @ifc-lite/ids@1.16.0

## 1.40.0

### Minor Changes

- [#3947](https://github.com/LTplus-AG/ifc-lite/pull/3947) [`5d4140b`](https://github.com/LTplus-AG/ifc-lite/commit/5d4140b305aa3ef2c1d82e1def85095c8832bbed) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Compare a saved clash-run baseline against the current run and see which clashes are new, still open, or no longer detected ([#3928](https://github.com/LTplus-AG/ifc-lite/issues/3928)).
  
  `@ifc-lite/clash` already shipped `compareClashRuns`, the matching engine for diffing two clash runs by their durable `clashReviewKey`, but it had no viewer, CLI, or sandbox consumer. This adds one: a "Compare clash runs" dialog in the clash panel header lets a coordinator save the current result as a baseline and later compare a fresh run against it.
  
  A raw `compareClashRuns` diff is unsafe to show as-is: it cannot tell "genuinely fixed" apart from "we didn't actually re-check". A dropped rule, a rule whose selector now matches nothing, or a model no longer part of the comparison all make a clash vanish from the current run's results for reasons that have nothing to do with the model getting better. `@ifc-lite/clash` gains `compareClashRevisions`, which wraps `compareClashRuns` and reclassifies an unsafe `resolved` clash into a new `unretested` bucket, so a coordinator is told "unconfirmed" instead of a false "fixed". The viewer dialog surfaces the reason for every `unretested` clash instead of hiding it in a bucket count.
  
  The safety check works at per-element granularity, not just per-rule/per-model: a `resolved` clash is only trusted when BOTH of its elements are confirmed, by durable key, to still be matched by the SAME SIDE of the same rule in the current run (`ClashRuleCoverage.matchedKeysA`/`matchedKeysB`, new fields the engine now records alongside the existing match counts). Checking `matchedKeysA` and `matchedKeysB` separately, rather than as one combined set, matters when the two sides overlap (e.g. an element listed in both `membersA` and `membersB`): a clash's A-side element must still be matched on side A, and its B-side element still matched on side B — an element that only moved to the other side is not "still matched" for that clash. A self-clash rule (no `b` side at all) has just the one group, so its two elements are checked against that single set instead. This also catches a narrowed selector or re-scoped membership filter that drops just one previously-clashing element while the rule's overall coverage stays non-zero, and a durable key (e.g. GlobalId) that was re-minted between exports for the same physical element. Model identity for the missing-model check no longer collapses on a duplicate display name: two models sharing one name are told apart by how many still share it, not by simple set membership.
  
  The viewer's saved-baseline persistence now validates the stored shape (`result.clashes` must be an array) and its schema version before trusting it, instead of handing a structurally-thin corrupted value to the compare engine, which iterates `clashes` directly.
  
  New exports on `@ifc-lite/clash`: `compareClashRevisions`, `ClashRevisionSide`, `ClashRevisionComparison`, `ClashRevisionReasons`.

- [#3945](https://github.com/LTplus-AG/ifc-lite/pull/3945) [`aaa6253`](https://github.com/LTplus-AG/ifc-lite/commit/aaa625341db3f53111cb1c3ceaf3647650874ce9) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Add a portable federation setup file: save which models make up a federation (load order, visibility, and the alignment anchor) and reopen it later by matching saved slots back to local files by content fingerprint. The file references source files by name, size, and a content fingerprint — it never embeds file bytes, paths, or handles. Reopening replays the existing alignment pipeline against the restored anchor rather than storing baked transforms, and always reports how many models were restored versus missing or mismatched instead of silently accepting a partial restore. Reachable via the command palette ("Save Federation Setup" / "Open Federation Setup").

- [#3942](https://github.com/LTplus-AG/ifc-lite/pull/3942) [`360cca0`](https://github.com/LTplus-AG/ifc-lite/commit/360cca0a7855caa0da18e12ac9aa984e565344ee) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Add a per-model Load Report panel showing source/schema, load path, existing geometry diagnostics, and applicable approximation settings ([#3927](https://github.com/LTplus-AG/ifc-lite/issues/3927)).
  
  Each loaded model now has a compact report: the file's schema version, resolved load path (wasm/cache/server/point-cloud), tessellation tier and fast-mode setting, plus the load's CSG/opening diagnostics rendered as actionable text (dropped representation items, silent no-op cuts, CSG failures, oversized content-hash reference drops). A model whose diagnostics were never captured for its current load (a cache hit, the server render path, GLB, or IFCX) reads as "diagnostics unavailable", never as a false "clean" result; a model with nothing diagnostic-worthy shows a quiet "clean" line instead of a fabricated warning.
  
  Diagnostic hosts that carry a captured bounding box are listed as affected entities and can be selected and framed in 3D from the panel; hosts and dropped-item categories that carry no entity identity in the diagnostics contract are summarized as counts only, never invented as a selectable entity. The report can be exported as JSON for reproduction. Reachable from the Analyze ribbon tab and the command palette ("Load Report").

### Patch Changes

- [#3958](https://github.com/LTplus-AG/ifc-lite/pull/3958) [`4e08fe8`](https://github.com/LTplus-AG/ifc-lite/commit/4e08fe835569f21fa61a4b82237efb8bc535cf33) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Split `CommandPalette.tsx`'s fuzzy search/ranking and recent-usage helpers into a new `commandPaletteSearch.ts` module. This is a pure internal refactor to bring the file back under the repo's module-size budget (it had grown to 852 lines against an 849-line budget after two same-day PRs each added a command entry) — no command was renamed, removed, or behaviorally changed.
- Updated dependencies [[`5d4140b`](https://github.com/LTplus-AG/ifc-lite/commit/5d4140b305aa3ef2c1d82e1def85095c8832bbed), [`af067e5`](https://github.com/LTplus-AG/ifc-lite/commit/af067e598e64cbc8265fdcd462ac9cb9727711a2), [`e1d807c`](https://github.com/LTplus-AG/ifc-lite/commit/e1d807cf4bf4f3bf25122fed4d7e3fde8296bf6d), [`09f9419`](https://github.com/LTplus-AG/ifc-lite/commit/09f941947666f567cd1fd6fd362041e048868434), [`6094e2f`](https://github.com/LTplus-AG/ifc-lite/commit/6094e2f16f27c80bc227f73bbdf634a770f17abc), [`af067e5`](https://github.com/LTplus-AG/ifc-lite/commit/af067e598e64cbc8265fdcd462ac9cb9727711a2)]:
  - @ifc-lite/clash@2.1.0
  - @ifc-lite/parser@5.1.0
  - @ifc-lite/ids@1.15.54
  - @ifc-lite/wasm@6.3.0
  - @ifc-lite/sdk@4.0.1

## 1.39.0

### Minor Changes

- [#3697](https://github.com/LTplus-AG/ifc-lite/pull/3697) [`bc0906e`](https://github.com/LTplus-AG/ifc-lite/commit/bc0906e18053717b184a06ef022abee4012c4f49) Thanks [@louistrue](https://github.com/louistrue)! - Let a BYOK Anthropic key that spans several workspaces authenticate at all.
  
  Anthropic keys come in two shapes. One is created against a single workspace and carries that binding itself. The other — an identity-linked key, personal or service-account, with access to more than one workspace — carries no binding, so the API cannot tell which workspace a request acts in and rejects every one of them:
  
  ```text
  400 anthropic-workspace-id is required when authenticating with an identity-linked
  API key; send the id of the workspace this request acts in.
  ```
  
  The SDK sends auth, version and content-type on its own. `anthropic-workspace-id` is the caller's to send, and nothing here sent it, so a key of the second kind could not be used at all. Every model failed identically, which reads like a model problem and is not one — the request never gets far enough to select a model.
  
  **The credential is now a pair, in the type.** Modelling it as a bare `apiKey: string` is what made this a bug rather than a setting: each call site had to remember a header it could not see in the signature, and one of the two did not. `createAnthropicClient({ apiKey, workspaceId })` in the new `lib/llm/anthropic-client.ts` is the only place a browser-side client is constructed, and it applies the header, so no call site can forget it. `resolveStreamRoute` carries `credentials` instead of `apiKey`; `streamAnthropicChat` and the MCP playground's `runConversation` both take the pair. An empty workspace id sends no header at all rather than a blank one, because a blank header is itself a 400 on a single-workspace key — the common case.
  
  **Settings gained an optional Workspace ID field** on the Anthropic tab only. Stored configs written before the field existed read back with an empty one, so no browser needs a migration. The BYOK walkthrough now says to scope a new key to one workspace, which avoids the field entirely.
  
  **One form, one Save.** The Settings tab commits what is on screen in a single write. While the workspace box had its own separate Save, the ordinary first run — paste both, press the Save you can see — stored the key, said "key saved", and dropped the id while leaving it in the box; the next request then failed with this feature's own error telling the user to add an id their Settings appeared to hold. `saveCredential` in `api-keys.ts` does the composite write: an empty key box means "keep the stored key", an untouched workspace box lets the rule below stand, and a touched one wins over it. Collapsing the two forms also removed the second button reading "Save", the remount that discarded an unsaved draft, and the focus drop to `<body>` on save.
  
  **A workspace id never outlives the key it was entered for.** Both writes go through `api-keys.ts` — `clearProvider` on removal and `saveCredential` on save, over one shared `keyWriteUpdates` rule keyed by a per-provider table — because the pairing is a fact about the credential, not about whichever button happens to offer it, and not about Anthropic in particular. Replacing the key is the path that matters and the one the walkthrough now recommends: swap a multi-workspace key for a single-workspace one and a carried-over id would send every request to a workspace the new key was never granted, failing with a 400 naming a workspace the user does not remember choosing. Saving a *different* key clears the id and the toast says so, since re-entering one is a paste and chasing a stale one is not. Re-pasting the same key — what people do when a request fails and they want to be sure the key is set — changes no binding and keeps the id, because discarding a correct one there would create the failure they were checking for. Nor does the *first* key clear one: both fields are visible from the start, so a new user can fill the workspace box first, and "replaces" needs something to replace.
  
  **The field refuses a value carrying a paste artifact.** Header values are ByteStrings, so a character above U+00FF throws while the request is built, before any HTTP call, with a message about ByteStrings and a character index and nothing naming the box it came from — and it repeats on every send until the user happens to clear it. The rule is plain printable ASCII, deliberately stricter than that boundary: a non-breaking space would go out fine, but an NBSP, a zero-width space or a curly quote in an id is a copy artifact rather than a plausible value, all of them survive a paste out of a console UI where a newline would not, and naming the cause locally beats a server 400 for an id that looks correct. Control characters are refused too: a CR or LF in a header value is header injection, not a typo. It still says nothing about the id's *format* — a clean but wrong id earns the 400 the mapper explains, because guessing the format would reject ids the API may yet start issuing.
  
  The modal's audit link followed the code. Its trust bullet pointed at `stream-direct.ts` and claimed the BYOK path was "~60 lines"; that path is now two files, and for a modal whose whole job is claims you can check in DevTools, a link that no longer covers the code holding your key is the wrong kind of stale. It lists the files it actually spans, per provider.
  
  **The failure explains itself.** A 400 naming the header used to reach the user as `Anthropic error (400): 400 {"type":"error",...}`. Two different 400s name it — one for a missing id, one for an id the API cannot resolve — and telling someone to add an id they already added is a dead end, so the message follows what the request carried rather than a second phrase in Anthropic's wording. Whether a 400 concerns the header at all is still matched on text, because the API offers no machine-readable code — but on the body's own message field and anchored to its start, which is where both of Anthropic's messages put the header name. A 400 that merely quotes the name elsewhere (a rejected tool schema; the MCP playground forwards tool definitions it did not write) keeps its own actionable wording instead of being buried under a dead end pointing at a field that is fine. A rephrasing that buried the name mid-sentence would fall through to the previous generic text rather than to anything worse. The 401 and 429 messages are unchanged, and now shared with the playground, which previously printed raw `err.message` for everything.
  
  `byok_key_saved` gained `saved_fields` and `has_anthropic_workspace`. Every write goes through one path, so a workspace-id edit already fired this event and was indistinguishable from a key save — any existing count of BYOK key saves silently included them. Naming the fields written separates the two and answers the question the new field raises: how many BYOK users actually need one.
  
  The paths this change exists to fix are now the paths under test. `streamAnthropicChat` — the viewer chat's actual call, and the one the original bug lived in — had no test at all: every header assertion sat on `createAnthropicClient` driving `messages.create`, while the chat calls `messages.stream`, so the bug could have been reintroduced with the suite green. It is now driven end to end against a real SSE body. The MCP playground, the second consumer, was likewise uncovered; dropping the workspace id there or handing the error mapper the wrong one both survived the whole suite, and both now fail a test that reads the outgoing headers and the rendered message.
  
  Covered by tests that drive a request through a stubbed `fetch` and read the headers that actually went out — asserting on the options object would hold even if the SDK dropped them — and that let the SDK build both errors from real response bodies rather than from a hand-rolled `APIError` matching our guess at their shape. One test swaps those two bodies between the two cases, so the branch cannot be passing by matching a phrase. Each assertion was checked by reverting the behaviour it covers and watching it fail.
  
  The modal's audit link is per-surface as well as per-provider. The MCP playground renders this same modal but drives its own Anthropic loop and never reaches `stream-direct.ts` — while issuing no OpenAI request at all, so its OpenAI tab keeps the default. The caller names the sending file per provider and the bullet links the code that actually runs.
  
  The clear-on-replace rule is now stated for credentials rather than for Anthropic: a per-provider table names each provider's key field and the fields bound to it, and both the save path and Remove read it. Adding an OpenAI org or project id later is a row in that table for clear-on-replace and for Remove, instead of quietly getting the passthrough the old provider branch handed OpenAI. The save path is not generalised — it still names the workspace field directly, because the form's draft shape does — so that row is two thirds of adopting a second companion field, not all of it. None of this generality has a test behind it either: there is no second companion field yet to exercise it.
  
  Two smaller repairs found on the way. A failure with no HTTP status — a dropped connection, an abort — rendered as `Anthropic error (undefined): Connection error.`; it now keeps the SDK's own wording, which the playground had before this change routed it through the shared mapper. And the rate-limit branch had no test of its own: it was folded into the 401 case, so deleting it left the file green.

- [#3908](https://github.com/LTplus-AG/ifc-lite/pull/3908) [`c5da727`](https://github.com/LTplus-AG/ifc-lite/commit/c5da72799a1832d7040942fa621c50973896b7fd) Thanks [@louistrue](https://github.com/louistrue)! - Clash rules can define each side with the viewer's advanced filter, not just a type selector ([#3902](https://github.com/LTplus-AG/ifc-lite/issues/3902)).
  
  A clash rule's A and B sets were one type-name pattern each (`IfcDuct*|IfcPipe*`), which cannot say "external walls" or "elements whose Pset_Revit_Phase.Phase is Existing". Each side of a rule may now carry a filter: the same rule rows the search panel offers — IFC type, name, predefined type, storey, elevation, property, quantity, material, classification — combined with AND or OR, edited with the same row components. The set is resolved with the same evaluator the search panel runs (`evaluateFilterRulesFederated`), so the two cannot drift apart.
  
  `ClashRule` gains optional `membersA` / `membersB`: explicit `clashMemberKey(model, ref)` membership for a side, which replaces that side's selector when present. An empty list means the filter matched nothing and is deliberately distinct from an absent one, which still means "use the selector". A side with no filter, and every rule set saved before this, runs exactly as it did.
  
  New exports on `@ifc-lite/clash`: `clashMemberKey`, `clashMemberSet` and `inClashSet` build and read that membership, and `describeEmptyRuleSides` says which side of a rule matched nothing and whether it was defined by a selector or by a filter. `ClashRuleCoverage` gains `fromMembersA` / `fromMembersB` for the same reason, and `ClashResult.rulesRun` reports each rule without its resolved member lists — those are run state, not configuration.

- [#3585](https://github.com/LTplus-AG/ifc-lite/pull/3585) [`e76791e`](https://github.com/LTplus-AG/ifc-lite/commit/e76791ea330610f3036ff33b86f99fceaae68a80) Thanks [@louistrue](https://github.com/louistrue)! - Fix isolating a geometry-less entity (an `IfcElementAssembly` or a similar container that owns no mesh of its own) blanking the entire 3D view, in the five isolation channels that never expanded it: the embed bridge's `ISOLATE` command, `?isolate=` URL params, the IDS row isolate, the IDS set isolate (the failed/passed/involved buttons), and the BCF viewpoint isolation mode.
  
  `isolatedEntities` is a whitelist the renderer matches mesh ids against, so isolating a container's own id hides everything. `expandToGeometryBearingIds` swaps such an id for the `IfcRelAggregates` parts that do carry meshes, and it is reachable from exactly one production entry point, `cameraCallbacks.resolveHighlightIds`. Those five channels never called it. Each now routes its ids through `resolvePresentationIds` (`apps/viewer/src/lib/presentation/resolvePresentationIds.ts`), which is also where the two channels that already routed — a lens rule isolate, and the SDK/MCP `isolate()` adapter [#3382](https://github.com/LTplus-AG/ifc-lite/issues/3382) fixed — now get the policy from, so there is one implementation of it instead of one per call site. The policy is [#3382](https://github.com/LTplus-AG/ifc-lite/issues/3382)'s, unchanged: the resolved ids are unioned with the raw ids, never substituted for them ([#2680](https://github.com/LTplus-AG/ifc-lite/issues/2680)).
  
  An empty resolver result keeps the raw ids rather than skipping the isolate. The resolver bounds-checks against the type-visibility filtered mesh list, so `[]` is the answer for three different situations it cannot tell apart from the outside: ids hidden by a type toggle right now (`spaces`, `spatialZones`, `openings` and `virtualElements` all ship off), ids whose meshes have not streamed in yet, and ids that are genuinely geometry-less. Aborting on `[]` would turn "Isolate failed" on an IfcSpace-scoped IDS spec, a lens rule matching spaces, an SDK `isolate()` of a space ref and an embed `?isolate=<a space>` into silent no-ops. Carrying an id that owns no mesh costs nothing: it never matches the whitelist, and the isolation starts showing the right thing the moment the toggle flips or the batch lands. This is the same reasoning `PropertiesPanel.tsx`'s group-member isolate ([#1075](https://github.com/LTplus-AG/ifc-lite/issues/1075)) and `SearchModal.filter.tsx`'s "Isolate in 3D" ([#2660](https://github.com/LTplus-AG/ifc-lite/issues/2660)) already used, which is why those two keep calling the resolver inline rather than being converted.
  
  What this does not fix, stated rather than papered over: when an id is genuinely geometry-less and none of its aggregated parts render either, the isolation is still installed on a set with no mesh in it and the viewport still goes blank ([#3426](https://github.com/LTplus-AG/ifc-lite/issues/3426)). Telling that case apart from a hidden or not-yet-streamed one needs a resolver that can see unfiltered geometry, which is Viewport plumbing rather than a policy this helper can infer.
  
  Three isolation call sites are deliberately not routed, each with its reason recorded in the gate's allowlist: `HierarchyPanel.tsx` isolates ids `treeDataBuilder.ts` already expanded to geometry-bearing members at tree-build time; `useClash.ts` only ever isolates a clash pair, whose ids are geometry-bearing by construction because detection tests actual mesh triangles; and the anonymized-export 3D preview mirrors the export's `includedIds` exactly, so a container that draws nothing there is the truth the preview exists to show.

- [#3649](https://github.com/LTplus-AG/ifc-lite/pull/3649) [`ce7a5d0`](https://github.com/LTplus-AG/ifc-lite/commit/ce7a5d03784fdceec4b47e16f0ff0fcc9edc9b74) Thanks [@louistrue](https://github.com/louistrue)! - Refresh the LLM model registry, and stop the guard that should have caught its drift from lying.
  
  **BYOK models.** Anthropic is now Opus 5, Opus 4.8, Fable 5 and Haiku 4.5; OpenAI is the GPT-5.6 family (Sol, Terra, Luna) plus GPT-5.3 Codex, which stays because there is no 5.6 Codex. Sonnet 5 keeps the mid tier at $2/$10, between the Opus entries and Haiku 4.5. `claude-haiku-4-5-20251001` becomes `claude-haiku-4-5`: both resolve, but the dated form pins one snapshot while the alias is the id the docs tell you to use, and every other entry here is unsuffixed.
  
  **A retired id lands somewhere sensible.** A model selection persists in localStorage, so dropping an id silently reassigns whoever held it to `DEFAULT_BYOK_MODEL`. That default is Opus 5, so a Haiku user would have moved from $1/$5 to $5/$25 per MTok without being told, on their own key, and an OpenAI user would have landed on an Anthropic model and been asked for a key they never needed.
  
  `MODEL_ID_MIGRATIONS` covers both cases, and the two kinds of entry are worth keeping straight. `claude-haiku-4-5-20251001` to `claude-haiku-4-5` is the same model under a new name. `claude-sonnet-4-6` to `claude-sonnet-5`, and the GPT-5.4/5.5 entries to their 5.6 counterparts, are a retired model's nearest surviving neighbour: a different model, chosen to stay with the same provider and price tier. `getModelById`, `coerceModelForEntitlement` and the playground's validity check all resolve through it, and an id with no migration still falls back to the default, which is correct and asserted.
  
  **Output ceilings were sized for models that do not think.** Opus 4.7/4.8 run without thinking when `thinking` is omitted; Opus 5 runs adaptive. Making Opus 5 the default therefore started spending a fixed ceiling on reasoning at two call sites that pass no `thinking` and never budgeted for it. `streamAnthropicChat` goes 8,192 to 32,000 (it streams, so it can afford to be generous) and the MCP playground loop goes 4,096 to 16,384, which stays under the SDK's non-streaming timeout threshold of about 21,333. Because `display` defaults to `omitted`, those tokens were billed and invisible while the answer truncated.
  
  **`acceptsSamplingParams` now defaults to false.** It was an escape hatch for two models. After this refresh every model but Haiku 4.5 rejects `temperature`/`top_p`/`top_k` with a 400, so the default pointed at the minority case and the next model added would have 400'd unless someone remembered an opt-out line the file gave no cue about. Seven opt-out lines deleted, Haiku carries the single `true`. The decision moved into `sendsSamplingParams()` so both providers share one entry point, and it fails closed on an unknown id. Forgetting the flag now costs a default temperature instead of a failed request.
  
  **`playground-model.ts` was defaulting to `claude-sonnet-4-6`,** which this change removes from the list. Nothing validated that constant even though `isValidAnthropicModel()` sits eight lines below it, so a dead id went to the API as-is. The default is now checked against the registry and degrades to the first Anthropic model.
  
  **The OpenRouter catalog guard was passing on the wrong data.** `readConfiguredFreeModels()` prefers `process.env` over `.env.local`, and the capabilities test above it set `VITE_LLM_FREE_MODELS` to its own fixtures without restoring them. The catalog check therefore validated those fixtures, and passed only because they happened to be real model ids. Both tests now restore what they mutate. Verified by pointing the guard at a bogus id and watching it fail. Worth being plain about the limit: no workflow sets `IFC_LITE_VERIFY_OPENROUTER_MODELS` or `VITE_LLM_FREE_MODELS`, and CI has no `.env.local`, so both guards still skip in automation. This makes them correct for anyone who runs them by hand; it does not make them run.
  
  **Free (proxied) models** move from `qwen/qwen3-coder` + `mistralai/devstral-2512` to `z-ai/glm-5.3-flash`, `qwen/qwen3.7-flash` and `qwen/qwen3-coder-next`. That list lives in env, so it is not visible in this diff. Both old models are still served; qwen3-coder dates from July 2025 and `qwen3-coder-next` is its successor at 40% of the input price. All three new ones cost less per token than either model they replace, two of the three take images, and all three carry tool-use.
  
  Deliberately not in this change, all pre-existing and all now more likely to be hit:
  
  - A truncated or refused Anthropic turn is not surfaced. `streamAnthropicChat` forwards Anthropic's raw `max_tokens` while `ChatPanel` tests only the OpenAI spelling `length`, and a refusal arrives as HTTP 200 with empty content, so both render as a finished or blank answer. Fixing it means touching the chat state machine: `finalizeAssistantMessage` is the only thing on the success path that returns `chatStatus` to idle, so skipping it on empty text locks the composer, and enabling Continue after a zero-text truncation continues an unrelated earlier turn. That belongs in its own change, with tests, which this area does not currently have.
  - The playground tool-call cap sets a counter it never clears, so once tripped every later turn re-enters the cap branch. The loop has no hard iteration bound.
  - `contextWindow` feeds the per-turn history budget at `ChatPanel.tsx:666`, where `MAX_RECENT_MESSAGES` only applies inside the compaction loop, so the larger windows raise how much transcript each turn ships. This already shipped: Opus 4.7 was the default BYOK model at 1M.
  - `BYOK_MODELS` has no equivalent of the free list's catalog guard, which is why Sonnet 4.6 could sit in the picker after it was gone.
  - `claude-fable-5` shares the `$$$` badge with Opus 5 despite costing exactly twice as much, which a three-tier cost scale cannot express.

- [#3738](https://github.com/LTplus-AG/ifc-lite/pull/3738) [`ab8e76e`](https://github.com/LTplus-AG/ifc-lite/commit/ab8e76e88b65243f8eb008025e2614fcb667cf33) Thanks [@louistrue](https://github.com/louistrue)! - The Properties panel now shows a "Part of Assembly" badge when the selected element is aggregated into an `IfcElementAssembly`, and clicking it selects that assembly ([#3620](https://github.com/LTplus-AG/ifc-lite/issues/3620)).
  
  An assembly owns no mesh of its own, so selecting it highlights its renderable parts with the assembly kept as the primary selection, rather than framing the camera on something the renderer then leaves unlit.

- [#3737](https://github.com/LTplus-AG/ifc-lite/pull/3737) [`6f445b6`](https://github.com/LTplus-AG/ifc-lite/commit/6f445b6f2048b18431f537de61f7ddbf8de8314d) Thanks [@louistrue](https://github.com/louistrue)! - New "Show in context" action in the Properties panel header ([#3618](https://github.com/LTplus-AG/ifc-lite/issues/3618)): fades every other entity translucent and frames the camera on the selected one, so an object behind other geometry stays visible in its surroundings instead of being isolated away from them.
  
  It preserves an active isolation rather than discarding it, and tears its own fade down when the panel closes, so a fade can never outlive the only control able to clear it.

### Patch Changes

- [#3906](https://github.com/LTplus-AG/ifc-lite/pull/3906) [`cf1b6b5`](https://github.com/LTplus-AG/ifc-lite/commit/cf1b6b5fa39f46af4a45b0d80fa635a9254e02c3) Thanks [@louistrue](https://github.com/louistrue)! - BCF server sign-in now finds the API when you enter the bare space or instance URL. BIMcollab Nexus (and Solibri's BCF connector) ask for `https://myspace.bimcollab.com`, but the API is served under `/bcf`, so discovery hit `/2.1/auth` and the connect dialog failed with "BCF request failed (HTTP 404)". An address with no path of its own now falls back to `/bcf`, and a failed request names the URL it was made to. `normalizeBcfBaseUrl` also drops a query or fragment now, so a URL copied out of the browser address bar works. New `discoverBcfService` and `resolveBcfServiceBaseUrl` exports replace hand-rolled `normalizeBcfBaseUrl` + `getAuthInfo` pairs.

- [#3574](https://github.com/LTplus-AG/ifc-lite/pull/3574) [`1d51937`](https://github.com/LTplus-AG/ifc-lite/commit/1d519376392e405645166761cc537bfbed9083cf) Thanks [@BIMvoice](https://github.com/BIMvoice)! - BCF topics and comments read from a file that omitted `CreationAuthor`/`Author` no longer show `Unknown` as their author. They now show no author byline instead of a fabricated placeholder.

- [#3530](https://github.com/LTplus-AG/ifc-lite/pull/3530) [`18e4de8`](https://github.com/LTplus-AG/ifc-lite/commit/18e4de865884d3126f478a9081cf56178fefcd00) Thanks [@BIMvoice](https://github.com/BIMvoice)! - BCF topics and comments read from a file that omitted `CreationDate`/`Date` no longer show the import time as their creation date. They now show no date and sort as oldest in the topic list. Exporting a project that contains such a topic now fails with a message naming the topic, rather than writing a `.bcfzip` other BCF tools can reject.

- [#3375](https://github.com/LTplus-AG/ifc-lite/pull/3375) [`ef1aea8`](https://github.com/LTplus-AG/ifc-lite/commit/ef1aea8e922b7669f60593dd31f6781efd308591) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix a session reset (loading a new primary file) replaying the outgoing model's camera rotation onto the incoming one.
  
  `setCameraRotation` records the requested rotation in `pendingCameraRotation` as a replay buffer whenever no renderer has registered `setCameraCallbacks` yet, and replays it on the next `setCameraCallbacks` call regardless of which model that renderer belongs to. `cameraSlice`'s session-reset teardown cleared `cameraRotation` and `projectionMode` but left `pendingCameraRotation` untouched, so a rotation set before any renderer registered survived the reset and got replayed onto the next model's `Viewport` as soon as it mounted and called `setCameraCallbacks`.
  
  The teardown now also clears `pendingCameraRotation` on a session reset, so a stale pending rotation can no longer leak across a file swap. One caller-visible trade-off: an embed host's `SET_CAMERA` sent before the first load's `resetViewerState()` is now dropped rather than replayed on that first load — the `?camera=` initial-view path is unaffected, since `EmbedViewer` polls for callbacks post-load and re-issues it independently.

- [#3562](https://github.com/LTplus-AG/ifc-lite/pull/3562) [`536aeea`](https://github.com/LTplus-AG/ifc-lite/commit/536aeea2082ab23e02e47da1c5b05be305631070) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix the clash panel's header count silently disowning the review-status filter: unticking `resolved` or `accepted` in the status chips shrank the rendered list without touching the big headline number or the severity bar underneath it, so the panel could read e.g. "88 clashes" while only 81 rows were actually on screen. The header already reconciled correctly for the "Hide touching" filter (appending "· N shown"); it now does the same whenever ANY active filter — touching or status — drops a row, instead of checking `hideTouching` alone.

- [#3372](https://github.com/LTplus-AG/ifc-lite/pull/3372) [`aba9d13`](https://github.com/LTplus-AG/ifc-lite/commit/aba9d13b1396a73608d63b70698a692b2091fd23) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `clearAllModels()` leaving the `EntityRef`-keyed half of selection state (`selectedEntity`, `selectedEntities`, `selectedEntitiesSet`, `selectedModelId`, `activeStorey`) pointing at models that were just removed.
  
  The `all-models-cleared` teardown scope only ever cleared the global-id half (`selectedEntityId`, `selectedEntityIds`, `selectedStoreys`). `resetViewerState()` clears both halves, so the gap only showed on a path that calls `clearAllModels()` without it — `GeoreferencingPanel.tsx`'s `reloadModelsForAlignment`, which left the properties panel bound to a model that no longer existed.
  
  Since `clearAllModels` removes every model, there is no surviving federated sibling to preserve a selection for (unlike the single-model `model-removed` scope, which filters by `modelId`), so both halves now clear unconditionally.

- [#3543](https://github.com/LTplus-AG/ifc-lite/pull/3543) [`c1677a4`](https://github.com/LTplus-AG/ifc-lite/commit/c1677a4f8ec9b5c96e7a86f7b236503f01428504) Thanks [@BIMvoice](https://github.com/BIMvoice)! - The command palette's `Export JSON` entry now names each entity's declared class instead of its `IfcTypeEnum`-coalesced family ([#3503](https://github.com/LTplus-AG/ifc-lite/issues/3503)). `[#3475](https://github.com/LTplus-AG/ifc-lite/issues/3475)` routed the Lists Class column and the Parquet `Type` column onto `@ifc-lite/data`'s `exactTypeName()`; the palette's `export:json` action was a third, independent caller still reading `EntityTable.getTypeName` directly, so exporting the same model via the palette named `IFCDOORSTANDARDCASE` entities `IfcDoor` while the other two export paths named them `IfcDoorStandardCase`. The row-building logic is extracted to `buildCommandPaletteJsonEntities` (`apps/viewer/src/components/viewer/commandPaletteJsonExport.ts`) so all three export paths now route through the same accessor.

- [#3537](https://github.com/LTplus-AG/ifc-lite/pull/3537) [`cf84256`](https://github.com/LTplus-AG/ifc-lite/commit/cf84256f94949faf968c2d04d80019ace31e4a65) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix duplicate React keys (and the matching dev-mode console warning) when an entity carries two property sets or quantity sets with the same name. That is a legitimate IFC model shape: two `IfcPropertySet` or `IfcElementQuantity` entities can share a `Name`, including an empty `""` name. The Properties/Quantities panel, model metadata panel and material totals panel now key each card by its position in the list plus its name, and a property set's own rows are keyed the same way, so every key is unique among its siblings. Both cards already rendered their own properties before this change, so what it closes is the console warning plus the reconciliation behaviour React documents as unsupported for duplicate sibling keys, not a reproduced dropped card.

- [#3531](https://github.com/LTplus-AG/ifc-lite/pull/3531) [`cbea10b`](https://github.com/LTplus-AG/ifc-lite/commit/cbea10bcb4c7b2eeddcb8a0ce3a4a6d2348a7f2e) Thanks [@BIMvoice](https://github.com/BIMvoice)! - The live 2D drawing canvas now resolves `ElementData.properties` for its graphic-override rules. It previously built `ElementData` with only `expressId`/`ifcType`, so a `property`/`propertySet`-gated rule could never win over its lower-priority base rule on screen. The built-in "Structural Highlight" preset's `LoadBearing` rule and "Fire Safety"'s `FireRating exists` fire-door rule now match where they silently matched nothing. Fire Safety's three fire-rating band rules compare `FireRating` with `greaterOrEqual`, which only matches a numeric value, so they still match nothing on a file that writes `FireRating` as the `IfcLabel` IFC4 specifies for it. This fixes the live canvas only; the SVG/PDF export paths still build `ElementData` without properties.
  
  Properties are resolved once per (model set, polygon set) change via a new `useDrawingElementPropertiesLookup` hook, never inside the canvas's per-frame draw loop, and skipped entirely when no active rule uses a `property`/`propertySet` criterion. An entity carrying two property sets with the same name (a type-level and an occurrence-level `Pset_WallCommon`, say) keeps the properties of both, first match across the sequence winning.

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

- [#3570](https://github.com/LTplus-AG/ifc-lite/pull/3570) [`49f607e`](https://github.com/LTplus-AG/ifc-lite/commit/49f607e8e27c42e0aacc0fb7a82c8915fe17e23c) Thanks [@BIMvoice](https://github.com/BIMvoice)! - The DXF R12 writer's TEXT/layer content mojibaked on any real DXF reader when it contained non-ASCII characters. `DxfWriter.toString()` produces plain ASCII-DXF text declaring `$ACADVER AC1009`, a version with no UTF-8 support (that starts at R2007/AC1021) — but the viewer's DXF download wrote that string out with a UTF-8 encoder (`Blob`'s default string encoding), while a real reader with no declared codepage falls back to `ANSI_1252` (confirmed against `ezdxf`, which mirrors AutoCAD's own default). "Wände" round-tripped as "WÃ¤nde".
  
  The writer now declares `$DWGCODEPAGE ANSI_1252` in its HEADER section, and a new `encodeDxfCp1252` export encodes the document string to the matching windows-1252 bytes (a character outside that codepage, e.g. CJK, becomes `?`, the only representation R12's single-byte TEXT format has). The viewer's section-DXF export now writes those bytes instead of the raw string, and surfaces a toast when a character had to fall back to `?`.
  
  Verified against `ezdxf` (kept out of the repo, per the export-format validation convention `@ifc-lite/export`'s glTF/DXF tests already use): before the fix, a TEXT entity containing "Büro Nr. 3 – Wände östlich" read back as "BÃ¼ro Nr. 3 â€“ WÃ¤nde Ã¶stlich"; after, it reads back byte-correct with zero `ezdxf` audit errors.

- [#3719](https://github.com/LTplus-AG/ifc-lite/pull/3719) [`4f670aa`](https://github.com/LTplus-AG/ifc-lite/commit/4f670aa0d8e544b5fbe0cd26db34f4fb3974938a) Thanks [@louistrue](https://github.com/louistrue)! - Let `hideTypes` reach the symbolic 2D overlay, so `hideTypes: ['IfcAnnotation']` stops being a silent no-op.
  
  `IfcAnnotation` 2D content is not a mesh. Rust routes every shape representation identified `Plan`, `Annotation`, `FootPrint` or `Axis` into symbolic data (`rust/processing/src/symbolic/mod.rs`), which the viewport draws as a line-and-text overlay gated only on the store's `typeVisibility.ifcAnnotations` and `.ifcGrid`. The embed's `hideTypes` filters the mesh list, so it could never touch that overlay: a host naming `IfcAnnotation` got silence and no error ([#2934](https://github.com/LTplus-AG/ifc-lite/issues/2934)). Measured on AC20-FZK-Haus through the real embed build, five states pixel-diffed against each other: before this change `hideTypes=IfcAnnotation` moved 0 of 960,000 pixels, while turning the store's own annotation toggle off moved 6,492 — the same 6,492 that stripping the 14 `IFCANNOTATION` instances out of the bytes moves. After it, the `hideTypes` states are pixel-identical to both (0 px apart), by either host route: `INIT`'s `config.hideTypes` and `?hideTypes=`.
  
  The embed now publishes its case-folded hidden-class set to `store.hostHiddenIfcTypes`, and the two overlay hooks read it there, beside the per-entity hides they already apply, through one pure function (`lib/symbolic-overlay-gate.ts`). Nothing is threaded through `Viewport`: the overlay is built two levels below it, and a prop would have added a link only `Viewport` could keep honest — and no test mounts `Viewport`, which needs a WebGPU device.
  
  **What `hideTypes` matches, for the 2D overlay.** The class that OWNS the drawn content, taken from the one table the overlay parse itself uses (`lib/overlay-parse/overlay-channels.ts`): dimensions, leaders and room tags are `IfcAnnotation`; grid axes and their bubbles are `IfcGridAxis`, not `IfcGrid`, which owns no drawn content and so hides nothing. Naming a wall or a space removes their meshes and no 2D content — their `Axis` / `FootPrint` representations are not drawn in the 3D viewport at all (they reach the 2D drawing generator, which this does not gate). Should a channel ever draw a second owner class, it switches off only when every class it draws is hidden, so hiding one class can never take another's content with it.
  
  Precedence is unchanged: `hideTypes` and the store toggles both apply, and a class named in `hideTypes` stays hidden when a later `SET_TYPE_VISIBILITY` turns its toggle on, exactly as a hidden `IfcSpace` mesh behaves today. The full viewer sets no host list and renders as before.

- [#3528](https://github.com/LTplus-AG/ifc-lite/pull/3528) [`62bb58f`](https://github.com/LTplus-AG/ifc-lite/commit/62bb58fc8364c27bcf8452ab8edbde26727f527c) Thanks [@louistrue](https://github.com/louistrue)! - Re-home `MeshData.geometryItemId` — and the instanced occurrence's `itemId` beside it — by the federation id offset, so a federated model's source representation item cannot resolve to a real entity in the wrong model.
  
  The loader's federated finalize shifted `expressId` and, since [#1781](https://github.com/LTplus-AG/ifc-lite/issues/1781), `textureRef.textureId` into the model's global id range, and left `geometryItemId` (the `IfcRepresentationItem` a mesh was tessellated from, [#2985](https://github.com/LTplus-AG/ifc-lite/issues/2985)/[#3199](https://github.com/LTplus-AG/ifc-lite/issues/3199)) in the model's local space on the same mesh. Resolution back to (model, expressId) in the viewer is range-based — `FederationRegistry.fromGlobalId`/`getModelForGlobalId` and `modelSlice.resolveGlobalIdFromModels` all ask which model's id range contains the number — so an unshifted item id from a model loaded at offset 1,000,000 is a small number that lands inside the primary model's range. It did not miss and it did not throw: it resolved to a real entity in the wrong model, which nothing downstream can tell from a correct answer.
  
  The instanced path moves with it. `Scene.getInstancedMeshDataPieces` is already called with a global id (`useZoneGeometrySplit`, `useZoneApportionment`) and stamps an occurrence's `itemId` onto the materialized piece's `geometryItemId`, so shifting only the flat path would feed the same field a local number through the other door. Both shifts guard absence explicitly: the field is optional and legitimately absent, and it must not become `NaN` (`undefined + offset`) or the bare offset (`(x ?? 0) + offset`), which is itself a resolvable wrong answer.
  
  `MeshData.materialId`, the other source id added in [#3199](https://github.com/LTplus-AG/ifc-lite/issues/3199), is an `IfcMaterial` express id with the same gap and is deliberately not touched here.

- [#3523](https://github.com/LTplus-AG/ifc-lite/pull/3523) [`1b11e3c`](https://github.com/LTplus-AG/ifc-lite/commit/1b11e3ccd9d0fb2de03ee12d2d8ae780a5040ee6) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Wire the SVG/PDF drawing export's graphic-override engine up to real IFC property data, so `property`/`propertySet` criteria can match again.
  
  `ElementData.properties` (`packages/drawing-2d/src/graphic-overrides/types.ts`) was declared and read by the rule engine's `property`/`propertySet` criteria (`rule-engine.ts`), but every construction site in `useDrawingExport.ts` built only `{ expressId, ifcType }`, the same gap [#3520](https://github.com/LTplus-AG/ifc-lite/issues/3520) found and removed for the sibling `materials`/`layers` fields. Unlike those two this one is directly user-reachable: the built-in "Fire Safety" and "Structural Highlight" presets (selectable from the drawing settings panel's Style Presets list) gate rules on `FireRating`, `OccupancyType` and `LoadBearing`, and every one of those rules silently painted its elements with the non-matching base style.
  
  `generateExportSVG` and `generateSheetSVG` now resolve each polygon's properties from the real parsed model before calling `applyOverrides`, via a new `makePropertiesGetter` (`hooks/drawingElementProperties.ts`) that caches per export pass and resolves a federated drawing's global entity id back to its owning model's store (`fromGlobalIdFromModels`) before extracting. The engine reads a record keyed by property-set name while the parser returns a list of sets, and the flattening between the two handles two shapes that would otherwise drop a property before any rule sees it. An entity can carry two property sets with the same name, one from the type definition and one from the occurrence; those are merged instead of being left to overwrite each other, first match across the sequence winning, which is the semantics `findPropertyInSets` (`packages/query/src/pset-lookup.ts`) settled for the rest of the repo in [#3468](https://github.com/LTplus-AG/ifc-lite/issues/3468). And a property of a multi-valued subtype (`IfcPropertyEnumeratedValue`, `IfcPropertyListValue`, `IfcPropertyBoundedValue`, `IfcPropertyTableValue`) reaches the engine as its scalar `value` — the string the property panel shows — rather than as the parser's raw `values` array, which every string operator in `evaluateOperator` rejects outright.
  
  What this turns on, and what it does not. Fire Safety's "Fire Doors" rule (`FireRating exists`), its "Escape Routes" rule (`OccupancyType contains`), Structural Highlight's "Load-bearing Walls" rule (`LoadBearing equals true`), and user-authored property rules now match, in the exported SVG, the sheet SVG, the sheet PDF (which rasterizes the sheet SVG) and Print. Fire Safety's three fire-rated wall rules still do not: they compare `FireRating` numerically (`greaterOrEqual` 120, 60, 30), but `Pset_WallCommon.FireRating` is declared `IfcLabel`, so a schema-conformant file writes it as a string ('REI 120', 'EI90', or a bare '120') and the rule engine's numeric operators only ever compare two numbers. Making those three match is a change to the preset's own criteria and is tracked separately. `useDrawingExport.propertyOverride.test.tsx` pins both halves against a parsed IFC4 fixture that also carries a wall with two `Pset_WallCommon` sets and a space whose `OccupancyType` is written as an `IfcPropertyEnumeratedValue`.
  
  The live on-screen 2D canvas (`Drawing2DCanvas.tsx`) is unchanged. Like [#3520](https://github.com/LTplus-AG/ifc-lite/issues/3520) found for `materials`, it has no data-store reference in its hot per-frame render loop, and threading one through is a larger, separate change. DXF export is unchanged too, but for a different reason: it never consulted the override engine at all. It does write colour — a layer colour per line category, and a DXF group-code-62 colour on each `LINE`/`POLYLINE` — but that comes from `getLineStyle`/`getHatchPattern` keyed on line category and IFC type, never from a rule.

- [#3427](https://github.com/LTplus-AG/ifc-lite/pull/3427) [`2485a91`](https://github.com/LTplus-AG/ifc-lite/commit/2485a91be2e687d58ee5c9c81d2d0cd8abb47ee4) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Clear `lensAppliedColors`, `lensAutoColorLegend` and `discoveredLensData` on a session reset — all three are derived from the outgoing model and were missing from `lensTeardown`'s `owns` list, so they survived a new file load. A later shared-colour handoff could reapply the outgoing lens overlay, the new session could show stale legend entries, and discovered lens data from the removed model stayed live.
  
  Refs [#3423](https://github.com/LTplus-AG/ifc-lite/issues/3423)

- [#3880](https://github.com/LTplus-AG/ifc-lite/pull/3880) [`8f8706b`](https://github.com/LTplus-AG/ifc-lite/commit/8f8706bbad278609245a1ab24055a44e12c5ab47) Thanks [@BIMvoice](https://github.com/BIMvoice)! - fix(viewer): assembly parts streaming in after a hide or isolate now respect it ([#3865](https://github.com/LTplus-AG/ifc-lite/issues/3865))
  
  Presentation channels persist the complete set of aggregated descendants for an assembly, not just the parts that currently have geometry. Hide and isolate match mesh ids against a persisted set on every frame, so a part that streams in later is already in that set and is hidden or isolated the moment its mesh lands. Previously it escaped the action.
  
  Colour is not fixed by this change. Both colour sinks in `useGeometryStreaming.ts` drain their pending map and clear it, and `scene.setColorOverrides` builds overlay batches once from `meshDataMap`, so a part whose mesh arrives after the flush is never painted. That is tracked separately in [#3890](https://github.com/LTplus-AG/ifc-lite/issues/3890).

- [#3899](https://github.com/LTplus-AG/ifc-lite/pull/3899) [`c3f0da3`](https://github.com/LTplus-AG/ifc-lite/commit/c3f0da3ccaf6bc98c02ae254c37eeef01c308ba1) Thanks [@louistrue](https://github.com/louistrue)! - fix(viewer): colouring an assembly now reaches parts whose meshes stream in later ([#3890](https://github.com/LTplus-AG/ifc-lite/issues/3890))
  
  Hide and isolate are whitelists the renderer re-matches mesh ids against, so a part that streams in after the action is caught the moment its mesh lands. Colour was not: `pendingColorUpdates` is a one-shot signal that is flushed and nulled, and `scene.setColorOverrides` builds overlay batches once from `meshDataMap`, so a part with no mesh at flush time was never painted at all.
  
  The colour channel now hands the scene back its own retained override map once the geometry counter settles and the mesh queue has drained, which rebuilds the overlay batches with the late meshes included. It does that only when an override id it was waiting on has actually arrived, so an active overlay does not pay a rebuild after every later streaming burst, and it costs nothing when nothing is coloured. Because the map is read from the scene at that moment rather than remembered, a targeted `resetColors` is not repainted and a correction made in the meantime is the colour that lands.
  
  GPU-instanced occurrences need their own half of this and cannot use the counter: a streaming event carrying only instanced shards appends through `appendInstancedShards`, which never changes `geometryResult`, so the counter does not move. `Scene.addInstancedShard` now applies a recorded colour override to occurrences arriving in the shard, mirroring the late-selection seeding that already sat beside it.
  
  `SceneContents` gains `getColorOverrides`, `hasMeshData` and `isInstancedEntity`. The first exposes the retained map the catch-up re-applies; the other two are the O(1) presence probes it needs, since `getMeshDataPieces` and `getInstancedMeshDataPieces` answer the same question but materialize geometry to do it.

- [#3399](https://github.com/LTplus-AG/ifc-lite/pull/3399) [`c230fba`](https://github.com/LTplus-AG/ifc-lite/commit/c230fba047d44f79ae36d271446700ad22c62bb3) Thanks [@louistrue](https://github.com/louistrue)! - Stop grid BUBBLES from framing the camera.
  
  **The second half of [#3359](https://github.com/LTplus-AG/ifc-lite/issues/3359).** Routing grid lines to their own `grid` channel ([#3381](https://github.com/LTplus-AG/ifc-lite/issues/3381)) fixed the line half: the renderer decides whether a 3D line overlay grows the scene AABB per CHANNEL, and `grid` deliberately does not, because a grid reaches past the model envelope and framing on it throws the model off screen ([#967](https://github.com/LTplus-AG/ifc-lite/issues/967)).
  
  Bubbles never travelled that route. A grid bubble is a text plus a fill, and both reach the renderer through `uploadAnnotationTexts3D` / `uploadAnnotationFills3D`, which have no channel to key a policy on and grew the bounds unconditionally. They are also the outermost grid content there is, sitting `BUBBLE_OFFSET_M` beyond each axis endpoint, so with the lines correctly routed an annotations-off / grid-on session still reframed the camera on grid extent.
  
  **Added:** an optional `definesExtent?: boolean` on `SymbolicTextInput` and `SymbolicFillInput`. `false` draws the item without letting the scene AABB grow to it. It defaults to `true`, so an existing caller that omits it keeps the behaviour it had — that is what makes this additive rather than breaking. (The one deliberate exception is the fill re-fit described below.) Per ITEM rather than per call because both uploads REPLACE the whole array, so a caller cannot split one annotation call and one grid call. That is a property of today's pipeline, not of the problem; a channel-keyed upload matching `setLineOverlay` would delete the flag, and it needs per-channel buffers.
  
  **One behaviour change beyond the flag:** `uploadAnnotationFills3D` used to re-fit the camera's scene bounds on every call, including a clear that changed nothing. It now re-fits only when a fill actually moved the bounds, which is how `uploadAnnotationTexts3D` and `setLineOverlay` have always behaved.
  
  **The trade-off, stated:** a model whose only content is the symbolic grid now has nothing defining an extent, so the camera keeps the placeholder AABB the geometry pipeline seeds when there are zero meshes. That is consistent with how `grid` already treated the lines, so it makes one rule out of two rather than introducing a second. Real IFCs with grids nearly always carry meshes.
  
  The viewer now passes its annotation records straight to the two uploads instead of remapping them field by field. They are structurally assignable to the renderer's input types and the renderer copies only its declared fields, so the mapping was a hand-written field list whose only real property was that `definesExtent` could be forgotten from it. `definesExtent` is required on the viewer's own record types, so an omission is now a compile error at the point the record is built.

- [#3394](https://github.com/LTplus-AG/ifc-lite/pull/3394) [`7e62dc5`](https://github.com/LTplus-AG/ifc-lite/commit/7e62dc5cd932609252d793028857326635580d72) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Stop drawing every `IfcGridAxis` twice in the 3D viewport, which also made section-clipping of grid lines inert and let the two copies disagree in elevation.
  
  The viewport fed the `ifcGrid`-visibility toggle from two independent sources at once: `useSymbolicAnnotations` (its grid buckets, section-clipped against the active cut plane and rebased by the TS-side `originShift`) and `useGridLines3D` (the wasm `parseGridLines` API, unclipped and rebased only by RTC). The two were merged into one buffer (`mergeGridLineChannels`) and uploaded to the renderer's `grid` line-overlay channel, so every axis drew twice, issue [#862](https://github.com/LTplus-AG/ifc-lite/issues/862)'s grid section-clipping never had any effect (the unclipped copy always drew the full grid), and a federated or re-aligned model with a nonzero `originShift` could show the two copies at different elevations.
  
  Grid lines in the viewport now draw only from `useSymbolicAnnotations`'s already-split `grid` channel (issue [#3359](https://github.com/LTplus-AG/ifc-lite/issues/3359)), which already section-clips and origin-shift-rebases its grid buckets. The redundant `useGridLines3D` hook and the now-empty `mergeGridLineChannels` merge step are removed. `parseGridLines`/`parseGridAxes` themselves are unchanged — they remain published `@ifc-lite/geometry` SDK surface for embedders who want raw, unclipped grid geometry with no annotation/storey semantics.

- [#3381](https://github.com/LTplus-AG/ifc-lite/pull/3381) [`cb2ef0f`](https://github.com/LTplus-AG/ifc-lite/commit/cb2ef0f9d7836938c650dac1a3ceb8566705c460) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Turning "Show IFC Annotations" off while leaving the IfcGrid toggle on no longer reframes the camera onto the grid.
  
  `useSymbolicAnnotations` lifted IfcAnnotation curves AND IfcGridAxis lines into one buffer uploaded to the renderer's `annotation` line-overlay channel. With annotations off and the grid on, that buffer carried only grid content, but `CHANNEL_EXPANDS_MODEL_BOUNDS.annotation` is `true` — the policy exists so an annotation-only model can still be framed — so the grid-only upload grew the scene bounds that `CHANNEL_EXPANDS_MODEL_BOUNDS.grid: false` exists to protect (grid axes routinely extend far past the model envelope, issue [#967](https://github.com/LTplus-AG/ifc-lite/issues/967)). Every later camera fit and every empty-space orbit gesture (whose pivot falls back to the scene-bounds centroid, `useMouseControls.ts`/`useTouchControls.ts`) then reframed around the inflated bounds instead of the model.
  
  `useSymbolicAnnotations` now returns the two content kinds separately (`{ annotation, grid }`), and the viewport uploads each to its own channel, so grid content reaches the policy it was designed for.

- [#3545](https://github.com/LTplus-AG/ifc-lite/pull/3545) [`c512dd6`](https://github.com/LTplus-AG/ifc-lite/commit/c512dd6293ef83fc08e2f6d4c5fe719daa910fea) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Clicking a storey in the hierarchy panel (Solo, or Ctrl-click to accumulate) now mirrors the storey's identity into the search filter, not just its name — so when two storeys share a name, the filter no longer pulls in the other storey's elements. Hand-typed storey-name filters behave as before.

- [#3457](https://github.com/LTplus-AG/ifc-lite/pull/3457) [`6df94a1`](https://github.com/LTplus-AG/ifc-lite/commit/6df94a184b1a1a0f3c8f3255f3021b4d00207cea) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix a hover tooltip or an open context menu surviving `removeModel` (dropping one model out of a live federation) and `clearAllModels`, so it kept naming a stale global express id that a later-loaded model could reuse.
  
  `hoverSlice`'s `model-removed` and `all-models-cleared` teardown arms were both `notApplicable`. Only `session-reset` cleared `hoverState` / `contextMenu`, whose own doc comment already explains why that matters: "ids are reused across files, so a hover tooltip or an open context menu surviving a swap describes an unrelated element of the incoming one." That hazard applies just as much to removing a single federated model (other models staying loaded) or clearing the whole federation without a full session reset — several `clearAllModels()` call sites do exactly that (`GeoreferencingPanel.tsx`'s `reloadModelsForAlignment`, a federation rebuild in `useFileCommands.tsx`).
  
  `model-removed` now clears each field only when its `entityId` is stale (no surviving model owns that global id, mirroring `selectionSlice.teardown.ts`'s global-id half); `all-models-cleared` clears both unconditionally, since with every model gone there is no survivor left to ask.

- [#3382](https://github.com/LTplus-AG/ifc-lite/pull/3382) [`975cd6d`](https://github.com/LTplus-AG/ifc-lite/commit/975cd6d89813873ba37b2b0b717ad4b82581ebf0) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix the SDK/MCP `isolate()` call (scripts and the `viewer_isolate` tool) isolating a geometry-less `IfcElementAssembly` by its own id instead of its `IfcRelAggregates` parts, which showed an empty viewport ([#3338](https://github.com/LTplus-AG/ifc-lite/issues/3338)).
  
  Assembly expansion has one shared implementation, `expandToGeometryBearingIds`, reached through `cameraCallbacks.resolveHighlightIds`. LensPanel, PropertiesPanel and both SearchModal isolate paths already route through it; `apps/viewer/src/sdk/adapters/visibility-adapter.ts`'s `isolate()` — reached by scripts and the MCP `viewer_isolate` tool — expanded spatial-structure refs (storey, building) but never routed its result through the same resolver, so isolating an assembly by ref left an id with no mesh in the isolation set. It now resolves through `cameraCallbacks.resolveHighlightIds` the same way the other channels do, falling back to the unresolved ids when no renderer has registered one yet.

- [#3736](https://github.com/LTplus-AG/ifc-lite/pull/3736) [`a738d60`](https://github.com/LTplus-AG/ifc-lite/commit/a738d609faa99aa4444d2aad99817f1ba494765d) Thanks [@louistrue](https://github.com/louistrue)! - Lists Area and Volume columns now scale by LENGTHUNIT squared and cubed when the file declares no explicit `AREAUNIT`/`VOLUMEUNIT`, which is what IFC means by omitting them. A millimetre-authored 2m x 3m slab reported `6,000,000 m²` and now reports `6 m²`. Models that do declare an explicit unit are unaffected.
  
  The zone "Volume (mesh)" column derives its scale on a separate path (`ListPanel`), and that path gets the same fallback through the new `zoneVolumeSiScale` helper. Without it the two disagreed by the length factor cubed and a 30 m³ zone in a millimetre model displayed as `3e-8 m³`.

- [#3532](https://github.com/LTplus-AG/ifc-lite/pull/3532) [`fc40d01`](https://github.com/LTplus-AG/ifc-lite/commit/fc40d013a739c8921aa9cd8d7d56644a6c18af6c) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix the LLM context builder (`context-builder.ts`) silently reporting no material for a selected/typed entity whose material association resolves to an unnamed `IfcMaterialLayerSet`, `IfcMaterialProfileSet`, or `IfcMaterialConstituentSet`.
  
  `materialName` was computed as `rawMaterial?.name ?? rawMaterial?.materials?.[0]?.name` — a set-level name, then the first `IfcMaterialList` member. Neither leg reads `.layers[]`, `.profiles[]`, or `.constituents[]`, so a set with no set-level `Name` (common: those sets are frequently authored unnamed, with the name carried only on the layer/profile/constituent) reported `materialName: undefined` — the LLM's system-prompt context then had no material at all for that element, even though one was assigned.
  
  Extracted the lookup into a new sibling module (`apps/viewer/src/lib/llm/material-name.ts`) exporting `materialDisplayName()`, which falls back through `.materials[]` → `.layers[]` → `.profiles[]` → `.constituents[]`, matching the same fallback chain fixed for the MCP `materials` resource in [#3519](https://github.com/LTplus-AG/ifc-lite/issues/3519).

- [#3540](https://github.com/LTplus-AG/ifc-lite/pull/3540) [`d2fb0e4`](https://github.com/LTplus-AG/ifc-lite/commit/d2fb0e4121ccd19f326837ea574b189ee2a5f6c8) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Re-home `MeshData.materialId` — the `IfcMaterial` express id a material-layer mesh slices ([#3199](https://github.com/LTplus-AG/ifc-lite/issues/3199)) — by the federation id offset, alongside `expressId` and `geometryItemId` ([#2985](https://github.com/LTplus-AG/ifc-lite/issues/2985)/[#1781](https://github.com/LTplus-AG/ifc-lite/issues/1781)).
  
  `materialId` was the one source id `applyFederationOffsetToMesh` left unshifted, by explicit exclusion ([#3199](https://github.com/LTplus-AG/ifc-lite/issues/3199)/[#3525](https://github.com/LTplus-AG/ifc-lite/issues/3525)): whether to move it depended on which id space its consumers expected, and offsetting a field a consumer indexed by local id would have been a regression rather than a fix.
  
  Census of every TS-side reader of `MeshData.materialId` (`packages/geometry/src/geometry.worker.ts`, `geometry-coordinate.ts`, the binary cache round trip in `packages/cache/src/sections/geometry.ts`, `apps/viewer/src/utils/serverMesh.ts`) found none that index a store by the raw value or otherwise depend on it being model-local — every one only copies the field through. The five style-lookup sites [#3211](https://github.com/LTplus-AG/ifc-lite/issues/3211) found reading a material id as a representation item (`ctx.geometry_style_index` and siblings in `rust/processing/src/element.rs`) are a same-named but unrelated id: they run inside per-model Rust geometry production, before a federation offset exists at all.
  
  With no settled consumer expecting local space, leaving `materialId` unshifted beside an already-global `expressId` on the same mesh reproduced the exact "resolves to a real entity in the wrong model" defect [#2985](https://github.com/LTplus-AG/ifc-lite/issues/2985) fixed for `geometryItemId` — worse than a miss, because it looks like an answer. `applyFederationOffsetToMesh` now shifts `materialId` the same way, with the same absence and `0`-is-not-absent guards as the other ids on the mesh.

- [#3785](https://github.com/LTplus-AG/ifc-lite/pull/3785) [`a4a498b`](https://github.com/LTplus-AG/ifc-lite/commit/a4a498bcb84c927862ea5ffcd865465e4c3a1a5f) Thanks [@louistrue](https://github.com/louistrue)! - `count_entities` now counts BIM products on every grouping, the same universe `query_entities` returns and the CLI's `query --count` / `query --group-by type` use ([#3765](https://github.com/LTplus-AG/ifc-lite/issues/3765)). The ungrouped total and `group_by: 'type'` folded `store.entityIndex.byType` instead — every raw STEP record, so `IfcCartesianPoint`, `IfcPolyLoop` and `IfcPropertySingleValue` lines were counted as entities — while `group_by: 'storey'` and `group_by: 'material'` walked `bim.query()`. On `AC20-FZK-Haus.ifc` the same tool answered 44,249 by type and 128 by storey, and 128 is what the CLI and MCP's own `query_entities` report.
  
  **This is a behaviour change to the numbers `count_entities` returns.** An agent that read the ungrouped total as "how big is this file" now gets the product count. The raw STEP record count is unchanged and still available from `model_info` and `model_audit`, which are file-statistics tools (the MCP analogue of `ifc-lite info`) and keep `foldedTypeCounts`. The tool's description now says which universe it counts and points at `model_info` for the other one.
  
  `type` filtering, subtype expansion and the IfcPascalCase group keys are unchanged; the group keys now come from `EntityData.type`, the same field `query_entities` reports. A test asserts the three groupings and the ungrouped total agree with `query_entities` on the same fixture.
  
  The web playground's `count_entities` handler (`apps/viewer/src/components/mcp/playground-dispatcher.ts`) is a second implementation, not a caller of the one above — it re-executes the same tool client-side so the browser chat surface can run MCP tools without a server round-trip. Its `group_by: 'type'` branch had the identical bug (folding `store.entityIndex.byType`) and is fixed the same way, so the playground now agrees with the installed MCP server on the same model ([#3785](https://github.com/LTplus-AG/ifc-lite/issues/3785) review).

- [#3861](https://github.com/LTplus-AG/ifc-lite/pull/3861) [`adc5fab`](https://github.com/LTplus-AG/ifc-lite/commit/adc5fab7fe9208019dccf890589fb5fa5637ea63) Thanks [@louistrue](https://github.com/louistrue)! - Fix `hide()`, `show()`, `colorize()`, `colorizeAll()` and `resetColors()` doing nothing when given a geometry-less `IfcElementAssembly`, over both the SDK and the embed's postMessage bridge ([#3338](https://github.com/LTplus-AG/ifc-lite/issues/3338)).
  
  Isolation already expanded such an id to its `IfcRelAggregates` parts. Its sibling channels did not, and they fail the same way for the same reason: the renderer matches `hiddenEntities` and the mesh colour map against ids it saw on a MESH, and an assembly carries no mesh of its own. So `hide([assemblyRef])` left every part visible, `colorize([assemblyRef], red)` repainted nothing, and both reported success. The embed bridge's `HIDE`, `SHOW` and `SET_COLORS` commands had the identical gap.
  
  All of them now route through the shared expansion policy, which moved from `lib/isolation/resolveIsolationIds.ts` to `lib/presentation/resolvePresentationIds.ts`. The old name was part of the problem: a `hide` handler author reading "isolation ids" concludes the module is not theirs and hand-rolls the id list, which is exactly the "one call site every channel must remember to use" failure [#3338](https://github.com/LTplus-AG/ifc-lite/issues/3338) is about. The colour channel gets `resolvePresentationColorMap`, which keeps each id paired with its own colour, calls the resolver once per distinct colour rather than once per id, and lets an explicitly named part outrank the colour it would inherit as some assembly's part.
  
  On the MCP side the same expansion moved from the five viewer tools that each remembered to call it into the one `resolveTargetRefs` they all share, so a sixth tool gets it by construction. No behaviour change there.
  
  One consequence worth knowing when scripting: because `colorize` now paints an assembly's parts, `resetColors([assemblyRef])` clears those parts' colours whoever set them — including a colour an earlier, independent `colorize([partRef])` applied. The adapter keeps a flat id-to-colour map with no record of which call wrote each entry, so it cannot tell the two apart. Reset by part rather than by assembly where that matters.

- [#3535](https://github.com/LTplus-AG/ifc-lite/pull/3535) [`3f6ecc6`](https://github.com/LTplus-AG/ifc-lite/commit/3f6ecc658f4b353e9092f22d719aad39029b3750) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix: loading a `.glb` as the first (primary) model, then adding another model, no longer overlaps their entity ids.
  
  The primary GLB path never registered itself in the federation registry (a GLB carries no IFC entities, so the registration guard skipped it), so `idOffset` for a subsequently-added model started back at the primary GLB's own range instead of past it. A test now pins that a federated add after a primary GLB gets a disjoint `idOffset`.

- [#3460](https://github.com/LTplus-AG/ifc-lite/pull/3460) [`47b2c90`](https://github.com/LTplus-AG/ifc-lite/commit/47b2c902be074027c597001762d03b6b03c8708d) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Four sites in `PropertyEditor.tsx` and `BulkPropertyEditor.tsx` used `parseFloat(value) || 0` / `parseInt(value, 10) || 0` when committing a user-entered Real/Integer property or quantity value. `NaN || 0` is `0`, so a value that didn't parse as a number silently wrote a real `0` into the model — indistinguishable from a value the user actually entered, with no error shown anywhere. Same defect as [#3456](https://github.com/LTplus-AG/ifc-lite/issues/3456)'s `CsvConnector.parseValue` fix.
  
  `PropertyEditor`'s inline commit (`commitSave`) and its "Add Property" dialog now refuse the save and show the existing `toast.error` notification instead of writing the fabricated value; the "Add Quantity" dialog does the same. An empty Real/Integer field now commits as `null` (unset), matching the convention the Boolean/Logical arm already used one case above it. A genuinely-entered `"0"` still writes `0`.
  
  `BulkPropertyEditor`'s single parsed value is reused for every entity in the matched selection, so a bad value previously fabricated a `0` across the whole selection at once. `buildAction` now returns a failure instead of an action, and both Preview and Execute refuse the whole operation before touching a single entity — surfaced through the component's own execute-result Alert, the pattern it already uses for a failed run — rather than half-applying a default across some but not all of the selection.

- [#3371](https://github.com/LTplus-AG/ifc-lite/pull/3371) [`e568300`](https://github.com/LTplus-AG/ifc-lite/commit/e568300e02ba28cb05690c1f631edc2086f5a7e8) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix a session reset (loading a new primary file) leaving the section tool's face-picked custom plane in place.
  
  `sectionSlice`'s teardown reset `axis`/`position`/`enabled`/`flipped` to their defaults but left `custom` untouched. `custom` (`normal`, `distance`, `pickedAt`, `tangent`, `bitangent`) is absolute world-space geometry read off the outgoing model's coordinate frame — strictly more model-relative than the four fields the reset already cleared. Face-picking an arbitrary-normal section plane and then loading a different file kept the old model's cut plane instead of arming face-pick mode for the new one.
  
  The teardown now rebuilds `sectionPlane` from its defaults on every session reset and carries forward only the three fields that round-trip through localStorage (`showCap`, `showOutlines`, `capStyle`), instead of spreading the live plane and overwriting individual session-scoped fields by name. A future session-scoped field on `SectionPlane` therefore defaults to cleared on reset unless it is deliberately added to that keep-list.

- [#3645](https://github.com/LTplus-AG/ifc-lite/pull/3645) [`c40afc4`](https://github.com/LTplus-AG/ifc-lite/commit/c40afc4e044dbc5a44e6c484896f6119226adbdc) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix a Drawing Sheet's title block printing the requested scale ratio instead of the actual one when the viewport fit shrinks the drawing.
  
  `sheet-types.ts`'s `calculateDrawingTransform` (`fitScale = min(scaleX, scaleY, 1)`) can shrink a drawing below its requested named scale to fit the sheet's fixed viewport. The scale bar already accounted for this — `generateSheetSVG` passes the actual `scaleFactor` to `renderTitleBlock` as `effectiveScaleFactor` — but the title block's "Scale" text field is plain static content, written once (by `sheetSlice.ts`'s `autoPopulateTitleBlock`) from the requested `sheet.scale.factor`, and was never corrected the same way. A sheet whose drawing had to be shrunk to fit the page could print e.g. "Scale: 1:100" next to a bar and a drawing both actually rendered at a materially different ratio — a silently wrong deliverable, the same defect class PR [#2131](https://github.com/LTplus-AG/ifc-lite/issues/2131) fixed for the plain (non-sheet) SVG exporter's title block.
  
  `generateSheetSVG` (`useDrawingExport.ts`) now runs the title block through `titleBlockWithEffectiveScale` (new `apps/viewer/src/hooks/titleBlockScaleField.ts`), which replaces the "scale" field's value with the actual rendered ratio whenever the fit clamp changed it, and leaves the title block untouched otherwise.

- [#3657](https://github.com/LTplus-AG/ifc-lite/pull/3657) [`d26ef08`](https://github.com/LTplus-AG/ifc-lite/commit/d26ef08ae62c6d3ba88a80fc63d3b0366ad4c631) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Space Sketch no longer inverts `NetFloorArea` above `GrossFloorArea` when the "outer" boundary is emitted (twin of [#3656](https://github.com/LTplus-AG/ifc-lite/issues/3656)). Confirming a drawn room only ever passed `grossFloorArea` (the wall-centreline area) to `addSpaceToStore`, leaving `NetFloorArea` to default to the emitted `OuterCurve`'s own area — the outer-face outline when the user picked "outer" in the boundary popover, which is larger than the centreline. `Qto_SpaceBaseQuantities.NetFloorArea` now always measures the room's inner-face outline, independent of which boundary the user chose to draw/emit, so it never exceeds `GrossFloorArea`.

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

- [#3597](https://github.com/LTplus-AG/ifc-lite/pull/3597) [`fa0624b`](https://github.com/LTplus-AG/ifc-lite/commit/fa0624bc09c962eae2d9bd6fb03d7624b921b93d) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fixed the section/plan SVG export writing a graphic-override rule's `fillColor`/`strokeColor` straight into a `fill="…"`/`stroke="…"` attribute with no XML escaping. Every other user-derived string reaching this writer (IFC type, annotation text, DXF layer names) already went through `escapeXml`; the override-rule colors did not. A color value containing `"` — reachable through the free-text color input next to the swatch in the drawing settings panel's graphic-override rules — closed the attribute early, letting the rest of the string parse as markup: the exported file was not well-formed XML and, opened directly in a browser, could execute an injected `<script>` element. Both the direct SVG export and the sheet (paper) SVG export shared the same gap; both are now escaped.

- [#3384](https://github.com/LTplus-AG/ifc-lite/pull/3384) [`fcdd368`](https://github.com/LTplus-AG/ifc-lite/commit/fcdd36841923d096f4f8a22a2f06c57b6752dd79) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Make the store teardown seam fail to compile when a slice omits a scope arm, instead of silently no-oping.
  
  `TeardownScope` is a three-kind union, and each of the 28 slice contributions was one `(scope, state)` function. 22 of them opened with `if (scope.kind !== 'session-reset') return {};`, which is exactly as "correct" for a scope kind that does not exist yet as for one that does — a fourth kind would have compiled clean, passed every test, and silently left those 22 slices' state uncleared.
  
  Each contribution now declares one named arm per scope kind (`'session-reset'`, `'model-removed'`, `'all-models-cleared'`) via `defineSliceTeardown`'s new `SliceTeardownArms` record. Omitting an arm — today, or for a kind added to `TeardownScope` later — is a compile error in all 28 files at once, not a `{}` nobody wrote. `notApplicable` spells the deliberate "this scope does not touch me" case.
  
  One trade-off, measured: typing every arm with the existing foreign-key rejection (a slice returning a key it does not own) tripled the checker's `Exclude<keyof ViewerState, K>` work across the 28-entry registry and crossed TypeScript's TS2590 ("union type too complex") budget. Arms are typed loosely instead, and `composeTeardown` now checks a returned key's ownership at runtime against the same map `createTeardownRegistry` already proves disjoint — a real check, just no longer a compile-time one for that specific case.

- [#3536](https://github.com/LTplus-AG/ifc-lite/pull/3536) [`27789c9`](https://github.com/LTplus-AG/ifc-lite/commit/27789c91195d958ebadb9ab3c2dcecbd629ee980) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix the properties panel rendering a blank group header for a property set or quantity set whose IFC `Name` is empty.
  
  `IfcRoot.Name` is optional, so a real STEP file can declare an `IFCPROPERTYSET`/`IFCELEMENTQUANTITY` with `Name` as the empty string literal `''` — `extractPsetsFromIds` in `packages/parser` only fabricates a placeholder when `Name` is the null marker `$` (not a string at all), so a declared `''` already passes through to the panel today, before PR [#3534](https://github.com/LTplus-AG/ifc-lite/issues/3534). `PropertySetCard` and `QuantitySetCard` rendered that name verbatim, collapsing the group header to just the count badge with no visible label.
  
  Both cards now route the header through a new `setDisplayName(name, kind)` helper (`apps/viewer/src/components/viewer/properties/setDisplayName.ts`), falling back to `Unnamed Property Set` / `Unnamed Quantity Set` when the name is empty. Neither card receives an id to build a fallback from — the viewer's `PropertySet`/`QuantitySet` prop shapes declare no id field — so unlike `treeDataBuilder`'s `getName || "<Type> #<id>"` convention for element rows, the fallback here names only the kind. A named set still renders its real name unchanged.

- [#3549](https://github.com/LTplus-AG/ifc-lite/pull/3549) [`cb56282`](https://github.com/LTplus-AG/ifc-lite/commit/cb56282133a3349299665859b5507b739808d32e) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix the compare panel reporting every quantified element as modified when the two files simply declare different project length units. Qto_ Length/Area/Volume quantities are now compared in base SI rather than the raw author-unit value.

- [#3544](https://github.com/LTplus-AG/ifc-lite/pull/3544) [`a99ecd9`](https://github.com/LTplus-AG/ifc-lite/commit/a99ecd9998dada941dc66e8bcc85ce3864b44065) Thanks [@BIMvoice](https://github.com/BIMvoice)! - The viewer's PostHog noise gate for auto-recovered wasm version skew ([#1363](https://github.com/LTplus-AG/ifc-lite/issues/1363)) only matched the wasm-binary MIME/404 message text, so a worker-SCRIPT skew (classified separately, by `kind`, since [#1680](https://github.com/LTplus-AG/ifc-lite/issues/1680)) reloaded correctly but was still captured to error tracking as if unhandled ([#3533](https://github.com/LTplus-AG/ifc-lite/issues/3533)). `@ifc-lite/geometry` now exports `isWorkerScriptSkewMessage` for the worker-script wrapper signature (`"…worker script failed to load (possibly a stale deployment)"`), and the viewer's `shouldSuppressWasmSkewNoise` matches on it alongside the existing wasm-MIME matcher. Every other pre-pass/worker failure is still captured unchanged.

- [#3541](https://github.com/LTplus-AG/ifc-lite/pull/3541) [`cfee9b2`](https://github.com/LTplus-AG/ifc-lite/commit/cfee9b28f5e6bec2040a29cbf7917be4696f407e) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `query --where` (and `query_entities`'s `property` filter over MCP) tested only the first same-named property or quantity set, so an entity was wrongly excluded when the value it should have matched lived on a later same-named set ([#3490](https://github.com/LTplus-AG/ifc-lite/issues/3490)) — two `IfcPropertySet`/`IfcElementQuantity` entities sharing one name is legitimate (e.g. one from the type definition, one from the occurrence).
  
  A filter is a predicate over the entity, so it now passes when ANY same-named set satisfies the operator, not just the first one found — uniformly across every operator, `!=` included. `@ifc-lite/query` adds `findAllPropertiesInSets`/`findAllQuantitiesInSets` (alongside the existing first-match `findPropertyInSets`/`findQuantityInSets`, which stay correct for value extraction — export, aggregation, display); `@ifc-lite/cli`'s `query --where` and the shared `HeadlessBackend.query.entities()` filter, and `@ifc-lite/mcp`'s `query_entities` filter, all switch to the any-match lookup. The viewer SDK's `entities()` filter now matches a property/quantity in ANY same-named set, not only the first.
- Updated dependencies [[`1f657d5`](https://github.com/LTplus-AG/ifc-lite/commit/1f657d5e7f82de890b27b10bc1b7c40d8d31203e), [`44a3c95`](https://github.com/LTplus-AG/ifc-lite/commit/44a3c95ac99c46d5eb800c3ff067477329d7bca9), [`8bdb7fe`](https://github.com/LTplus-AG/ifc-lite/commit/8bdb7fef31b8fafd9341bdc59725cacb8983195e), [`b02da88`](https://github.com/LTplus-AG/ifc-lite/commit/b02da889d60f720f1b4a868b48be12a95027f6e6), [`142b84c`](https://github.com/LTplus-AG/ifc-lite/commit/142b84c41036b749e7b64418a882424b9c386edb), [`142b84c`](https://github.com/LTplus-AG/ifc-lite/commit/142b84c41036b749e7b64418a882424b9c386edb), [`9ce6dd2`](https://github.com/LTplus-AG/ifc-lite/commit/9ce6dd2f2a21183423099edcf71675a625613b16), [`cf1b6b5`](https://github.com/LTplus-AG/ifc-lite/commit/cf1b6b5fa39f46af4a45b0d80fa635a9254e02c3), [`3284390`](https://github.com/LTplus-AG/ifc-lite/commit/328439014322dafaecb1bc930cd66ce5192c3c74), [`bbcb476`](https://github.com/LTplus-AG/ifc-lite/commit/bbcb476209a96b3c8a97f11751f4540cdaf41919), [`bbcb476`](https://github.com/LTplus-AG/ifc-lite/commit/bbcb476209a96b3c8a97f11751f4540cdaf41919), [`bbcb476`](https://github.com/LTplus-AG/ifc-lite/commit/bbcb476209a96b3c8a97f11751f4540cdaf41919), [`1d51937`](https://github.com/LTplus-AG/ifc-lite/commit/1d519376392e405645166761cc537bfbed9083cf), [`18e4de8`](https://github.com/LTplus-AG/ifc-lite/commit/18e4de865884d3126f478a9081cf56178fefcd00), [`80398a9`](https://github.com/LTplus-AG/ifc-lite/commit/80398a944093e3607944c70803b82d64fc372cba), [`9e45546`](https://github.com/LTplus-AG/ifc-lite/commit/9e455460f81f4bd463ef65116cbd89000e5539f7), [`06f81fe`](https://github.com/LTplus-AG/ifc-lite/commit/06f81fe10ba35a5b8edc7848017017f1f4d045ea), [`3e117c2`](https://github.com/LTplus-AG/ifc-lite/commit/3e117c249e792362ee5ec7eb722cf400ee18940a), [`f283c62`](https://github.com/LTplus-AG/ifc-lite/commit/f283c62da53d672d590322edd3351e7b71724757), [`c4fb369`](https://github.com/LTplus-AG/ifc-lite/commit/c4fb36908b350829e73217851c07d9a2e6de74fb), [`f98e601`](https://github.com/LTplus-AG/ifc-lite/commit/f98e601e5efc749088949665e41efd44f1b889c4), [`a1aebc8`](https://github.com/LTplus-AG/ifc-lite/commit/a1aebc822b819221258f4759edf4c82ff0d140f7), [`f8e03d4`](https://github.com/LTplus-AG/ifc-lite/commit/f8e03d4d5bb620fc9e807d5233091d145a201165), [`21b131d`](https://github.com/LTplus-AG/ifc-lite/commit/21b131d77e9079edc80ccf1dc1708c2d65747ae7), [`082fd0b`](https://github.com/LTplus-AG/ifc-lite/commit/082fd0bf0d8f472acdadac438bd43523826491ce), [`70acd06`](https://github.com/LTplus-AG/ifc-lite/commit/70acd063b99d5581f74f50e941df3d997cdebe91), [`56a0e01`](https://github.com/LTplus-AG/ifc-lite/commit/56a0e0112a22f58ac779534427781500c2256826), [`c5da727`](https://github.com/LTplus-AG/ifc-lite/commit/c5da72799a1832d7040942fa621c50973896b7fd), [`53a92b1`](https://github.com/LTplus-AG/ifc-lite/commit/53a92b1f7cc5770f164dc4867fc2adc33470e245), [`8904273`](https://github.com/LTplus-AG/ifc-lite/commit/890427360361fba5232bef614371fe69d9528e47), [`bcbe7b9`](https://github.com/LTplus-AG/ifc-lite/commit/bcbe7b9afa38e8dafb5900e73575c71a8fd96012), [`7b79a93`](https://github.com/LTplus-AG/ifc-lite/commit/7b79a93f80afe104ebe3e20ae742af26b48b21a2), [`82343f7`](https://github.com/LTplus-AG/ifc-lite/commit/82343f75dd2e6029946cbcd0990d3f8fd38a26ad), [`55b69fb`](https://github.com/LTplus-AG/ifc-lite/commit/55b69fbac09155f4cc9c8b2eecba17fd84067c32), [`36719c2`](https://github.com/LTplus-AG/ifc-lite/commit/36719c22f2cbd6027d8afc73c660cda5c994fdf4), [`b9c8fdf`](https://github.com/LTplus-AG/ifc-lite/commit/b9c8fdfbc5e224003fa2094f7b9703aa71600dbf), [`59fae4c`](https://github.com/LTplus-AG/ifc-lite/commit/59fae4cb4c4841b27cbe26a618648407d74d2326), [`9f945d1`](https://github.com/LTplus-AG/ifc-lite/commit/9f945d1e2193cb27e5471f5272496b2791975ede), [`793fce2`](https://github.com/LTplus-AG/ifc-lite/commit/793fce217039f11d6b74f898daed03f48c33809d), [`a76bc4e`](https://github.com/LTplus-AG/ifc-lite/commit/a76bc4ec0df4b683b5d03c89ff3f48fa1ab51057), [`0e3e71f`](https://github.com/LTplus-AG/ifc-lite/commit/0e3e71fb0a42ea752405a4c54862c8f1159a1ae9), [`b0a6265`](https://github.com/LTplus-AG/ifc-lite/commit/b0a6265a804099b9cea7e55f26fc50825c1df07a), [`eb142e0`](https://github.com/LTplus-AG/ifc-lite/commit/eb142e00bc8ad1d6c699ea42fdbc35a9281d8133), [`2b594d2`](https://github.com/LTplus-AG/ifc-lite/commit/2b594d20616f957f7ef949aa8563274e5373a95b), [`2b594d2`](https://github.com/LTplus-AG/ifc-lite/commit/2b594d20616f957f7ef949aa8563274e5373a95b), [`586fa29`](https://github.com/LTplus-AG/ifc-lite/commit/586fa292b69cdb3ba6e45764b4ff742b2fa7b9a9), [`fb72ba8`](https://github.com/LTplus-AG/ifc-lite/commit/fb72ba8cfdb2622e2354015151937ea5f7766dcd), [`49f607e`](https://github.com/LTplus-AG/ifc-lite/commit/49f607e8e27c42e0aacc0fb7a82c8915fe17e23c), [`445d813`](https://github.com/LTplus-AG/ifc-lite/commit/445d813b8ea3b6a09f2930a3e409ccaeff316a85), [`37ce0d0`](https://github.com/LTplus-AG/ifc-lite/commit/37ce0d0ab9587b8bb1098dc05cc4e3a44c6f4741), [`10b45b5`](https://github.com/LTplus-AG/ifc-lite/commit/10b45b571e2c2832bd938bb2a89e6d85d80aed5d), [`3efe762`](https://github.com/LTplus-AG/ifc-lite/commit/3efe762a993897fc3ddc029a8de1e5914e27df3f), [`e8682d5`](https://github.com/LTplus-AG/ifc-lite/commit/e8682d5add8bf0fb08c6cafcfbdf3b6784e3b47e), [`0b9cf1f`](https://github.com/LTplus-AG/ifc-lite/commit/0b9cf1fd12a9cc046c442fb45bae0a94a3378dc5), [`d08e420`](https://github.com/LTplus-AG/ifc-lite/commit/d08e420c9f39e9c0427aba47966cc6acf12642cc), [`9fb14d1`](https://github.com/LTplus-AG/ifc-lite/commit/9fb14d11896c52e51e0334bdaad33fabf166c136), [`c3f0da3`](https://github.com/LTplus-AG/ifc-lite/commit/c3f0da3ccaf6bc98c02ae254c37eeef01c308ba1), [`05193c9`](https://github.com/LTplus-AG/ifc-lite/commit/05193c9a9fd878f70bd9d9007199166fee05872b), [`ddc0221`](https://github.com/LTplus-AG/ifc-lite/commit/ddc0221a776bce15348d915a861e3fbc6cdff968), [`b264887`](https://github.com/LTplus-AG/ifc-lite/commit/b26488758f481c489e7f596568adfe237dd444da), [`3d11231`](https://github.com/LTplus-AG/ifc-lite/commit/3d11231806fec3047c9ed32b9d095be3abe60c2f), [`62399a4`](https://github.com/LTplus-AG/ifc-lite/commit/62399a456661d3db7dd3f86f01a26f4fe8ca594c), [`140a6d8`](https://github.com/LTplus-AG/ifc-lite/commit/140a6d8541224341835c98028dc75e6a5ccd605d), [`801e697`](https://github.com/LTplus-AG/ifc-lite/commit/801e697ea09cad23839b032fd593eb363bf8455b), [`7160b73`](https://github.com/LTplus-AG/ifc-lite/commit/7160b73d573e276e390f62c065b66eb80862c1c5), [`5f44fec`](https://github.com/LTplus-AG/ifc-lite/commit/5f44fec2630bff04fde00dac0eeeb520854dcde1), [`49581d6`](https://github.com/LTplus-AG/ifc-lite/commit/49581d6f3a622d34f677661651c778a36a01e88b), [`34aacc6`](https://github.com/LTplus-AG/ifc-lite/commit/34aacc689d26cbaa15c3bdd4c06d5c710f5676c6), [`e09b5c3`](https://github.com/LTplus-AG/ifc-lite/commit/e09b5c364138d56816e45452622078e951e051ee), [`5297514`](https://github.com/LTplus-AG/ifc-lite/commit/52975142846390bb1eb12b723d53c0e275289a90), [`f76b3a1`](https://github.com/LTplus-AG/ifc-lite/commit/f76b3a1fe729acbf8fea40766ba8d068721f09df), [`6aa2b76`](https://github.com/LTplus-AG/ifc-lite/commit/6aa2b76d4a988e7ee1fd6bcad7c46a41650704b3), [`df878b3`](https://github.com/LTplus-AG/ifc-lite/commit/df878b36fa8cf62878f25d177a15163fec354139), [`1000dce`](https://github.com/LTplus-AG/ifc-lite/commit/1000dce72e9ec75c59848efefc1f709d01172e72), [`9ffdb35`](https://github.com/LTplus-AG/ifc-lite/commit/9ffdb35a9282adf3334a8df26f4a3c80f7f41582), [`1000dce`](https://github.com/LTplus-AG/ifc-lite/commit/1000dce72e9ec75c59848efefc1f709d01172e72), [`1000dce`](https://github.com/LTplus-AG/ifc-lite/commit/1000dce72e9ec75c59848efefc1f709d01172e72), [`b7db4d2`](https://github.com/LTplus-AG/ifc-lite/commit/b7db4d2e51aaf551d3681f07a28921536362bdd7), [`c230fba`](https://github.com/LTplus-AG/ifc-lite/commit/c230fba047d44f79ae36d271446700ad22c62bb3), [`c6b3e1c`](https://github.com/LTplus-AG/ifc-lite/commit/c6b3e1c1e699108f7ece83315b16b780fc4d8a33), [`499ccf2`](https://github.com/LTplus-AG/ifc-lite/commit/499ccf2f97fe1e24728eb4eb99f895044c36f7b2), [`afb9725`](https://github.com/LTplus-AG/ifc-lite/commit/afb972525bb99e3056ccaa84ee7a78e0c7de81ef), [`c1390f3`](https://github.com/LTplus-AG/ifc-lite/commit/c1390f38e32f7a345a4f2651b8a3b6d849e56af6), [`5dbc51d`](https://github.com/LTplus-AG/ifc-lite/commit/5dbc51d053b3a5d7ffa833374215c336c60548cc), [`abae27b`](https://github.com/LTplus-AG/ifc-lite/commit/abae27b5a08c3c5c8a706d144f3f5a08de096d93), [`2329b20`](https://github.com/LTplus-AG/ifc-lite/commit/2329b20506160171da97af7d4dd0cd76ab85f13f), [`d733175`](https://github.com/LTplus-AG/ifc-lite/commit/d733175d4ac2e8a2e94fc0bf9804d7bc03627cc1), [`6bd2550`](https://github.com/LTplus-AG/ifc-lite/commit/6bd25508dadd14fee97ee1f7393212cdcc086fdc), [`15d6d96`](https://github.com/LTplus-AG/ifc-lite/commit/15d6d96adbc4b36a3f787c2d111aaa199403193e), [`32104cb`](https://github.com/LTplus-AG/ifc-lite/commit/32104cbb5c59ea7af0b7b69d27fce15d17627723), [`f7a17ca`](https://github.com/LTplus-AG/ifc-lite/commit/f7a17ca6bedff238ac22315278657801ac41ede0), [`233da61`](https://github.com/LTplus-AG/ifc-lite/commit/233da6172abd3f79cbcde6e827e503fe8eb3ac3e), [`15d6d96`](https://github.com/LTplus-AG/ifc-lite/commit/15d6d96adbc4b36a3f787c2d111aaa199403193e), [`32b31bc`](https://github.com/LTplus-AG/ifc-lite/commit/32b31bc8501f04e110733289bde0389b9899bc76), [`d46732e`](https://github.com/LTplus-AG/ifc-lite/commit/d46732ec22638a5391aa2c04f473795a12c4ab55), [`7f670f9`](https://github.com/LTplus-AG/ifc-lite/commit/7f670f934d52f789ef7800badb3bb74bad56681c), [`cebcb21`](https://github.com/LTplus-AG/ifc-lite/commit/cebcb2133ef672e9199ee2f158578499d449d9e0), [`e986c81`](https://github.com/LTplus-AG/ifc-lite/commit/e986c81bf6d28fec57f1953fa53bf315dbd80a3a), [`8c181c9`](https://github.com/LTplus-AG/ifc-lite/commit/8c181c99f91964402ad352aead36d9619af5b427), [`6e48c4c`](https://github.com/LTplus-AG/ifc-lite/commit/6e48c4c5f441e8a42e4cc55440cf747ad8679f0a), [`8f08715`](https://github.com/LTplus-AG/ifc-lite/commit/8f087158a662a02c01a21dd2546fb863bb24e665), [`9b709c5`](https://github.com/LTplus-AG/ifc-lite/commit/9b709c51480fbabb68167aa4892f7e4c87b0e4e6), [`f8e03d4`](https://github.com/LTplus-AG/ifc-lite/commit/f8e03d4d5bb620fc9e807d5233091d145a201165), [`32b31bc`](https://github.com/LTplus-AG/ifc-lite/commit/32b31bc8501f04e110733289bde0389b9899bc76), [`843aefb`](https://github.com/LTplus-AG/ifc-lite/commit/843aefb9333ae1ad2af24a26fdec889b83de48ed), [`b777dbb`](https://github.com/LTplus-AG/ifc-lite/commit/b777dbb085d70f7f56c15c50b48e3c8e57c889a7), [`62bb58f`](https://github.com/LTplus-AG/ifc-lite/commit/62bb58fc8364c27bcf8452ab8edbde26727f527c), [`ea81645`](https://github.com/LTplus-AG/ifc-lite/commit/ea81645f7cd47d9e62718a6687f9e780794c2aa2), [`74d76bb`](https://github.com/LTplus-AG/ifc-lite/commit/74d76bb52d03397734022855c9cbcd6bdef38632), [`de9d10a`](https://github.com/LTplus-AG/ifc-lite/commit/de9d10af48cc8051456ec368394ab0daffaf1c9e), [`fc68d01`](https://github.com/LTplus-AG/ifc-lite/commit/fc68d01be55aa630a3817a28943d88ff33386b25), [`96d8f41`](https://github.com/LTplus-AG/ifc-lite/commit/96d8f4126073250e079d7cdc8f77b409e70400e7), [`020932a`](https://github.com/LTplus-AG/ifc-lite/commit/020932aade4a506b5e6e6e27ddb706884660f995), [`a8c48ee`](https://github.com/LTplus-AG/ifc-lite/commit/a8c48eed679a31ef0c44782ee19c0889cef5a665), [`c6ffda4`](https://github.com/LTplus-AG/ifc-lite/commit/c6ffda4789099a45fafdb5fe237c33c6edd9884c), [`3b266b9`](https://github.com/LTplus-AG/ifc-lite/commit/3b266b99dac5e384c48a410df7074803b01ef20f), [`cbbb409`](https://github.com/LTplus-AG/ifc-lite/commit/cbbb4090e357abffd57a80f874721d916188ce08), [`d2fb0e4`](https://github.com/LTplus-AG/ifc-lite/commit/d2fb0e4121ccd19f326837ea574b189ee2a5f6c8), [`0a372b7`](https://github.com/LTplus-AG/ifc-lite/commit/0a372b7f3d6cce197ef3e4772267236b570a4447), [`32c5172`](https://github.com/LTplus-AG/ifc-lite/commit/32c51722003e58947c922507bfa7457050025114), [`b964918`](https://github.com/LTplus-AG/ifc-lite/commit/b964918c53992b18ea3fc29be540e1ab28470371), [`a4a498b`](https://github.com/LTplus-AG/ifc-lite/commit/a4a498bcb84c927862ea5ffcd865465e4c3a1a5f), [`2b594d2`](https://github.com/LTplus-AG/ifc-lite/commit/2b594d20616f957f7ef949aa8563274e5373a95b), [`cb56282`](https://github.com/LTplus-AG/ifc-lite/commit/cb56282133a3349299665859b5507b739808d32e), [`f326aa0`](https://github.com/LTplus-AG/ifc-lite/commit/f326aa03fd263b15b8188767520085fe635bf430), [`cbbb409`](https://github.com/LTplus-AG/ifc-lite/commit/cbbb4090e357abffd57a80f874721d916188ce08), [`89c4cf2`](https://github.com/LTplus-AG/ifc-lite/commit/89c4cf22e83d76115035f7dcbf6e34f9c06dd091), [`f41116a`](https://github.com/LTplus-AG/ifc-lite/commit/f41116af2bc41b349053c0eeeff7a276e0915879), [`fc40d01`](https://github.com/LTplus-AG/ifc-lite/commit/fc40d013a739c8921aa9cd8d7d56644a6c18af6c), [`c78ce8c`](https://github.com/LTplus-AG/ifc-lite/commit/c78ce8c3f1da3b8b2c6fa0f982595adc8c48b7d6), [`4246aaa`](https://github.com/LTplus-AG/ifc-lite/commit/4246aaa2035124dbe827827155dbbac2851fda4e), [`eb3000a`](https://github.com/LTplus-AG/ifc-lite/commit/eb3000aa21f13528bb75861f0f810bfc93c91fcc), [`b45180b`](https://github.com/LTplus-AG/ifc-lite/commit/b45180b7821014c1be6835201fa7a45b528c6377), [`a3d5a3a`](https://github.com/LTplus-AG/ifc-lite/commit/a3d5a3a23b6638a4cc68d9bb0da55035d4176bd0), [`3174ee9`](https://github.com/LTplus-AG/ifc-lite/commit/3174ee9d5b72d3d07c7b8c41238ae84221ae89fd), [`858b75a`](https://github.com/LTplus-AG/ifc-lite/commit/858b75a0ef5636098452a2297277767efdc956a2), [`19f1312`](https://github.com/LTplus-AG/ifc-lite/commit/19f13120a05cd3a3b729eeaf5550cff71b7506d9), [`82c77c1`](https://github.com/LTplus-AG/ifc-lite/commit/82c77c118d5a4be8e5ee5b7f7e0648514e9fb74e), [`456d189`](https://github.com/LTplus-AG/ifc-lite/commit/456d1898cdfdc1e31b145777b0f33bad203cc62a), [`d33deb9`](https://github.com/LTplus-AG/ifc-lite/commit/d33deb93e4d40323b76583a2c5ce7e6f0dcdf919), [`b7efeac`](https://github.com/LTplus-AG/ifc-lite/commit/b7efeac2195908729d1bf571839e2607f43c8ff7), [`4735f1c`](https://github.com/LTplus-AG/ifc-lite/commit/4735f1cbb6635016e83c7890f670e615bbdc48c3), [`4475e58`](https://github.com/LTplus-AG/ifc-lite/commit/4475e583ea35def444fb6d7ba92410629bd89096), [`182215a`](https://github.com/LTplus-AG/ifc-lite/commit/182215a835c4beac6a776bcb4eb1d019cab9063e), [`f1a006a`](https://github.com/LTplus-AG/ifc-lite/commit/f1a006af952dd670c6486cdb4ef0e8e1e0e280d7), [`3e61c40`](https://github.com/LTplus-AG/ifc-lite/commit/3e61c407e8b274c85ea4c74bd3b0d63cfc1c300f), [`4c00738`](https://github.com/LTplus-AG/ifc-lite/commit/4c007381bf14b3a4885adfea9b921beb105a8cc3), [`4475e58`](https://github.com/LTplus-AG/ifc-lite/commit/4475e583ea35def444fb6d7ba92410629bd89096), [`afa717b`](https://github.com/LTplus-AG/ifc-lite/commit/afa717bcf6041ad34085626fcfac321207ce4b81), [`6bd2550`](https://github.com/LTplus-AG/ifc-lite/commit/6bd25508dadd14fee97ee1f7393212cdcc086fdc), [`cb56282`](https://github.com/LTplus-AG/ifc-lite/commit/cb56282133a3349299665859b5507b739808d32e), [`d733175`](https://github.com/LTplus-AG/ifc-lite/commit/d733175d4ac2e8a2e94fc0bf9804d7bc03627cc1), [`fdac473`](https://github.com/LTplus-AG/ifc-lite/commit/fdac4734ce04758d2cd12b365f8b6de624713de6), [`902768e`](https://github.com/LTplus-AG/ifc-lite/commit/902768e138b595b26a47389bcea536f3f9e25b6d), [`adc5fab`](https://github.com/LTplus-AG/ifc-lite/commit/adc5fab7fe9208019dccf890589fb5fa5637ea63), [`ce8ca9f`](https://github.com/LTplus-AG/ifc-lite/commit/ce8ca9f3b8fd51ed89a9c21a275f00d63c240875), [`4f5414d`](https://github.com/LTplus-AG/ifc-lite/commit/4f5414d7faf69b2ca8a624edf20f6d6b0b448cac), [`a1aebc8`](https://github.com/LTplus-AG/ifc-lite/commit/a1aebc822b819221258f4759edf4c82ff0d140f7), [`a21f271`](https://github.com/LTplus-AG/ifc-lite/commit/a21f2718e93cd6bb432591ab006a9ecbb0cb648d), [`f8e03d4`](https://github.com/LTplus-AG/ifc-lite/commit/f8e03d4d5bb620fc9e807d5233091d145a201165), [`f8e03d4`](https://github.com/LTplus-AG/ifc-lite/commit/f8e03d4d5bb620fc9e807d5233091d145a201165), [`9368b2d`](https://github.com/LTplus-AG/ifc-lite/commit/9368b2dcdc8df61afe790e671de95317e0418c21), [`2c84b15`](https://github.com/LTplus-AG/ifc-lite/commit/2c84b15526456ad57ba93a77f669208174efbed3), [`4b043d4`](https://github.com/LTplus-AG/ifc-lite/commit/4b043d4e77345e77532c328ddd62d58c39b6bbe8), [`3cd1647`](https://github.com/LTplus-AG/ifc-lite/commit/3cd1647a2918ac27b903cb82bc797c2d2b288ac3), [`a1069f8`](https://github.com/LTplus-AG/ifc-lite/commit/a1069f8f096fcfc5771200a2748466096c3463d5), [`bcd716a`](https://github.com/LTplus-AG/ifc-lite/commit/bcd716a0bd5291b431b5d52c0910be47685224d6), [`9bc0dd9`](https://github.com/LTplus-AG/ifc-lite/commit/9bc0dd952b93982eafe1fbe7a9a483d4c3557b61), [`afb9725`](https://github.com/LTplus-AG/ifc-lite/commit/afb972525bb99e3056ccaa84ee7a78e0c7de81ef), [`dc8198c`](https://github.com/LTplus-AG/ifc-lite/commit/dc8198ce3f9b9be4b2420dce90343822e0079465), [`8b975fe`](https://github.com/LTplus-AG/ifc-lite/commit/8b975fec2769ba8f1787075ecb7785bb3bc06ac0), [`b331b49`](https://github.com/LTplus-AG/ifc-lite/commit/b331b4921ff0927ee18bb78f00d2bb6e496219d8), [`ae3efa1`](https://github.com/LTplus-AG/ifc-lite/commit/ae3efa1f09dd9e16de2d34c51665532a8dfde3f1), [`cfee55b`](https://github.com/LTplus-AG/ifc-lite/commit/cfee55b287075eddbe10cc37d4c0d70caaac7279), [`1389598`](https://github.com/LTplus-AG/ifc-lite/commit/1389598ac7e8c4986a89b50d7671cbb5028ab066), [`de3c82d`](https://github.com/LTplus-AG/ifc-lite/commit/de3c82d03047737fc4b870477b2cc0b61ffc56dc), [`cb9dad2`](https://github.com/LTplus-AG/ifc-lite/commit/cb9dad2df38f1796ab8cb6eefe881ad795876cc9), [`0b13e2d`](https://github.com/LTplus-AG/ifc-lite/commit/0b13e2d89b51608c2be3425ba2e5c95bfb8c0e5e), [`c4dafbf`](https://github.com/LTplus-AG/ifc-lite/commit/c4dafbf418810c519d49d5739bfedb2da41651b0), [`c65ec91`](https://github.com/LTplus-AG/ifc-lite/commit/c65ec91b411754b73c6317455873f771a15ba9f7), [`c3bdc8f`](https://github.com/LTplus-AG/ifc-lite/commit/c3bdc8fe55536a9b27adaa7ed92fb214c975fe2e), [`c3bdc8f`](https://github.com/LTplus-AG/ifc-lite/commit/c3bdc8fe55536a9b27adaa7ed92fb214c975fe2e), [`1060a30`](https://github.com/LTplus-AG/ifc-lite/commit/1060a30187c8f6bb327f9e356056f2364568e8ff), [`3460785`](https://github.com/LTplus-AG/ifc-lite/commit/3460785652f251f3161aa8dd6f1d247750df2715), [`80a0cd9`](https://github.com/LTplus-AG/ifc-lite/commit/80a0cd9b946a5ff1aa6ca214ddb427a5d1f5303c), [`a2488e8`](https://github.com/LTplus-AG/ifc-lite/commit/a2488e858bc7792cdcc818f7759c0a6e46e7d892), [`b135862`](https://github.com/LTplus-AG/ifc-lite/commit/b1358623210867daba42ff56e97ff05733bff646), [`4bdab03`](https://github.com/LTplus-AG/ifc-lite/commit/4bdab03efb71f878f307ceb3767beb83d8c8b0f6), [`d401b85`](https://github.com/LTplus-AG/ifc-lite/commit/d401b85a59b30a4223e291f6388800499a47954b), [`d401b85`](https://github.com/LTplus-AG/ifc-lite/commit/d401b85a59b30a4223e291f6388800499a47954b), [`8368339`](https://github.com/LTplus-AG/ifc-lite/commit/83683393654d8c1b903f03b5c6e9e5ff111fdaf0), [`ececb25`](https://github.com/LTplus-AG/ifc-lite/commit/ececb25f4e70e1086a274c7651512ccc60b23205), [`e5b8dbc`](https://github.com/LTplus-AG/ifc-lite/commit/e5b8dbc7e037aa049d56b1fb3bd1b55c034f9114), [`2edd144`](https://github.com/LTplus-AG/ifc-lite/commit/2edd14432999ceeed4c0bb0baf6b2000c1c5b041), [`cd6f54f`](https://github.com/LTplus-AG/ifc-lite/commit/cd6f54f48e0c3d9013d13f1b9a95d495287b3b45), [`2a2c73f`](https://github.com/LTplus-AG/ifc-lite/commit/2a2c73fc95044c5e6823f0dbc55f5e2c7a87a948), [`f8e03d4`](https://github.com/LTplus-AG/ifc-lite/commit/f8e03d4d5bb620fc9e807d5233091d145a201165), [`f76b3a1`](https://github.com/LTplus-AG/ifc-lite/commit/f76b3a1fe729acbf8fea40766ba8d068721f09df), [`3ccb417`](https://github.com/LTplus-AG/ifc-lite/commit/3ccb4176f3a61a227bcfc302c3e0b1fb43a6f0ec), [`7eaed2a`](https://github.com/LTplus-AG/ifc-lite/commit/7eaed2a98a8cd60bd402c0a9d79940739eabb331), [`2213431`](https://github.com/LTplus-AG/ifc-lite/commit/22134312e50d7f2dbe5d45928740eef5f6ffa241), [`499ccf2`](https://github.com/LTplus-AG/ifc-lite/commit/499ccf2f97fe1e24728eb4eb99f895044c36f7b2), [`4475e58`](https://github.com/LTplus-AG/ifc-lite/commit/4475e583ea35def444fb6d7ba92410629bd89096), [`80a0cd9`](https://github.com/LTplus-AG/ifc-lite/commit/80a0cd9b946a5ff1aa6ca214ddb427a5d1f5303c), [`a99ecd9`](https://github.com/LTplus-AG/ifc-lite/commit/a99ecd9998dada941dc66e8bcc85ce3864b44065), [`cfee9b2`](https://github.com/LTplus-AG/ifc-lite/commit/cfee9b28f5e6bec2040a29cbf7917be4696f407e), [`1b54404`](https://github.com/LTplus-AG/ifc-lite/commit/1b54404039bf2973732795cb219dcfd6a631b9e6), [`ff292b6`](https://github.com/LTplus-AG/ifc-lite/commit/ff292b685a7c663ef3e79928a754667bb919066a), [`2b87396`](https://github.com/LTplus-AG/ifc-lite/commit/2b87396553df0f3c11a930e3dae8b8600d70a23f)]:
  - @ifc-lite/export@4.0.0
  - @ifc-lite/parser@5.0.0
  - @ifc-lite/bcf@3.0.0
  - @ifc-lite/renderer@2.0.0
  - @ifc-lite/encoding@2.2.0
  - @ifc-lite/clash@2.0.0
  - @ifc-lite/bcf-api@0.2.0
  - @ifc-lite/wasm@6.2.0
  - @ifc-lite/sandbox@2.2.2
  - @ifc-lite/sdk@4.0.0
  - @ifc-lite/cache@3.2.0
  - @ifc-lite/collab@0.6.1
  - @ifc-lite/data@4.0.0
  - @ifc-lite/create@2.2.1
  - @ifc-lite/mutations@2.0.0
  - @ifc-lite/source-dalux@0.3.1
  - @ifc-lite/diff@0.8.0
  - @ifc-lite/mcp@0.13.0
  - @ifc-lite/query@2.1.0
  - @ifc-lite/drawing-2d@4.0.0
  - @ifc-lite/pointcloud@0.7.2
  - @ifc-lite/geometry@4.2.0
  - @ifc-lite/spatial@1.14.16
  - @ifc-lite/server-client@2.0.0
  - @ifc-lite/ids@1.15.53
  - @ifc-lite/ifcx@4.0.0
  - @ifc-lite/extensions@0.6.0
  - @ifc-lite/lens@1.19.1
  - @ifc-lite/lists@2.1.0
  - @ifc-lite/merge@0.4.5

## 1.38.0

### Minor Changes

- [#3064](https://github.com/LTplus-AG/ifc-lite/pull/3064) [`610ce20`](https://github.com/LTplus-AG/ifc-lite/commit/610ce2090b76bede9aa040dc0dddb45848e9610c) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Measure: derive a mass from geometry volume × material density, labelled as derived.
  
  The Quantities panel reported a weight only when the file declared an `IfcQuantityWeight`. A model with geometry and materials but no declared weight reported nothing, even though everything needed to compute one was present.
  
  It now derives a mass from the meshed geometry volume (the same value the "Volume mesh" row reports, after opening cuts) times the material density the file declares in `Pset_MaterialCommon.MassDensity`, and shows it as its own **"Mass derived"** row.
  
  **It is a separate row, never the same number.** A declared `Qto` weight, a mass computed from a density the file declared, and a mass estimated from a density the file did not are three different confidence levels. They are totalled separately and labelled separately, the same way the panel already refuses to read a bare `Volume` as a `NetVolume`. The row's tooltip and a footnote both say the figure is calculated and not an IFC-declared quantity.
  
  **A declared weight is never derived over.** When the file states a weight, that is the answer and no derivation runs for that element — including when a volume and a density are both available.
  
  **An untrusted volume produces no mass at all.** For a model federation alignment re-baked (`'same-crs'` / `'reprojected'`), the proved volume describes a size that is no longer on screen ([#1993](https://github.com/LTplus-AG/ifc-lite/issues/1993)), so no mass is derived from it and the existing note explains why. Likewise, an element whose materials declare *different* densities gets no mass: without each material's share of the volume there is no answer, and the panel says so rather than picking one.
  
  Units route through `project_units` as the single source: densities convert from the file's `MASSDENSITYUNIT` and the result renders in `MASSUNIT`, honouring the per-unit-type display override. The row says "Mass" rather than "Weight" because kg/m³ × m³ is a mass; where a file's `MASSUNIT` resolves to a force symbol instead, no mass is derived and the panel reports that rather than guessing between kilograms and kilonewtons.
  
  Scope: only the file's own density is wired. There is no project density library in the viewer today, so the "estimated from a library density" basis is modelled and tested but has no configured source yet. IFC2X3's `IfcGeneralMaterialProperties.MassDensity` — a scalar attribute rather than a property set — is still not read by the parser, so IFC2X3 files carrying their density that way are unaffected.
  
  Closes [#2736](https://github.com/LTplus-AG/ifc-lite/issues/2736).

- [#2930](https://github.com/LTplus-AG/ifc-lite/pull/2930) [`1823d70`](https://github.com/LTplus-AG/ifc-lite/commit/1823d70a581429fb6a7df2272b31d426e0cf2149) Thanks [@Blogbotana](https://github.com/Blogbotana)! - Add sun-cast shadows to the standalone WebGPU viewer ([#2670](https://github.com/LTplus-AG/ifc-lite/issues/2670), Phase 2).
  
  The standalone path had no cast shadows — surfaces were lit as if nothing
  occluded them, reading flat next to a tool like Blender. This adds classic sun
  shadow mapping end to end:
  
  - a depth pre-pass (`ShadowPass`) renders every occluder from the sun into a
    shadow map, fitted with an orthographic light-view-projection
    (`fitSunLightMatrix`) whose lateral extent tracks the camera frustum clipped
    to the model (`cameraFrustumFocusCorners`) while the depth range spans the
    whole model, so a small building on a large site keeps sharp shadows instead
    of spending the whole map on distant terrain;
  - the shared main-family fragment shader samples it with a rotated 12-tap
    Poisson-disk PCF kernel and a slope-scaled bias (normal-offset plus a
    grazing-angle depth term, so a flat ground under a low sun does not ring with
    acne), occluding only the direct sun term — ambient/fill/rim stay lit;
  - the penumbra width follows the sun's angular size (physical, ~0.53° like
    Blender's Sun lamp Angle), exposed as `sunShadows.sunAngleDeg`.
  
  All four geometry paths — flat, lattice-quantized, GPU-instanced and
  surface-textured — both cast (`collectShadowOccluders`) and receive (the shared
  shader / textured derivation), so no part of the model silently stops
  shadowing; a test drives the real `ShadowPass.render` and asserts each path
  issues a depth draw through its own pipeline. Transparent geometry (glass
  windows, and the virtual IfcSpace / IfcOpeningElement volumes) is excluded from
  casting by its material alpha, so daylight passes through windows and openings
  instead of the glass throwing a solid shadow into the void the wall already
  carries.
  
  The shadow map rides the existing environment bind group (group 1), so no
  pipeline-layout churn. Additive and off by default: `RenderOptions.sunShadows`
  (`{ enabled, resolution?, sunAngleDeg? }`) — absent/`enabled: false` skips the
  pass entirely and the shader's `enabled` gate returns fully lit, so the hot
  path pays only a boolean check. The viewer drives it from a Sun & Sky panel
  section (cast-shadows toggle, sun-angle softness, resolution, and a manual
  time-of-day sun for models without georeference).

- [#2980](https://github.com/LTplus-AG/ifc-lite/pull/2980) [`9279987`](https://github.com/LTplus-AG/ifc-lite/commit/927998774b87ebd7763f988447ea0ac63c2f990d) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Show how many physical objects in the loaded model are visible, and how many are not.
  
  The viewport now reports "N of M objects visible" whenever a visibility filter is actually holding something back, following the same speak-up-only-when-the-numbers-disagree rule the point-cloud class list uses. An unfiltered model shows no extra chrome, and with no model loaded there is nothing to report rather than a meaningless "0 of 0".
  
  The number that matters here is the denominator. `ViewportOverlays` already computed a visible/total pair from `geometryResult.meshes.length` and threw both away without ever rendering them, and that total would have been the wrong thing to show: it counts things that PRODUCED a mesh, so an object present in the file that never generated geometry is absent from both sides of the ratio and can never appear as "not visible". The counter would have read "1203 of 1203 visible" while a wall silently failed to slice. The mesh array is the wrong denominator in three independent ways: one element can produce many `MeshData` entries (per material, per CSG part), a colour-merged batch carries many entities in a single entry via `entityIds`, and a fully instanced entity produces no entry at all.
  
  The count is therefore taken from the entity index (`entityIndex.byType`), so the gap between "in the model" and "on screen" is observable instead of definitionally zero.
  
  A physical object is an entity whose schema inheritance chain contains `IfcElement`, minus `IfcFeatureElement` and `IfcVirtualElement` subtypes. Everything excluded is excluded so the number does not cry wolf by reporting objects as missing that were never meant to be drawn. Spatial containers (`IfcSite`, `IfcBuilding`, `IfcBuildingStorey`, `IfcSpace`) descend from `IfcSpatialElement` rather than `IfcElement` and drop out with no special case — they have no shape representation by design. `IfcSpace` is the genuine judgement call and lands outside: it is a real object users care about, but it is a spatial element by schema and the viewer ships with spaces hidden, so every model with rooms would otherwise read "N not visible" permanently — an alarm that is never actionable. `IfcOpeningElement` and other feature elements are `IfcElement` subtypes by schema but are voids subtracted from real elements, and are hidden by default; `IfcVirtualElement` is a non-physical clearance volume, hidden for that reason. `IfcAnnotation` and `IfcGrid` are drafting aids and are not `IfcElement` subtypes. Keying on the inheritance chain rather than a leaf list means a schema bump that adds an `IfcElement` subtype is counted without anyone editing a set, and the chain is resolved across schemas because the single-schema walk is pinned to IFC4 and would read IFC4X3 infrastructure classes as non-physical.
  
  The visible count mirrors the store's own `isEntityVisible` — hidden set, isolation, class filter — so the badge and the renderer cannot disagree about what "visible" means. Isolation is intersected with the physical set rather than read off `isolatedEntities.size`, which counts the non-physical children an isolated storey drags in. Ghosted objects are reported separately rather than as hidden, because X-Ray renders them translucent, i.e. still drawn.

### Patch Changes

- [#3039](https://github.com/LTplus-AG/ifc-lite/pull/3039) [`deaf4f0`](https://github.com/LTplus-AG/ifc-lite/commit/deaf4f088890effeba3f070a4963175667ce5e82) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix inward-facing normals on the "add element" instant-preview mesh's side faces.
  
  `buildBoxFromIfcCorners` draws the instant-preview box the moment a builder tool commits, and is fed by two callers that wind their corner rings in **opposite** directions: `buildAxisBox` (column / door / window) lists its bottom ring counter-clockwise seen from IFC +Z, `buildLinearBox` (wall / beam / member) lists it clockwise. Each side face's normal came from `faceNormal(corners, a, b, c)`, whose sign follows that winding — so one fixed argument order was outward for one family and inward for the other. Columns, doors and windows previewed with all 4 side faces lit backwards until the export+re-parse round-trip replaced the preview with real geometry.
  
  Fixed by resolving the side normal's sign against the box centre rather than against the ring order: the cross product still supplies the face's axis, and the direction that points away from the centre is chosen (valid for any winding, since the box is convex). Both families now light correctly, and a future caller gets outward normals whatever ring order it uses. Vertex positions, the index buffer, per-vertex entity ids and the hardcoded top/bottom normals are byte-identical to before for every currently reachable shape.

- [#3086](https://github.com/LTplus-AG/ifc-lite/pull/3086) [`932f043`](https://github.com/LTplus-AG/ifc-lite/commit/932f0439fc1625419aae3cf2d9f81a614fb2273c) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Close seven holes in the collaborative-session role gate. In a shared room only editor/admin may write, and `mutationSlice` enforces that with `canCollabEdit()` before each local commit — but the gate had been added one call site at a time, and each round left the arms nobody happened to look at open. `deletePropertySet` sat directly beneath a gated `createPropertySet` with a byte-for-byte identical body minus the gate; `setEntityType` sat beneath a gated `setAttribute`; `setPositionalAttribute`, the rawest write in the slice, had none; `duplicateEntity` creates an entity the way the gated `addWall`/`addColumn` do; and `splitWallAtDistance`, `splitLinearElementAtDistance` and `splitSlabByLine` write the way the gated `resizeWall` does. So a viewer-role participant could delete a property set, reclass an entity, overwrite a STEP attribute slot, duplicate an element or split a wall, slab or beam: the edit committed to their local view, dirtied the model and entered their undo stack, and — being ungated — never reached the room, which is the silent divergence the gate exists to prevent. All seven now reject with the same message their gated siblings use. `roleCanEdit(null)` is `true`, so single-user sessions are untouched. The regression test is written as an enumeration of the slice's writers rather than a sample of them, since sampling is what let the gap survive three rounds of fixing. Still ungated and reported rather than changed here, because each needs a product call rather than a copied line: `generateSpacesFromWalls` (its `dryRun` mode is a legitimate read for any role), `setGeorefField`/`setGeorefFields`, `setPositionalAttributesBatch` (reached only through gated callers today), `importChangeSet`, `undo`/`redo`, and `clearMutations`/`clearAllMutations` (they discard local mutation history rather than writing, which is the same divergence family as undo/redo).

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

- [#2957](https://github.com/LTplus-AG/ifc-lite/pull/2957) [`1118399`](https://github.com/LTplus-AG/ifc-lite/commit/11183991d9fb042221d20f1ca432dc0b2293c928) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Don't fail a flavor operation on an active-flavor pointer write that changes
  nothing, and snapshot a same-version reinstall before overwriting its bundle.
  
  Four sites wrote in two steps, and treated a refused second write as fatal
  without first asking whether that write would have stored what was stored
  already:
  
  - **`switchFlavor`** rolled every extension toggle back and reported
    `'<pointer>'` when `setActiveFlavor` was refused. Re-applying the flavor that
    is already active writes the id the pointer already holds, so the refusal
    changed nothing — and the rollback disabled every extension the target
    declares. `FlavorSwitcherCallbacks` gains an optional `readActiveFlavor()`;
    when it reports the id `activeFlavorPointer(target)` would have written, the
    switch stands. Without the callback, or when the read fails, the refusal is
    still fatal — the behaviour every host had before.
  - **`activeFlavorPointer(target)`** is now exported: it builds the id the
    pointer stores for a flavor, so the value compared is the value written by
    construction rather than a second derivation that can drift.
  - **`activeFlavorPointerAlreadyStored(read, pointer)`** is now exported and is
    the single comparison both hosts ask through, so a change to how the pointer
    is encoded lands once. It answers `false` for a pointer that is not a string,
    so an absent id can never match an unset pointer and report a refused write
    with nothing stored as a successful one.
  - **`ExtensionHostService.switchFlavor`** (viewer) wires that callback through
    `FlavorService.activeId()`, also new. It turned a failed switch into a thrown
    error, which skipped the lens, clash and sidebar restores below it.
  - **`FlavorService.resetToDefaults`** (viewer) threw when `setActiveId` was
    refused even though the baseline flavor had landed and the pointer already
    named it — the common case, since resetting is the way back from anything.
    It now rethrows only when the pointer is not provably already that id.
  
  Separately, **`installFromBytes`** (viewer) snapshotted the previous install's
  bundle bytes only when the incoming version differed. Bundle bytes are keyed by
  id and version, so a reinstall of the same version overwrote them; a loader
  rejection then deleted the record and the bundle with nothing to restore,
  wiping a working extension. The snapshot is now taken for any previous install.
  The teardown stays gated on a version change.
  
  The rollback also restores the previous record under its own guard, independent
  of the bundle bytes. The record carries the capability grants, the enabled bit,
  the install time and the source, none of which need bytes and none of which the
  user can reconstruct, so a previous install whose bytes were already gone no
  longer has its record deleted by the rollback, and a byte write that fails
  during the restore — `putBundle` is the step with a storage-quota path — no
  longer takes the record down with it. A record without its bytes is a state the
  loader names (`invalid_reference`); reinstalling the same version repairs it and
  keeps the grants, but the app offers no route to that today — the Repair queue
  passes an extension whose engine range still matches, so it never reports the
  missing bytes. Keeping the record is still the better outcome: unloaded *and*
  deleted is strictly worse than unloaded.
  
  The rollback now also checks that the record in storage is still the one this
  install wrote before undoing anything. `load` is an await point, so a user can
  uninstall while a slow load is in flight; restoring the previous record after
  that would undo an explicit uninstall. The check is on record identity, never
  on whether bytes exist, so it does not reintroduce the gate above.
  
  One cost, in the safe direction: because the snapshot is no longer gated on a
  version change, a transient failure reading the previous bundle bytes now fails
  a same-version reinstall that previously would have proceeded. Nothing is
  written or destroyed in that case; the install has to be retried.
  
  Each comparison is one-directional: `false` means "not provably a no-op", never
  a guess, so anything unreadable costs only a refusal that was already the old
  behaviour. No path reports success while the stored state differs from what a
  successful operation would have left.

- [#3046](https://github.com/LTplus-AG/ifc-lite/pull/3046) [`f126041`](https://github.com/LTplus-AG/ifc-lite/commit/f126041345b397f48a060a4032a96e44477769fb) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Tell the user when a flavor switch could not apply part of the flavor, instead
  of warning about it in the console.
  
  `ExtensionHostService.switchFlavor` restores three pieces of viewer state after
  the extension switch itself has landed: saved lenses, the clash rule-set +
  detection settings, and the sidebar layout. Each of those can be refused on its
  own — the store commits a config only once it has actually persisted, and a
  browser that blocks `localStorage` outright refuses every write. The refusals
  were `console.warn`ed and the method returned `void`, so `FlavorDialog` toasted
  an unqualified "Switched to X" over a flavor whose clash config had not been
  applied at all. In a locked-down browser, switching flavor changed nothing the
  user could see and nothing told them why ([#3002](https://github.com/LTplus-AG/ifc-lite/issues/3002)).
  
  `switchFlavor` now returns `{ unapplied }`, one entry per part that did not land
  (`'lenses' | 'clash' | 'layout'`) carrying the refusal's own message, and the
  dialog reports those parts and their reason in place of the success toast.
  
  The gate is the store's own verdict, not "was a write refused": a write refused
  over bytes identical to what is already stored changed nothing, and
  `applyClashFlavorConfig` already answers `ok` for that case. Such a switch keeps
  reporting a plain success, because the state the user asked for is the state
  they have.
  
  This does not make the config apply in a browser that refuses storage — it
  cannot, since the flavor's config would silently revert on the next reload. What
  changes is that the refusal is now visible and names its cause.

- [#3034](https://github.com/LTplus-AG/ifc-lite/pull/3034) [`75867a7`](https://github.com/LTplus-AG/ifc-lite/commit/75867a7e6ebf51b2da47cab14242bcd71787ba3b) Thanks [@louistrue](https://github.com/louistrue)! - Make `bim.mutate.*` persist in the headless CLI and MCP backends instead of silently discarding every edit.
  
  `HeadlessBackend.createMutateAdapter` answered `setProperty`, `setAttribute` and `deleteProperty` with no-ops in both `packages/cli` and `packages/mcp`. Nothing threw and nothing returned a failure, so an `ifc-lite run` script could call `bim.mutate.setProperty` six thousand times, report six thousand edits, and get an export back byte-for-byte identical to its input. The write path that does persist was already present — `MutablePropertyView`, which `StepExporter` reads when `applyMutations` is on, and which `bim.store.*` and `bim.spaces.*` already routed into — nothing connected `bim.mutate` to it.
  
  Both backends now share `createHeadlessMutateAdapter` from `@ifc-lite/sdk`, which owns `MutateBackendMethods` and already depends on `@ifc-lite/mutations`. The adapter takes a thunk rather than a view so the overlay is still built on first write and a read-only session pays nothing.
  
  Values are classified before they are stored. `MutablePropertyView.setProperty` defaults to `PropertyValueType.String`, so forwarding a raw JavaScript value wrote `IFCLABEL('true')` where the caller passed `true`; `propertyValueTypeOf` maps boolean to `IFCBOOLEAN`, whole numbers to `IFCINTEGER` and the rest to `IFCREAL`.
  
  `undo` and `redo` still answer `false` and `batchBegin`/`batchEnd` are still accepted and ignored: the mutation history they would walk belongs to the viewer's store, and a headless session has none. That is now documented at the adapter rather than implied by a bare stub.
  
  The browser viewer's adapter had the same defect from the other direction: it forwarded the raw value to `mutationSlice.setProperty`, whose `valueType` also defaults to `String`, so `bim.mutate.setProperty(ref, pset, prop, true)` wrote `IFCLABEL('true')` there too. It now passes `propertyValueTypeOf`, which is also why that helper is exported. The two other character-identical copies of the classifier — `detectValueType` in the MCP mutation tool and `inferValueType` in the CLI gym ops — now alias it, so the paths cannot diverge on a future correction.
  
  Verified on the export, not on the overlay — reading the view back passes against the broken adapter too. With the original no-ops restored, 5 of the 6 new CLI tests fail; the sixth is the control that asserts an unmutated re-export still contains the original name.

- [#3029](https://github.com/LTplus-AG/ifc-lite/pull/3029) [`fe38b33`](https://github.com/LTplus-AG/ifc-lite/commit/fe38b334c33e507922127168cc7d4055b831190e) Thanks [@louistrue](https://github.com/louistrue)! - Report hidden objects as a count, in the viewport's own style.
  
  The overlay added in [#2980](https://github.com/LTplus-AG/ifc-lite/issues/2980) read "1442 of 1446 objects visible" inside a rounded pill with an amber accent. Two things wrong with that.
  
  **It reported the wrong number.** The figure a user acts on is what the viewer is withholding. A ratio makes them subtract to find the four objects that matter. It now reads "4 hidden".
  
  **It did not follow the viewport's design.** The 3D overlays along the bottom edge are deliberately plain: the scale bar and axis helper are bare text at `text-xs text-foreground/80` with no container. The badge instead used `rounded-full` with a border, a backdrop blur, a shadow and `text-amber-500`, which is neither the bottom-row treatment nor a palette colour. It is now styled as its neighbours are.
  
  Counting logic is unchanged; only the reported figure and the presentation.

- [#2979](https://github.com/LTplus-AG/ifc-lite/pull/2979) [`a6cb603`](https://github.com/LTplus-AG/ifc-lite/commit/a6cb603b56d4c8c0edb52a415713cd135ea8a588) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Restructure the IDS HTML report around requirements, and stop emitting an unopenable document for a large model.
  
  The report grouped results only by entity: each specification rendered one flat table whose rows were entities, and a requirement appeared only inside a per-entity `<details>` in the last column, and only when it had failed. Answering the question a reader actually brings to the report — *which requirement is failing, and on what?* — meant expanding every row and tallying by hand. Each specification now leads with one block per requirement carrying the facet type, the checked description, the pass/fail check counts, and the failing elements beneath it with type, name, GlobalId, express id and the written failure reason. The per-entity table is still there, moved into a collapsed `<details>` below.
  
  Grouping happens before `not_applicable` is filtered out, keyed on `requirement.id` rather than on array position, so an entity whose requirement was not applicable does not shift every later requirement's results onto the wrong requirement.
  
  Three pass rates are now reported side by side instead of two, with an explanation of why they legitimately disagree. The check-level rate — one element measured against one requirement — was not computed anywhere before; it is aggregated here from `requirementResults`. The entity-level rate (an entity passes only if all its requirements pass) is `summary.overallPassRate`, read rather than recomputed, and is the figure the report showed before, previously labelled ambiguously as "entity checks". The specification-level rate is the one a compliance deliverable should quote, and the report now says so. Every rate is floored, matching the validator and the in-app panel; the export used to round, so 99.6% could read as 100% while elements were still failing.
  
  Nothing is truncated silently. Failing elements are grouped by IFC type, capped at 5 examples per type and 100 elements per requirement, and every cap states its exact hidden count ("Showing 5 of 312 IfcWall failures"). The per-entity table is capped at 100 rows and emits failing entities first, so the cap can never hide every failure behind a wall of passes. Individual text fields are truncated at a 160-character budget — a count of code points, so a surrogate pair is never split in half — with a visible ellipsis and the untruncated text preserved in a `title` attribute, so a shortened field stays readable rather than being destroyed. The summary card states plainly that the HTML is a summary and that the JSON export holds the complete results.

- [#3048](https://github.com/LTplus-AG/ifc-lite/pull/3048) [`9b29946`](https://github.com/LTplus-AG/ifc-lite/commit/9b29946d181b6ad96b9f042ad95cd9ae153bf505) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Remove the reconstructed `room:<id>` model when a collab session is left while
  its join is still finishing.
  
  The recipient join registers a real model record for the room and installs the
  teardown that removes it only after `await reconstruct()` has returned. The
  abandoned-join guard sits below that assignment and returned without running the
  teardown, so a Leave landing in that window left the model in `models` — and the
  doc `update` listener attached — until the next `stopCollab` ([#3016](https://github.com/LTplus-AG/ifc-lite/issues/3016)).
  
  The guard now runs the teardown this join installed before disposing the
  session. It runs the join's OWN closure, never the module-level slot, because a
  newer join may already own that slot by then and running its teardown would drop
  the room model of the session the user is actually in.
  
  The publish into that slot is now conditional on this join still being the live
  one, which fixes the mirror-image leak the fix would otherwise have left open: a
  stale continuation resuming after a newer join had already published its
  teardown overwrote it, so the newer room's model was never removed on the next
  Leave. Both checks read `collabRoomId` against this join's `roomId`, the same
  granularity as every other re-check in `startCollab` — neither can tell a rejoin
  of the same room from this join still being live.

- [#2977](https://github.com/LTplus-AG/ifc-lite/pull/2977) [`40cd43c`](https://github.com/LTplus-AG/ifc-lite/commit/40cd43ce29cce6c71671e07abde00b41c8886e37) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Give unclassified elements a real legend entry in classification auto-color mode, instead of silently ghosting them.
  
  Previously, `evaluateAutoColorLens` pushed any entity whose `extractAutoColorValues` returned no values into `ghostIds` — a faint gray tint, no legend row, no count, no way to select or isolate it. For `source: "classification"` this meant every unclassified element (and, when a system filter was set, every element classified in a *different* system) disappeared into the ghost mass with no way to see how many there were.
  
  `AutoColorSpec` gains an opt-in `includeUnclassified` flag. When set on a `classification` source, value-less entities get real, clickable legend entries instead:
  
  - **"No classification"** — the entity has zero classification references.
  - **"Not in this system"** — it has references, but none in the system named by `psetName`. This bucket only appears when `psetName` names a specific system; with no system filter there is nothing to be "not in", so everything collapses into the single "No classification" bucket.
  
  Both buckets get fixed, visually-neutral colors (not drawn from the rank-based palette), so they can never take the most-saturated color just because they're the largest group, and turning `includeUnclassified` on/off never shifts the colors already assigned to real classification values. Each `AutoColorLegendEntry` for one of these buckets carries `isAbsent: true` so a consumer can tell an absence bucket apart from a real classification code.
  
  The flag defaults to unset/`false`, which reproduces the exact pre-existing ghosting behavior — this is additive, not a new default, so an existing saved lens or SDK caller relying on unclassified elements being ghosted sees no change. An older `@ifc-lite/lens` build that doesn't know this field simply ignores it and keeps ghosting, which is also the safe fallback if the field is ever malformed on import.
  
  The viewer's lens editor now exposes this as a "Show unclassified" toggle, shown only when the auto-color source is set to Classification. It is off by default, matching the flag's default; turning it on persists into saved lenses and JSON export/import exactly like the rest of an auto-color spec.

- [#3024](https://github.com/LTplus-AG/ifc-lite/pull/3024) [`b172462`](https://github.com/LTplus-AG/ifc-lite/commit/b1724626f494c6a9d6c7983fe041ccf7c4fc4bf9) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `loadListDefinitions` returning non-array JSON verbatim, bricking the List panel on a corrupt or hand-edited `localStorage` entry.
  
  `loadListDefinitions` parsed the stored value and cast it straight to `ListDefinition[]` without checking it actually was an array. A hand-edited entry, or any well-formed JSON that isn't an array (an object, a stray number, `null`), came back unchanged. `listSlice.addListDefinition` spreads that result (`[...listDefinitions, def]`) on the very first list the user creates, so a non-array value threw `TypeError: ... is not iterable` at that point instead of the panel just starting empty. `loadListDefinitions` now falls back to `[]` for any parsed value that isn't an array, the same way it already does for unparsable JSON.

- [#3065](https://github.com/LTplus-AG/ifc-lite/pull/3065) [`ffe3185`](https://github.com/LTplus-AG/ifc-lite/commit/ffe3185c6320d57a0be76f5d1810a13f43926f57) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Make the Measure tool's relative-coordinate readout distinguishable from an absolute one, and show the datum it is measured from ([#2737](https://github.com/LTplus-AG/ifc-lite/issues/2737) §3).
  
  The temporary reference point itself already shipped: a store field and a subtraction feeding one "Rel. ref" row. Two things about how that row read are fixed here.
  
  The offset printed as `X 3.000  Y 4.000  Z 4.000` — character for character the shape every absolute coordinate the viewer shows uses (model-local, project/anchor, render-frame world, georeferenced). Only the small label cell beside it said otherwise, and a label cell is what a narrow panel or a screenshot crop loses. It now prints as signed per-axis deltas, `ΔX +3.000  ΔY +4.000  ΔZ +4.000`, so the distinction is carried in the value and survives being read out of context. A zero axis stays unsigned: an offset of nothing has no direction.
  
  The datum was also never displayed, only implied by the delta row's existence — an offset whose origin is off-screen or forgotten is a number nobody can act on. A **Datum** row now shows the reference point's own position, in the same frame and the same format as the Model row above it, because that is what it is: a point somebody picked. Both rows are derived from the store on every render, so moving the reference recomputes the offset in place and clearing it removes both rows rather than leaving their last numbers on screen.
  
  No change to when the datum is kept or dropped, to the absolute rows when no datum is set, or to the georeferenced projection.

- [#3057](https://github.com/LTplus-AG/ifc-lite/pull/3057) [`fdd6121`](https://github.com/LTplus-AG/ifc-lite/commit/fdd61211e41d3e563a7604ac5e0630a9daae2de1) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Remove two advertised-but-unread option surfaces, and with them the `--quality`
  CLI flag. Both were found by the issue [#2731](https://github.com/LTplus-AG/ifc-lite/issues/2731) audit; an earlier changeset marked
  the audit's inert *fields* `@deprecated` and deliberately left these two out,
  because each carries a behaviour decision rather than only a doc fix. This is
  that decision, taken as removal.
  
  **`DynamicBatchConfig.initialBatchSize` / `.maxBatchSize` (`geometry`,
  breaking).** The interface promised a ramp-up — small first batches for a fast
  first frame, larger ones later. No ramp-up exists.
  `getStreamingBatchSize` reads `fileSizeMB` alone (falling back to the buffer's
  own length when it is absent or zero) and returns a fixed value off a size
  ladder; the two size fields were never read on any path. `DynamicBatchConfig`
  is now `{ fileSizeMB?: number }`. Streaming behaviour is unchanged for every
  caller — the values were already ignored — but an object literal that still
  sets either field is now an excess-property error. Delete the fields; the
  resulting batch sizes are identical.
  
  **`GeometryProcessorOptions.quality` and the `GeometryQuality` enum
  (`geometry`, breaking).** The constructor discarded the value (`void
  options.quality;`) and nothing downstream consulted it, so `Fast`, `Balanced`
  and `High` selected exactly the same geometry. The field and the exported
  `GeometryQuality` enum are both gone. Callers wanting a real detail-level
  control want `tessellationQuality` (`'lowest' | 'low' | 'medium' | 'high' |
  'highest'`), which is honoured by the WASM pipeline.
  
  **`GenerateLod1Options.quality` (`export`, breaking).** It existed only to
  forward into the discard above. Removed.
  
  **`ifc-lite lod --quality` (`cli`, user-visible removal).** The flag accepted
  `low | medium | high | fast | balanced`, validated the value, rejected anything
  else with a non-zero exit — and then fed the result into the discarded field.
  Every accepted value produced byte-identical LOD1 output. The flag is removed
  rather than left validating into nothing: a command that still fails on
  `--quality gorgeous` while ignoring `--quality low` misleads more than an
  unknown-flag path does. Scripts passing it need the flag dropped; the generated
  GLB and metadata are unchanged.
  
  `geometry` and `export` take `major` because a public export is removed and
  optional fields disappear from published types — the repo's own API-surface
  guard puts a removed export at `major` for a package at or past 1.0. `cli` is
  `0.x` and takes `minor` for the flag removal.

- [#2994](https://github.com/LTplus-AG/ifc-lite/pull/2994) [`a55d13b`](https://github.com/LTplus-AG/ifc-lite/commit/a55d13ba5e0f8659de0a527fb2a9a928e488205a) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Stop a script Run result from one place in the UI silently overwriting a newer script result started from another.
  
  `useSandbox()` is instantiated independently in `ScriptPanel`, `ChatPanel`, `CommandPalette` and `ExecutableCodeBlock`, each with its own local sandbox — but all publish to the same shared `scriptLastResult`/`scriptLastError`/`scriptExecutionState` store fields with no check that the completing call was still the one being waited on. Two overlapping runs (a Script Console run racing a chat auto-executed code block) published in FINISH order rather than START order, so a slower, older run could land after a faster, newer one and silently replace its already-displayed result. `useClash`/`useIDS`/`useCompare` already guard the equivalent race with a per-hook run epoch, but that shape cannot cover this case: each `useSandbox()` instance has its own local ref, so two different instances' epochs never compare against each other. `scriptRunEpoch` now lives in the shared store instead, so every `useSandbox()` instance reads and writes the same counter, and a superseded run's terminal store write is skipped.
  
  That store-level epoch gates the shared store write only. It does not gate what `execute()` resolves with to its own caller: an unrelated instance's newer run must not turn a script that actually finished successfully into a fabricated failure for the panel that ran it (`ExecutableCodeBlock`/`ChatPanel`'s auto-execute both read a `null` return as "this script failed"). `execute()`'s return value is instead gated by a separate, per-instance run epoch — the same shape `useClash`/`useIDS`/`useCompare` already use — so only that same instance's own newer call, or its own `reset()`, can make an earlier call of its own resolve `null`, matching the existing [#1922](https://github.com/LTplus-AG/ifc-lite/issues/1922) teardown-abort contract for a run that actually died.
  
  Also fixes what that guard turned terminal: "Reset sandbox" left the store reporting a successful run with no result and no error. `setScriptResult(null)` moved the execution state to `'success'` unconditionally, so `useSandbox().reset()` — its only caller that passes `null` — cleared the result and then announced a success for it. That used to be overwritten by whatever run completed next; with the supersession epoch, a run the reset itself superseded no longer writes at all, so the incoherent state was the one the panel came to rest in. A `null` result is now reported as `'idle'`, which is what every other "nothing has run" path in the store already uses.

- [#2960](https://github.com/LTplus-AG/ifc-lite/pull/2960) [`be74930`](https://github.com/LTplus-AG/ifc-lite/commit/be74930b383a189ac61c5f8ef5bc8b5f4579dda3) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Key the 2D-Section pinned-placement cache on the section axis as well as the sheet geometry.
  
  `resolveSheetTransform` returns the per-axis flips as an output so a consumer cannot pair one axis's transform with another axis's flips. The cached transform, however, is a second carrier of those flips: `calculateDrawingTransformForAxis` folds `flipX`/`flipY` into `translateX`/`translateY`. The cache key covered the sheet's id, paper, viewport and scale only, so an entry written by a resolve on one axis was served to a pinned resolve on another — on a 1:100 A3 fixture that puts the drawing centre 140 mm from the viewport centre, off the paper. In the app the axis change also nulls the cache and forces a re-fit, so the mismatch was at most a single frame rather than a persistent one.
  
  The cached entry is now tagged with `sheetTransformCacheKeyOf(sheet, axis)` and validated against it, which makes the pairing unrepresentable at the cache too. Same-axis pinned reads still hit the cache, so pinning is unaffected.

- [#2960](https://github.com/LTplus-AG/ifc-lite/pull/2960) [`be74930`](https://github.com/LTplus-AG/ifc-lite/commit/be74930b383a189ac61c5f8ef5bc8b5f4579dda3) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix a 2D-Section drawing sheet printing at a different position than the preview while Pin View is on.
  
  Pin View (on by default) holds the sheet placement steady while the drawing's bounds change underneath it — that is what pinning is for. The preview honoured it by reusing a cached transform; the print/export path (`useDrawingExport`'s `generateSheetSVG`) was never given the pin state or the cache at all, so it re-fitted the drawing from the current bounds. The cache is deliberately keyed on the sheet's geometry (id, paper, viewport, scale) and not on the drawing bounds, so it stayed valid across a regenerate at a new elevation: the preview kept the held placement and the print computed a different one. Same visible symptom as the earlier off-centre print, different cause.
  
  Both paths now go through one resolver (`resolveSheetTransform`) that owns the per-axis flip correction and the cache read, with the flips derived from the section axis rather than at each call site. The preview still owns the cache write, and the export path never writes, so printing cannot move what is on screen.

- [#2960](https://github.com/LTplus-AG/ifc-lite/pull/2960) [`be74930`](https://github.com/LTplus-AG/ifc-lite/commit/be74930b383a189ac61c5f8ef5bc8b5f4579dda3) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix a 'side' section's drawing sheet — preview, print and export alike — landing off-center on the sheet along X.
  
  `calculateDrawingTransformForAxis` (added to fix the analogous Y-axis issue) only corrected `translateY` for the caller's Y-flip; `translateX` was passed through unmodified regardless of the caller's X-flip. 'side' sections flip X (`adjustedX = -x`, to view from the conventional direction) but `calculateDrawingTransform`'s `translateX` bakes in the assumption of no X-flip, so a 'side' section whose bounds weren't symmetric about X=0 was centered at a point shifted by `(minX + maxX) * scaleFactor` — up to the full width of the viewport for a section far from X=0.
  
  `calculateDrawingTransformForAxis` now takes an optional `flipX` parameter (default `false`, preserving prior behavior for callers that don't pass it) and applies the mirror-image correction to `translateX` when it is true. Both the preview (`Drawing2DCanvas.tsx`) and the print/export path (`useDrawingExport.ts`'s `generateSheetSVG`) reach it through one shared resolver that derives the flips from the section axis, so a 'side' section centers correctly and neither path derives the flips separately.

- [#3067](https://github.com/LTplus-AG/ifc-lite/pull/3067) [`55fa1e8`](https://github.com/LTplus-AG/ifc-lite/commit/55fa1e8db07a0461444b787f13f891820bb49e23) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Stop the Drawing Sheet PDF export asking the browser for a canvas it will not allocate, and never let a blank one reach the page.
  
  The sheet PDF rasterizes `generateSheetSVG`'s output at a fixed 300 dpi, sized to the sheet's own paper. On the big papers that is far past what WebKit allocates: ARCH E (1219.2 x 914.4 mm) is 14400 x 10800 = 155,520,000 px, A0 is 14043 x 9933 = 139,489,119 px, against `CanvasBase::maxCanvasArea()` — `8192 * 8192` on the iOS family, `16384 * 16384` elsewhere. Nine of the twenty-five registry paper sizes are over the lower cap; ARCH E, not the A0 named in review, is the worst case.
  
  Nothing about that failure announces itself. `CanvasBase::validateArea()` logs a console warning and returns false, the canvas gets no backing store, `getContext('2d')` still hands back a live context, the paint calls no-op, and `toDataURL()` returns the literal string `"data:,"` (`encodeDataURL(RefPtr<ImageBuffer>&&)` returns `"data:,"_s` for a null buffer). The export then died inside jsPDF's PNG decoder, so the user got a complaint about a PNG signature with no remedy in it.
  
  The pixel grid now comes from `fitRasterPixels` — the same helper the 3D-view PDF's shaded underlay already uses, rather than a second cap policy — budgeted at WebKit's lower cap. It scales both sides by one factor, and the image is still placed across the full paper rectangle in millimetres, so a capped sheet is blurrier and never mis-scaled: A0 lands at 208 dpi and ARCH E at 197, both above the 150 dpi this repo already ships as adequate for a printed PDF raster. Papers inside the cap — ARCH C and everything smaller, including the A3 default — are untouched at the full 300 dpi.
  
  Capping is surfaced, not silent: a reduced sheet raises a notice naming the dpi actually delivered and pointing at the SVG export for a vector sheet at any size. And because a pixel budget is necessary but not sufficient — Safari enforces a separate total canvas-memory limit, and any browser can fail a large allocation on a low-memory device — a data URL that is not a PNG is now refused with a message that names the paper size and the way out, instead of being handed to jsPDF.
  
  The cap value and the failure mode are read off WebKit's source, not observed in a browser; no Safari, Chrome or Firefox was run, and Chrome's and Firefox's own limits are not modelled.

- [#3095](https://github.com/LTplus-AG/ifc-lite/pull/3095) [`bea50bd`](https://github.com/LTplus-AG/ifc-lite/commit/bea50bd7bca7fdf69f01076ebb96a31b8e797a46) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Put the symbolic annotation/grid overlay in the same coordinate frame as the meshes it is drawn over.
  
  The symbolic extractor re-based its plan coordinates by the wrong component of the model RTC offset — the offset's Z (elevation) was subtracted along the northing axis — and never re-based the elevation it reports as `worldY` at all. Both mistakes are invisible for a model near the origin, where the offset is (0,0,0), and neither had test cover. For a georeferenced model the mesh pipeline re-bases every vertex by the whole offset, so annotations, dimension text, fill areas and grid bubbles were drawn a northing away from the building, at an elevation that no longer matched any storey; the plan view's grid section-clip compared that unshifted elevation against a re-based cut band, so the visible grid belonged to the wrong storey or to none.
  
  The offset now travels as one `RenderFrameRebase` with private components and two named conversions (`plan`, `elevation`) instead of two loose floats threaded through six modules, so no call site can reach for the wrong axis. The viewer half matches: the storey-table elevation that `buildParseResult` falls back to when a placement carries no Z is re-based to the same frame as the extractor's `worldY`, since both feed one set of buckets lifted into one scene.

- [#2996](https://github.com/LTplus-AG/ifc-lite/pull/2996) [`4797203`](https://github.com/LTplus-AG/ifc-lite/commit/47972034855eca7d2af6ca3cfc358e6c54c59aa9) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `loadFromServer`'s streaming path writing a superseded load's geometry into the model the user just opened.
  
  `useIfcCache.ts`'s `isStale` doc claims the same re-check contract as `loadFromServer`'s, but the streaming batch callback passed to `client.parseParquetStream` (and the post-stream/post-parse writes on all three server paths) never re-checked `isStale` after their awaits. A user opening file B while file A was still streaming from the server kept getting A's later batches painted into B's slot, including the trailing progress line reaching `Complete` for a load nobody owned any more. `loadFromServer` now re-checks `isStale` inside the batch callback and after each of the streaming/Parquet/JSON awaits, matching `loadFromCache`'s per-chunk guard, and returns `false` for a superseded load instead of reporting success.
  
  Also closes one more post-await window in the same function: a re-check right after `await client.isParquetSupported()` resolves, so a load already superseded during that capability check no longer goes on to issue the (now-pointless) parse request at all.

- [#3011](https://github.com/LTplus-AG/ifc-lite/pull/3011) [`13f0669`](https://github.com/LTplus-AG/ifc-lite/commit/13f06695d35dc20134e75150f7b1b91d2160f502) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix leaving a collaboration room mid-join silently putting the user back in it once the join finished.
  
  `startCollab` re-checks `get().collabRoomId === roomId` after each of its own await points, from session creation through model reconstruction, so a `stopCollab()` landing in any of those windows is caught and the half-built session disposed. The final block — wiring the remote-apply and annotation-sync teardowns, then the closing `set({ collabSession: session, collabConnecting: false, ... })` — had no such check and ran unconditionally. `collabRoomId` is set synchronously at the top of `startCollab`, before any await, so `RoomPanel`'s "Leave" button is live while the join is still awaiting `session.whenSynced`: clicking it cleared `collabRoomId`/`collabSession`, and the suspended continuation then resumed and revived the session the user had just left, with remote-apply and annotation-inbound teardown closures installed that the next `stopCollab()` would not match to the session it disposes.
  
  `startCollab` now applies the same `collabRoomId` guard before that final block, disposing the session and returning instead.

- [#3074](https://github.com/LTplus-AG/ifc-lite/pull/3074) [`d3bd99a`](https://github.com/LTplus-AG/ifc-lite/commit/d3bd99ac3fae1c6c003141d00b5d269f4904f1f1) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Report openings a wall split could not reassign on the typed-distance path too, not only the click path.
  
  A wall split commits from two places, and both call the same `MutationSlice.splitWallAtDistance`, so both receive the same `openings.skipped` count — openings that stay attached to the source wall the split has just tombstoned rather than moving to either half, and can therefore end up orphaned. [#3023](https://github.com/LTplus-AG/ifc-lite/issues/3023) taught only the canvas click handler (`selectionHandlers.ts`) to surface that count. The Split tool's numeric-distance panel (`tools/SplitNumericInput.tsx`) kept its own inlined copy of the "(N openings reassigned)" wording, read only `toLeft`/`toRight`, and never looked at `skipped` at all — so committing the identical split by typing a distance instead of clicking silently dropped the warning that clicking showed.
  
  Both notices now come from a single emitter, `notifyWallSplit` in the new `wallSplitNotice.ts`, which both call sites invoke instead of composing toasts themselves. An emitter rather than a shared formatter is the point: a formatter is still something a call site can neglect to call, which is exactly how these two paths came apart. The module imports nothing but the toast surface, so announcing a split does not drag `selectionHandlers.ts`'s store, geometry and measurement imports into the panel. Both paths are now pinned by tests asserting the full toast strings, in both directions — the warning when `skipped > 0`, and silence when it is 0.
- Updated dependencies [[`93b450c`](https://github.com/LTplus-AG/ifc-lite/commit/93b450c1cc0c3cee811625989edb82cf522c70c4), [`ddf9f1d`](https://github.com/LTplus-AG/ifc-lite/commit/ddf9f1da830cef5f941ea09e8aee19624e9def3a), [`f7e26e4`](https://github.com/LTplus-AG/ifc-lite/commit/f7e26e4200e1475728d4976142b49cb408400a8e), [`e19aa0e`](https://github.com/LTplus-AG/ifc-lite/commit/e19aa0ef271eccc7f2f6862b8580e9f98dbd1a66), [`66697fc`](https://github.com/LTplus-AG/ifc-lite/commit/66697fc57de1de4475a2c5eed4361e0e378e0f7a), [`447f02e`](https://github.com/LTplus-AG/ifc-lite/commit/447f02eefc2933c63c03aea6c7793343df20fcd7), [`0ea7167`](https://github.com/LTplus-AG/ifc-lite/commit/0ea7167a6bd96d5b5e12e7e5a8c5615ab0b7c3b2), [`228bbe7`](https://github.com/LTplus-AG/ifc-lite/commit/228bbe730522148ea797780c5acd08502b18a3a3), [`3bef19b`](https://github.com/LTplus-AG/ifc-lite/commit/3bef19b13d303029b87e862660e3730c06852687), [`e6caf11`](https://github.com/LTplus-AG/ifc-lite/commit/e6caf11a8f8d9d8634a6811b6705ab3367cd02e0), [`2580830`](https://github.com/LTplus-AG/ifc-lite/commit/25808308bbbc63eb0fd8b25e6dd0c08864adb6a8), [`b25b2e7`](https://github.com/LTplus-AG/ifc-lite/commit/b25b2e7387bd365fda02d48095266f16b4f05cd7), [`7ff31ba`](https://github.com/LTplus-AG/ifc-lite/commit/7ff31ba854671a9ca3ebbf30b15e928e1b52a8b9), [`8ba612f`](https://github.com/LTplus-AG/ifc-lite/commit/8ba612f90d3bb0ad41f756d6fdef6b3250e8d330), [`9359bc4`](https://github.com/LTplus-AG/ifc-lite/commit/9359bc488173585b2b90e124cc66dcf8292c4be9), [`8571d70`](https://github.com/LTplus-AG/ifc-lite/commit/8571d70270d072170fc4e204e8b0d11a424d2330), [`65d19dd`](https://github.com/LTplus-AG/ifc-lite/commit/65d19ddd305b00dd6cdd8a815e3e9749dee5949b), [`b1d7a4d`](https://github.com/LTplus-AG/ifc-lite/commit/b1d7a4d832557e6961aef82102f423b07742c385), [`f64ecdc`](https://github.com/LTplus-AG/ifc-lite/commit/f64ecdc2129074d2d3def676d6ddd69dffdd785e), [`f6febcc`](https://github.com/LTplus-AG/ifc-lite/commit/f6febcc2d4986e79b3c44d63853bb72a16475c65), [`5781e5c`](https://github.com/LTplus-AG/ifc-lite/commit/5781e5c2998111926683419d27f8efa3519de7c6), [`bc2e5e5`](https://github.com/LTplus-AG/ifc-lite/commit/bc2e5e56d7324f605b15b6e6f939849859a5d0ad), [`1118399`](https://github.com/LTplus-AG/ifc-lite/commit/11183991d9fb042221d20f1ca432dc0b2293c928), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`063a140`](https://github.com/LTplus-AG/ifc-lite/commit/063a1408e4c54ebc874618f8d68fe298ed3f3a6f), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`f7e26e4`](https://github.com/LTplus-AG/ifc-lite/commit/f7e26e4200e1475728d4976142b49cb408400a8e), [`f76c805`](https://github.com/LTplus-AG/ifc-lite/commit/f76c80511dce5ffc1756365b786042c4bc64808d), [`75867a7`](https://github.com/LTplus-AG/ifc-lite/commit/75867a7e6ebf51b2da47cab14242bcd71787ba3b), [`75867a7`](https://github.com/LTplus-AG/ifc-lite/commit/75867a7e6ebf51b2da47cab14242bcd71787ba3b), [`4a8fe77`](https://github.com/LTplus-AG/ifc-lite/commit/4a8fe77707127d251702610490f53430610e4ef7), [`f135c02`](https://github.com/LTplus-AG/ifc-lite/commit/f135c02624b8a7aa1915068405545d108f55fce4), [`ffcc9e6`](https://github.com/LTplus-AG/ifc-lite/commit/ffcc9e6f048cd263a5b70946417c9b6aceec1bec), [`4a8fe77`](https://github.com/LTplus-AG/ifc-lite/commit/4a8fe77707127d251702610490f53430610e4ef7), [`f7e26e4`](https://github.com/LTplus-AG/ifc-lite/commit/f7e26e4200e1475728d4976142b49cb408400a8e), [`0146f0a`](https://github.com/LTplus-AG/ifc-lite/commit/0146f0a3b2ed36313f7f91236bcc95587cdcc8d3), [`f449776`](https://github.com/LTplus-AG/ifc-lite/commit/f4497765cb4e17828ff6ca6b52fb8a96caa2f81f), [`40cd43c`](https://github.com/LTplus-AG/ifc-lite/commit/40cd43ce29cce6c71671e07abde00b41c8886e37), [`56ad58c`](https://github.com/LTplus-AG/ifc-lite/commit/56ad58cc8d1d8d54fdb996606f667c0c170d74aa), [`8b9bc5a`](https://github.com/LTplus-AG/ifc-lite/commit/8b9bc5a0b2d6541f6a0ec45c10e41b005059e06b), [`dec0708`](https://github.com/LTplus-AG/ifc-lite/commit/dec0708ef841c88abea6ec91404419fd7a3d93c6), [`dec0708`](https://github.com/LTplus-AG/ifc-lite/commit/dec0708ef841c88abea6ec91404419fd7a3d93c6), [`dec0708`](https://github.com/LTplus-AG/ifc-lite/commit/dec0708ef841c88abea6ec91404419fd7a3d93c6), [`5ea5f99`](https://github.com/LTplus-AG/ifc-lite/commit/5ea5f9969f3a4a3f8b21eb2a90a1df2be48eb7b0), [`66f3969`](https://github.com/LTplus-AG/ifc-lite/commit/66f39693ce006a43efb2c156e4f5f8f95f1d1606), [`66f3969`](https://github.com/LTplus-AG/ifc-lite/commit/66f39693ce006a43efb2c156e4f5f8f95f1d1606), [`412f78c`](https://github.com/LTplus-AG/ifc-lite/commit/412f78c1bf4907f8c230fc149bbb00e0711b6689), [`487866d`](https://github.com/LTplus-AG/ifc-lite/commit/487866dac131bf50a0b3008ddce5db933768dca2), [`932f043`](https://github.com/LTplus-AG/ifc-lite/commit/932f0439fc1625419aae3cf2d9f81a614fb2273c), [`f1ee3e8`](https://github.com/LTplus-AG/ifc-lite/commit/f1ee3e88889281af34f0e382cef7ea57ee9d47c1), [`754837b`](https://github.com/LTplus-AG/ifc-lite/commit/754837b066172dad8afcdf1a0104f1a021b5f6e5), [`2273a73`](https://github.com/LTplus-AG/ifc-lite/commit/2273a73127d03ec36d667544da6237479737881a), [`20264d8`](https://github.com/LTplus-AG/ifc-lite/commit/20264d8b1ee82169a02f9dc588decc45fb8fdc00), [`5ea5f99`](https://github.com/LTplus-AG/ifc-lite/commit/5ea5f9969f3a4a3f8b21eb2a90a1df2be48eb7b0), [`131e3dc`](https://github.com/LTplus-AG/ifc-lite/commit/131e3dc84244d9dd24859a5923ef0aef4d6119c4), [`a8587cc`](https://github.com/LTplus-AG/ifc-lite/commit/a8587cc21c309ebd6c87119cb0d1cd6d1005c281), [`b1f4335`](https://github.com/LTplus-AG/ifc-lite/commit/b1f4335f3bf3c379f4a2afa4f96e5fe1fc3bc97d), [`945c4d7`](https://github.com/LTplus-AG/ifc-lite/commit/945c4d7a773614dd664feb9490e13372782a543b), [`fdd6121`](https://github.com/LTplus-AG/ifc-lite/commit/fdd61211e41d3e563a7604ac5e0630a9daae2de1), [`50d9f91`](https://github.com/LTplus-AG/ifc-lite/commit/50d9f91af0b49c2b503e5cf8abd0aa83adfd8c34), [`6e51909`](https://github.com/LTplus-AG/ifc-lite/commit/6e519094bb69dff4c550c383bbc89b889a5fcafa), [`409520e`](https://github.com/LTplus-AG/ifc-lite/commit/409520ee2e940866b126c3433cc10d0fe110d645), [`6095fe0`](https://github.com/LTplus-AG/ifc-lite/commit/6095fe0c19072e9a97edefb2be95dde66f514f6b), [`b59c520`](https://github.com/LTplus-AG/ifc-lite/commit/b59c5206a154728139d1307bf823e5c5d7c4786a), [`be74930`](https://github.com/LTplus-AG/ifc-lite/commit/be74930b383a189ac61c5f8ef5bc8b5f4579dda3), [`be74930`](https://github.com/LTplus-AG/ifc-lite/commit/be74930b383a189ac61c5f8ef5bc8b5f4579dda3), [`870ec9e`](https://github.com/LTplus-AG/ifc-lite/commit/870ec9ee9a35f798196c59ce82e65e210eddd429), [`00f6e79`](https://github.com/LTplus-AG/ifc-lite/commit/00f6e79c22641ff59bfb3327d910b04f9a164d8b), [`116a3e9`](https://github.com/LTplus-AG/ifc-lite/commit/116a3e94de753b95fa94b2d6c41a0171cd254729), [`75867a7`](https://github.com/LTplus-AG/ifc-lite/commit/75867a7e6ebf51b2da47cab14242bcd71787ba3b), [`1823d70`](https://github.com/LTplus-AG/ifc-lite/commit/1823d70a581429fb6a7df2272b31d426e0cf2149), [`c7c8207`](https://github.com/LTplus-AG/ifc-lite/commit/c7c820772ccdf99ecf45032b714b80249fbbc767), [`78d85dc`](https://github.com/LTplus-AG/ifc-lite/commit/78d85dcd4c59ee5b3b3b7857a454113c4911bc36), [`147693a`](https://github.com/LTplus-AG/ifc-lite/commit/147693a7a8fd0778ddb71839199b75bf1d622327), [`bea50bd`](https://github.com/LTplus-AG/ifc-lite/commit/bea50bd7bca7fdf69f01076ebb96a31b8e797a46), [`af48854`](https://github.com/LTplus-AG/ifc-lite/commit/af488542a19a8559065cfd450d0eaad5ba2f7489), [`3969c52`](https://github.com/LTplus-AG/ifc-lite/commit/3969c523063d02e501f421e6b42d1a9a516dc2e4), [`bb734da`](https://github.com/LTplus-AG/ifc-lite/commit/bb734da27afbea4b6e595714950cdb195cddeb1f), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`00f6e79`](https://github.com/LTplus-AG/ifc-lite/commit/00f6e79c22641ff59bfb3327d910b04f9a164d8b), [`e43582b`](https://github.com/LTplus-AG/ifc-lite/commit/e43582b069007c6c2c932f6981743a80630fe217), [`043e06a`](https://github.com/LTplus-AG/ifc-lite/commit/043e06a05c6625fef91bb17d84e3a3447f1379e3)]:
  - @ifc-lite/bcf@2.0.0
  - @ifc-lite/parser@4.3.0
  - @ifc-lite/mcp@0.12.0
  - @ifc-lite/collab@0.6.0
  - @ifc-lite/extensions@0.5.0
  - @ifc-lite/wasm@6.0.0
  - @ifc-lite/cache@3.0.6
  - @ifc-lite/ifcx@3.0.0
  - @ifc-lite/merge@0.4.4
  - @ifc-lite/export@3.0.0
  - @ifc-lite/sdk@3.0.0
  - @ifc-lite/encoding@2.1.0
  - @ifc-lite/lists@2.0.0
  - @ifc-lite/data@3.4.1
  - @ifc-lite/drawing-2d@3.0.0
  - @ifc-lite/renderer@1.50.0
  - @ifc-lite/geometry@4.0.0
  - @ifc-lite/query@2.0.0
  - @ifc-lite/ids@1.15.49
  - @ifc-lite/lens@1.19.0
  - @ifc-lite/clash@1.9.1
  - @ifc-lite/source-msgraph@0.2.1
  - @ifc-lite/mutations@1.27.0
  - @ifc-lite/pointcloud@0.7.1
  - @ifc-lite/sandbox@2.2.1
  - @ifc-lite/create@2.2.0
  - @ifc-lite/server-client@1.23.0
  - @ifc-lite/spatial@1.14.15

## 1.37.0

### Minor Changes

- [#2698](https://github.com/LTplus-AG/ifc-lite/pull/2698) [`c3a4690`](https://github.com/LTplus-AG/ifc-lite/commit/c3a46909e391e1aaf774ec183aec50a76452936a) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Add a custom **XYZ/TMS** basemap to the 3D world context (issue [#2685](https://github.com/LTplus-AG/ifc-lite/issues/2685)). The Base map selector in Sun & Sky gains a "Custom (XYZ)" source: paste a tile URL template like `https://example.org/tiles/{z}/{x}/{y}.png`, give it the attribution its licence requires, and the globe drapes those tiles the same way it drapes the built-in OSM map. Only XYZ is implemented — WMTS needs a `WMTSCapabilities.xml` parse plus a layer and tileMatrixSetID choice, and WMS is not tiled at all; the stored value is a union tagged on `protocol` so either can be added as a new member rather than a migration of what users have already saved, and a stored protocol this build does not implement is rejected on read instead of half-honoured.
  
  **CORS is surfaced, not swallowed.** A tile server without `Access-Control-Allow-Origin` cannot be read from a browser at all, and the symptom is an empty globe rather than an error. Saving therefore fetches one zero tile in `mode: 'cors'`: the discrimination is not the status code but whether a response reaches JavaScript at all, since a cross-origin response that does has already passed the CORS check — so a 404 from a server whose pyramid starts deeper still counts as accessible (and says so), while only a rejected fetch reports "this server does not allow browser access". A 401 or 403 is called what it is instead — an authorisation failure that will refuse every zoom level, most often a missing or expired API key — rather than being folded into the reassuring "normal for a deeper-starting pyramid" wording. The save is not gated on the probe, because the same rejection is what an offline browser produces. At runtime the layer's `errorEvent` carries Cesium's `RequestErrorEvent`, whose absent `statusCode` marks the same refusal, and the viewport shows that message rather than leaving the user with a blank backdrop — and takes it back down again as soon as a tile request resolves, so one ad-blocker rule or DNS blip cannot leave the banner stranded over a basemap that is drawing.
  
  **Attribution is required, not optional.** An XYZ template carries no capabilities document, so there is nowhere but the user's own input for the credit to come from, and most public imagery is licensed on condition of visible credit — making the field optional would make unattributed use the default path. The credit is escaped text and the optional licence link becomes an anchor built here around an already-validated http(s) URL, so the field is never a markup channel.
  
  **The basemap is stored per browser**, in `localStorage` beside the existing ion token and data-source choice, and does not travel with a project: a tile URL is a property of the person viewing rather than of the building, it routinely embeds a personal API key that a shared project would hand to everyone it reaches, and the project artifact here is an IFC file with no viewer-preference channel. Clearing the basemap also leaves the custom source, and a stored `custom` selection whose basemap is missing or no longer valid falls back rather than opening on an empty globe.
  
  Templates are validated before they can be saved: http(s) only, `{z}`/`{x}`/`{y}` (or their reverse forms) all present, no unsupported placeholder passed to Cesium verbatim, no credentials embedded in the URL, and a whole-number maximum zoom. `{s}` is rejected with the reason, because this editor collects no `subdomains` list: accepting it would let a server sharding over `1,2,3,4` save cleanly and then 404 every tile from Cesium's `a`/`b`/`c` default — a silent blank globe, which is the exact failure the placeholder allowlist exists to prevent.
  
  The banner is also **bound to the effect that raised it**. Cesium frees a tile's texture on teardown but never cancels the in-flight request, and destroying the viewer does not detach the layer's error listener — so a provider belonging to an already-destroyed viewer could still write to the component. Both async callbacks now check the same cancellation flag their siblings already used, and the error listener is unsubscribed with the effect rather than living as long as the provider. The retraction path is the one that mattered most: switching away from a slow basemap to one that genuinely is refused could otherwise let a late tile from the discarded provider clear the new basemap's warning, leaving a blank globe with nothing on screen.
  
  The save probe is **bounded**. A host that accepts the connection and never answers does not reject the fetch, so Save would spin with no verdict; the probe now gives up after ten seconds and says the server did not respond — which is deliberately not the "does not allow browser access" wording, since a slow host may serve tiles perfectly once the globe is up.
  
  Clearing the basemap now goes through the same action any other base-map change goes through, so it clears the terrain elevation cache and resets the terrain state that was sampled under the removed basemap, instead of repeating a shorter version of that teardown. And the loading, error and basemap-warning banners stack instead of sharing one position — a slow or refused tile host is exactly the case where the warning and the loading indicator are both on screen.
  
  A template using `{reverseZ}` now **requires a maximum zoom**. Cesium only inverts the level when `maximumLevel` is defined (`defined(maximumLevel) && level < maximumLevel ? maximumLevel - level - 1 : level`); without it `{reverseZ}` silently resolves to the ordinary `{z}` numbering — no error, no blank globe, just the wrong tile at every level for a genuinely reverse-Z service. Unlike the CORS case, that failure has no visible signal, so it is rejected at input time instead.
  
  The stored entry is **type-checked on read**, not just re-validated. `localStorage` is hand-editable and shared with every tab on the origin, and the decoded basemap feeds the store's initial state on every boot — so a `"url": 123` would once have thrown a `TypeError` out of store creation and left a white screen with no way to reach the Remove button. Every field is now checked for its type before validation runs, and the decoder returns `null` for anything it dislikes rather than propagating. The input surface states plainly that tiles are fetched straight from that server, so it sees where the user pans — a custom basemap is a deliberate choice to send a viewport to a third party, and it should read as one.

### Patch Changes

- [#2849](https://github.com/LTplus-AG/ifc-lite/pull/2849) [`aa61c88`](https://github.com/LTplus-AG/ifc-lite/commit/aa61c889fb64c9a151ea4cffbb88732f653d332a) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix the Add Element panel's Auto Spaces preview staying on screen after switching the target storey or federated model.
  
  `AddElementAutoSpacePreview` is a dry-run wall-graph detection keyed to the storey it ran against (`storeyExpressId`), but nothing re-ran or cleared it when the target storey or model changed via the panel's selects — `AddElementOverlay` kept drawing the stale outlines at the old storey's elevation, and the panel kept reporting region/wall counts for a storey the user had since navigated away from. `setAddElementStoreyId` and `setAddElementModelId` now clear `addElementAutoSpacePreview` alongside the id, so a stale preview never outlives the selection it was computed for.

- [#2780](https://github.com/LTplus-AG/ifc-lite/pull/2780) [`544dc41`](https://github.com/LTplus-AG/ifc-lite/commit/544dc417e47094eeec8041aa6f7638fa42c6e739) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix a peer's deletion of one of your own annotation pins resurrecting on reload.
  
  `removeRemoteAnnotation` — the path a collab room's incoming delete event drives — dropped the id from the in-memory map but never touched `localStorage`. If the pin was locally-authored (persisted on creation), its id stayed in the stored JSON; `loadFromStorage()` reads that JSON on the next mount and put the "deleted" pin right back.
  
  Its two siblings already got this right: `removeAnnotation` (a local delete) and `upsertRemoteAnnotation` (a peer's edit of one of our pins arrives as non-remote and is persisted like any local edit) both call `saveToStorage`. `removeRemoteAnnotation` now mirrors `upsertRemoteAnnotation`'s condition — it persists the deletion when the pin being removed was not marked `remote` (i.e. it was ours and therefore already in storage), and skips the write for a purely-remote pin, which was never persisted in the first place.

- [#2833](https://github.com/LTplus-AG/ifc-lite/pull/2833) [`6e2fe58`](https://github.com/LTplus-AG/ifc-lite/commit/6e2fe588caa6f4ad24602c4b17c726cd8382b525) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `upsertRemoteAnnotation` leaving a stale pin behind in `localStorage` when a previously-local pin's id later arrives flagged `remote`.
  
  `upsertRemoteAnnotation` only wrote to storage `if (!annotation.remote)`, on the assumption that a `remote`-flagged upsert never needs a write. That held for a fresh peer pin (never persisted, nothing to clean up) but not for an id that was persisted earlier while non-remote: skipping the write left the old local version sitting in storage, ready to resurrect on the next `loadFromStorage()` even though the in-memory map had already moved on. `saveToStorage` already filters its own output to non-remote entries, so the guard was redundant for the write-a-local-pin case and unsafe for the ownership-flip case — both `upsertRemoteAnnotation` and `removeRemoteAnnotation` now always call `saveToStorage`, letting it be the single source of truth for what belongs in storage.

- [#2775](https://github.com/LTplus-AG/ifc-lite/pull/2775) [`5159383`](https://github.com/LTplus-AG/ifc-lite/commit/5159383eb060d0293a18ed20d47fa23256dee6d5) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix a stray blank line in the exported BCF description for compare rows with a synthetic key.
  
  `bcfTextFromChange` builds its description as an array of lines, dropping the
  GlobalId line for synthetic `missing:` keys by pushing `''` in its place, then
  filtering with `lines.filter((l, i) => l !== '' || i > 0)`. That filter is a
  no-op: `lines[0]` is always the `"Detected in model comparison: …"` line and is
  never blank, so `i > 0` is true for every other index and nothing was ever
  removed. A `missing:` row therefore kept an empty line where the GlobalId line
  should have been omitted.
  
  The direct fix (`lines.filter(l => l !== '')`) would have broken a second,
  unrelated use of `''`: the function also pushes an intentional blank separator
  before the `"Data changes:"` block, and dropping every `''` removes that
  separator too. `''` was overloaded between "omit this line" and "this line is
  a deliberate blank" - two meanings needed two values.
  
  `lines` is now typed `(string | null)[]`; a synthetic-key row pushes `null`
  (omitted) instead of `''`, and the filter drops only `null`, leaving the real
  `''` separator before "Data changes:" untouched.
  
  Cosmetic only - an extra blank line in an exported BCF topic description for
  rows with no GlobalId (deleted or added-without-GlobalId compare rows).

- [#2704](https://github.com/LTplus-AG/ifc-lite/pull/2704) [`6a43522`](https://github.com/LTplus-AG/ifc-lite/commit/6a43522cdf3b0a9b0f7ce303b59f479dca2a2aca) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix clash element identity for federated models past the first.
  
  The viewer's loader shifts every `mesh.expressId` into the federated global id
  space in place, while `IfcDataStore` keeps local express ids. `elementsFromStep`
  used `mesh.expressId` to address the store anyway, so for any model with a
  non-zero `idOffset` every lookup missed: `key` fell back to the synthetic
  `expressid:N`, `tag` read `Unknown`, name and storey came back empty, and
  `buildStepExclusions` found no relationships — so the void / host / assembly
  exclusions silently stopped excluding, and a door in the opening it fills was
  reported as a hard clash. `ref` was wrong in the other direction, with
  `federation.toGlobalId` adding the offset a second time.
  
  `elementsFromStep` now takes `meshIdOffset`: the shift the host has already
  applied to `mesh.expressId`. It subtracts that back out before touching the
  store, so the store is addressed locally and the federation offset is applied
  exactly once. Callers that pass local meshes (CLI, MCP, the playground) leave it
  at its `0` default and are unaffected — it stays optional deliberately, since
  `elementsFromStep` is published API and requiring it would break every external
  caller. To keep a forgotten offset from being silent in any host, the adapter
  now also warns once when every element in a model resolves to an empty GlobalId
  *and the store does hold GlobalIds* — the signature of exactly this wiring
  mistake. A model whose store has none (a GLB import, whose store carries
  geometry and no IFC entities) is left alone: there, every element missing is the
  normal state, not a defect.
  
  The synthetic key an element without a GlobalId falls back to is now scoped to
  its model — `expressid:<encoded modelId>:<expressId>` rather than
  `expressid:<expressId>`. Express ids are only unique within a model, and review
  state and user element-pair exclusions are keyed on the element key alone
  (deliberately, so they survive a reload), so in a federation the unqualified
  form made two models' elements one identity: a review status or an exclusion set
  on one model's element silently covered another model's element. Two federated
  GLB models produced ONE review key where there should have been two.
  
  Migration: elements that have a GlobalId — nearly all of them, and every one
  this fix restores — are unaffected; only the fallback changes shape. A review
  status or an element-pair exclusion a previous session stored against the old
  `expressid:N` string stops matching: the clash comes back as `open`, the
  exclusion rule stays listed but suppresses nothing. Nothing is mis-applied, and
  nothing else reads the string. In the viewer that fallback is per-load anyway
  (the model id is a per-load uuid), which is the honest position for an element
  that carries no durable identity of its own. Review status a pre-fix session
  saved against a federated model past the first was likewise keyed on the old
  fallback and no longer matches.

- [#2878](https://github.com/LTplus-AG/ifc-lite/pull/2878) [`b699875`](https://github.com/LTplus-AG/ifc-lite/commit/b6998754039676def950735335147556afcb2977) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix clash detection silently skipping every GPU-instanced entity.
  
  `useClash` built its clash elements from `model.geometryResult.meshes` alone, which excludes every entity whose geometry was fully GPU-instanced — anything repeated 8 or more times (`INSTANCE_MIN_OCCURRENCES` in the wasm mesher). Doors, windows, columns, sprinklers, light fittings, and other repeated components vanished from clash detection with no error, no warning, and no count discrepancy: the report simply came back short.
  
  `gatherElements` now restores those entities with `withInstancedMeshes` — the same helper the glTF/IFC5 export path already uses ([#2558](https://github.com/LTplus-AG/ifc-lite/issues/2558)/[#2576](https://github.com/LTplus-AG/ifc-lite/issues/2576)) to reach instanced-only geometry through `Scene.getAllInstancedMeshData()`. This surfaces real triangles from the live renderer scene, not an AABB approximation, so a clash reported off an instanced entity is exactly as exact as one reported off a flat mesh.
  
  This also covers federated models. `withInstancedMeshes` used to gate on `isPrimary` and no-op for every non-primary model — correct when it was written, but GPU instancing stopped being primary-only once federated models got instanced shards too ([#2255](https://github.com/LTplus-AG/ifc-lite/issues/2255)), and the gate was never updated, so a federated model's own instanced entities were silently skipped for both clash and every glTF/IFC5/KMZ export call site. The helper now takes this model's `{ idOffset, maxExpressId }` id-range bracket instead of a boolean, scoping `getAllInstancedMeshData()`'s all-models output down to just this model's occurrences — restoring a federated model's own instanced entities without a federation of N models double-counting each other's.
  
  `elementsFromStep` (`@ifc-lite/clash`) now also keys an element's identity on `MeshData.occurrenceKey` when present, so distinct physical occurrences of one GPU-instanced expressId no longer collapse onto a single review/exclusion key, and a relationship-derived exclusion (void/host, assembly) fans out to every occurrence sharing that expressId instead of only the last one built.
  
  That per-occurrence `key` is one `ClashElement` per `MeshData`, so an entity with a mix of a flat submesh and an instanced occurrence (an ordinary shape once routing goes per-mesh, `rust/wasm-bindings/src/api/gpu_meshes/batch.rs:820-856`) now mints two elements with the SAME `ref` but DIFFERENT `key`s. The broad-phase self-clash guard only checked `key`, so that pair passed through as a false-positive self-clash — the entity clashing with itself. `candidatePairs`' guard (`@ifc-lite/clash`, `engine-ts/broad.ts`) now also treats a shared `ref` within the same model as the same entity.

- [#2878](https://github.com/LTplus-AG/ifc-lite/pull/2878) [`b699875`](https://github.com/LTplus-AG/ifc-lite/commit/b6998754039676def950735335147556afcb2977) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix the Location panel's KMZ export leaking every other loaded model's GPU-instanced geometry into a single model's export.
  
  `GeoreferencingPanel` computed the `InstancedModelRange` it hands to `LocationMap`'s KMZ export by looking up its own `modelId` in the loaded-models map, falling back to `null` (no per-model filter) whenever that lookup failed — including while more than one model was loaded (no entity selected in a federation, or a stale id after a model was removed). `withInstancedMeshes(geometryResult, null)` treats `null` as "already spans every loaded model", so an unresolved `modelId` in a federation spliced every OTHER loaded model's instanced occurrences into this model's export.
  
  `resolveInstancedExportGate` (new, in `@ifc-lite/viewer`'s `utils/instancedExport.ts`) makes `null` correct only when it's provably the sole loaded model, and otherwise withholds the export (`canExport: false`) rather than falling through to the leaky unfiltered case — mirroring the rule `KmzExportDialog` already followed for its own model list.

- [#2697](https://github.com/LTplus-AG/ifc-lite/pull/2697) [`e0679f7`](https://github.com/LTplus-AG/ifc-lite/commit/e0679f7de9d5c2f8495372dbbee1100482a47720) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix clash rows being inert in a collaborative session, without letting a stale row target the wrong element.
  
  `useClash` resolved a clash ref back to its model through the `federationRegistry` singleton, which only knows models registered via `registerModelOffset`. The collab recipient's model is put into the store by `collabSlice` with `upsertModel({ id: 'room:<id>', ..., idOffset: 0 })` and never registered, so every ref resolved to `null` and `focusClash` / `selectElement` / `highlightAll` returned before doing anything — clicking a clash row in a room did nothing, while clicking the same element in the 3D view selected it normally.
  
  A `ClashElementRef` already carries the model id it was gathered from, so the ref is now resolved against that named model instead of by searching offset ranges two models can both claim. The lookup is delegated to `resolveGlobalIdInModel`, which shares its range and overlay predicates with the store's canonical `resolveGlobalIdFromModels` rather than repeating them — so overlay-allocated ids (StoreEditor duplicates, scripted adds) resolve here through the same rules a 3D click uses, instead of being rejected by a range check that does not know about them. A loaded model now answers for its own ids or not at all: the registry is consulted only when the named model is not loaded, so a ref that does not fit its own model goes inert rather than being resolved against some other model that happens to cover the number.
  
  Naming the model is not sufficient on its own, because the id space behind a model id can be replaced while the id stays. A collab peer edit re-derives the model from the CRDT and calls `setIfcDataStore`, swapping the entity table under the same key while `idOffset` and `maxExpressId` stay put, and express ids are a sequential counter that any structural edit renumbers. A stale ref would then still resolve — to a different element than the row names. The federation identity a run records is now bound to the published result, and a ref into a model whose id space has been replaced is refused, with the reason shown in the panel, instead of resolving to something else. The check is per model, so unloading one file does not disable rows that live entirely in another.
  
  The same check covers a model that has been UNLOADED rather than replaced. The room model is never registered with the federation singleton, so removing it — which is what leaving a room does, while keeping the published result — left its rows pointing at numbers a normally loaded file's registered range still covered: clicking one isolated and coloured two elements of that other file, with no error. A row naming a model the result was computed on and that is no longer loaded is now refused, and says so.
  
  Every refusal now explains itself, in its own words: id space replaced (re-run detection), model no longer loaded (load it again), or an id its own loaded model no longer has. Previously the last of the three refused silently, which reads as a broken click.

- [#2717](https://github.com/LTplus-AG/ifc-lite/pull/2717) [`7607340`](https://github.com/LTplus-AG/ifc-lite/commit/7607340f02f697e4dd9dbf932857f6659519fa08) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Add the missing `'malformed-operand'` member to `ClashSolidDegenerateReason`.
  
  The wasm binding `clashIntersectionSolid` returns five degenerate reason
  strings, but the viewer's union declared only four. `'malformed-operand'` — the
  binding's own verdict when an operand has a positions/indices length that is not
  a multiple of 3, an index past its own operand's vertex count, or a non-finite
  coordinate — was absent. The union's doc comment said it mirrored
  `DegenerateReason` in `clash_solid.rs`, and it did: that reason is produced by
  the binding's `mesh_from` guard and has no enum variant behind it, so mirroring
  the enum missed it. Because the reason crosses the wasm boundary as an untyped
  string and is cast on arrival, TypeScript could not catch the gap.
  
  No UI copy changes: the clash panel's reason chain already ends in a generic
  "No solid could be computed for this pair" fallback, which is accurate for a
  rejected operand, and every consumer of the union either handles the reason
  positionally or falls through to that string. The defect was that the type
  claimed a value the runtime can produce is impossible, so any future
  exhaustiveness check over it would have been built on a set that is short by one.
  
  A new test confirms through the real wasm kernel that a malformed operand does
  come back as `'malformed-operand'`. Declaration parity — that the union lists
  exactly the reasons `clash_solid.rs` can emit, in both directions — can only be
  claimed by reading both sources, which is a source-text assertion and banned in
  test files, so it is a CI lint instead:
  `scripts/check-clash-degenerate-reason-parity.mjs`. It refuses to pass on two
  empty sets, and its own regression harness
  (`scripts/check-clash-degenerate-reason-parity.test.mjs`) turns each drift and
  each vacuity mode red against mutated copies of the real sources.

- [#2854](https://github.com/LTplus-AG/ifc-lite/pull/2854) [`f191023`](https://github.com/LTplus-AG/ifc-lite/commit/f191023e063f27c892cdbb02acc9201f7a2b583e) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `clearAllModels` leaving an active model-comparison result and lens still pointed at a federation that no longer exists, and fix `removeModel` leaving a comparison result stale when the removed model was either side of it.
  
  `federationRegistry.clear()` (called by `clearAllModels`) resets the offset counter to 0, so the next model registered can be handed the exact global-id offsets a surviving `compareResult` or lens state describes. `GeoreferencingPanel.tsx`'s `reloadModelsForAlignment` calls `clearAllModels()` directly, without `resetViewerState()` — the only other place either was cleared — then reloads every model. If a comparison or a lens was active, its `excludedHiddenIds`/`diff` or `lensHiddenIds`/`lensColorMap`/`lensAppliedColors` could then silently hide or tint elements of the freshly reloaded, unrelated model. `useLens.ts`'s effect deps (`[activeLensId, activeLens]`) also never re-run on a model add/remove on their own, so a lens stays stale across any such reload regardless.
  
  `clearAllModels` now clears `compareResult` and deactivates the lens (mirroring what `resetViewerState` already does on an ordinary file load). `removeModel` now clears `compareResult` when the removed model was the comparison's base or head — offsets are never reused on a partial removal, so this is precautionary consistency, not a misresolution fix — and leaves it alone otherwise, so removing an unrelated federated sibling does not disturb a comparison between two other still-loaded models.

- [#2858](https://github.com/LTplus-AG/ifc-lite/pull/2858) [`e805e8c`](https://github.com/LTplus-AG/ifc-lite/commit/e805e8cfa0ee9227b5641dfd9731577fdca20f48) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `clearAllModels` leaving a registered 4D-animation overlay layer (`overlaySlice.overlayLayers`) pointed at a federation that no longer exists.
  
  `federationRegistry.clear()` (called by `clearAllModels`) resets the offset counter to 0, so the next model registered can be handed the exact global-id offsets a still-registered layer's `hiddenIds`/`colorOverrides` describe. `GeoreferencingPanel.tsx`'s `reloadModelsForAlignment` calls `clearAllModels()` directly, without `resetViewerState()`, then reloads every model — the same shape that made `compareResult` and the lens state misresolvable in [#2854](https://github.com/LTplus-AG/ifc-lite/issues/2854). `useConstructionSequence.ts` writes the 'animation' layer's ids as already-translated GLOBAL ids at registration time, and its registration effect's deps exclude `models`; `scheduleData` is untouched by `clearAllModels`, so a paused animation leaves the layer registered indefinitely across the reload. `useOverlayCompositor.ts` applies the composite straight to `hideEntities`/`setPendingColorUpdates` by global id, so a recycled offset would hide or tint whatever live entity the reloaded federation assigns that number to.
  
  `clearAllModels` now drops every registered overlay layer. `removeModel` is left alone: `unregisterModel` burns the freed offset range instead of reclaiming it, so a layer left registered after a partial removal cannot ever be handed to a new model.

- [#2920](https://github.com/LTplus-AG/ifc-lite/pull/2920) [`e95a01e`](https://github.com/LTplus-AG/ifc-lite/commit/e95a01e7f314950bdacdcc8f195bc99ed7f14e3c) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix the AI chat's code-block extractor silently dropping every fenced code block in a CRLF-authored assistant message.
  
  `extractCodeBlocks`'s fence regex required a literal `\n` right after the opening fence's language tag. A message with `\r\n` line endings (pasted or Windows-authored content) has `\r` there instead, so the regex never matched the block at all — it rendered as plain text with no "Run" affordance, and a script referencing `bim.` silently lost its executability rather than surfacing an error. The regex now tolerates an optional `\r` before the newline.

- [#2706](https://github.com/LTplus-AG/ifc-lite/pull/2706) [`4ce3879`](https://github.com/LTplus-AG/ifc-lite/commit/4ce38798211b6b5f84e5b21ed335aa80fe1514c4) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Keep a shared room's edits inside the shared model, in both directions. In a collaborative session the viewer resolved the room's model as "whichever model is currently active", for peers' incoming edits and for mirroring your own edits out. Those are not the same model as soon as a second file is open: loading a file does not move the selection to it, so joining a room and then opening and selecting your own file — two clicks — leaves the room's model registered but not active. From that point a peer's edit was applied to *your* file instead of the shared one, using an entity id that means something else there, and it was recorded as a real edit — it counted towards your file's modified elements, survived a reload and was written into anything you exported. In the other direction, edits you made on your own private file were broadcast into the room and applied to whatever entity the id happened to match in the owner's model. Both directions now address the room's model by id, fixed when the session starts, and every action that carries an entity id also carries the model that id belongs to — so an edit on any other model stays local, the move gizmo no longer offers itself on a private model's entities, and an incoming edit that cannot be placed in the room's model is dropped rather than applied to a different one. Which model is active, and what joining a room with a file already open should do, are unchanged.

- [#2708](https://github.com/LTplus-AG/ifc-lite/pull/2708) [`3f30a2c`](https://github.com/LTplus-AG/ifc-lite/commit/3f30a2ccb0f7aedfbbdb9911749c6555f1d4b89f) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Keep moved elements where they were moved to when joining or working in a shared room. Geometry reaches a collaborator as mesh blobs baked at the position they had when they were shared, and the viewer only ever re-positioned them in response to a live "someone moved this" message — it never re-derived position from the shared document at load time. So a person joining a room after an element had been moved got it back at its original position, with no message coming to correct it, and the model simply looked wrong. Worse, whenever anyone in the room added or deleted an element, every mesh was rebuilt from its baked blob and all previously applied moves snapped back — permanently, and with no indication anything had happened, in the ordinary course of two people working together. The recipient now compares each element's current placement in the document against the position its geometry was baked at, and re-applies the difference after every rebuild.

- [#2706](https://github.com/LTplus-AG/ifc-lite/pull/2706) [`4ce3879`](https://github.com/LTplus-AG/ifc-lite/commit/4ce38798211b6b5f84e5b21ed335aa80fe1514c4) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fail closed, instead of silently falling back to whatever model you have selected, when a live collaboration session's room model cannot be resolved. Opening the Share dialog mints a join token before starting the session; if you remove your last model while that request is in flight, the session used to start anyway with no room model recorded, and every inbound/outbound room-edit resolver would then quietly target whichever model you loaded next — the same private-model corruption already fixed for the ordinary case. Those resolvers now distinguish "no session yet" (where falling back to the active model is correct and unchanged) from "a session is live but its room model is unknown" (where nothing is guessed at: incoming edits are dropped and outgoing edits are not mirrored, exactly as when the room model is legitimately not yet registered). Also: a peer deleting an entity while your own file is still loading into the room can no longer hide a mesh of your own model, and a peer's edit to the shared model while a different model is active now correctly invalidates the merged viewport's render cache instead of leaving stale geometry on screen.

- [#2706](https://github.com/LTplus-AG/ifc-lite/pull/2706) [`4ce3879`](https://github.com/LTplus-AG/ifc-lite/commit/4ce38798211b6b5f84e5b21ed335aa80fe1514c4) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Stop a collaborator's edit from overwriting another model's geometry and data store. When a recipient joins a shared room, the viewer rebuilds the shared model from the CRDT on every peer edit and pushed the result through `setIfcDataStore` / `setGeometryResult` — both of which write to `activeModelId`, an unstated assumption that the reconstructed `room:<roomId>` model is the active one. It need not be: `upsertModel` keeps the existing `activeModelId` rather than switching to the new model, so a recipient who also has their own file open (a link carrying both `?room=` and `?model=`, or a file opened while the room was still syncing) — or who joined normally, loaded a second model and selected it in the hierarchy — has a different model active. The next peer edit then replaced that model's meshes and store with the room's, so the user's own geometry was gone and only a reload brought it back. The reconstruct path now addresses the room model by id: when it is active the write still goes through the active-model setters (so the top-level store the outbound mutation mirror reads stays in sync and the renderer's geometry tick is bumped), and when it is not, the room model's record is patched in place and the active model is left untouched.

- [#2831](https://github.com/LTplus-AG/ifc-lite/pull/2831) [`8ef2e5b`](https://github.com/LTplus-AG/ifc-lite/commit/8ef2e5bf896e0a88484e8a2ddb2979861e8f0259) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Reset `collabRoomId`, `collabRole` and `collabSelfToken` when `startCollab` fails to bring up a session, instead of leaving them naming the room that never started. `startCollab` sets those three fields synchronously (so an early `ShareDialog` subscriber sees the join token) before it awaits `createCollabSession`; if that rejects — for example a browser without IndexedDB, or a WebSocket provider that never connects — the failure handler cleared `collabConnecting` and `collabStatus` but left the room id, role and token in place with no live session behind them. Anything reading "is `collabRoomId` set" as "still in a room" (the toolbar indicator, the Share dialog) kept showing a joined room, and `canCollabEdit()` / `canCollabComment()` — the gate `mutationSlice` checks every write against — kept applying the failed room's role instead of falling back to single-user editing rules, silently blocking edits for a viewer/commenter role even though the session that role belonged to never came up.

- [#2847](https://github.com/LTplus-AG/ifc-lite/pull/2847) [`f4d419b`](https://github.com/LTplus-AG/ifc-lite/commit/f4d419b9a4a04e06008d390f3e0c84b8c3b5069a) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix the BIM ↔ scan deviation heatmap (`DeviationPanel`) staying "computed" — slider, legend and colours all left showing — after removing a federated model whose geometry the heatmap was built against.
  
  `DeviationComputer.compute` builds its BVH from every triangle currently in the scene, not just one model's, so removing any federated model invalidates a prior compute. `pointCloudDeviationComputed` is the flag that gates both the panel's "Recompute" vs. "Compute deviation" label and its auto-recompute effect (`!computed && ...`), so leaving it `true` meant nothing ever re-triggered a rebuild — the panel kept presenting a heatmap computed against a triangle set that no longer existed until the user happened to click Recompute themselves.
  
  `removeModel` already tears down this same "references geometry that just changed" class of staleness for the clash focus, the IDS validation report and the compare result; the deviation flag was the one sibling it left out. `clearAllModels` gets the same fix for the full-teardown path.

- [#2825](https://github.com/LTplus-AG/ifc-lite/pull/2825) [`2335dc4`](https://github.com/LTplus-AG/ifc-lite/commit/2335dc4411aec5a2aca749c7b1ddaf1d776f00e7) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `clearDrawing2D` wiping graphic overrides, DXF underlays, and all 2D
  annotations instead of just the generated drawing.
  
  `clearDrawing2D` called `set(getDefaultState())`, resetting the entire
  `Drawing2DSlice` to its initial values. The "View 2D" button
  (`SectionPanel.tsx`) calls it solely to force drawing regeneration with the
  current settings -- but the whole-state reset also discarded the user's
  custom graphic-override rules, the enabled/disabled state of the built-in
  overrides, every DXF underlay they had imported, and every measurement,
  polygon-area, text, and cloud annotation on the 2D sheet.
  
  `clearDrawing2D` now resets only the drawing-generation fields
  (`drawing2D`, `drawing2DStatus`, `drawing2DProgress`, `drawing2DPhase`,
  `drawing2DError`, `drawing2DSvgContent`).

- [#2770](https://github.com/LTplus-AG/ifc-lite/pull/2770) [`75c327c`](https://github.com/LTplus-AG/ifc-lite/commit/75c327c30acbc63957b01b44055084845ce8e76a) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix a federated GLB/IFCX/point-cloud add being marked `loadState: 'error'` after it had already loaded successfully.
  
  `useIfcLoader`'s shared `finalizeModel` closure read a `const allInstancedShards`
  that is declared ~800 lines further down the same `loadFile` function, inside
  the WASM-streaming section. GLB, IFCX, and point-cloud federated adds call
  `finalizeModel` before that section ever runs, so the read landed in the
  binding's temporal dead zone and threw `ReferenceError: Cannot access
  'allInstancedShards' before initialization` — *after* `addModel` had already
  registered the model with its correctly parsed geometry. The surrounding
  catch then wrote `loadState: 'error'` onto the now-live model, so a user
  federating one of these formats saw a failed model that had, in fact, loaded.
  
  `finalizeModel` now takes the GPU-instancing shard bytes as an explicit
  parameter (default `[]`), forwarded by the WASM streaming path once it has
  populated them. GLB/IFCX/point-cloud loads have no instancing concept, so an
  empty array is the correct value on their path, not a placeholder.

- [#2859](https://github.com/LTplus-AG/ifc-lite/pull/2859) [`f2fa69e`](https://github.com/LTplus-AG/ifc-lite/commit/f2fa69e1ed6a11638e402e16c9cef1d5f3ffd6bb) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix the Georeferencing panel's double-georeference banner reading the wrong scale for IFC2x3 `ePSet_MapConversion` files with no explicit ePset `MapUnit` — a 1000x scale error for millimetre projects.
  
  `getEffectiveGeoreference` (`effective-georef.ts`) resolves this case via `resolveEpsetMapUnitScale`: when an ePSet-sourced georeference has no explicit `MapUnit`, its offsets are in the project length unit per the buildingSMART convention, not metres. Every other consumer of the georeference — `ViewportContainer`, `BasepointOverlay`, `FederationAlignmentControls`, `federationAlign.ts`, `useAnchorGeoreference.ts` — reaches that fix by calling `getEffectiveGeoreference`.
  
  `GeoreferencingPanel.tsx` built its `mergedCRS` from `mergeProjectedCRS` alone, fed by `ModelMetadataPanel.tsx`'s own direct `extractGeoreferencingOnDemand` call rather than `getEffectiveGeoreference`. For an ePSet-sourced file with no explicit MapUnit this left `mapUnitScale` `undefined`, which `resolveMapUnitToMetreScale` reads as "treat offsets as metres" — the panel's `detectDoubleGeoreference` check then scaled a millimetre project's eastings/northings by 1 instead of 0.001, a 1000x error in the reported residual/displacement.
  
  `mergedCRS` now applies `resolveEpsetMapUnitScale` after `mergeProjectedCRS`, matching `getEffectiveGeoreference`'s composition exactly.

- [#2879](https://github.com/LTplus-AG/ifc-lite/pull/2879) [`48dadab`](https://github.com/LTplus-AG/ifc-lite/commit/48dadaba0e2582cb52399a64577b5c17ea8ddda1) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix KMZ export scaling a millimetre IFC2x3 project's `ePset_MapConversion` offsets by 1 instead of 0.001.
  
  `kmzSuggestsAbsoluteAltitude` and `buildKmzForModel` (kmz-export.ts) built their `ProjectedCRS` via `extractGeoreferencingOnDemand` + `mergeProjectedCRS` directly, without the `resolveEpsetMapUnitScale` correction `getEffectiveGeoreference` applies for every other georeference consumer. For a file whose only georeference is an IFC2x3 `ePset_MapConversion` property set with no explicit `MapUnit` — the buildingSMART convention is to read those offsets in the project length unit — `mapUnitScale` stayed `undefined`, so `resolveMapUnitToMetreScale`'s "no MapUnit ⇒ treat offsets as metres" heuristic took over instead: eastings, northings and OrthogonalHeight were all read as metres rather than the project's millimetres, a 1000× error in every exported KMZ placement and the "True elevation (MSL)" altitude-mode hint. Both functions now apply `resolveEpsetMapUnitScale`, matching the correction `GeoreferencingPanel.tsx` already applies ([#2859](https://github.com/LTplus-AG/ifc-lite/issues/2859)).

- [#2777](https://github.com/LTplus-AG/ifc-lite/pull/2777) [`731dc06`](https://github.com/LTplus-AG/ifc-lite/commit/731dc06ec28043f5b7869f1bf8e2f732ceec7f5e) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix the material totals panel dropping area/weight for vendor-named quantities.
  
  `MaterialTotalsPanel`'s `pickQuantity` docstring promised "pick a quantity
  value by candidate names (case-insensitive), else by type," but only the
  volume total implemented the else-by-type fallback. An element whose only
  area (or weight) quantity used a name outside the IFC-standard candidate
  list — a vendor-specific `PerimeterArea` or `TopArea`, say — contributed
  zero to that material's area/weight total and its row stayed hidden, while
  the identical situation for volume was counted correctly.
  
  `pickQuantity` now applies the else-by-type fallback uniformly to volume,
  area and weight, picking the alphabetically-first named quantity of that
  type when nothing matches a candidate name — a deterministic tiebreak,
  rather than depending on the qset scan order the previous volume-only
  fallback relied on. The per-element map-building + pick logic that all
  three totals shared is now a single extracted function instead of three
  call sites that could (and did) drift apart.
  
  Follow-up fix: the alphabetical fallback could select `CrossSectionArea` —
  a beam/column/member's section (profile) property, not a surface extent —
  as the element's Area, because no candidate name matched it and it sorts
  before every real surface-area name those elements carry
  (`GrossSurfaceArea`, `NetSurfaceArea`, `OuterSurfaceArea`). Proven on the
  app's own shipped `infra-bridge.ifc` sample, this reported a bridge beam's
  0.12 m² cross-section as its material area instead of leaving the total
  unset. `AREA_CANDIDATES` now recognises the standard surface-area names by
  name (so standard beams/columns resolve without reaching the fallback at
  all), and the fallback itself excludes `crosssectionarea` so it can never
  be picked even as a last resort — degrading to "no value" rather than a
  wrong one when it's the only area quantity present.

- [#2781](https://github.com/LTplus-AG/ifc-lite/pull/2781) [`0112cf0`](https://github.com/LTplus-AG/ifc-lite/commit/0112cf0a54ff862f5c74fef5edc02908f194784f) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix the MCP playground chat attaching two files with the same basename in one batch showing two chips for what the upload store treats as one attachment.
  
  `playground-uploads.ts`'s `UploadStore` intentionally de-dupes uploads by basename (last file wins — see its `add()` comment), but `PlaygroundChat`'s `attachFiles` tracked its own `pendingAttachments` list independently, pushing every resolved entry with no such de-dupe. Attaching `spec.ids` (A) and `spec.ids` (B) in one drop produced two chips while the store held only B: the first file's content became unreachable through `ids_validate`/`ids_explain` (which resolve by name through the store) even though its chip was still shown as attached, the duplicate `key={f.name}` in the chip list violated React's key-uniqueness contract, and clicking Remove on either chip — filtering by name — dropped both at once.
  
  The chat panel now tracks only the pending *names* for the current turn and projects them through the store's live contents on every render, so the chip list can no longer disagree with what the store actually holds — there is structurally only one thing to render per name. The store's last-wins behavior is unchanged.
  
  The outbound chat-turn text was never affected: `describeAttachment` reads each in-memory attachment object directly, not through the store.

- [#2832](https://github.com/LTplus-AG/ifc-lite/pull/2832) [`75ea8c7`](https://github.com/LTplus-AG/ifc-lite/commit/75ea8c790600f7b158e8d9ade6d72bcabedf9ce6) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `removeModel`/`clearAllModels` leaving the AddElement panel's target-model pin, and every global-id set (isolate, ghost, hidden, selection, class filter), pointing at a model that no longer exists.
  
  `removeModel`'s selection cleanup (added for [#2654](https://github.com/LTplus-AG/ifc-lite/issues/2654)) purged `selectedEntity`/`activeStorey`/`selectedEntities` by comparing `.modelId`, but never touched the id-keyed state on the same slices: `addElementModelId`/`addElementStoreyId` (addElementSlice — the panel keeps naming a removed model and every placement click then fails with "No model loaded for id"), and `selectedEntityIds`/`selectedStoreys`/`hiddenEntities`/`isolatedEntities`/`ghostExceptEntities`/`classFilter`/`hiddenEntitiesByModel`/`isolatedEntitiesByModel` (selectionSlice/visibilitySlice — keyed by bare `globalId`, not `{modelId, expressId}`, so `.modelId` comparisons can't see them stale). A stale `isolatedEntities` was the worst of these: `syncSourceModel.ts`'s `purgeStaleEntityState` already runs the equivalent purge on the same-modelId resync path, and its own comment explains why an empty-but-non-null isolate set is worse than leaving it alone — `effectiveIsolatedIds` keeps returning it, so `isolatedIds` matches nothing in the surviving federation and the entire remaining scene renders as hidden. `removeModel` never got that treatment for the full-removal path.
  
  Now `removeModel` resolves each id against which surviving model's parse range or mutation-view overlay owns it (mirroring `purgeStaleEntityState`), drops only the ids the removed model owned, and collapses an isolate/ghost set to `null` (not an empty `Set`) when nothing survives. `clearAllModels` clears all of it unconditionally, since no model survives.

- [#2817](https://github.com/LTplus-AG/ifc-lite/pull/2817) [`ed35801`](https://github.com/LTplus-AG/ifc-lite/commit/ed35801c639cdd8c3a76b2b406b9f45f8e550c01) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Pin `loadExclusions`'s unreadable-entry recovery guard with the same coverage its three sibling loaders (presets, reviews, settings) already had: corrupt JSON, an empty stored string, the quota-exhausted-backup path, and a later clean read clearing the latch.
  
  While auditing the three siblings, the same "clean read clears the flag" guard turned out to be unpinned for all four loaders — no existing test killed a mutation removing `unwritableKeys.delete(...)` from the top of `readStoredPresets`, `loadReviews`, or `loadSettings` either. Added one targeted test per loader.
  
  Also pinned (not fixed) a real behavioral difference: unlike its three siblings, which distinguish a missing key (`raw === null`) from an empty stored string, `loadExclusions` uses `if (!raw)`, so an empty string is treated as "no entry" rather than a read failure — it is never backed up and never blocks the next write. No production code changed; this is coverage only.

- [#2853](https://github.com/LTplus-AG/ifc-lite/pull/2853) [`794cf14`](https://github.com/LTplus-AG/ifc-lite/commit/794cf1451d7015519ba9f3a8498e921956a3bb5c) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix the 2D sheet drawing rendering at the wrong position/scale after swapping paper size, scale, or a saved sheet template while "keep position on regenerate" (pinned) was on.
  
  `Drawing2DCanvas` reuses `cachedSheetTransformRef.current` whenever pinned, instead of recomputing the transform from the active sheet's viewport/scale/paper. `useViewControls` only cleared that cache on an axis/flip change or a `sheetEnabled` on/off toggle — but `setPaperSize`, `setFrameStyle`, `updateFrameMargins`, and `setDrawingScale` all mutate the same sheet in place (same id), and `loadTemplate` swaps in a different sheet entirely, none of which ever touch `sheetEnabled`. The cache kept the OLD sheet's transform applied to the new paper/scale/viewport until the user toggled sheet mode off and back on, or changed the section axis.
  
  `useViewControls` now also invalidates the cache whenever the sheet's id, paper size, viewport bounds, or scale factor changes.

- [#2851](https://github.com/LTplus-AG/ifc-lite/pull/2851) [`8c9e3d3`](https://github.com/LTplus-AG/ifc-lite/commit/8c9e3d34d83709e8ffa8f734762fcfb74662d038) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `removeModel`/`clearAllModels` leaving the pinboard/basket (`pinboardEntities`, `hierarchyBasketSelection`) pointing at a model that no longer exists.
  
  `pinboardEntities` is pinboardSlice's documented source of truth for the basket: every basket edit (`addToBasket`/`removeFromBasket`/`showPinboard`) re-derives `isolatedEntities` from it via `toGlobalIdForRef` → `toGlobalIdFromModels`, which falls back to the raw, un-offset `expressId` once a ref's `modelId` is no longer in `models`. A basket ref surviving model removal therefore doesn't just dangle: the next basket operation can resolve it to a bare id that collides with a real entity in any surviving model whose own offset range covers that number (any model loaded at `idOffset` 0, notably), silently co-isolating or co-hiding an entity the user never touched — on top of inflating the basket's visible entity count in the toolbar/dock indefinitely. Same shape as the globalId-keyed selection/isolation state `removeModel` already purges ([#2832](https://github.com/LTplus-AG/ifc-lite/issues/2832)); the basket's own `Set<string>` state was the one sibling that was missed. `clearAllModels` gets the matching unconditional clear for the full-teardown path.

- [#2855](https://github.com/LTplus-AG/ifc-lite/pull/2855) [`5dec9ba`](https://github.com/LTplus-AG/ifc-lite/commit/5dec9ba9759e8170fec87321e6338deaca23f516) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix EPSG:2065 (S-JTSK Ferro Krovak) and EPSG:27700 (OSGB36 British National Grid, when its precision-grid fetch is unavailable) silently getting zero datum shift on reprojection.
  
  `sanitizeProj4`'s `DATUM_TOWGS84` fallback table is keyed by the datum name reported by the bundled EPSG index (`packages/data`), lowercased. For EPSG:2065 that name is `"S-JTSK (Ferro)"`, and for EPSG:27700 it is `"OSGB36"` — neither matched the table's existing `'s-jtsk'` / `'osgb 1936'` keys, so the lookup missed silently (no warning either, since the OSGB36 case only warns when a `+nadgrids` reference is present to strip, and the 2065 def carries none). EPSG:2065 has no precision-grid coverage at all (see `precision-grids.ts`), so this fallback was its only datum shift — every EPSG:2065 model reprojected with the source CRS's raw coordinates read as if they were already WGS84, landing roughly 100+ m off. EPSG:27700 is normally rescued by the OSTN15 precision grid, so this only bit when that fetch failed (offline, CDN down, or in a Node test environment, which always skips the network fetch).
  
  Added `'osgb36'` and `'s-jtsk (ferro)'` as additional keys carrying the same published Bursa-Wolf parameters already used under the existing aliases. `reproject.test.ts`'s EPSG:2065 fixture previously passed the idealized datum name `'S-JTSK'` rather than the real `'S-JTSK (Ferro)'` the bundled index reports for that code, which is why the mismatch went unnoticed — it now uses the real value, plus a new OSGB36 case.

- [#2714](https://github.com/LTplus-AG/ifc-lite/pull/2714) [`7862e92`](https://github.com/LTplus-AG/ifc-lite/commit/7862e929e7b8644c9df6a87f90f151901d33fc77) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Make the section plane's in-plane basis continuous in the normal.
  
  `planeBasis` picked its reference axis with `Math.abs(ny) < 0.9`, switching
  from world-Y to world-X at that threshold. `|ny| = 0.9` is a plane 25.8 degrees
  off horizontal — an ordinary ~6:12 roof pitch — and `setSectionPlaneFromFace`
  reaches it from a face pick, so two picks on roof faces either side of that
  pitch got bases that were nowhere near each other. Measured across the
  boundary: at `nz = 0` the tangent inverted exactly (`dot = -1`, a 180-degree
  flip); at `nz = 0.3` it was an arbitrary 133-degree rotation, the size of the
  jump depending on `nz`; and it was asymmetric — the `ny < 0` crossing did not
  move at all. Nothing pinned it: the existing test asserted only orthonormality,
  which every rotation and sign flip of an in-plane basis satisfies.
  
  That basis is the coordinate frame a face-picked drawing is generated in —
  `useDrawingGeneration` hands `custom.tangent`/`custom.bitangent` to the cutter
  as `customPlane`, and `drawing-generator` works in it — so the jump was a
  drawing that came out rotated between two nearly identical picks. (The cap
  hatch is screen-space and its 2D→3D round-trip uses one basis at both ends, so
  it self-cancels; the module doc's stated victim was in fact immune.)
  
  The threshold is gone. World-Y is now the reference for every normal except
  exactly `±Y`, where the cross product genuinely vanishes; the tangent is
  `normalize(normal × Ŷ)`, which depends only on the normal's azimuth and is
  continuous over the whole sphere minus those two points. Continuity everywhere
  is not available — the hairy-ball theorem forbids a nowhere-zero tangent field
  on a sphere, so some normal has to be singular — and `±Y` is the cheapest place
  for it: the plane is exactly horizontal there, so the drawing is a plan whose
  in-plane rotation carries no meaning. At those two normals the historical basis
  is kept unchanged, so a picked horizontal floor still reproduces the "Down"
  preset's hatch orientation. The branchless Frisvad/Duff construction was
  measured and rejected: its `copysign` variant is itself discontinuous across
  `nz = 0` (`dot = -1` at `n = +X`), and pinning the singularity to one point
  costs `bitangent · Y = -nx`, i.e. every elevation on half the sphere upside
  down. The chosen field keeps `bitangent · Y = sin(tilt) >= 0` everywhere, so
  face-picked elevations stay upright — which the old code did not manage either,
  since its X-fallback pointed the bitangent downward for every `ny > 0.9`.
  
  Behaviour change: for normals with `|ny| > 0.9` — near-horizontal planes,
  including every horizontal-ish face pick except an exactly axis-aligned one —
  the basis is different from before. A section drawing regenerated from such a
  pick can come out rotated relative to one generated before this change, and a
  saved section plane reloads with the new basis. Cardinal presets, exactly
  axis-aligned picks (`±X`, `±Y`, `±Z`) and every normal with `|ny| < 0.9` are
  bit-for-bit unchanged. No golden or snapshot moved: the renderer, drawing-2d
  and viewer suites pass unmodified.

- [#2823](https://github.com/LTplus-AG/ifc-lite/pull/2823) [`89ea6bd`](https://github.com/LTplus-AG/ifc-lite/commit/89ea6bd2043528d7463cf57644bd0ce43d2360af) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix two dead-field defects found while adding coverage for [#2802](https://github.com/LTplus-AG/ifc-lite/issues/2802)'s zero-coverage store slices.
  
  `sheetSlice`'s `clearSheet` reused the same `getDefaultState()` helper the store uses to seed its initial state, so clicking "clear sheet" reset `savedSheetTemplates` to `[]` along with the active sheet — silently deleting every saved template. `clearSheet` now preserves `savedSheetTemplates` across the reset.
  
  `idsSlice`'s `clearIdsValidationReport` already reset `idsIsolateMode` when it invalidated the validation report, but its two siblings that also invalidate the report — `setIdsDocument` (loading a new IDS document) and `clearIdsDocument` — did not. The isolate-panel "pressed" state and the 3D isolation built from `idsIsolateMode` in `useIDS.ts` were left pointing at a report that no longer existed after loading or clearing a document. Both now reset `idsIsolateMode` and `idsIsolationScope` the same way `clearIdsValidationReport` does.

- [#2635](https://github.com/LTplus-AG/ifc-lite/pull/2635) [`f1db423`](https://github.com/LTplus-AG/ifc-lite/commit/f1db4237b257e908b0af3926cec890237cf547f6) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Add `@ifc-lite/source-dropbox`: a Dropbox file-source provider implementing `FileSourceProvider` from `@ifc-lite/plugin-api`. Browses the signed-in user's Dropbox (folders and files), lists version history, and downloads any revision — current or historical — directly through `files/download`, using Dropbox's `"rev:<rev-id>"` path form for a specific historical revision (Dropbox serves this as a normal, non-redirecting, CORS-safe response, unlike Microsoft Graph's browser-only current-revision limitation).
  
  Authentication is delegated OAuth 2.0 Authorization Code + PKCE (`@ifc-lite/oauth-pkce`), scope `account_info.read files.metadata.read files.content.read` — no client secret. Getting a refresh token requires `token_access_type=offline` on the authorization request (a Dropbox-specific requirement, distinct from Microsoft Graph's `offline_access` scope); omitting it silently yields a session that stops working the moment its access token expires. No client ID is committed; it's a required, non-secret `clientId` preference the deployment configures (see the package README for what to register in the Dropbox App Console, including the 50-linked-user production-approval constraint).
  
  Registered alongside `@ifc-lite/source-dalux` and `@ifc-lite/source-msgraph` in the viewer's `createRegisteredProviders()`.
  
  The popup-callback channel this needs (`OAUTH_CALLBACK_CHANNEL`, `waitForOAuthCallback` and the `OAuthCallbackMessage` / `WaitForOAuthCallbackOptions` types) is imported from `@ifc-lite/oauth-pkce`, which already ships it. It lives there, not in this provider, because the defect it works around is a property of the browser's COOP handling and of that package's popup-based authorization flow, not of any one provider: every provider built on it inherits both the failure and the fix. `@ifc-lite/source-dropbox` keeps no copy of its own and deliberately does not re-export those names.
  
  The popup handoff is a `BroadcastChannel` from the redirect page, not the usual `popup.closed`/`popup.location` poll. A host that serves `Cross-Origin-Opener-Policy: same-origin` (the viewer does, for `SharedArrayBuffer`) has its opener link severed by the cross-origin authorization hop: `popup.closed` reads `true` while the popup is visibly open, so the poll loop rejects every sign-in as "cancelled" before the user has even consented. The viewer now serves the redirect path as a small static page (`apps/viewer/public/oauth/dropbox/callback.html`, routed in dev by `apps/viewer/vite-plugins/oauth-callback.ts` and in production by a `vercel.json` rewrite) instead of letting the SPA fallback boot a second copy of the whole application inside the popup.

- [#2827](https://github.com/LTplus-AG/ifc-lite/pull/2827) [`56fbd50`](https://github.com/LTplus-AG/ifc-lite/commit/56fbd50c01fdb94d8af2b9eed4d7a1be46dbb518) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix the Split tool committing a slab cut against a stale anchor from a different element.
  
  `setSplitTarget` preserved `splitMode: 'first-anchor'` whenever the slice was mid-slab-cut, regardless of whether the new target was the same element the anchor was latched against. Retargeting Split to a different element — e.g. picking a different row in the Hierarchy panel and re-triggering "Split selected entity" from the Command Palette while a slab's first click was still latched — moved `splitTargetModelId`/`splitTargetExpressId` to the new element but left `slabCutAnchor`/`slabCutFootprint`/`slabCutStoreyElevation` pointing at the old one. The next click then committed `splitSlabByLine` against the new target using an anchor point and footprint from an unrelated slab's coordinate space.
  
  `setSplitTarget` now only preserves the latched anchor when the retarget re-enters the *same* element; retargeting to anything else drops back to `'idle'` and clears the anchor/footprint/elevation, matching what `clearSplitHover` already does for every other exit path.

- [#2837](https://github.com/LTplus-AG/ifc-lite/pull/2837) [`6beb3f4`](https://github.com/LTplus-AG/ifc-lite/commit/6beb3f4885ce2f52fc0a136ea4a05912b6b3ced9) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix a slower clash run overwriting a newer, faster one in the Clash panel.
  
  `publishClashResult` in `useClash.ts` guarded every write to `clashResult` with a federation-identity check (`clashFederationIsCurrent`) - but that identity is keyed on the model set, not on which call started it. Two detection jobs issued while the federation is untouched (an "All elements" run, then a duplicate scan started while it is still going) carry the identical identity, so the guard could not tell a call the user is still waiting on from one they have moved past. An older, slower call finishing after a newer one had already published overwrote its answer.
  
  `run()` and `runDuplicates()` now capture a per-call epoch and re-check it, together with the federation identity, immediately before every store write - the publish, the "no geometry loaded" error, the caught-exception error, and the `finally` that flips `clashRunning` / `clashProgress` back off. The `finally` check matters as much as the publish one: without it, an older call's `finally` running after a newer one has already started reports "not running" while the newer job is still genuinely in flight. `clearAll()` also bumps the epoch, so a clear mid-run cannot be resurrected by the run it cleared landing afterwards.

- [#2829](https://github.com/LTplus-AG/ifc-lite/pull/2829) [`ffd7fbe`](https://github.com/LTplus-AG/ifc-lite/commit/ffd7fbe96a4087149c2688b2650b0f2c59ca8c47) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix a superseded model comparison overwriting a newer one in the Compare panel.
  
  `isCurrentFor` / `buildAtCurrentVersion` in `useCompare.ts` guard the fingerprint cache against a federation re-alignment moving meshes in place — they say nothing about whether a given `runComparison()` call is still the one the user is waiting on. Three ways an in-flight comparison could clobber the panel after the fact, all now fixed:
  
  - A slower `runComparison()` call finishing after a newer one (a different A/B pair, or a re-run) published its answer over it.
  - `clearCompare()` mid-flight did not stick: the in-flight run's eventual result or error resurrected what the user had just cleared.
  - Changing the A/B selection mid-flight (without clicking Run again) still published a result for the old pair, which nothing checked against the currently selected pair — the panel could show a diff that didn't match its own selectors.
  
  `runComparison` now captures a per-call epoch and re-checks it, together with the live `compareBaseModelId`/`compareHeadModelId`, immediately before every write to the store (success, the exhausted-retries error, and the failure path) — never earlier, so nothing can supersede between the check and the write. `clearCompare` is now returned from `useCompare()` and bumps that epoch before delegating to the store action, so `ComparePanel` (and the hook's own re-alignment cleanup) route through it instead of calling the raw store action directly.

- [#2837](https://github.com/LTplus-AG/ifc-lite/pull/2837) [`6beb3f4`](https://github.com/LTplus-AG/ifc-lite/commit/6beb3f4885ce2f52fc0a136ea4a05912b6b3ced9) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix a slower IDS validation run overwriting a newer, faster one in the IDS panel.
  
  `runValidation()` in `useIDS.ts` resolved its target model once, awaited the (potentially long, worker-or-main-thread) validation, and then wrote `setIdsValidationReport(...)` unconditionally - with no guard of any kind, not even a federation-identity check. Two validations issued back to back (a re-run, or a different target model picked from the federation dropdown while one was still running) raced: whichever finished last won the store, regardless of which the user actually issued last.
  
  `runValidation()` now captures a per-call epoch and re-checks it immediately before every store write that follows an `await` - the progress updates, the published report, the caught-exception error, and the `finally` that flips `idsLoading` back off. The `finally` check matters as much as the report write: without it, an older call's `finally` running after a newer one has already started reports "not loading" while the newer validation is still genuinely in flight. `clearIDS()` and `clearValidation()` also bump the epoch, so a clear mid-run cannot be resurrected by the run it cleared landing afterwards.

- [#2856](https://github.com/LTplus-AG/ifc-lite/pull/2856) [`74f51f5`](https://github.com/LTplus-AG/ifc-lite/commit/74f51f585625fea16f32bc2c0a7a35b886bbdd46) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix an active lens keeping a removed model's colors and clearing them onto a new model that reuses its global-id range.
  
  `useLens`'s evaluation effect only depended on `[activeLensId, activeLens]`; it read `models` / `ifcDataStore` from `getState()` without subscribing to either, so removing a model or calling `clearAllModels` never triggered a re-evaluation. `lensColorMap`, `lensHiddenIds`, `lensRuleCounts`, `lensRuleEntityIds`, and `lensAppliedColors` kept referencing the departed model's entities. This wasn't just dangling: `clearAllModels` also resets the federation registry's offset counter, so the next model loaded can be handed the exact global-id range those stale entries still point at — a lens rule that matched the old model's entity keeps "matching" whatever unrelated entity now occupies that id, and `useCompareOverlay`'s teardown resends `lensAppliedColors` to the renderer verbatim.
  
  The effect now also depends on a lightweight fingerprint of the loaded model id set (add/remove only, not in-place field patches like loading progress or visibility toggles), and clears the lens-derived state when the model set empties out — mirroring what already happens on lens deactivation.

- [#2779](https://github.com/LTplus-AG/ifc-lite/pull/2779) [`216446a`](https://github.com/LTplus-AG/ifc-lite/commit/216446af6a698e11f69652f09c8a07da263a78db) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix a crashed extension widget masking every widget viewed afterward in the same dock slot.
  
  `WidgetErrorBoundary` never cleared its caught error, and `ExtensionDockHost` rendered it (and its `DockBody` parent) without a `key`, so switching the active dock tab reused the same React instance. Once any widget in a dock slot threw during render, every subsequently-viewed widget in that slot showed the first widget's stale crash banner instead of its own content — the panel effectively froze until it fully unmounted.
  
  `DockBody` and `WidgetErrorBoundary` are now keyed on the widget's identity (`extensionId`/`widget` path), so switching tabs discards the crashed instance and mounts a fresh one; re-rendering the *same* widget keeps the same key, so a widget that throws on every render still shows its own crash and does not enter a remount/crash retry loop.

- [#2703](https://github.com/LTplus-AG/ifc-lite/pull/2703) [`2f46c0d`](https://github.com/LTplus-AG/ifc-lite/commit/2f46c0d06e6dd51cf0c98f74c5d57ab3cbcbd112) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix "select elements in this zone" selecting nothing inside a collaborative room.
  
  Zone selection resolved each matched element through the `federationRegistry`
  singleton alone, and dropped every id the registry could not place. The collab
  recipient seeds its room model with `upsertModel` and never calls
  `registerModelOffset` (`collabSlice.ts`), so the registry knew none of the
  room's ids: every match was dropped, and the panel then took its empty-result
  branch and answered `No elements in this zone` — a confident, false statement
  about the zone's contents rather than a silent no-op. Federated-IFCX
  composition seeds its layers the same way.
  
  Resolution now goes through the store's canonical `resolveGlobalIdFromModels`
  — the resolver `resolveEntityRef.ts` calls the single source of truth, and the
  only one that also sees overlay-allocated ids via its `mutationViews` pass —
  falling back to the registry for a model that has left `state.models` but is
  still registered. `useIfcFederation`'s `findModelForEntity` / `resolveGlobalId`
  get the same delegation. Sibling of the clash-path fix in [#2697](https://github.com/LTplus-AG/ifc-lite/issues/2697).
  
  This is complete only while the room's id space stays inside the first
  snapshot's maximum. `collabSlice` computes the room model's `maxExpressId` in
  its first-reconstruct branch only; every later peer edit goes through
  `setIfcDataStore`, which replaces the store and leaves `maxExpressId` at the
  first value. Ids allocated after that snapshot fall outside the model's
  recorded range and still resolve to nothing — measured in review at 3 of 4
  assigned elements once a peer adds one, and 0 of 3 when the first build saw an
  empty doc and the bound froze at 0. That is a pre-existing `collabSlice`
  defect, degrading every `resolveGlobalIdFromModels` consumer in a room rather
  than zone selection specifically, and it is not fixed here.
- Updated dependencies [[`b9faf82`](https://github.com/LTplus-AG/ifc-lite/commit/b9faf8296f86943914c30550af8131fee250d4c8), [`8f89331`](https://github.com/LTplus-AG/ifc-lite/commit/8f893311b170a983e160737bd9479c3caf961911), [`bc179f6`](https://github.com/LTplus-AG/ifc-lite/commit/bc179f6a1091c8c307a07b31d8c30fbba140e4a9), [`b9faf82`](https://github.com/LTplus-AG/ifc-lite/commit/b9faf8296f86943914c30550af8131fee250d4c8), [`48b204b`](https://github.com/LTplus-AG/ifc-lite/commit/48b204b868016aad29b694b53ac8ace5e76a0542), [`b14e710`](https://github.com/LTplus-AG/ifc-lite/commit/b14e710ae8d56f518f84abb4d4ec8d1f98aacad8), [`05592f8`](https://github.com/LTplus-AG/ifc-lite/commit/05592f8c1ef5b34a00c2ea077542dc68107a7ae5), [`7b3617f`](https://github.com/LTplus-AG/ifc-lite/commit/7b3617f2ec9a6e9e8a57127d2ec61f9c33cadf3a), [`432fdb8`](https://github.com/LTplus-AG/ifc-lite/commit/432fdb8dd12dd90af17d1ca3ce24a2fd5b7168b0), [`6a43522`](https://github.com/LTplus-AG/ifc-lite/commit/6a43522cdf3b0a9b0f7ce303b59f479dca2a2aca), [`b699875`](https://github.com/LTplus-AG/ifc-lite/commit/b6998754039676def950735335147556afcb2977), [`b3a4d30`](https://github.com/LTplus-AG/ifc-lite/commit/b3a4d307c50c9b0a8b8bb0e29952c4a98e417c16), [`0a10389`](https://github.com/LTplus-AG/ifc-lite/commit/0a1038972a72b27bda99c8793055efe39d623f10), [`5334bd1`](https://github.com/LTplus-AG/ifc-lite/commit/5334bd1589acb1c4b81a1f255d1a9171530b1467), [`b1ac6be`](https://github.com/LTplus-AG/ifc-lite/commit/b1ac6be425cd89ff90eaab02636211f0d928b3e6), [`c688a12`](https://github.com/LTplus-AG/ifc-lite/commit/c688a1272ec72d575e8ecf78072e0a0084b517ca), [`4ce3879`](https://github.com/LTplus-AG/ifc-lite/commit/4ce38798211b6b5f84e5b21ed335aa80fe1514c4), [`79322b6`](https://github.com/LTplus-AG/ifc-lite/commit/79322b6e76049be0df3b07149c711414bd80863e), [`a257092`](https://github.com/LTplus-AG/ifc-lite/commit/a2570927c5496fc4a6e3a54183a4f6d99c6f5edf), [`5103734`](https://github.com/LTplus-AG/ifc-lite/commit/51037344717fe3d4c7c138e03f709a01a19ddccd), [`3329521`](https://github.com/LTplus-AG/ifc-lite/commit/33295218a3a2ecd35671483bc92bbf018807ae1e), [`2156528`](https://github.com/LTplus-AG/ifc-lite/commit/2156528c926114233c79ba74925c0c8656f1ea65), [`7869a90`](https://github.com/LTplus-AG/ifc-lite/commit/7869a90f35384ceba40b7ce4f3e9fadbe6990fa8), [`be6b43c`](https://github.com/LTplus-AG/ifc-lite/commit/be6b43c2b334811422c1cbfbea5d6e6d1b9a401d), [`989ee2c`](https://github.com/LTplus-AG/ifc-lite/commit/989ee2c4e396575529488c17b73e1a884e4e8b9d), [`1cda2d0`](https://github.com/LTplus-AG/ifc-lite/commit/1cda2d04dc66542892dd0181768c027b3d1b4e6f), [`0ed2582`](https://github.com/LTplus-AG/ifc-lite/commit/0ed2582b71973fa6d16307999ed2ea59f7a2db3f), [`b4740a1`](https://github.com/LTplus-AG/ifc-lite/commit/b4740a1fb18050c065e8fbd58714626bdf852f00), [`5a9ecfb`](https://github.com/LTplus-AG/ifc-lite/commit/5a9ecfb6bcd3190eae4463bd8926cf38a2143496), [`9fb50eb`](https://github.com/LTplus-AG/ifc-lite/commit/9fb50ebcfaaf2926b2badd4d4d8dfc6ca55b762f), [`969cff9`](https://github.com/LTplus-AG/ifc-lite/commit/969cff95a77ce4c17a949a93632c8a0378fd3ede), [`a29b040`](https://github.com/LTplus-AG/ifc-lite/commit/a29b04069fec3c6b726f49fc58054e535c255034), [`cc19a8d`](https://github.com/LTplus-AG/ifc-lite/commit/cc19a8d4a79a5e8563a90ab663b28e1b93ef9c18), [`36e4eca`](https://github.com/LTplus-AG/ifc-lite/commit/36e4eca3b19a2fe02f1679acc9a2a43cd90aa163), [`a7b8a20`](https://github.com/LTplus-AG/ifc-lite/commit/a7b8a201eaecd411a4246421893e887bf55aafd3), [`ad50aa9`](https://github.com/LTplus-AG/ifc-lite/commit/ad50aa9751c31f6895944e26ce19fe8cbbf3018e), [`ccc38b0`](https://github.com/LTplus-AG/ifc-lite/commit/ccc38b0de9925a3de1106893a5785117e0e7551d), [`105eb31`](https://github.com/LTplus-AG/ifc-lite/commit/105eb31e7ccdd697f74db3bc9fac41396cdc6faa), [`4f01d5c`](https://github.com/LTplus-AG/ifc-lite/commit/4f01d5caf469c380c5e1a15d807a5ebb7f6de86e), [`679c7cb`](https://github.com/LTplus-AG/ifc-lite/commit/679c7cb680ab0d8f17e8f5c267fdb424049ec0d0), [`ae14cd3`](https://github.com/LTplus-AG/ifc-lite/commit/ae14cd3036f11c039d9b7cd786acf51a68b884dc), [`8226c0a`](https://github.com/LTplus-AG/ifc-lite/commit/8226c0aae9c4ca641b970873c0a0adf648429205), [`2edf1c6`](https://github.com/LTplus-AG/ifc-lite/commit/2edf1c60023832a7a9a3629e9d5aaa40e4be1e35), [`f31822b`](https://github.com/LTplus-AG/ifc-lite/commit/f31822b0833e1bcd76c43736daf1d76cb3e59914), [`4d1c611`](https://github.com/LTplus-AG/ifc-lite/commit/4d1c611b822e80a6123b040887a31cdb43c460da), [`5660d53`](https://github.com/LTplus-AG/ifc-lite/commit/5660d53f5326188c474bb0c31d3e1ff6b104426c), [`5254699`](https://github.com/LTplus-AG/ifc-lite/commit/52546994268440a468de81ce6ac0b385e6ef73d7), [`c233d48`](https://github.com/LTplus-AG/ifc-lite/commit/c233d48a935a70851271b61a305f43dd9261dcca), [`b28a629`](https://github.com/LTplus-AG/ifc-lite/commit/b28a629d49f279ce01537cb06ae4c28f32beb2bb), [`1900a1a`](https://github.com/LTplus-AG/ifc-lite/commit/1900a1a9f8174ef874dddbd1541ccadd9a89415e), [`6ce17fa`](https://github.com/LTplus-AG/ifc-lite/commit/6ce17fa903d38ab8ee3e6ebaf6da8453726d3ce2), [`b7d2a11`](https://github.com/LTplus-AG/ifc-lite/commit/b7d2a11345add8acdf0926ade5d4c1ca19ccecf7), [`c849b13`](https://github.com/LTplus-AG/ifc-lite/commit/c849b1395511e48ed6c8b6bd01bc0b1a66d60bfa), [`7862e92`](https://github.com/LTplus-AG/ifc-lite/commit/7862e929e7b8644c9df6a87f90f151901d33fc77), [`5d68a13`](https://github.com/LTplus-AG/ifc-lite/commit/5d68a13f7e2ed9c9754242b624abfa7343888f14), [`7862c03`](https://github.com/LTplus-AG/ifc-lite/commit/7862c0360c7297c0b24f100b62c55abc8e612b75), [`f1db423`](https://github.com/LTplus-AG/ifc-lite/commit/f1db4237b257e908b0af3926cec890237cf547f6), [`ae5a5ca`](https://github.com/LTplus-AG/ifc-lite/commit/ae5a5caa3e20304085ba14c0708cd026c1d4bf16), [`adc37ca`](https://github.com/LTplus-AG/ifc-lite/commit/adc37cac288e53be88796fddf06b0a7ae179f451), [`2affb53`](https://github.com/LTplus-AG/ifc-lite/commit/2affb534e8ed7b339dc52984789638d4ea4774bc), [`adc37ca`](https://github.com/LTplus-AG/ifc-lite/commit/adc37cac288e53be88796fddf06b0a7ae179f451), [`f19206b`](https://github.com/LTplus-AG/ifc-lite/commit/f19206b8912ba418627373e147c1699019450ebf), [`c49c7f6`](https://github.com/LTplus-AG/ifc-lite/commit/c49c7f644cd7930bd3937ed850f3864aa516934b)]:
  - @ifc-lite/bcf@1.18.2
  - @ifc-lite/collab@0.5.0
  - @ifc-lite/mutations@1.26.1
  - @ifc-lite/cache@3.0.5
  - @ifc-lite/clash@1.9.0
  - @ifc-lite/geometry@3.8.4
  - @ifc-lite/parser@4.2.0
  - @ifc-lite/source-dalux@0.3.0
  - @ifc-lite/drawing-2d@2.1.1
  - @ifc-lite/query@1.14.17
  - @ifc-lite/data@3.4.0
  - @ifc-lite/wasm@5.0.0
  - @ifc-lite/ids@1.15.48
  - @ifc-lite/create@2.1.2
  - @ifc-lite/ifcx@2.3.7
  - @ifc-lite/lens@1.18.1
  - @ifc-lite/sdk@2.1.3
  - @ifc-lite/export@2.9.4
  - @ifc-lite/mcp@0.11.3
  - @ifc-lite/merge@0.4.3
  - @ifc-lite/renderer@1.49.1
  - @ifc-lite/server-client@1.22.2
  - @ifc-lite/solar@1.15.5
  - @ifc-lite/source-dropbox@0.2.0
  - @ifc-lite/spatial@1.14.14
  - @ifc-lite/lists@1.23.2

## 1.36.0

### Minor Changes

- [#2688](https://github.com/LTplus-AG/ifc-lite/pull/2688) [`58ae85b`](https://github.com/LTplus-AG/ifc-lite/commit/58ae85bbb9c42506850db1ff2efa1debe379f799) Thanks [@Blogbotana](https://github.com/Blogbotana)! - Phase 1 of the Blender-like lighting work ([#2670](https://github.com/LTplus-AG/ifc-lite/issues/2670)): expose light-hardness and shadow-feel controls in the standalone WebGPU viewer.
  
  **Renderer** — `LightingEnvironment` gains a `sunSoftness` field: the diffuse-wrap that sets the sun terminator, previously hardcoded to `0.3` in the shader. `0` is a crisp light/shadow boundary (harder shadows), larger values soften it (overcast). Resolved into the existing environment uniform (a spare pad slot, no UBO size change) and clamped to `[0, 1]`; omitting it reproduces the historic look exactly.
  
  **Viewer** — the Sun & Sky panel adds two sliders (WebGPU shading, hidden in world-context mode): **Light hardness** (deepens shadows by cutting hemisphere ambient + fill) and **Terminator softness** (trims the preset's `sunSoftness`). Both are user trims composed onto the active preset — switching presets changes the base, the trims persist — mirroring Exposure. Presets now carry per-preset softness (crisp Day/Evening, soft Overcast) so the terminator changes with the sky being simulated. Settings persist in localStorage.

### Patch Changes

- [#2696](https://github.com/LTplus-AG/ifc-lite/pull/2696) [`572100f`](https://github.com/LTplus-AG/ifc-lite/commit/572100fcdc3df89bd0461445e14e05809d1581a8) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix a clash run that finishes after the models it examined are gone repopulating the result list. Both publish sites in `useClash` wrote `setClashResult` unconditionally, so clearing the federation mid-run ("Clear all", "Open file", "Remove model", or a collab peer edit replacing the active model's data store) was undone seconds later by the finishing run. After a teardown every restored row is inert — focusing one resolves no entity refs — and after a collab peer edit the rows still focus but point at entities the peer's edit renumbered, so they select the wrong elements. Each run now records the identity of the federation it actually gathered elements from (each contributing model id mapped to its entity table, the express-id space its refs are derived from) and both sites publish through one guard that drops the result if any of those models is gone or has been re-parsed. The identity is read off the federation rather than bumped by each teardown, so no enumeration of teardown paths can fall out of date; and because it is keyed on the entity table rather than the `ifcDataStore` wrapper, a background spatial-index publish — which replaces the wrapper while every express id stays put — leaves a correct run alone.

- [#2633](https://github.com/LTplus-AG/ifc-lite/pull/2633) [`c706f34`](https://github.com/LTplus-AG/ifc-lite/commit/c706f3452df4ab64a17966d5e965cf6518ccd417) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Add `@ifc-lite/source-msgraph`: a Microsoft Graph (OneDrive/SharePoint) file-source provider implementing `FileSourceProvider` from `@ifc-lite/plugin-api`. Browses the signed-in user's OneDrive (folders and files), lists version history, and downloads the current revision of a file via Graph's pre-signed `@microsoft.graph.downloadUrl` — never `GET .../content` directly, which 302-redirects in a way a browser can't follow under a CORS preflight.
  
  Authentication is delegated OAuth 2.0 Authorization Code + PKCE (`@ifc-lite/oauth-pkce`), scope `offline_access https://graph.microsoft.com/Files.Read` — no admin consent required, no client secret. No client ID is committed; it's a required, non-secret `clientId` preference the deployment configures (see the package README for what to register in Azure AD).
  
  Registered alongside `@ifc-lite/source-dalux` in the viewer's `createRegisteredProviders()`.
  
  The popup handoff is a `BroadcastChannel` from the redirect page, not the usual `popup.closed`/`popup.location` poll. A host that serves `Cross-Origin-Opener-Policy: same-origin` (the viewer does, for `SharedArrayBuffer`) has its opener link severed by the cross-origin authorization hop: `popup.closed` reads `true` while the popup is visibly open, so the poll loop rejects every sign-in as "cancelled" before the user has even consented. The viewer now serves the redirect path as a small static page (`apps/viewer/public/oauth/msgraph/callback.html`, routed in dev by `apps/viewer/vite-plugins/oauth-callback.ts` and in production by a `vercel.json` rewrite) instead of letting the SPA fallback boot a second copy of the whole application inside the popup.
  
  Because that failure is a property of the popup being cross-origin rather than of any one provider, the waiting side ships as `waitForOAuthCallback` (plus the `OAUTH_CALLBACK_CHANNEL` name and its `OAuthCallbackMessage` shape) in `@ifc-lite/oauth-pkce`, so every provider built on that package shares one implementation. Messages are routed by the sign-in attempt's `state`, which is what keeps two concurrent sign-ins from completing each other's flow; `parseAuthorizationCallback` still performs the authoritative CSRF check. One consequence is deliberate: cancellation is no longer detectable, because `popup.closed` is the only signal a browser gives for it and that is exactly what COOP made unusable, so closing the popup now waits out the timeout.
- Updated dependencies [[`d1fb40d`](https://github.com/LTplus-AG/ifc-lite/commit/d1fb40d1f72bb0b8345644e83e410cc8c240cf38), [`58ae85b`](https://github.com/LTplus-AG/ifc-lite/commit/58ae85bbb9c42506850db1ff2efa1debe379f799), [`d1fb40d`](https://github.com/LTplus-AG/ifc-lite/commit/d1fb40d1f72bb0b8345644e83e410cc8c240cf38), [`d1fb40d`](https://github.com/LTplus-AG/ifc-lite/commit/d1fb40d1f72bb0b8345644e83e410cc8c240cf38), [`c706f34`](https://github.com/LTplus-AG/ifc-lite/commit/c706f3452df4ab64a17966d5e965cf6518ccd417), [`b8fb71e`](https://github.com/LTplus-AG/ifc-lite/commit/b8fb71e5c19ddf405563664f29e8a6ec22f36b63)]:
  - @ifc-lite/drawing-2d@2.1.0
  - @ifc-lite/renderer@1.49.0
  - @ifc-lite/source-msgraph@0.2.0

## 1.35.0

### Minor Changes

- [#2535](https://github.com/LTplus-AG/ifc-lite/pull/2535) [`e5acbb2`](https://github.com/LTplus-AG/ifc-lite/commit/e5acbb2589628d7e9f8a9d640c4b82d11f510929) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Surface the existing spatial clash grouping (`groupClashes({ by: 'cluster' })`, already used for BCF export) in the Clash panel's results list itself. Previously the panel only ever listed raw element pairs, so a model where several nearby pairs are really one coordination problem (e.g. a cluster of beam clashes at a single connection) read as many rows instead of one issue.

  The panel now shows a "Pairs" / "Issues" toggle plus an issue count next to the pair total. In the Issues view, results are grouped by spatial proximity (default cluster radius 1.5 m, adjustable in Clash settings' existing "Cluster radius" field); each group is expandable to the individual pairs it contains — nothing is hidden, only re-organized.

- [#2641](https://github.com/LTplus-AG/ifc-lite/pull/2641) [`743d4db`](https://github.com/LTplus-AG/ifc-lite/commit/743d4db5396447317999032b024e31491630d129) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Add a multi-click polyline measurement mode to the Measure tool, alongside the existing drag-to-measure distance gesture.

  A new "Polyline" toggle in the Measure panel switches the tool from the original drag (A to B) gesture to accumulating points via successive clicks. Double-click or Enter finishes the sequence as an open polyline (reports the sum-of-segments length); clicking back near the first point (once at least 3 points are placed) closes it into a loop instead, reporting the perimeter (the same sum plus the closing segment). Escape cancels an in-progress sequence without recording anything. The panel always prints which basis a number was computed under ("Length" vs. "Perimeter (closed)") rather than leaving it implicit.

  The two gestures are mutually exclusive by construction: switching modes cancels whichever gesture was in progress in the mode being left (`setMeasureMode` in `measurementSlice.ts`), and polyline mode never starts a drag measurement (`shouldStartDragMeasurement` gates `mousedown` in `useMouseControls.ts`) — the original drag-to-measure flow is unchanged.

  This is the first consumer of the mode; distances continue to route through the existing `formatDistance`/`resolveQuantityDisplay` unit-display path, honouring the same `unitDisplayOverrides`. Neither toolbar hosts any of this UI — it lives entirely in the shared Measure panel, per the existing `measure-parity.test.tsx` guard.

  Deliberately out of scope for this change: free-polygon/rectangle area, three-point angle, minimum distance, diameter/radius, and circle-centre snapping — each still needs either mesh analysis reachable from TypeScript or its own interaction beyond the polyline primitive shipped here.

- [#2675](https://github.com/LTplus-AG/ifc-lite/pull/2675) [`aea7c6b`](https://github.com/LTplus-AG/ifc-lite/commit/aea7c6b08f1f3bc5577ff190f3ec594403d64cd2) Thanks [@louistrue](https://github.com/louistrue)! - Clash exclusions: mark an overlap as by design and stop it counting.

  A coordinator can exclude a whole IFC type pair, a one-sided type rule that
  excludes every clash involving one type regardless of what it meets, or one
  specific element pair. Each rule shows how many clashes it is hiding, and rules
  can be disabled or removed. They persist in local storage and apply to the last
  run without re-detecting.

  This note exists because the feature shipped in [#2535](https://github.com/LTplus-AG/ifc-lite/issues/2535) under a changeset that
  named only `@ifc-lite/clash`. Consuming a changeset deletes it, so the
  viewer-facing description of a viewer feature would otherwise have been lost
  from `apps/viewer/CHANGELOG.md` permanently rather than merely delayed.

### Patch Changes

- [#2654](https://github.com/LTplus-AG/ifc-lite/pull/2654) [`6b1b5a2`](https://github.com/LTplus-AG/ifc-lite/commit/6b1b5a23e72b998b242b3443c5d7ff453c2d6305) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix an orphaned clash intersection-solid render surviving the clash tour and Home / "Show all".

  `focusClash` (`apps/viewer/src/hooks/useClash.ts`) computes the true intersection solid for a focused clash pair asynchronously, ghosts the whole model, and draws the solid opaque. The in-flight compute was staled out by `solidRequestGuard`, a `useRef` private to one `useClash()` hook instance — no code outside that hook's own callbacks could ever invalidate it.

  Two teardown paths reset the same fields `useClash.clearHighlight()` resets (selection, isolation, ghost, pair colours, the contact overlay, `clashSelectedId`) directly against the store, written before the on-demand solid feature landed:

  - the clash tour's "zoom-to-clash" step cleanup (`apps/viewer/src/lib/tours/tours/clash.ts`)
  - the Home / "Show all" reset, `resetVisibilityForHomeFromStore` (`apps/viewer/src/store/homeView.ts`)

  Neither called anything that could invalidate the guard, so running the clash tour to completion, or clicking Home / "Show all", while a clash solid was showing (or its compute was still in flight) left an orphaned opaque intersection-solid mesh rendering with nothing selected and no clash focused — or let a since-superseded compute land afterward and reapply the full-model ghost the user had just cleared.

  Rather than adding `clearClashSolid()` calls at these two sites (which would leave the same gap for the next teardown path that forgets to), the invalidation now lives in the clash store slice itself: `setClashSelectedId`, `clearClashSolid` and `clearClash` (`apps/viewer/src/store/slices/clashSlice.ts`) all reset the solid presentation and bump a new `clashSolidRequestSeq` counter. `focusClash`'s async compute checks that counter instead of a private ref, so any code path that changes or clears the focused **clash** — including ones not written yet — invalidates an in-flight solid compute by construction. `Viewport.tsx` additionally gates the solid draw on `clashSelectedId !== null` as defence in depth.

  That "by construction" property covers clash-_focus_ teardown. The paths that replace or unload the **model** the presentation belongs to are a separate, pre-existing gap and touched no clash field at all, so a resolved solid and a non-null `clashSelectedId` both survived them — which meant the render gate passed too, and the previous model's solid was eligible to be re-pushed into the new scene when the renderer re-initialised. All three now route through the same store invalidation:

  - `resetViewerState()` (`apps/viewer/src/store/index.ts`), the primary-file "open another model" reset. Same stale-model-reference class as the `compareResult` / `zoneAssignments` / `searchIndexes` drops beside it — a clash result is keyed by `model:expressId` pairs from the outgoing model, and an IFCX recomposition reassigns expressIds outright.
  - `clearAllModels()` (`apps/viewer/src/store/slices/modelSlice.ts`): a full federation teardown leaves nothing for a solid to be drawn against.
  - `removeModel()` drops the focused-clash **presentation** but keeps the clash **result**: the result is a list the user is reading, while the solid is a mesh in the live scene whose model set just changed under it.

  Clash presets and settings are workspace preferences and survive all three, as they do everywhere else `clearClash` is called.

  The solid is not the only thing `focusClash` draws, though, and the same "one decision, several spellings" shape produced a second ghost. Ending a clash focus means clearing the A/B pair tint, the contact marker (`clashContactLines`, or the `clashOverlapBox` AABB fallback) and the solid — but that field list was written out by hand in seven callers, and they had drifted to different subsets. `Viewport.tsx` draws the contact marker from an effect keyed on `[clashOverlapBox, clashContactLines, showClashRegionBox]` alone — it reads neither `clashSelectedId` nor `clashSolidStatus` — so a teardown that cleared only the solid and the selected id did not retract the wireframe. Two callers had that bug:

  - `removeModel()` left the contact outline drawn in world space over models that had just been unloaded.
  - `ClashPanel`'s unmount cleanup cleared `clashOverlapBox` but not `clashContactLines`, which is the field that carries the marker in the common case: `focusClash` prefers the real contact interface and nulls the box when it can build one. Closing the panel on such a clash left its outline behind.

  Both are fixed by making the field list exist once. `clearClashFocus()` (`apps/viewer/src/store/slices/clashSlice.ts`) is now the single complete spelling of "stop drawing the focused clash" — tint, marker, solid, selected id and the `clashSolidRequestSeq` bump — and `clearClash` composes the same shared constant, so the two cannot drift. Every teardown path (`removeModel`, `ClashPanel`'s unmount, the clash tour cleanup, Home / "Show all", `useClash`'s `clearHighlight` / `clearAll` / pre-run discard) calls it instead of listing fields, so a teardown path added later is complete by construction rather than by remembering.

  The clash-slice fields are not the whole presentation, though. `focusClash` writes two more channels that no clash action can reach, and the model-lifecycle paths were leaving both behind:

  - The shared **visibility** channels (`ghostExceptEntities` / `isolatedEntities`, `visibilitySlice`). `focusClash` writes exactly one of them per focus: `isolate` hides everything but the pair (one click from every panel row), `ghost` fades the pair's context, and the resolved-solid path ghosts the _entire_ model (`installClashGhost(new Set())`) so nothing opaque buries the overlap. Focus a clash in a federated session, then remove the model it belongs to: the solid, the marker and the selected id all went, while every surviving model stayed translucent — or, in isolate mode, invisible — with nothing selected and no way to tell why.
  - The **colour-override** channel (`pendingColorUpdates`, `dataSlice`). `clashHighlightColors` is only a record of the A/B tint; the albedo override the user actually sees is pushed separately into a fire-and-forget effect (`useGeometryStreaming.ts` → `scene.setColorOverrides`) that is undone only by a _later_ push. Clearing the record left the amber/cyan pair painted on the models that survived, and kept lens colouring suppressed with it. Every user-initiated end of a focus already ends with `setPendingColorUpdates(lensAppliedColors ?? new Map())` for exactly this reason.

  `removeModel()`, `clearAllModels()` and `resetViewerState()` now end all three channels through one helper, `endClashScenePresentation` (`apps/viewer/src/lib/clash/visibility-ownership.ts`), so a fourth model-lifecycle teardown is complete by construction rather than by remembering. `resetViewerState` was the odd one out: it set `pendingColorUpdates: null`, and `null` is a **no-op** in the effect that owns that channel — only a non-null _empty_ map reaches `scene.clearColorOverrides()` — so the outgoing file's pair tint stayed pushed at the renderer across a model switch.

  The two shared channels are released **by ownership, not unconditionally** — they have several owners besides clash (`LayerDiffView`, Space Sketch's ghost preview, "Isolate in 3D", IDS/BCF isolation, and `syncSourceModel`'s post-removal purge), and the last is a hard contract: `syncSourceModel` calls `removeModel` one line before `purgeStaleEntityState`, which deliberately _keeps_ the part of the user's X-ray or isolation still owned by a surviving model and drops only the ids burned with the replaced one. An unconditional clear would make that filter dead code on its only production path, so "Sync from source" would silently wipe the user's X-ray.

  Clash's ownership record therefore moved out of `useClash` and into the store, as `clashVisibilityOwned` on the clash slice — the channel it installed into plus the exact content it installed. It is written by the two install helpers, dropped by `applyFocusMode`'s `highlight` branch (which clears both channels and owns neither afterwards), and read by one shared predicate, `releaseOwnedClashVisibility`, which releases a channel only while it still content-matches the record. Both `useClash`'s run-start discard and every model-lifecycle teardown call that one predicate over that one record, so there is no hook-private copy left for the store's view to diverge from. It is the same shape as the lens slice's `lensRuleIsolation` / `lensAppliedHiddenIds`, which record lens ownership of these same channels in the store for the same reason.

  An earlier revision of this fix inferred ownership at the store level from `clashSelectedId` instead, because the record was unreachable there. That inference is wrong in both directions, and both are now covered by tests driving the real hook: `applyFocusMode`'s `highlight` mode — the panel's default row click — leaves a clash _selected_ while owning neither channel, so an unrelated model removal destroyed the ghost the next owner installed (on the `syncSourceModel` path, the original regression above); and `selectElement` — the chevron expand and the per-side button — installs a non-empty clash isolation and never writes `clashSelectedId`, so that isolation survived the removal and `isEntityVisible` returned false for everything.

  The colour channel has no ownership record of its own, so it is released on the two facts that do mean clash painted: a recorded pair tint (`clashHighlightColors`, written only by clash), or a visibility release that verifiably succeeded. An unrelated model removal therefore cannot switch off Pset / IDS / schedule colouring clash never took. A full teardown (`clearAllModels` / `resetViewerState`) clears all three outright and releases the colour channel to an _empty_ map rather than replaying `lensAppliedColors`: those overrides are keyed by the outgoing models' global ids.

  This is also why the visibility **channels** stay out of the clash slice's shared `CLASH_FOCUS_RESET` constant, even though that is where the rest of the field list lives: `clearClashFocus()` is also called at run start, where the release must be ownership-aware so a user's own X-ray survives pressing Run.

  The ownership **record** is a different thing, and leaving it out of that constant left one residual hole. `releaseOwnedClashVisibility` and `applyFocusMode`'s `highlight` branch were the only two places that dropped it, so every path that clears both channels _by hand_ — `useClash.clearHighlight` / `clearAll`, `ClashPanel`'s unmount, the clash tour cleanup, Home / "Show all" — ended the focus while leaving the record standing. Because ownership is tested by **value**, that stale record goes matching → cleared → _matching again_ the moment any other owner installs a set with equal content: focus a clash in ghost mode, clear the highlight, let the spaces X-ray ghost the same two elements, then remove an unrelated model, and that owner's ghost was destroyed — "Sync from source wipes the user's X-ray" all over again, by a narrower route. `clashVisibilityOwned` is therefore now a member of `CLASH_FOCUS_RESET` itself: every one of those paths already routes through `clearClashFocus()` / `clearClash()`, so ending the focus ends the claim by construction rather than by each caller remembering to.

  That only works in one order. Since the clash clear now nulls the record, the release must run **before** it; released afterwards, the predicate reads `null`, finds nothing to release, and leaves clash's own ghost or isolation standing over a scene whose models just changed — the originally reported bug, reopened. `endClashScenePresentation` is ordered accordingly (sample the paint fact, release the visibility channels, then clear the focus), as `useClash.discardSolidPresentation` already was. The order is also self-enforcing rather than merely documented: each step re-reads the store instead of sharing one snapshot, so a reordering cannot hide behind a stale read — it fails eight tests across three files.

  `removeModel()` is now also a genuine no-op for an id that is not loaded, matching `updateModel`. `syncSourceModel` and the collab room teardown can both re-enter with an already-removed id, and every other cleanup in `removeModel` is keyed to that model — but the clash teardown is not, so a stale id used to drop the user's focused clash as the side effect of a removal that removed nothing.

  One known gap remains, pre-existing and out of scope here: `useClash.run()` writes its result without a staleness check, so a run that finishes _after_ `clearAllModels()` can repopulate `clashResult` with pairs from models that are no longer loaded. The teardown paths themselves are complete; that race is a separate defect on the write side.

- [#2641](https://github.com/LTplus-AG/ifc-lite/pull/2641) [`743d4db`](https://github.com/LTplus-AG/ifc-lite/commit/743d4db5396447317999032b024e31491630d129) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix three defects in the multi-click polyline measurement mode found by adversarial review:

  - Switching away from the Measure tool with a polyline sequence in progress (or a drag mid-flight) no longer strands it. `setActiveTool` now clears the in-progress gesture whenever it leaves `'measure'` — the only way `MeasureOverlay` ever unmounts, since it is gated purely on `activeTool === 'measure'`. Switching back to Measure always starts clean.
  - Finishing a polyline with a physical double-click no longer appends a spurious near-duplicate vertex. Browsers dispatch `click, click, dblclick` for one gesture; `finishPolyline` now drops a trailing point that lands within a couple CSS px of the previous one before validating/recording, the same fix `SpaceSketchOverlay`'s polygon tool already applies to its own double-click-to-close gesture. That duplicate check is scoped to the double-click gesture alone: the screen coordinates it compares are reprojected on every camera move, so running it on the Enter or close-loop-click paths deleted genuinely distinct vertices that happened to line up after an orbit and reported a short length with nothing on screen to say so.
  - Pressing Enter (or double-clicking) on a 1-point sequence — too few points to finish — now shows an error toast instead of doing nothing silently. The sequence is left in progress rather than cancelled, matching how the AddElement polygon tool handles the same too-few-points case.

- Updated dependencies [[`90d5b35`](https://github.com/LTplus-AG/ifc-lite/commit/90d5b3563c7732c674dfd4890ab94d201b83db3d), [`20d27aa`](https://github.com/LTplus-AG/ifc-lite/commit/20d27aaae4ce1d00bccd8a5a8a4c8410cbe1ba39), [`20d27aa`](https://github.com/LTplus-AG/ifc-lite/commit/20d27aaae4ce1d00bccd8a5a8a4c8410cbe1ba39), [`20d27aa`](https://github.com/LTplus-AG/ifc-lite/commit/20d27aaae4ce1d00bccd8a5a8a4c8410cbe1ba39), [`33eb685`](https://github.com/LTplus-AG/ifc-lite/commit/33eb685de6c1578727587d87af5c3cd4a30a4122), [`20d27aa`](https://github.com/LTplus-AG/ifc-lite/commit/20d27aaae4ce1d00bccd8a5a8a4c8410cbe1ba39), [`33eb685`](https://github.com/LTplus-AG/ifc-lite/commit/33eb685de6c1578727587d87af5c3cd4a30a4122), [`e5acbb2`](https://github.com/LTplus-AG/ifc-lite/commit/e5acbb2589628d7e9f8a9d640c4b82d11f510929), [`20d27aa`](https://github.com/LTplus-AG/ifc-lite/commit/20d27aaae4ce1d00bccd8a5a8a4c8410cbe1ba39), [`2421442`](https://github.com/LTplus-AG/ifc-lite/commit/2421442363c5adf39d9405bf7a0e16b72adc73d1), [`2297fa9`](https://github.com/LTplus-AG/ifc-lite/commit/2297fa9ceeda69d754d77b83aba86152e2dee02b), [`3dd3dd4`](https://github.com/LTplus-AG/ifc-lite/commit/3dd3dd41c50f027b705b3a3b04c72f3aea66c0df), [`f5c96c5`](https://github.com/LTplus-AG/ifc-lite/commit/f5c96c581eebfcc627be96de0670c9540b61623f), [`1419b86`](https://github.com/LTplus-AG/ifc-lite/commit/1419b86206d7bc10c6f80ff6d2c33eb5958466dc), [`4a0897c`](https://github.com/LTplus-AG/ifc-lite/commit/4a0897cd5ebcfb9f0f79dc181d243bd618853a3a), [`cc8cfcf`](https://github.com/LTplus-AG/ifc-lite/commit/cc8cfcf426b02bd999aa37e0fa12ca2ff3ee18de), [`79503d3`](https://github.com/LTplus-AG/ifc-lite/commit/79503d3346c6c383c831b08ecaab94c6da13192d), [`20d27aa`](https://github.com/LTplus-AG/ifc-lite/commit/20d27aaae4ce1d00bccd8a5a8a4c8410cbe1ba39)]:
  - @ifc-lite/clash@1.8.0
  - @ifc-lite/wasm@4.7.0
  - @ifc-lite/create@2.1.1
  - @ifc-lite/renderer@1.48.1
  - @ifc-lite/export@2.9.3

## 1.34.0

### Minor Changes

- [#2645](https://github.com/LTplus-AG/ifc-lite/pull/2645) [`2d87b39`](https://github.com/LTplus-AG/ifc-lite/commit/2d87b3919c0ca5afff03e205c5f598142bbc980d) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Re-export `triangleArea` and the `Triangle` type from `@ifc-lite/clash`'s public surface (issue [#2199](https://github.com/LTplus-AG/ifc-lite/issues/2199): "mesh analysis reachable from TypeScript"). It previously existed only inside the package's clash contact solver, so nothing outside `@ifc-lite/clash` — including the viewer's Measure tool — could reach a triangulated-mesh area even though every `MeshData` already carries the `positions`/`indices` a caller needs.

  The Measure tool's Quantities panel ([#2199](https://github.com/LTplus-AG/ifc-lite/issues/2199) §1, element surface area) now reports a "mesh" area alongside the existing declared (net/gross/unqualified) and mesh volume rows: the selection's total triangulated surface area, summed live from mesh geometry via the newly-exported `triangleArea`. Unlike the mesh volume row, this needs no closed-solid proof, so it covers open shells and layered walls too — and unlike the mesh volume row, it is not invalidated by federation alignment re-baking, because it is recomputed from current vertex positions rather than read from a value cached before alignment ran. It is the sum of every meshed face (not one side), so it is labelled "mesh" and never presented as a `NetSideArea`/`GrossSideArea` equivalent. Where no mesh geometry exists for a selected element (e.g. an instanced-only occurrence with no flat mesh materialised), the panel says so rather than reporting zero.

### Patch Changes

- [#2530](https://github.com/LTplus-AG/ifc-lite/pull/2530) [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Report duplicates as coincident sets, not pairs. `findDuplicates` is pairwise, so N coincident copies of one object produce N(N−1)/2 rows and each copy is named in N−1 of them — three triplicated columns read as nine findings with every object mentioned twice. No row was ever literally repeated, but the list overstated the problem and the same object kept reappearing.

  New `groupDuplicateSets(result)` partitions a duplicate result into the connected components of the pair graph: each reported clash is an edge between two model-qualified `(model, key, ref)` elements — `ref` is in the node identity so two elements that share a GlobalId within one model stay distinct nodes instead of collapsing into one — and each component becomes one `ClashGroup` titled e.g. "3 coincident IfcWall objects". Unlike `groupClashes({ by: 'cluster' })` it needs no epsilon and cannot fuse two unrelated duplicate sets that happen to stand within the 1.5 m cluster radius of each other. Sets that span models group correctly (the same object delivered in two files). A set's severity is its most severe member, so a set containing an exact-duplicate pair still surfaces as `major`.

  Connected components treat coincidence as transitive, which under `positionTolerance` — the corner-distance gate `findDuplicates` uses by default — it strictly is not: A≈B and B≈C puts A and C in one set even if A≉C. That is deliberate — a chain of near-coincident objects is a single coordination issue, and the strict alternative would put the same object back into several findings.

  Detection and thresholds are unchanged; `ClashResult` still carries the same pairwise clashes, so the other grouping modes and BCF export are unaffected. In the viewer, a duplicate scan now RENDERS these sets: the clash panel shows one section per coincident set ("3 coincident IfcColumn objects") with the member pair rows inside it, instead of bucketing the pairwise rows under the generic severity/rule/type-pair headers; the scan's telemetry counts sets rather than pairwise rows for the same reason. The duplicate scan's position tolerance is also now a setting (Clash settings → "Duplicate tolerance", default 10 mm) — it previously always ran at the library default, with no viewer control.

  The panel's "Group by" control is now disabled during a coincident-set view: it previously stayed clickable and its selection persisted, but the sections it draws are always the coincident sets during a duplicates-only run, so choosing "By severity" or "By type pair" changed nothing on screen.

- [#2599](https://github.com/LTplus-AG/ifc-lite/pull/2599) [`8324512`](https://github.com/LTplus-AG/ifc-lite/commit/8324512daee39a018056aa88a148f72791db89c4) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Distinguish "the clash matrix found nothing" from "the clash matrix had nothing to check".

  The built-in discipline matrix (`--matrix`) is shaped for MEP/HVAC/electrical/fire coordination: every preset's `selectorA` is one of those disciplines. Run it on a model with none of those element types — an infrastructure model, for instance — and every rule matches zero elements on the A side, so the matrix silently reports "0 clashes". That reads as "this model is clean" when it actually means no rule ever ran a real comparison.

  `ClashResult` now carries a `ruleCoverage` field (per-rule counts of matched elements on each side), and `@ifc-lite/clash` exports `classifyRuleCoverage`/`ruleHadNoMatch` to turn that into one of `clean` / `partial` / `no-match` / `unknown`. The CLI's `--matrix` (and any other rule set) prints a loud `WARNING` when no rule matched anything, and a shorter note when some rules did not, in both the human summary and the `--json` output (`ruleCoverageOutcome` + `ruleCoverage`); the viewer's clash panel shows the same warning in place of the "No clashes found 🎉" empty state. Zero clashes is never treated as an error — the CLI still exits 0 — this only makes the _kind_ of zero visible.

  The `no-match` warning's wording now depends on whether a real discipline matrix ran. `--matrix` runs many rules, so its "the matrix did NOT run" phrasing is accurate there. The default path (`ifc-lite clash <file> --a <selector> --b <selector>`, no `--matrix`) builds exactly one ad-hoc rule; when only one side's selector matches nothing (e.g. `--a IfcWall --b IfcRoof` on a model with no roofs), the _other_ side did match and no matrix was ever involved — the CLI now names the empty selector ("selector B (\"IfcRoof\") matched 0 elements") instead of claiming a matrix that never ran. The viewer's clash panel makes the same distinction for its own single-rule runs (`runAll`'s "Detect all clashes" and a one-off `runPreset`) versus a real multi-rule `runMatrix`.

  Out of scope: adding infrastructure-discipline presets to the built-in matrix. That's a product decision about what an infra clash matrix should contain, not something to bundle into a diagnostic fix.

- Updated dependencies [[`7f2d9cf`](https://github.com/LTplus-AG/ifc-lite/commit/7f2d9cf1fdcf8facd9bf3f1445ddf3c665206b76), [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6), [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6), [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6), [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6), [`8324512`](https://github.com/LTplus-AG/ifc-lite/commit/8324512daee39a018056aa88a148f72791db89c4), [`5cf117d`](https://github.com/LTplus-AG/ifc-lite/commit/5cf117d1eb16dba7f3e7be67114e26ce3ec44a8f), [`5cf117d`](https://github.com/LTplus-AG/ifc-lite/commit/5cf117d1eb16dba7f3e7be67114e26ce3ec44a8f), [`5cf117d`](https://github.com/LTplus-AG/ifc-lite/commit/5cf117d1eb16dba7f3e7be67114e26ce3ec44a8f), [`a351839`](https://github.com/LTplus-AG/ifc-lite/commit/a35183910da35bd44dd38c5ed50d49d5f73b9f4a), [`5086c57`](https://github.com/LTplus-AG/ifc-lite/commit/5086c5729b6ae8ad967aafa91d96dfdb37327599), [`307693c`](https://github.com/LTplus-AG/ifc-lite/commit/307693c678d525ab007773f74e13a308bfe63b34), [`7cb7394`](https://github.com/LTplus-AG/ifc-lite/commit/7cb73940e0c23cd6b93c4483bfddb7b45cbb363a), [`649aa0c`](https://github.com/LTplus-AG/ifc-lite/commit/649aa0ccbc4e67c233b9175a6a2f9c8e1ff310ec), [`004b2ff`](https://github.com/LTplus-AG/ifc-lite/commit/004b2ff636fc0299ff669d14e6fbe1ed97881e21), [`004b2ff`](https://github.com/LTplus-AG/ifc-lite/commit/004b2ff636fc0299ff669d14e6fbe1ed97881e21), [`fffc0ee`](https://github.com/LTplus-AG/ifc-lite/commit/fffc0ee91c0c7c63955993faf470fa0581303005), [`2d87b39`](https://github.com/LTplus-AG/ifc-lite/commit/2d87b3919c0ca5afff03e205c5f598142bbc980d), [`2bd854d`](https://github.com/LTplus-AG/ifc-lite/commit/2bd854de15965b0fee684ef6fda90f2984d3e6f0), [`fffc0ee`](https://github.com/LTplus-AG/ifc-lite/commit/fffc0ee91c0c7c63955993faf470fa0581303005), [`5086c57`](https://github.com/LTplus-AG/ifc-lite/commit/5086c5729b6ae8ad967aafa91d96dfdb37327599), [`7cd8193`](https://github.com/LTplus-AG/ifc-lite/commit/7cd81939ed4acf9e93686d1d96dddcf7606fb59a)]:
  - @ifc-lite/clash@1.7.0
  - @ifc-lite/parser@4.1.0
  - @ifc-lite/wasm@4.6.0
  - @ifc-lite/renderer@1.48.0
  - @ifc-lite/drawing-2d@2.0.0
  - @ifc-lite/geometry@3.8.3
  - @ifc-lite/lens@1.18.0
  - @ifc-lite/pointcloud@0.7.0
  - @ifc-lite/solar@1.15.4
  - @ifc-lite/diff@0.7.0
  - @ifc-lite/export@2.9.2
  - @ifc-lite/ids@1.15.47
  - @ifc-lite/sdk@2.1.2
  - @ifc-lite/ifcx@2.3.6
  - @ifc-lite/mcp@0.11.2
  - @ifc-lite/merge@0.4.2

## 1.33.10

### Patch Changes

- [#2640](https://github.com/LTplus-AG/ifc-lite/pull/2640) [`6d45c9d`](https://github.com/LTplus-AG/ifc-lite/commit/6d45c9d214069ff05e843028c081562960b5eead) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Honour the LENGTHUNIT display override in the 2D section/drawing canvas's on-canvas distance and perimeter labels ([#2199](https://github.com/LTplus-AG/ifc-lite/issues/2199) slice).

  `0de10a0fd` ([#2538](https://github.com/LTplus-AG/ifc-lite/issues/2538)) wired `unitDisplayOverrides` through every measure-tool distance readout — `MeasurePanel.tsx`, `MeasurementVisuals.tsx`, `MeasurePointReadout.tsx` — but `Drawing2DCanvas.tsx`'s own measure-line and polygon-area-perimeter labels still called `formatDistance()` with no `overrides` argument, so a user who set feet as their display unit still saw metres there. `Drawing2DCanvas` now accepts a `unitDisplayOverrides` prop (defaulting to `{}`, so the no-override behaviour is unchanged) and threads it into both `formatDistance()` call sites; `Section2DPanel.tsx` reads the override map from the store and passes it down.

- Updated dependencies [[`9cccc00`](https://github.com/LTplus-AG/ifc-lite/commit/9cccc002f5f03ad96c710b6d2a1e12b1bf61172c), [`118188b`](https://github.com/LTplus-AG/ifc-lite/commit/118188b22c0685f07c3537f0500b0bcb2aa4b33f), [`9d6daac`](https://github.com/LTplus-AG/ifc-lite/commit/9d6daac8133a6f41e3d400aa597f73029fde4376), [`2a03d0f`](https://github.com/LTplus-AG/ifc-lite/commit/2a03d0fd0897f0c382c7e9b51947daad1ebb3c28)]:
  - @ifc-lite/clash@1.6.8
  - @ifc-lite/drawing-2d@1.21.2
  - @ifc-lite/plugin-api@0.3.0
  - @ifc-lite/source-dalux@0.2.3
  - @ifc-lite/renderer@1.47.0

## 1.33.9

### Patch Changes

- [#2601](https://github.com/LTplus-AG/ifc-lite/pull/2601) [`ef09a5b`](https://github.com/LTplus-AG/ifc-lite/commit/ef09a5b7d8435f84d9f6534ab967aa56794e5c88) Thanks [@louistrue](https://github.com/louistrue)! - Split `CesiumOverlay.tsx` into the four responsibilities it had accumulated.

  The file had grown past 1,000 lines carrying the Cesium viewer's lifecycle, the coordinate bridge, the model lifecycle and the solar study at once — four subjects with four different histories, interleaved. It is now 377 lines and reads as what it is: create the viewer, render the container, and call four hooks in the order their effects used to sit in.

  `cesium/useCesiumBridge` owns where the model sits (ENU/ECEF framing, grid convergence, geoid undulation, terrain clamping, placement drafts). `cesium/useCesiumModel` owns what is drawn (GLB build, readiness-gated swap, matrix updates). `cesium/useCesiumSolar` owns lighting, shadows, the sun-path dome and the sky. `cesium/useCesiumCameraSync` owns the per-frame camera mirror, and `cesium/cesium-module` the lazy CesiumJS import they share.

  Behaviour is unchanged, and the ordering that makes it unchanged is now written down: within a component React runs effect setups AND cleanups in declaration order, so the viewer effect — declared first — also cleans up first, and nothing in a later hook's cleanup may assume a live scene. Each hook documents where it must be called and what that buys it. Two teardown paths that the viewer effect cannot reach on unmount — the model's and the solar study's — are exposed as explicit `invalidate()` callbacks rather than left implicit.

- [#2595](https://github.com/LTplus-AG/ifc-lite/pull/2595) [`4ea38db`](https://github.com/LTplus-AG/ifc-lite/commit/4ea38db9f7d9d8006ae1f29b27f075202d75d286) Thanks [@louistrue](https://github.com/louistrue)! - Ribbon search moves right, Cloud sources reaches the toolbars, and a detached panel stops lying about being closed.

  The inline search field sat immediately after the ribbon tabs, competing with them for the same reading position and sliding sideways whenever the tab set changed. It now docks to the right, beside the rest of the always-on chrome, where users expect to find a search field. Load progress and the error line moved to the left of the spacer in the same pass. Parked on the right they shoved the search field every time a model started or finished loading.

  Cloud sources (CDE integrations) had the ActivityBar rail as its only entry point. Location zones had the same gap before [#2508](https://github.com/LTplus-AG/ifc-lite/issues/2508). Cloud sources is now a command on both toolbar styles, routed through `useWorkspacePanelControls` so the panel's single-tenant docking, its float and pop-out re-docking, and its latched state are one implementation rather than two. Both panels reach the command palette too, along with World context, Sun & Sky and SpaceMouse. Location zones is the cautionary case: it was wired into both toolbars at [#2508](https://github.com/LTplus-AG/ifc-lite/issues/2508) and still never reached the palette, so a fix that looked complete left a third door shut.

  **A detached panel now reads as open, and toggling it brings it home.** A panel lives in one of four places, but the toolbars only read the dock flags, and the two answers come apart the moment a panel is floated or popped out. `floatPanel` leaves the dock flag set, then the sidebar's exclusivity rule clears it as soon as any other panel docks, without touching the float channel. Float BCF, open IDS, and the BCF window sat on screen with every toolbar latch dark. Clicking a floating panel was worse than useless: the bottom strip cleared the flag and orphaned the window, while a side panel was torn down entirely instead of re-docking. The activity bar never had either bug because it asks `panelLocation`. The shared hook now asks the same question, and hands bottom-strip clicks to the store's `toggleBottomPanel` rather than re-deriving the flag flips. It could not delegate before, because it spelled the entity-list panel `'list'` where the registry and store spell it `'lists'`.

  **The mobile bottom sheet showed the wrong panel.** It hand-wrote a chain over the seven panels it knew and fell through to the Properties panel for the rest, so Compare, Clash, Cloud sources, the Layer stack, Location zones and the collab Room all opened on a phone as Properties, titled "Properties". It now renders through `renderPanelBody`, the same map the sidebar, the floating host and the pop-out windows use, and titles from the registry.

  **Controls that did nothing now say so.** Add Element is disabled for viewer and commenter roles on the classic Panels menu, matching the ribbon; the palette withholds its three authoring commands for those roles instead of listing commands the store silently rejects. The ribbon's collab Room button is no longer hidden until you are already in a room, which is how the other three surfaces have always offered it.

  Naming and shortcut corrections across surfaces: the Information panel was also called "Inspector" and "Properties"; Hierarchy was also "Spatial Tree"; Frame Selection was "Focus" on the ribbon; Show all was "Display all". The Isolate button advertised `I / =`, but `=` runs set-basket, which differs once the basket is non-empty; the palette advertised `I` for a command that runs set-basket. Ribbon button labels were split between Title Case and sentence case, and the minority is converted.

  Tests: `cloud-sources-parity` clicks the real control on all three surfaces, `detached-panel-latch` covers the float and pop-out cases in both regions, and `mobile-sheet-coverage` fails if a registry panel renders nothing or renders another panel's body. Each was mutation-checked against the defect it describes. Testing the palette needed one harness gap closed: `vite-module-hooks` now serves Vite's `?raw` imports as file text, which is what made `CommandPalette` unmountable under `tsx --test`.

- [#2607](https://github.com/LTplus-AG/ifc-lite/pull/2607) [`2bb936c`](https://github.com/LTplus-AG/ifc-lite/commit/2bb936c213fdb7ca78d42b14a4cb207fbcfd6f18) Thanks [@louistrue](https://github.com/louistrue)! - X-Ray now reaches 3D World Context, and glass on the map looks like glass.

  The world view drew every element fully opaque no matter its alpha. Clash focus in ghost mode, the Space Sketch preview and layer diff all faded the model in the viewport and changed nothing on the map; authored `IfcSurfaceStyleRendering` transparency was ignored there too. The cause was one line that was never written: a glTF material with no `alphaMode` is `OPAQUE` per spec, so Cesium discarded the per-vertex alpha the exporter had been packing all along.

  The merged GLB now emits up to two primitives over the same vertex buffers — one opaque, one `alphaMode: 'BLEND'` — split by mesh alpha. Splitting rather than blending the whole model keeps the bulk of the geometry out of the translucent pass, where triangles are not depth-sorted against each other. A model with no translucent geometry still emits exactly one primitive, as before.

  `@ifc-lite/renderer` exports `DEFAULT_GHOST_ALPHA` and `OPAQUE_ALPHA_CUTOFF` so the world view matches the viewport's ghosting rather than inventing its own; the ghost alpha was previously a literal inside `Renderer.render`. Selection is exempt from ghosting on the map exactly as it is in the viewport, and the GLB cache key carries a content-based ghost epoch so an equal set does not rebuild.

  One deliberate difference: GPU-instanced occurrences ghost on the map but not in the viewport, because the renderer's instanced pass never receives the ghost set. That is the viewport being wrong, and replicating it to stay symmetrical would have meant copying a defect.

- Updated dependencies [[`3af6d2a`](https://github.com/LTplus-AG/ifc-lite/commit/3af6d2ad076e76fc95e58a9252bf712f8513c6e9), [`9e6020d`](https://github.com/LTplus-AG/ifc-lite/commit/9e6020d116b2669cfb934cfa40b9f4f74d87fad5), [`cd72412`](https://github.com/LTplus-AG/ifc-lite/commit/cd724127245fcb767894642cd0994baaba88ff7d), [`b85b2be`](https://github.com/LTplus-AG/ifc-lite/commit/b85b2be4dd79045f1dd02ed344d102f27ecc2594), [`c9953ec`](https://github.com/LTplus-AG/ifc-lite/commit/c9953ec6691003a2cfada80da28effcdfcf5e56c), [`bd92912`](https://github.com/LTplus-AG/ifc-lite/commit/bd92912965b6b1ab6573a4b304b1e54d494c22b7), [`9175e35`](https://github.com/LTplus-AG/ifc-lite/commit/9175e35b29ff57b39b671e5db33f38c7807fb0fd), [`9b4d791`](https://github.com/LTplus-AG/ifc-lite/commit/9b4d791990cf72786b04f5b02933395fed1fe085), [`cd72412`](https://github.com/LTplus-AG/ifc-lite/commit/cd724127245fcb767894642cd0994baaba88ff7d), [`2bb936c`](https://github.com/LTplus-AG/ifc-lite/commit/2bb936c213fdb7ca78d42b14a4cb207fbcfd6f18), [`e51f5cb`](https://github.com/LTplus-AG/ifc-lite/commit/e51f5cb82d10b6c7d73186d8126f788b48c7f3a1)]:
  - @ifc-lite/clash@1.6.7
  - @ifc-lite/source-dalux@0.2.2
  - @ifc-lite/geometry@3.8.2
  - @ifc-lite/parser@4.0.3
  - @ifc-lite/renderer@1.46.0
  - @ifc-lite/extensions@0.4.2
  - @ifc-lite/create@2.1.0
  - @ifc-lite/export@2.9.0
  - @ifc-lite/wasm@4.5.1
  - @ifc-lite/ids@1.15.46

## 1.33.8

### Patch Changes

- [#2588](https://github.com/LTplus-AG/ifc-lite/pull/2588) [`21fece1`](https://github.com/LTplus-AG/ifc-lite/commit/21fece1f4848fe34c8070f9e3d79b89a1ef0576b) Thanks [@louistrue](https://github.com/louistrue)! - Split the Location panel's helpers out of `LocationMap.tsx`, and cover them with tests they never had.

  `LocationMap.tsx` was past the ~400-line rule and kept growing. Four units that had no business living inside a component moved out: MapLibre load/dispose/purge (`location-map-lifecycle`), the footprint polygon's matched add/remove pair (`location-map-footprint`), Nominatim place search (`location-map-geocode`), and the generic `useDebouncedValue` hook.

  None of them had a single test before. They do now, covering the parts that actually bite: the footprint pair must leave nothing behind, because MapLibre throws on a duplicate source and the panel re-runs this on every style toggle; the geocoder must resolve to `[]` rather than reject on a rate-limit, an offline network or an HTML error page, because the panel calls it from an effect with no rejection handling; the debounce must DROP intermediate values, not merely delay them, or it would still hammer the geocoder per keystroke; and the map teardown must contain a throw from `map.remove()`, because it runs from an effect cleanup where an escaping error would strand the panel half torn down.

- [#2586](https://github.com/LTplus-AG/ifc-lite/pull/2586) [`48683a0`](https://github.com/LTplus-AG/ifc-lite/commit/48683a0816f5332a40f73eabde613301026d9744) Thanks [@louistrue](https://github.com/louistrue)! - 3D World Context no longer blinks out while it rebuilds.

  The world view dropped its model the moment anything invalidated it — a streaming geometry batch, a type toggle, a georef edit, a hide — and only then started a one-second debounce, a GLB build and a glTF load. The building disappeared from the map for over a second on every edit, which reads as the model being broken rather than reloading.

  The model now stays on the globe while its replacement is built, and the two are exchanged only once the new one can actually draw. That last part matters: `Model.fromGltfAsync` resolving means the glTF was fetched and parsed, not that the model is renderable — Cesium creates its WebGL resources across later frames and skips one more frame after raising `readyEvent`. Swapping at construction time would have replaced a drawable primitive with a blank one and left the map empty for several frames, a much shorter version of the same defect. The effect cleanup only cancels the in-flight build; the model is torn down when its geometry goes away, or with the viewer.

  A rebuild no longer flips `cesiumGlbLoaded` false and back, so the solar study — which relied on that flip to re-apply shadow settings to the new primitive — now keys on a model epoch that changes whenever a different primitive reaches the globe.

- Updated dependencies [[`495cc38`](https://github.com/LTplus-AG/ifc-lite/commit/495cc388ea95f6e55aee76ea37bcf6d11c99558b), [`081ed7e`](https://github.com/LTplus-AG/ifc-lite/commit/081ed7e7e38072ecb307c01c0512cd911be886a6), [`a38012f`](https://github.com/LTplus-AG/ifc-lite/commit/a38012f6d9fec6b9ea934b22016c9005579a54b7)]:
  - @ifc-lite/clash@1.6.6
  - @ifc-lite/renderer@1.45.1

## 1.33.7

### Patch Changes

- [#2576](https://github.com/LTplus-AG/ifc-lite/pull/2576) [`e09f824`](https://github.com/LTplus-AG/ifc-lite/commit/e09f8247eae1a7291f4e2ce18272ec4c2c7660ae) Thanks [@louistrue](https://github.com/louistrue)! - 3D World Context now shows the whole model — repeated geometry (curtain-wall facades, mullions, windows) no longer disappears on the map.

  The Cesium overlay built its GLB from `geometryResult.meshes`, which by design holds only part of the model: GPU-instanced occurrences render from compact shards and are deliberately absent from that flat list, as `utils/instancedExport.ts` documents and as the glTF and IFC exporters already compensate for. The world view never did, so every repeated occurrence was dropped from the map while the WebGPU viewport drew it correctly. On the model from issue [#2558](https://github.com/LTplus-AG/ifc-lite/issues/2558) that was 9,950 of 18,555 meshes and 396K of 655K triangles — a tower's entire facade gone, leaving bare floor slabs over Google's imagery.

  Building the GLB and its cache key now live together in `lib/geo/cesium-model-glb.ts`, which materialises the instanced half through the same `withInstancedMeshes` helper the exporters use. The cache key also counts instanced entities rather than flat meshes alone, so a geometry batch whose occurrences are all instanced — one that adds no flat meshes at all — no longer reads as "unchanged". It also folds in `geometryContentVersion`, so an in-place edit such as a gizmo move, which changes no count at all, invalidates the cached bytes too.

- [#2582](https://github.com/LTplus-AG/ifc-lite/pull/2582) [`f01588b`](https://github.com/LTplus-AG/ifc-lite/commit/f01588bc83593c621d521233cf697393c6df1936) Thanks [@louistrue](https://github.com/louistrue)! - KMZ export no longer ships a model with its repeated geometry missing.

  `buildKmzForResolvedGeoref` was handed `geometryResult.meshes`, which holds only part of the model: GPU-instanced occurrences render from compact shards and are deliberately absent from that flat list. Both surfaces that export a KMZ — the Export KMZ dialog and the Location panel's "Google Earth" button — passed it, so a tower whose facade is repeated panels exported to Google Earth as bare floor slabs. Same defect [#2576](https://github.com/LTplus-AG/ifc-lite/issues/2576) fixed for the on-screen world view, in the file the user hands to someone else.

  The complete set is now derived inside the shared builder, from a `geometryResult` rather than a mesh array, so there is no way for a call site to pass a pre-flattened list — the same reason the builder refuses a pre-guarded conversion. Callers pass `isPrimaryModel` alongside it, since instanced shard occurrences live in the primary model's id space and a federated model must not adopt them.

- [#2581](https://github.com/LTplus-AG/ifc-lite/pull/2581) [`645b066`](https://github.com/LTplus-AG/ifc-lite/commit/645b066cfb2ab0f09c076df17cadca9a79d525fe) Thanks [@louistrue](https://github.com/louistrue)! - 3D World Context now hides what you hide: hide and isolate reach the map, not just the viewport.

  The world view renders the model through its own glTF pipeline, so it never inherited the per-frame hide/isolate filtering the WebGPU renderer applies. It honoured type visibility (its mesh list arrives pre-filtered) but nothing else — hide an element, or isolate a storey, and the map kept drawing everything. Since [#2576](https://github.com/LTplus-AG/ifc-lite/issues/2576) gave the world view the GPU-instanced half of the model as well, that gap covered both geometry channels.

  `@ifc-lite/renderer` now exports the rule itself rather than leaving each surface to restate it. `isEntityVisible(expressId, hiddenIds, isolatedIds)` was written out separately at the flat-draw and instanced-draw sites; both now call the shared helper, and so does the world view. `VisibilityEpochTracker` — already used internally for content-based change detection on those two sets — is exported alongside it, so a consumer outside the render loop can tell a real visibility change from a store handing out a fresh Set with identical content.

  Two details the shared rule pins down, both easy to get wrong when restating it: an EMPTY isolation set isolates _nothing_ (it hides everything) and is not the same as `null` (no isolation), and hiding wins over isolation.

- Updated dependencies [[`6d09c4a`](https://github.com/LTplus-AG/ifc-lite/commit/6d09c4a768a9caa1600fb6db38d0e80ec8051aee), [`02079a6`](https://github.com/LTplus-AG/ifc-lite/commit/02079a66042a6e446b9f83f656685f6056020718), [`6d09c4a`](https://github.com/LTplus-AG/ifc-lite/commit/6d09c4a768a9caa1600fb6db38d0e80ec8051aee), [`6d09c4a`](https://github.com/LTplus-AG/ifc-lite/commit/6d09c4a768a9caa1600fb6db38d0e80ec8051aee), [`645b066`](https://github.com/LTplus-AG/ifc-lite/commit/645b066cfb2ab0f09c076df17cadca9a79d525fe)]:
  - @ifc-lite/export@2.8.6
  - @ifc-lite/data@3.3.0
  - @ifc-lite/ifcx@2.3.5
  - @ifc-lite/mutations@1.26.0
  - @ifc-lite/wasm@4.5.0
  - @ifc-lite/renderer@1.45.0
  - @ifc-lite/ids@1.15.45
  - @ifc-lite/lists@1.23.1

## 1.33.6

### Patch Changes

- Updated dependencies [[`2e18adc`](https://github.com/LTplus-AG/ifc-lite/commit/2e18adc0e6983dbd5832367429cc3782e2cb2d1e), [`2e18adc`](https://github.com/LTplus-AG/ifc-lite/commit/2e18adc0e6983dbd5832367429cc3782e2cb2d1e), [`2e18adc`](https://github.com/LTplus-AG/ifc-lite/commit/2e18adc0e6983dbd5832367429cc3782e2cb2d1e), [`0ab480d`](https://github.com/LTplus-AG/ifc-lite/commit/0ab480dd78fbce9f8159b6248579356cfa25bfaa), [`7ee619f`](https://github.com/LTplus-AG/ifc-lite/commit/7ee619f8c6a7490982136d5677674f4f6355a568), [`bb0c1fe`](https://github.com/LTplus-AG/ifc-lite/commit/bb0c1feab74d0e4b76b66acbabf7bebe45144b25), [`1e13943`](https://github.com/LTplus-AG/ifc-lite/commit/1e139434adac8e98e6e40c989b257e5ec87aa20a), [`b4b3e0c`](https://github.com/LTplus-AG/ifc-lite/commit/b4b3e0cfa8ffa9185e96dc266dd6fdc3fef34797), [`7ec9876`](https://github.com/LTplus-AG/ifc-lite/commit/7ec9876202b3fd4d83fda5f23931740a6b0e4e25), [`c532d6a`](https://github.com/LTplus-AG/ifc-lite/commit/c532d6a9cb9397a24e718bcfe09f1c515067852d), [`1de1696`](https://github.com/LTplus-AG/ifc-lite/commit/1de16969db1c56f4901e4af49da74085bae3b3fe), [`ed9acf0`](https://github.com/LTplus-AG/ifc-lite/commit/ed9acf0d5a11c291caa70165e9d673812c75c7fa)]:
  - @ifc-lite/cache@3.0.4
  - @ifc-lite/geometry@3.8.1
  - @ifc-lite/parser@4.0.2
  - @ifc-lite/renderer@1.44.1
  - @ifc-lite/server-client@1.22.1
  - @ifc-lite/encoding@2.0.0
  - @ifc-lite/lists@1.23.0
  - @ifc-lite/ids@1.15.44
  - @ifc-lite/bcf@1.18.1
  - @ifc-lite/create@2.0.3
  - @ifc-lite/data@3.2.4
  - @ifc-lite/export@2.8.5
  - @ifc-lite/sdk@2.1.1

## 1.33.5

### Patch Changes

- [#2369](https://github.com/LTplus-AG/ifc-lite/pull/2369) [`884ba81`](https://github.com/LTplus-AG/ifc-lite/commit/884ba8117ed819f88d0abc20a8d662d8eb52e774) Thanks [@louistrue](https://github.com/louistrue)! - Hand workers a source _envelope_ instead of the whole source bytes ([#2183](https://github.com/LTplus-AG/ifc-lite/issues/2183)).

  `getWholeSourceForWorker` now returns an `IfcSourceTransfer` rather than a `Uint8Array`, and the overlay-parse and IDS workers rebuild it on their own thread with `sourceBytesFromTransferable`.

  Behaviour-neutral today: a resident source describes itself as its underlying view, and a `SharedArrayBuffer` survives structured clone by reference, so the handoff stays exactly as cheap as it was. It matters once a source can be block-compressed, because materializing on the main thread would reintroduce the whole-file allocation the issue exists to remove — on the render thread, on every overlay re-parse.

  The IDS client also drops its manual copy-then-transfer step. This is a simplification, not a speed-up: structured clone serializes on the _sending_ thread, so a non-shared buffer costs the main thread an O(N) write either way. What it removes is the explicit `slice()`; what it must keep is that nothing goes into a transfer list, since transferring the source would detach the viewer's own bytes. On the paths that matter the source is `SharedArrayBuffer`-backed and crosses by reference, so neither form copies at all.

- Updated dependencies [[`1843d9f`](https://github.com/LTplus-AG/ifc-lite/commit/1843d9f13a7a10183f780ae0a1df9dd225938e73), [`8b09cfd`](https://github.com/LTplus-AG/ifc-lite/commit/8b09cfdadafaea9806e79b73deb9119ea66b5aa4), [`a500a98`](https://github.com/LTplus-AG/ifc-lite/commit/a500a9892ef1e40a0b42db37023c07c62259abdc), [`51cd3ab`](https://github.com/LTplus-AG/ifc-lite/commit/51cd3ab46c7f9d40588e319e7b2c24ce66e99c29), [`341901f`](https://github.com/LTplus-AG/ifc-lite/commit/341901f94c7ae16cb6b2e34542ee2958f1a9ae95), [`c8f771c`](https://github.com/LTplus-AG/ifc-lite/commit/c8f771ca15754cf314288f6797ac05a674a1e6b1), [`a220406`](https://github.com/LTplus-AG/ifc-lite/commit/a2204062ba1fc555e4529896cbc82efccc7a5146), [`29409e5`](https://github.com/LTplus-AG/ifc-lite/commit/29409e57227d3c458707dbc2cf0cb2e8ae8fcf7b), [`5dd1d18`](https://github.com/LTplus-AG/ifc-lite/commit/5dd1d181437bf0d1d357f3c5505049f802beb2cf), [`6635ddf`](https://github.com/LTplus-AG/ifc-lite/commit/6635ddfa91911b0fbc489452c02cf19e232201c3), [`6f5566f`](https://github.com/LTplus-AG/ifc-lite/commit/6f5566fa761f25a02818a750351b0b0db785ef9b), [`3029cb2`](https://github.com/LTplus-AG/ifc-lite/commit/3029cb2813940438dd43de3cca9e6b25546dad80), [`70c431d`](https://github.com/LTplus-AG/ifc-lite/commit/70c431d3d9a12a5217ac0c1912da18bce7548e4e), [`55f7591`](https://github.com/LTplus-AG/ifc-lite/commit/55f759154421bd002d0bdc171e82aa93b574470d), [`d260a35`](https://github.com/LTplus-AG/ifc-lite/commit/d260a35669e379e5f465861294391c95ee48cb3d), [`d75786f`](https://github.com/LTplus-AG/ifc-lite/commit/d75786f631047d234f204289426f708f0be8674b), [`51cd3ab`](https://github.com/LTplus-AG/ifc-lite/commit/51cd3ab46c7f9d40588e319e7b2c24ce66e99c29), [`e20c520`](https://github.com/LTplus-AG/ifc-lite/commit/e20c520b0c898ecd3c418e338e3684d6f9f39fed), [`273b068`](https://github.com/LTplus-AG/ifc-lite/commit/273b06827ef1469f63c396d204474a9f2400c642), [`79781f5`](https://github.com/LTplus-AG/ifc-lite/commit/79781f57c50bbc9641516a42d0de53e5b9d89932), [`403f448`](https://github.com/LTplus-AG/ifc-lite/commit/403f4485c21b9928f16566fa482c170f230852b0), [`58fbc63`](https://github.com/LTplus-AG/ifc-lite/commit/58fbc634994742c79375830c1983508752fd78e9), [`a220406`](https://github.com/LTplus-AG/ifc-lite/commit/a2204062ba1fc555e4529896cbc82efccc7a5146), [`c866bee`](https://github.com/LTplus-AG/ifc-lite/commit/c866bee62a7d6e40b15a7de63948354cbbe049a7), [`262b9df`](https://github.com/LTplus-AG/ifc-lite/commit/262b9df485e4bfd3760f73c30d93bb518e599b72), [`d4d980b`](https://github.com/LTplus-AG/ifc-lite/commit/d4d980bc3847ae94bfb043f447cb893b43d48077), [`e47a8f0`](https://github.com/LTplus-AG/ifc-lite/commit/e47a8f0f56800af1d6cbee3d63dfe9b106c9b343), [`bf44de2`](https://github.com/LTplus-AG/ifc-lite/commit/bf44de2d8d023f22e2f4010a0c7832543221909e), [`d954df3`](https://github.com/LTplus-AG/ifc-lite/commit/d954df35ef9e01f30e0a26333381b4dd50f9e59e), [`d27d043`](https://github.com/LTplus-AG/ifc-lite/commit/d27d043c62a0243ac95c4b25d7262e96622f3e3e), [`4565cf3`](https://github.com/LTplus-AG/ifc-lite/commit/4565cf3bf8e04a289cf066a8858ded7c972c1c21), [`15f3c23`](https://github.com/LTplus-AG/ifc-lite/commit/15f3c23a417d3af29a0a8302ce68173b016c6369), [`22a1eae`](https://github.com/LTplus-AG/ifc-lite/commit/22a1eae0d2b349d9abd18c7aced0c57a2f90c03a), [`2e16736`](https://github.com/LTplus-AG/ifc-lite/commit/2e167367037fa3b5d1d2d5d26dd4fb7ac169e2f5), [`ef2accf`](https://github.com/LTplus-AG/ifc-lite/commit/ef2accf9bde98e0e5dd9fcb56a1b82d385f604ff), [`710fd83`](https://github.com/LTplus-AG/ifc-lite/commit/710fd83638b51b2e4744a1ac364827a27dc0fc73), [`d9490e6`](https://github.com/LTplus-AG/ifc-lite/commit/d9490e6e2ecacb65aea42fcaef73fd292a4c3095), [`55f7591`](https://github.com/LTplus-AG/ifc-lite/commit/55f759154421bd002d0bdc171e82aa93b574470d), [`d89960a`](https://github.com/LTplus-AG/ifc-lite/commit/d89960aaab08387fbd2307c0f238bd112c684933), [`f67c622`](https://github.com/LTplus-AG/ifc-lite/commit/f67c622147ea51f2b04b93a7b7a9b485160b3e9c), [`33f11a8`](https://github.com/LTplus-AG/ifc-lite/commit/33f11a82d34b622c9d6d2c417e9fb38a7ace816e), [`c8f771c`](https://github.com/LTplus-AG/ifc-lite/commit/c8f771ca15754cf314288f6797ac05a674a1e6b1), [`8751ba4`](https://github.com/LTplus-AG/ifc-lite/commit/8751ba41dc4d1893530b0f1db6ad0f8fa0d5d3fd), [`deb54d3`](https://github.com/LTplus-AG/ifc-lite/commit/deb54d3ff75f35c3c9206c8ea9a1e875426352c6), [`51ec81b`](https://github.com/LTplus-AG/ifc-lite/commit/51ec81b125532cd0efe4f004c7ab01f4efe55cb8), [`35e37ac`](https://github.com/LTplus-AG/ifc-lite/commit/35e37ac99ab444773bfec669cfc5cf3937443942), [`2618511`](https://github.com/LTplus-AG/ifc-lite/commit/26185118071131a995b2d6a7e9f83bf1c9d578e4), [`acdddd9`](https://github.com/LTplus-AG/ifc-lite/commit/acdddd91b205d83374e2f820fcfe17db1c9abc4d), [`641530e`](https://github.com/LTplus-AG/ifc-lite/commit/641530e73c73bda24b6dc69d3a9fd8910ee16ec8), [`858fd6b`](https://github.com/LTplus-AG/ifc-lite/commit/858fd6bb0c92140bf6c3752cdc37e705e8202425), [`c589d5a`](https://github.com/LTplus-AG/ifc-lite/commit/c589d5af185d25efc20ec56b8f97849e2a20de7e), [`6668c66`](https://github.com/LTplus-AG/ifc-lite/commit/6668c66f02542cfb31e9c9c679e0c80f9a3abc40), [`dae94e2`](https://github.com/LTplus-AG/ifc-lite/commit/dae94e23f7514945ca60f7074f50f196a90dfc5d), [`b57f04c`](https://github.com/LTplus-AG/ifc-lite/commit/b57f04c45082bad7269e7f103f361b0947435cc4), [`c777cad`](https://github.com/LTplus-AG/ifc-lite/commit/c777cadde939b4bc84b08bc0366d54d34601d66c), [`8d1972d`](https://github.com/LTplus-AG/ifc-lite/commit/8d1972d059fe5e8725fffbf661cc56bb6a23767b), [`07d5309`](https://github.com/LTplus-AG/ifc-lite/commit/07d53098b7e9099152300e705d8a41430831f81c), [`958aef1`](https://github.com/LTplus-AG/ifc-lite/commit/958aef125743682da75c3da7b41991abd9d36d32), [`de7bd04`](https://github.com/LTplus-AG/ifc-lite/commit/de7bd04619a43a32900b188e0507b95e7542d8c8), [`09d67c7`](https://github.com/LTplus-AG/ifc-lite/commit/09d67c780bf68f58dec3f77920927857c752f8da), [`f86436b`](https://github.com/LTplus-AG/ifc-lite/commit/f86436bb464349c7ae653c275cdc13c6c4b1ca8f), [`72bf949`](https://github.com/LTplus-AG/ifc-lite/commit/72bf949bd3a58dfb460c2c445e546d930a248e02), [`512406f`](https://github.com/LTplus-AG/ifc-lite/commit/512406f0d21c7e33b8c84a83865ffaff299e7cc1), [`81e5415`](https://github.com/LTplus-AG/ifc-lite/commit/81e541588ff5e5665b9091179a87bc4d03cd77f9), [`5d763d6`](https://github.com/LTplus-AG/ifc-lite/commit/5d763d6bde10c0232cbf28e7d8e4e956ebaf4ff1), [`0671811`](https://github.com/LTplus-AG/ifc-lite/commit/0671811856888b8b930d3068166cff286a21a8c2), [`f9f5fb7`](https://github.com/LTplus-AG/ifc-lite/commit/f9f5fb701ea0ace55a68c7d53085774052ee8995), [`a803c35`](https://github.com/LTplus-AG/ifc-lite/commit/a803c3599d777669341b69309e7dab20cdf16db0)]:
  - @ifc-lite/bcf@1.17.0
  - @ifc-lite/cache@3.0.3
  - @ifc-lite/renderer@1.43.0
  - @ifc-lite/plugin-api@0.2.0
  - @ifc-lite/collab@0.4.2
  - @ifc-lite/create@2.0.2
  - @ifc-lite/merge@0.4.1
  - @ifc-lite/drawing-2d@1.21.1
  - @ifc-lite/export@2.8.3
  - @ifc-lite/query@1.14.16
  - @ifc-lite/data@3.2.2
  - @ifc-lite/mcp@0.11.1
  - @ifc-lite/encoding@1.15.1
  - @ifc-lite/ids@1.15.42
  - @ifc-lite/ifcx@2.3.4
  - @ifc-lite/pointcloud@0.6.1
  - @ifc-lite/lists@1.22.4
  - @ifc-lite/server-client@1.22.0
  - @ifc-lite/parser@4.0.0
  - @ifc-lite/mutations@1.24.2
  - @ifc-lite/geometry@3.7.1
  - @ifc-lite/sandbox@2.1.0
  - @ifc-lite/clash@1.6.5
  - @ifc-lite/sdk@2.0.3
  - @ifc-lite/source-dalux@0.2.0

## 1.33.4

### Patch Changes

- Updated dependencies [[`58f0473`](https://github.com/LTplus-AG/ifc-lite/commit/58f0473b792e6bd29b42f16bac41fc398ecb600d), [`2c47277`](https://github.com/LTplus-AG/ifc-lite/commit/2c47277ee6dfbd9779eb4948d1f2e7b0ea61d00e), [`5371d7d`](https://github.com/LTplus-AG/ifc-lite/commit/5371d7def2671f6568c838879b8be058bb6247c9), [`bdeb80d`](https://github.com/LTplus-AG/ifc-lite/commit/bdeb80d79443d89027a4d96879116e99dcc989a4), [`b3742d9`](https://github.com/LTplus-AG/ifc-lite/commit/b3742d9d29c3adfcbf67f573c62194547d7d172d), [`803005f`](https://github.com/LTplus-AG/ifc-lite/commit/803005f1c8d976350111c2f52a6b41b584393ca6), [`9d9c804`](https://github.com/LTplus-AG/ifc-lite/commit/9d9c8049075c9d8692a483ef1fa75325e822c15a), [`a25dd32`](https://github.com/LTplus-AG/ifc-lite/commit/a25dd32a78626a0ed697a21ed2c4963641bb7b89), [`07c0b4c`](https://github.com/LTplus-AG/ifc-lite/commit/07c0b4cc5a0b5617ed6ad300639e5c52ce225d44), [`4c739be`](https://github.com/LTplus-AG/ifc-lite/commit/4c739be2aba74ad6868b6dca51dad441c6fa9903), [`d85ef9b`](https://github.com/LTplus-AG/ifc-lite/commit/d85ef9bb725843f682463496e7a8f2d2ab9b83f1), [`f493930`](https://github.com/LTplus-AG/ifc-lite/commit/f4939309aed136979bd5cc1f95a25c2a0ebe779f), [`befc108`](https://github.com/LTplus-AG/ifc-lite/commit/befc1083e377315231006352cb3fe95949e92b47), [`6722e08`](https://github.com/LTplus-AG/ifc-lite/commit/6722e08b76c4cd89d8e7e1bbd06c768a36ae93ac), [`6cbf69a`](https://github.com/LTplus-AG/ifc-lite/commit/6cbf69acb2163ab671c41df36878f4d4e490e244), [`f566a3a`](https://github.com/LTplus-AG/ifc-lite/commit/f566a3af5d92728d682a150282e37de3ece3a613), [`f566a3a`](https://github.com/LTplus-AG/ifc-lite/commit/f566a3af5d92728d682a150282e37de3ece3a613), [`0ceb99a`](https://github.com/LTplus-AG/ifc-lite/commit/0ceb99a36125a2dfc8775e762d9f4f9ddb69d733), [`996f50f`](https://github.com/LTplus-AG/ifc-lite/commit/996f50f6749182f3eb3465bd390ce75fe68e549c), [`5befec5`](https://github.com/LTplus-AG/ifc-lite/commit/5befec5b6b73d2293f058b3c010c8553429f6178), [`1dade49`](https://github.com/LTplus-AG/ifc-lite/commit/1dade49f39833b1d95eb8c5b78297f77bbddca15), [`9b53852`](https://github.com/LTplus-AG/ifc-lite/commit/9b53852464b1329733cd954754923b16abf9060d), [`b47928f`](https://github.com/LTplus-AG/ifc-lite/commit/b47928f9c684413a8762330320c6ebaf02ffbbeb), [`d1d82aa`](https://github.com/LTplus-AG/ifc-lite/commit/d1d82aae99386505917a68551f033299ed8b4924), [`1303515`](https://github.com/LTplus-AG/ifc-lite/commit/1303515b8aa87cd6e8215ecf88fdf5a406b545d8), [`e03d879`](https://github.com/LTplus-AG/ifc-lite/commit/e03d879a96ba9a5818a7264d713237833e201ba3), [`a2787fa`](https://github.com/LTplus-AG/ifc-lite/commit/a2787fab292e50d60ed0081fd3d458e7555c5cb2), [`a77fbd1`](https://github.com/LTplus-AG/ifc-lite/commit/a77fbd1f4c52a5d13bd51fe37a70d306315df7fa), [`ae2debf`](https://github.com/LTplus-AG/ifc-lite/commit/ae2debf665fdbe25afd9e16411bd2347dcd4f39d), [`3c2ffa6`](https://github.com/LTplus-AG/ifc-lite/commit/3c2ffa6a1bd0a04d3d73e2ea7c0fb1a2233599a9), [`d44b6c1`](https://github.com/LTplus-AG/ifc-lite/commit/d44b6c1710ee86596e96e0204785d2bf7c0940a9)]:
  - @ifc-lite/renderer@1.42.0
  - @ifc-lite/geometry@3.7.0
  - @ifc-lite/export@2.8.2
  - @ifc-lite/pointcloud@0.6.0
  - @ifc-lite/mcp@0.11.0
  - @ifc-lite/mutations@1.24.1
  - @ifc-lite/wasm@4.3.1
  - @ifc-lite/data@3.2.1
  - @ifc-lite/cache@3.0.2
  - @ifc-lite/create@2.0.1
  - @ifc-lite/server-client@1.21.1
  - @ifc-lite/extensions@0.4.1
  - @ifc-lite/sdk@2.0.2
  - @ifc-lite/drawing-2d@1.21.0
  - @ifc-lite/sandbox@2.0.1
  - @ifc-lite/spatial@1.14.13
  - @ifc-lite/parser@3.15.1
  - @ifc-lite/ifcx@2.3.3
  - @ifc-lite/ids@1.15.41
  - @ifc-lite/lists@1.22.3

## 1.33.3

### Patch Changes

- Updated dependencies [[`59792cc`](https://github.com/LTplus-AG/ifc-lite/commit/59792cc7d15bba68708a88475861f499f7b15647), [`40e9c59`](https://github.com/LTplus-AG/ifc-lite/commit/40e9c5931fab27b0de05655e08804562dd794389), [`af869bd`](https://github.com/LTplus-AG/ifc-lite/commit/af869bd6c8133d8d13c9d62edecf04c37baa0245), [`d42fbf1`](https://github.com/LTplus-AG/ifc-lite/commit/d42fbf1c7a4abed637b7e80e28cbed69088bc943), [`e651699`](https://github.com/LTplus-AG/ifc-lite/commit/e651699180b791b95cbd721ad66d5f38e03eca2b), [`0adb741`](https://github.com/LTplus-AG/ifc-lite/commit/0adb7413b869c9d50bdcdae5c00a730d17c2823f), [`0adb741`](https://github.com/LTplus-AG/ifc-lite/commit/0adb7413b869c9d50bdcdae5c00a730d17c2823f), [`63905dc`](https://github.com/LTplus-AG/ifc-lite/commit/63905dc3993ad227500a0f68c406276c909eb6f5), [`a8e58a2`](https://github.com/LTplus-AG/ifc-lite/commit/a8e58a2b5e75db8388835c77b2688240667f68ab), [`a8e58a2`](https://github.com/LTplus-AG/ifc-lite/commit/a8e58a2b5e75db8388835c77b2688240667f68ab), [`0adb741`](https://github.com/LTplus-AG/ifc-lite/commit/0adb7413b869c9d50bdcdae5c00a730d17c2823f), [`263c3ef`](https://github.com/LTplus-AG/ifc-lite/commit/263c3efba5baf503f192700ba7f70ce08a1dafc8), [`e4782e8`](https://github.com/LTplus-AG/ifc-lite/commit/e4782e8362c0899d0df1070d5eafb70ef18481b6), [`a2ca053`](https://github.com/LTplus-AG/ifc-lite/commit/a2ca0535c14cd1bf9d55713584766dff55430158), [`e4d2db5`](https://github.com/LTplus-AG/ifc-lite/commit/e4d2db5f11798e3ec78f45249139d69aa1e65275), [`c868444`](https://github.com/LTplus-AG/ifc-lite/commit/c868444e94348a34cbea2b130968a6c7affc474e), [`084c32c`](https://github.com/LTplus-AG/ifc-lite/commit/084c32c26c82dedb32ef62d38fc60c4965c741e1), [`678e90d`](https://github.com/LTplus-AG/ifc-lite/commit/678e90d93e97d2b9ec3c8de9f2713e83361cab18), [`678e90d`](https://github.com/LTplus-AG/ifc-lite/commit/678e90d93e97d2b9ec3c8de9f2713e83361cab18), [`a5cc568`](https://github.com/LTplus-AG/ifc-lite/commit/a5cc568a642d7dd8d17f1ed7858844f9289bc841), [`a8e58a2`](https://github.com/LTplus-AG/ifc-lite/commit/a8e58a2b5e75db8388835c77b2688240667f68ab), [`a5cc568`](https://github.com/LTplus-AG/ifc-lite/commit/a5cc568a642d7dd8d17f1ed7858844f9289bc841), [`dc000cf`](https://github.com/LTplus-AG/ifc-lite/commit/dc000cff25a647d2a224f34a063f84b3d2d84ca8), [`e4d2db5`](https://github.com/LTplus-AG/ifc-lite/commit/e4d2db5f11798e3ec78f45249139d69aa1e65275), [`2716893`](https://github.com/LTplus-AG/ifc-lite/commit/2716893ac9d825fc529f3fd8164d9a6f766e87f8), [`620f4d2`](https://github.com/LTplus-AG/ifc-lite/commit/620f4d2100b397d33d2e61440950b7a31660dbb8), [`7261f1a`](https://github.com/LTplus-AG/ifc-lite/commit/7261f1a6a8595350d3ec400212e293a8924d57bf), [`8967a03`](https://github.com/LTplus-AG/ifc-lite/commit/8967a033704a7edbb03140291df7a8536d3dd892), [`8f139a8`](https://github.com/LTplus-AG/ifc-lite/commit/8f139a8ef44235b68c2f97c032419fa586111b62), [`ed63063`](https://github.com/LTplus-AG/ifc-lite/commit/ed63063c952bd1804ce83922da80635f03c77193)]:
  - @ifc-lite/wasm@4.3.0
  - @ifc-lite/diff@0.6.0
  - @ifc-lite/export@2.8.0
  - @ifc-lite/mcp@0.10.0
  - @ifc-lite/geometry@3.6.0
  - @ifc-lite/parser@3.13.0
  - @ifc-lite/data@3.2.0
  - @ifc-lite/mutations@1.23.0
  - @ifc-lite/sdk@2.0.0
  - @ifc-lite/create@2.0.0
  - @ifc-lite/sandbox@2.0.0
  - @ifc-lite/merge@0.4.0
  - @ifc-lite/ids@1.15.38
  - @ifc-lite/lists@1.22.2

## 1.33.2

### Patch Changes

- Updated dependencies [[`8793ffd`](https://github.com/LTplus-AG/ifc-lite/commit/8793ffd4948840fbd96bf745d8e9db71e139d350), [`15f5335`](https://github.com/LTplus-AG/ifc-lite/commit/15f53357f30a38d6aef7c9e4394c14400f5222e5), [`80051a5`](https://github.com/LTplus-AG/ifc-lite/commit/80051a51868b7343c4c3e08e335c0d5bdf900424), [`72b896b`](https://github.com/LTplus-AG/ifc-lite/commit/72b896b27eed3f394c76d602a2d1b2eb8db82e2f), [`4af7d75`](https://github.com/LTplus-AG/ifc-lite/commit/4af7d7590759bbcc7a39b0b48f06f980bb57414b), [`0571583`](https://github.com/LTplus-AG/ifc-lite/commit/05715834ce94a1f8e5dc20d6a60b7468190c2e88)]:
  - @ifc-lite/wasm@4.2.2
  - @ifc-lite/diff@0.5.0
  - @ifc-lite/mutations@1.22.0
  - @ifc-lite/export@2.7.1
  - @ifc-lite/lens@1.17.3
  - @ifc-lite/renderer@1.41.1
  - @ifc-lite/parser@3.12.0
  - @ifc-lite/ids@1.15.37
  - @ifc-lite/merge@0.3.2

## 1.33.1

### Patch Changes

- [#1829](https://github.com/LTplus-AG/ifc-lite/pull/1829) [`212e086`](https://github.com/LTplus-AG/ifc-lite/commit/212e086bcfb60526848aab1d9e0709b5b53a45d9) Thanks [@xyzbety](https://github.com/xyzbety)! - improve and refine the ribbon menu items

- Updated dependencies [[`0cfb88b`](https://github.com/LTplus-AG/ifc-lite/commit/0cfb88b3ac3e5615c7e125c5076ea75cf2039a09), [`382fa7c`](https://github.com/LTplus-AG/ifc-lite/commit/382fa7cf97c04bad07963e25052cbaeb6c2ba7e3), [`6792dd1`](https://github.com/LTplus-AG/ifc-lite/commit/6792dd11ad7049acb7329221ea8809d6333aefb7), [`0f15d56`](https://github.com/LTplus-AG/ifc-lite/commit/0f15d5629c532a9ae6b8d79586e6b16613000498), [`35c157d`](https://github.com/LTplus-AG/ifc-lite/commit/35c157d9a0513f368e83c4884465b5ad162c6ba0), [`401ab18`](https://github.com/LTplus-AG/ifc-lite/commit/401ab1842662c4e8ca26eae01b879f0290962b6d), [`87f3507`](https://github.com/LTplus-AG/ifc-lite/commit/87f3507f6fb67a3fd834a190737ea33d7e9ad661), [`8492e51`](https://github.com/LTplus-AG/ifc-lite/commit/8492e516f23775930e55a192abe526ff507d79bc), [`6842c56`](https://github.com/LTplus-AG/ifc-lite/commit/6842c56c72065fd9f43ac282cacb766b7808c282), [`a58feb3`](https://github.com/LTplus-AG/ifc-lite/commit/a58feb3d193106e79598f764deb01e6559bf2e61), [`b23a173`](https://github.com/LTplus-AG/ifc-lite/commit/b23a173775785eea179d7c243948bb86401920f4), [`653a685`](https://github.com/LTplus-AG/ifc-lite/commit/653a685625bda0c983a3123dda73e0d009529f4b), [`33a83dc`](https://github.com/LTplus-AG/ifc-lite/commit/33a83dc61ce6ba1fc3a75869c96ed7afbeb1340f), [`6869d5c`](https://github.com/LTplus-AG/ifc-lite/commit/6869d5ced2d19ac4ab8b2591847f3ffd52236d14), [`319486c`](https://github.com/LTplus-AG/ifc-lite/commit/319486c1ca4fccf7ad3d5ea8187af5c361201131), [`19dc013`](https://github.com/LTplus-AG/ifc-lite/commit/19dc013d66bd96a8ad7b7a01f9c495c829d4ba8b), [`d7065f9`](https://github.com/LTplus-AG/ifc-lite/commit/d7065f9bd08cd12d8b17c9f11f0adcd38e0ee1f3), [`ae0498a`](https://github.com/LTplus-AG/ifc-lite/commit/ae0498a23d61dd63baede3df86cd2f9ec74b1203), [`8799484`](https://github.com/LTplus-AG/ifc-lite/commit/87994844a5edb66404fa12b0719c89f5ec026c4d), [`22bffac`](https://github.com/LTplus-AG/ifc-lite/commit/22bffac737efa9bdd6ca583518f637593cb4d4bc), [`2738f9b`](https://github.com/LTplus-AG/ifc-lite/commit/2738f9b51efd3795259bd4c8870cf13016a989ba), [`87f3507`](https://github.com/LTplus-AG/ifc-lite/commit/87f3507f6fb67a3fd834a190737ea33d7e9ad661), [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f), [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f), [`2738f9b`](https://github.com/LTplus-AG/ifc-lite/commit/2738f9b51efd3795259bd4c8870cf13016a989ba), [`b716fd7`](https://github.com/LTplus-AG/ifc-lite/commit/b716fd7b045c918dc1bd2ecc1da6fed21e59f110), [`428c5ae`](https://github.com/LTplus-AG/ifc-lite/commit/428c5ae54bac236a3950f451ee12a0dc23226336), [`3dc3eb5`](https://github.com/LTplus-AG/ifc-lite/commit/3dc3eb56bd372ddd0e317347db1cad888dffd609), [`f8a3f39`](https://github.com/LTplus-AG/ifc-lite/commit/f8a3f3970844edf266ae6887884ed3be4293ff8c)]:
  - @ifc-lite/clash@1.6.4
  - @ifc-lite/wasm@4.2.0
  - @ifc-lite/create@1.17.0
  - @ifc-lite/encoding@1.15.0
  - @ifc-lite/data@3.0.0
  - @ifc-lite/cache@3.0.0
  - @ifc-lite/drawing-2d@1.20.0
  - @ifc-lite/lists@1.22.0
  - @ifc-lite/parser@3.11.0
  - @ifc-lite/renderer@1.40.0
  - @ifc-lite/pointcloud@0.5.0
  - @ifc-lite/export@2.7.0
  - @ifc-lite/mutations@1.21.1
  - @ifc-lite/sandbox@1.16.4
  - @ifc-lite/server-client@1.21.0
  - @ifc-lite/ifcx@2.3.2
  - @ifc-lite/geometry@3.5.0
  - @ifc-lite/collab@0.4.1
  - @ifc-lite/ids@1.15.35
  - @ifc-lite/mcp@0.9.2
  - @ifc-lite/query@1.14.14
  - @ifc-lite/sdk@1.21.3

## 1.33.0

### Minor Changes

- [#1819](https://github.com/LTplus-AG/ifc-lite/pull/1819) [`c570987`](https://github.com/LTplus-AG/ifc-lite/commit/c57098768d27ce08250206f0a55d1d048798c669) Thanks [@xyzbety](https://github.com/xyzbety)! - Update Ribbon icons and styles

### Patch Changes

- Updated dependencies [[`fb99bda`](https://github.com/LTplus-AG/ifc-lite/commit/fb99bda31397cff2fce7077a8553d2247c2dd151), [`74b9cd2`](https://github.com/LTplus-AG/ifc-lite/commit/74b9cd2ae0c8bd7888536c882baf809dd4f9e5d8)]:
  - @ifc-lite/geometry@3.3.1
  - @ifc-lite/wasm@4.1.3

## 1.32.8

### Patch Changes

- Updated dependencies [[`37224e8`](https://github.com/LTplus-AG/ifc-lite/commit/37224e8cd852d246cf463622cd612a38e0cf6e27), [`2a7c7ff`](https://github.com/LTplus-AG/ifc-lite/commit/2a7c7ffe0ac27a8cc315e5d4a633c56469646cf0), [`631c3a0`](https://github.com/LTplus-AG/ifc-lite/commit/631c3a0813e722fa65ff052108c2cea3ac905801), [`90522d2`](https://github.com/LTplus-AG/ifc-lite/commit/90522d218d5a9c4df0760349b5bfc60916a23f8f), [`613a1bf`](https://github.com/LTplus-AG/ifc-lite/commit/613a1bf6e8f6b3678ce6bd214e746e82dd11f73d), [`502c61b`](https://github.com/LTplus-AG/ifc-lite/commit/502c61bc7c0ae1ac313ed93ab335fdd942471c72), [`05c8bdf`](https://github.com/LTplus-AG/ifc-lite/commit/05c8bdf348c5afae8978293cd324d45104e24940), [`7dcf3e1`](https://github.com/LTplus-AG/ifc-lite/commit/7dcf3e1e33101c694f0acc74aa77cf07770c63c5), [`7194c95`](https://github.com/LTplus-AG/ifc-lite/commit/7194c95002f2c84cd3c9444d710a50190a976a90), [`502bdbf`](https://github.com/LTplus-AG/ifc-lite/commit/502bdbf5c4c4c86999f4e662b71ee5b0b16307ae), [`6102a22`](https://github.com/LTplus-AG/ifc-lite/commit/6102a222a6a71afcdab89855f1dcfa9437d3994f)]:
  - @ifc-lite/export@2.6.0
  - @ifc-lite/geometry@3.3.0
  - @ifc-lite/wasm@4.1.0
  - @ifc-lite/data@2.7.0
  - @ifc-lite/mutations@1.21.0
  - @ifc-lite/drawing-2d@1.19.0
  - @ifc-lite/ids@1.15.33
  - @ifc-lite/parser@3.10.0
  - @ifc-lite/renderer@1.39.0
  - @ifc-lite/pointcloud@0.4.0
  - @ifc-lite/server-client@1.20.0
  - @ifc-lite/lists@1.20.1
  - @ifc-lite/ifcx@2.3.1

## 1.32.7

### Patch Changes

- Updated dependencies [[`c1695d7`](https://github.com/LTplus-AG/ifc-lite/commit/c1695d777263483110460df767ec86ca691048ab), [`5e90494`](https://github.com/LTplus-AG/ifc-lite/commit/5e904942e3fd167d0d0e1a9c37b391d638eb6932), [`cd6c9bd`](https://github.com/LTplus-AG/ifc-lite/commit/cd6c9bda1066b7c7cda19e164d787d15b57e3483), [`b54f704`](https://github.com/LTplus-AG/ifc-lite/commit/b54f70478a7b92055750f11267ffe7fa47ed7da1)]:
  - @ifc-lite/collab@0.4.0
  - @ifc-lite/merge@0.3.0
  - @ifc-lite/mutations@1.20.0
  - @ifc-lite/mcp@0.9.0

## 1.32.6

### Patch Changes

- Updated dependencies [[`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`9689ea5`](https://github.com/LTplus-AG/ifc-lite/commit/9689ea5276cc107895be56aa9267a4b7b778de2d), [`62b68c0`](https://github.com/LTplus-AG/ifc-lite/commit/62b68c06347aab661c3d9417bcf016e565e2c4b1), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`8f3fafd`](https://github.com/LTplus-AG/ifc-lite/commit/8f3fafd7cc777e60cdc006956f8336680723c440), [`a2c31a1`](https://github.com/LTplus-AG/ifc-lite/commit/a2c31a185e868d15183df8360badb001789bd978), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`a1bbd6c`](https://github.com/LTplus-AG/ifc-lite/commit/a1bbd6c209ded2da1405a8d1c816a193601ae625)]:
  - @ifc-lite/ifcx@2.3.0
  - @ifc-lite/diff@0.4.0
  - @ifc-lite/extensions@0.4.0
  - @ifc-lite/mutations@1.19.0
  - @ifc-lite/collab@0.3.0
  - @ifc-lite/merge@0.2.0
  - @ifc-lite/mcp@0.8.0
  - @ifc-lite/renderer@1.37.0
  - @ifc-lite/geometry@3.2.0
  - @ifc-lite/wasm@4.0.0
  - @ifc-lite/clash@1.6.3
  - @ifc-lite/parser@3.8.5
  - @ifc-lite/ids@1.15.30

## 1.32.5

### Patch Changes

- Updated dependencies [[`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47), [`1d53646`](https://github.com/LTplus-AG/ifc-lite/commit/1d536460663b8ce607fb648ab2e996ac445ff651), [`fcbb667`](https://github.com/LTplus-AG/ifc-lite/commit/fcbb6679dd752f5b8be670c6a9e2d3fdc0b57e3d), [`7c65f23`](https://github.com/LTplus-AG/ifc-lite/commit/7c65f232952dcf0c1f7f6ebee3605fd556323035), [`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47), [`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47)]:
  - @ifc-lite/lists@1.17.0
  - @ifc-lite/wasm@3.0.5
  - @ifc-lite/parser@3.7.0
  - @ifc-lite/data@2.4.0
  - @ifc-lite/mutations@1.18.0
  - @ifc-lite/mcp@0.7.0
  - @ifc-lite/ids@1.15.24

## 1.32.4

### Patch Changes

- Updated dependencies [[`52dd7a1`](https://github.com/LTplus-AG/ifc-lite/commit/52dd7a16788375a9507c40fbde106b78236801db), [`218e613`](https://github.com/LTplus-AG/ifc-lite/commit/218e613b06cc5ca2a74c84f72e039b430be6caee), [`0762522`](https://github.com/LTplus-AG/ifc-lite/commit/076252241ec4201462f7fcf0555c83606de5fecd), [`d7a3205`](https://github.com/LTplus-AG/ifc-lite/commit/d7a3205524e023f936b29ee1bc113d1d10e3b0b1), [`5a9f384`](https://github.com/LTplus-AG/ifc-lite/commit/5a9f3846047c1920ff32e6833448b41b571d0e5c), [`52dd7a1`](https://github.com/LTplus-AG/ifc-lite/commit/52dd7a16788375a9507c40fbde106b78236801db), [`47bde10`](https://github.com/LTplus-AG/ifc-lite/commit/47bde10dcacddf8f99e1e6b2bf036c78c192c5ff), [`b157b48`](https://github.com/LTplus-AG/ifc-lite/commit/b157b4841bfa795f8a937a9be20c21b645757fbe)]:
  - @ifc-lite/cache@2.0.11
  - @ifc-lite/clash@1.5.0
  - @ifc-lite/geometry@3.1.0
  - @ifc-lite/parser@3.6.0
  - @ifc-lite/mcp@0.6.0
  - @ifc-lite/renderer@1.35.0
  - @ifc-lite/wasm@3.0.4
  - @ifc-lite/export@2.5.0
  - @ifc-lite/ids@1.15.23

## 1.32.3

### Patch Changes

- Updated dependencies [[`d942bed`](https://github.com/LTplus-AG/ifc-lite/commit/d942bedffe31d0a682c1aa8bb9fe3e3dc0f63104), [`369ee9b`](https://github.com/LTplus-AG/ifc-lite/commit/369ee9b680309ca70c569b3f26bd07acfb83c19d)]:
  - @ifc-lite/diff@0.3.0
  - @ifc-lite/wasm@3.0.3
  - @ifc-lite/geometry@3.0.3
  - @ifc-lite/export@2.4.1

## 1.32.2

### Patch Changes

- Updated dependencies [[`8e43ecf`](https://github.com/LTplus-AG/ifc-lite/commit/8e43ecf540b88b942a4ec2127dd9bcf24ec244fa), [`d1e16f9`](https://github.com/LTplus-AG/ifc-lite/commit/d1e16f944ea9f3a35a7153959f13db168a35c229), [`7d5a031`](https://github.com/LTplus-AG/ifc-lite/commit/7d5a03191a768f68c5ddad878698d1aacb9940ef), [`a46dcdf`](https://github.com/LTplus-AG/ifc-lite/commit/a46dcdf68d05e8cdec4199167647f2dfa3c62cb6), [`6d2cb21`](https://github.com/LTplus-AG/ifc-lite/commit/6d2cb21a170413c6c98aadf10d254667b2ed2b53), [`66f31ac`](https://github.com/LTplus-AG/ifc-lite/commit/66f31acb761209f7cf78e83ef01c02a1ec3dc13a), [`54b5c6b`](https://github.com/LTplus-AG/ifc-lite/commit/54b5c6b043ebd83dc9b10bd15e9973e6a58293cb), [`204cab4`](https://github.com/LTplus-AG/ifc-lite/commit/204cab48f8e3b6326a8005628ed5b7174d9d694c), [`a48abac`](https://github.com/LTplus-AG/ifc-lite/commit/a48abacfacdf226702f2454859afe9abe018e029), [`3d25765`](https://github.com/LTplus-AG/ifc-lite/commit/3d25765edc2cee40268a6d5a27d4055f88f76489), [`6a515ba`](https://github.com/LTplus-AG/ifc-lite/commit/6a515ba31bbe31bb6f018f7476cc9616e4691448), [`b66ff1d`](https://github.com/LTplus-AG/ifc-lite/commit/b66ff1dd915a0ff4f60198a511adb7ed7f714079)]:
  - @ifc-lite/wasm@3.0.0
  - @ifc-lite/geometry@3.0.0
  - @ifc-lite/renderer@1.34.0
  - @ifc-lite/data@2.3.0
  - @ifc-lite/query@1.14.11
  - @ifc-lite/cache@2.0.10
  - @ifc-lite/server-client@1.18.1
  - @ifc-lite/encoding@1.14.8
  - @ifc-lite/mcp@0.5.0
  - @ifc-lite/extensions@0.3.3
  - @ifc-lite/export@2.4.0
  - @ifc-lite/clash@1.4.1
  - @ifc-lite/parser@3.5.2
  - @ifc-lite/drawing-2d@1.18.5
  - @ifc-lite/spatial@1.14.10
  - @ifc-lite/ids@1.15.22
  - @ifc-lite/lists@1.16.1

## 1.32.1

### Patch Changes

- [#1407](https://github.com/LTplus-AG/ifc-lite/pull/1407) [`6af9dc2`](https://github.com/LTplus-AG/ifc-lite/commit/6af9dc26f97f87237c27ae502c127e6170a80d64) Thanks [@Blogbotana](https://github.com/Blogbotana)! - Apply pending edits in merged (federated) export. `MergeModelInput` gains an optional
  `mutationView`; `MergedExporter.exportAsync` now bakes each model's edits (attribute /
  property / quantity / retype / positional mutations and overlay-created entities) into its
  source via `StepExporter` before merging, so federated export round-trips edits exactly like
  single-model export. Previously the merged path read raw source bytes and silently dropped
  every mutation — only single-model export reflected edits ([#1406](https://github.com/LTplus-AG/ifc-lite/issues/1406)).

  Models without pending edits pass through unchanged (no export/parse cost). The synchronous
  `MergedExporter.export()` throws if a model carries pending edits, since baking needs the
  async parser. The viewer's "Merged (All Models)" export now passes each model's mutation view
  (gated by the Apply Mutations toggle).

  `MutablePropertyView` gains `hasPendingChanges()`, which reports the current overlay footprint
  (what the exporter would bake) rather than the append-only mutation history; the merged
  exporter uses it to decide whether to re-bake a model.

- Updated dependencies [[`6af9dc2`](https://github.com/LTplus-AG/ifc-lite/commit/6af9dc26f97f87237c27ae502c127e6170a80d64)]:
  - @ifc-lite/export@2.2.0
  - @ifc-lite/mutations@1.17.0

## 1.32.0

### Minor Changes

- [#1285](https://github.com/LTplus-AG/ifc-lite/pull/1285) [`593f02b`](https://github.com/LTplus-AG/ifc-lite/commit/593f02b471a894fd14d395edcfef575de7879738) Thanks [@louistrue](https://github.com/louistrue)! - Clash panel overhaul driven by user feedback ([#1271](https://github.com/LTplus-AG/ifc-lite/issues/1271)–[#1281](https://github.com/LTplus-AG/ifc-lite/issues/1281)):

  - **Find duplicates** — one-click scan for duplicate / coincident objects, the
    first check on a single discipline model ([#1280](https://github.com/LTplus-AG/ifc-lite/issues/1280)), plus single-model framing in
    the empty state ([#1271](https://github.com/LTplus-AG/ifc-lite/issues/1271)).
  - **Sort by severity / overlap depth / distance** and an info box explaining how
    severity (element-type pair) and hard-vs-clearance / tol-vs-gap work ([#1272](https://github.com/LTplus-AG/ifc-lite/issues/1272),
    [#1274](https://github.com/LTplus-AG/ifc-lite/issues/1274)).
  - **Hide touching** toggle + a "touch" badge for ≈0 m contacts ([#1273](https://github.com/LTplus-AG/ifc-lite/issues/1273)).
  - **Step through a pair** — expandable rows show each object with a plain-language
    description and per-element select ([#1276](https://github.com/LTplus-AG/ifc-lite/issues/1276)).
  - **Isolate** the clashing pair (per-row button + "isolate on select" toggle) so
    a clash can be judged in isolation ([#1275](https://github.com/LTplus-AG/ifc-lite/issues/1275)); the "Highlight all" button is
    relabelled and explained ([#1278](https://github.com/LTplus-AG/ifc-lite/issues/1278)).
  - **Create a BCF topic** directly from a clash into the in-app issue tracker, no
    download/re-import round-trip ([#1279](https://github.com/LTplus-AG/ifc-lite/issues/1279)).

- [#1290](https://github.com/LTplus-AG/ifc-lite/pull/1290) [`07dedbc`](https://github.com/LTplus-AG/ifc-lite/commit/07dedbcaa4f970b26134ae68aef5105761754011) Thanks [@louistrue](https://github.com/louistrue)! - Clash review now has an **X-Ray "Ghost" context** mode ([#1275](https://github.com/LTplus-AG/ifc-lite/issues/1275)). The "On select"
  control offers Highlight / Isolate / **Ghost**: Ghost keeps the clashing pair
  solid and fades the rest of the model to translucent context, so a clash can be
  judged in place without hiding its surroundings. Wires the renderer's
  `ghostExceptIds` through a new `ghostExceptEntities` visibility channel.

### Patch Changes

- Updated dependencies [[`593f02b`](https://github.com/LTplus-AG/ifc-lite/commit/593f02b471a894fd14d395edcfef575de7879738), [`39400ee`](https://github.com/LTplus-AG/ifc-lite/commit/39400ee5bb48c1554656e1ac7aaf8a06ba2274cf), [`84c9f6e`](https://github.com/LTplus-AG/ifc-lite/commit/84c9f6e09eba2747b37da8f74aa7de23cb9f96d3), [`07dedbc`](https://github.com/LTplus-AG/ifc-lite/commit/07dedbcaa4f970b26134ae68aef5105761754011), [`df607ef`](https://github.com/LTplus-AG/ifc-lite/commit/df607effd3a4cf2e0fb2898e14cb385df6d8e8d0)]:
  - @ifc-lite/clash@1.2.0
  - @ifc-lite/renderer@1.29.0
  - @ifc-lite/parser@3.3.2
  - @ifc-lite/geometry@2.9.2
  - @ifc-lite/wasm@2.11.1
  - @ifc-lite/ids@1.15.16

## 1.31.0

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

- [#1244](https://github.com/LTplus-AG/ifc-lite/pull/1244) [`3006682`](https://github.com/LTplus-AG/ifc-lite/commit/30066825cea412cfe76dc69e3aadd286366e0b17) Thanks [@louistrue](https://github.com/louistrue)! - Fix `this.store.getQuantities is not a function` crash when selecting an
  entity in an IFCX-imported model. The IFCX ingest built a populated data
  store but never attached the lazy accessor methods
  (`getQuantities`/`getProperties`/`getEntity`) the query/selection path
  calls — it now routes the store through `attachDataStoreAccessors`.

- [#1247](https://github.com/LTplus-AG/ifc-lite/pull/1247) [`0a0a922`](https://github.com/LTplus-AG/ifc-lite/commit/0a0a922adba1dabc56e97cc5ce0c553ab7356b3e) Thanks [@louistrue](https://github.com/louistrue)! - Move the KMZ (Google Earth) exporter to Rust. The `ifc-lite-export` crate now
  assembles the KMZ archive (`doc.kml` + `model.glb`) and computes the IFC
  grid-north → KML heading, exposed via the wasm `exportKmz` binding and
  `GeometryProcessor.exportKmz`. The viewer's `buildKmz` is now a thin async caller
  (matching the OBJ/glTF/CSV pattern); the GLB it packages is already produced by the
  Rust GLB exporter. The archive uses a hand-rolled stored-ZIP writer so the wasm
  bundle pulls in no zip/deflate dependency.
- Updated dependencies [[`fec82b9`](https://github.com/LTplus-AG/ifc-lite/commit/fec82b9f3eea3655f92413fce82387ddce2f9722), [`0a0a922`](https://github.com/LTplus-AG/ifc-lite/commit/0a0a922adba1dabc56e97cc5ce0c553ab7356b3e)]:
  - @ifc-lite/geometry@2.9.0
  - @ifc-lite/wasm@2.11.0
  - @ifc-lite/mcp@0.4.0
  - @ifc-lite/export@2.0.0
  - @ifc-lite/sdk@1.20.1

## 1.30.3

### Patch Changes

- [#1190](https://github.com/LTplus-AG/ifc-lite/pull/1190) [`d5aa38d`](https://github.com/LTplus-AG/ifc-lite/commit/d5aa38db57e90ecd69512cfad426a902a0eccebf) Thanks [@louistrue](https://github.com/louistrue)! - Recover from transient WASM engine-load failures and humanise the error.

  When the `ifc-lite_bg.wasm` binary fails to download (non-OK HTTP status, a cold
  CDN edge, a mid-deploy race, or a blocking proxy/antivirus), wasm-bindgen's
  streaming loader rethrows a cryptic `Failed to execute 'compile' on
'WebAssembly': HTTP status code is not ok`. The geometry and parser workers now
  retry `init()` once on such fetch/HTTP-shaped failures, and the viewer maps the
  failure to actionable guidance ("reload the page") instead of surfacing the raw
  TypeError. Captured exceptions are tagged with a stable `error_kind` for triage.

- Updated dependencies [[`23a36a6`](https://github.com/LTplus-AG/ifc-lite/commit/23a36a66dfcfbd9bef2b988094c003b17d400d76), [`d5aa38d`](https://github.com/LTplus-AG/ifc-lite/commit/d5aa38db57e90ecd69512cfad426a902a0eccebf)]:
  - @ifc-lite/geometry@2.7.9
  - @ifc-lite/parser@3.3.1
  - @ifc-lite/ids@1.15.13

## 1.30.2

### Patch Changes

- [#1159](https://github.com/LTplus-AG/ifc-lite/pull/1159) [`39e0f82`](https://github.com/LTplus-AG/ifc-lite/commit/39e0f82558ec65dd574b6b4bfb2430f7abba346b) Thanks [@louistrue](https://github.com/louistrue)! - Add a `?geomWorkers=N` override for the geometry worker pool, and document the
  per-tier worker caps as a memory-bandwidth ceiling.

  The parallel geometry pool picks a worker count from a cores/memory heuristic.
  A `?geomWorkers=N` A/B sweep on a large (722 MB) georef model showed that, with
  the pure-Rust exact CSG kernel, geometry wall-time is bound by **memory
  bandwidth**, not CPU cores: 3→4→5 workers gave no geometry speedup (flat
  wall-time, higher peak memory) and progressively starved the co-running parser.
  So the existing caps are correct for this class of file and are left unchanged —
  only their rationale is updated in comments.

  The override (`?geomWorkers=N`, persisted to localStorage so it survives the
  reload a re-measure needs; `?geomWorkers=0`/`auto` clears it) lets a user measure
  their own host's optimum, since the bandwidth ceiling is hardware-specific. It is
  threaded to `computeWorkerCount`, which honours it but still clamps to the memory
  budget, so the knob can never OOM the tab. Geometry output is byte-identical
  across worker counts (verified in the wild: identical mesh count at 3 and 4
  workers) — the count only repartitions which worker meshes which disjoint,
  deterministic element slice.

- Updated dependencies [[`39e0f82`](https://github.com/LTplus-AG/ifc-lite/commit/39e0f82558ec65dd574b6b4bfb2430f7abba346b), [`2556677`](https://github.com/LTplus-AG/ifc-lite/commit/25566773498f4761bb073e17b874e638208b7d13)]:
  - @ifc-lite/geometry@2.7.5

## 1.30.1

### Patch Changes

- [#1136](https://github.com/LTplus-AG/ifc-lite/pull/1136) [`98457b8`](https://github.com/LTplus-AG/ifc-lite/commit/98457b8aea6663806303abc8feb6598d841d1de3) Thanks [@louistrue](https://github.com/louistrue)! - Show IfcElementAssembly / IfcStair parts in the spatial tree and make assemblies
  selectable ([#1133](https://github.com/LTplus-AG/ifc-lite/issues/1133)). A decomposing assembly carries no geometry of its own — its
  stair flights, railings, landing slabs and virtual clearance volumes hang off it
  via `IfcRelAggregates` and hold the meshes — so the spatial panel previously
  listed the assembly as a childless leaf, the parts were unreachable, and
  clicking the assembly highlighted nothing. The hierarchy now nests an
  assembly's aggregated parts beneath it (recursively, cycle-guarded), clicking
  the assembly highlights and frames the whole thing, soloing a storey keeps the
  parts (they inherit the storey through the assembly), and `IfcVirtualElement`
  clearance volumes are hidden by default with a new "Virtual Elements"
  visibility toggle.
- Updated dependencies [[`61bad47`](https://github.com/LTplus-AG/ifc-lite/commit/61bad47257196b766fb0b8a17c56e53b763ca34a), [`bfd9004`](https://github.com/LTplus-AG/ifc-lite/commit/bfd9004daa17f481a7b33b5c3c11f620e6cd894d), [`69e5425`](https://github.com/LTplus-AG/ifc-lite/commit/69e5425e3d7586fcc2d44a33465806adc0ed53f8), [`81a6cdf`](https://github.com/LTplus-AG/ifc-lite/commit/81a6cdf93aa0af2e306f3697c2912f56405e8856), [`ca8a856`](https://github.com/LTplus-AG/ifc-lite/commit/ca8a856308e5a6df1bb84d0c28f0c1e5059da19a), [`bd585c7`](https://github.com/LTplus-AG/ifc-lite/commit/bd585c73de1f39db3c9aac168174012b98b79855), [`248f2c0`](https://github.com/LTplus-AG/ifc-lite/commit/248f2c09a4d61fa27dfeaba5511a2a641d4cd278), [`200681b`](https://github.com/LTplus-AG/ifc-lite/commit/200681ba17f162aaafaabf56c0723ddba693faf8), [`ef8343b`](https://github.com/LTplus-AG/ifc-lite/commit/ef8343baeb50f6de00c3ca3c31ab15849ebb2528), [`ddae2b0`](https://github.com/LTplus-AG/ifc-lite/commit/ddae2b0024f071d00f9e6e4b77e0be3965412ec3)]:
  - @ifc-lite/mutations@1.15.5
  - @ifc-lite/data@2.1.0
  - @ifc-lite/parser@3.3.0
  - @ifc-lite/geometry@2.7.3
  - @ifc-lite/renderer@1.28.2
  - @ifc-lite/sdk@1.19.0
  - @ifc-lite/sandbox@1.16.0
  - @ifc-lite/export@1.20.0
  - @ifc-lite/lens@1.15.3
  - @ifc-lite/lists@1.15.4
  - @ifc-lite/cache@2.0.4
  - @ifc-lite/ids@1.15.12

## 1.30.0

### Minor Changes

- [#1069](https://github.com/LTplus-AG/ifc-lite/pull/1069) [`49d146a`](https://github.com/LTplus-AG/ifc-lite/commit/49d146a653f65eb5e265347ed6a9e9e7a21589a4) Thanks [@louistrue](https://github.com/louistrue)! - Sky and lighting options for both rendering paths.

  Renderer: the hardcoded shader lights move into a global lighting-environment
  uniform (group(1)) — sun direction/colour/intensity, hemisphere ambient,
  exposure — with defaults that render pixel-identical to the previous look,
  plus a procedural sky pass (analytic gradient + sun disc, drawn at the
  reverse-Z far plane, tonemapped with the same ACES curve as geometry).

  Viewer: one collapsible, mode-aware Sun & Sky panel. Standalone it offers
  lighting presets (Default, Day, Overcast, Evening, Night), a Sky toggle and
  an exposure trim; in the Cesium world context the model is lit by the sun
  and atmosphere, so the panel swaps presets for the Sky/atmosphere toggle and
  the sun-path study. The study now also lights the model directly: the NOAA
  sun position at the site is mapped into viewer space (inverse of the Cesium
  bridge's ENU frame) with golden-hour/twilight/night photometric fades, so
  daylight studies read identically with and without the 3D world context.

  Cesium: OSM Buildings mode keeps the globe with the satellite base map —
  buildings sit on top of the imagery instead of replacing it, and the globe
  receives the buildings' and model's cast shadows during a sun study.

### Patch Changes

- [#1076](https://github.com/LTplus-AG/ifc-lite/pull/1076) [`da1999f`](https://github.com/LTplus-AG/ifc-lite/commit/da1999fc6e482fa3d668b9aa98a840d2bb838112) Thanks [@louistrue](https://github.com/louistrue)! - Add `createSyntheticDataStore()` — a typed factory for building a fully-typed
  `IfcDataStore` for synthetic / non-STEP models (GLB meshes, point-cloud scans).
  It assembles real `@ifc-lite/data` tables (empty, or a single synthetic entity
  row) and wires the lazy `getEntity` / `getEntitiesByType` / `getProperties` /
  `getQuantities` accessors through `attachDataStoreAccessors`, the same single
  source of truth the columnar parse / worker transport / cache restore use.

  The viewer's GLB (`createMinimalGlbDataStore`) and LAS/LAZ point-cloud
  (`emptyDataStore`) ingest paths now build their synthetic stores through this
  factory instead of whole-object `as unknown as IfcDataStore` casts. Those casts
  silently dropped the `IfcStoreBase` accessors, so a future required
  `IfcDataStore` member stayed green at the cast site and threw
  `TypeError: store.getProperties is not a function` at runtime on the
  GLB / point-cloud ingest flow (same crash class as [#950](https://github.com/LTplus-AG/ifc-lite/issues/950)). The contract is now
  compiler-enforced for these synthetic stores.

- Updated dependencies [[`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`49d146a`](https://github.com/LTplus-AG/ifc-lite/commit/49d146a653f65eb5e265347ed6a9e9e7a21589a4), [`49d146a`](https://github.com/LTplus-AG/ifc-lite/commit/49d146a653f65eb5e265347ed6a9e9e7a21589a4), [`da1999f`](https://github.com/LTplus-AG/ifc-lite/commit/da1999fc6e482fa3d668b9aa98a840d2bb838112)]:
  - @ifc-lite/create@1.16.2
  - @ifc-lite/export@1.19.6
  - @ifc-lite/parser@3.2.0
  - @ifc-lite/geometry@2.6.1
  - @ifc-lite/server-client@1.17.0
  - @ifc-lite/clash@1.1.3
  - @ifc-lite/sdk@1.18.3
  - @ifc-lite/renderer@1.27.0
  - @ifc-lite/mcp@0.3.3
  - @ifc-lite/data@2.0.3
  - @ifc-lite/solar@1.15.0
  - @ifc-lite/ids@1.15.10
  - @ifc-lite/lists@1.15.3

## 1.29.0

### Minor Changes

- [#1022](https://github.com/LTplus-AG/ifc-lite/pull/1022) [`7bd0459`](https://github.com/LTplus-AG/ifc-lite/commit/7bd045963b1339a35bd73d1aad18ff29de7db692) Thanks [@louistrue](https://github.com/louistrue)! - feat(spaces): interactive Space Sketch (DCEL) editor + headless generation

  A topology-aware space editor built on a persistent half-edge (DCEL) plate in
  the Rust geometry core, exposed via a stateful `SpacePlateHandle` wasm binding:

  - **Derive** rooms from a storey's walls, **drag** a shared vertex (both rooms
    follow), **split** a room between corners _or_ new nodes added anywhere on a
    wall, **merge** rooms across a shared wall, with undo/redo, and **bake** to
    real `IfcSpace` (via the existing `addSpace` path).
  - **Wall-axis recognition fixes** in `@ifc-lite/create`: read the extractor's
    reliable entity type instead of the columnar table's `'Unknown'` sentinel
    (every `Curve2D` Axis polyline — e.g. all of AC20-FZK-Haus — was skipped), and
    a body-footprint fallback (face sets, `IfcFacetedBrep`, vertically-extruded
    rect / arbitrary / IndexedPolyCurve profiles) for walls without an Axis.
  - Viewer "Space Sketch" tool: storey list with resolved names, auto-derive on
    selection, auto-escalating + manual snap tolerance to close centreline corner
    gaps.
  - **Headless generation** — derive IfcSpace across storeys from the CLI
    (`ifc-lite generate-spaces`), the SDK (`bim.spaces.generate`), or as a library
    function (`generateSpaces` from `@ifc-lite/create`), with auto-escalating snap,
    storey-datum ("slab") floor-to-floor heights, and rectangular corner cleanup
    ported into the TS detector.
  - **Production-grade baked spaces** — every derived `IfcSpace` now carries
    `Qto_SpaceBaseQuantities` (GrossFloorArea / NetFloorArea / GrossPerimeter /
    Height / GrossVolume, schema-aware) and an `IfcRelSpaceBoundary` per bounding
    wall. Generated spaces are stamped with `ObjectType 'IfcLite:GeneratedSpace'`,
    and a re-run skips a model that already contains them (idempotent; `--force`
    to override).

### Patch Changes

- [#1029](https://github.com/LTplus-AG/ifc-lite/pull/1029) [`cef9989`](https://github.com/LTplus-AG/ifc-lite/commit/cef99897ee287029c6db6bbaafcd2a35508af1be) Thanks [@louistrue](https://github.com/louistrue)! - fix(renderer): double-sided GPU pick pass — back-face culling could cull an
  element's entire camera-facing surface (IFC winding order varies), so clicks
  selected whatever was behind it (e.g. an IfcSpace behind a wall).

  fix(create): space bakes now survive the IFC round-trip —
  `addSpaceToStore` emits geometry in the model's native length unit
  (a space baked into a millimetre model used to export 1000× too small),
  and `resolveSpatialAnchor` no longer fails on models without
  `IfcOwnerHistory` (OPTIONAL from IFC4 onward); builders emit `$` instead.

  fix(viewer): Space Sketch surfaces real bake errors instead of counting
  them as "already a space" skips, reveals the (persisted) Spaces class
  visibility after a successful bake, and the toolbar button is edit-mode
  gated with a distinct icon.

- Updated dependencies [[`cef9989`](https://github.com/LTplus-AG/ifc-lite/commit/cef99897ee287029c6db6bbaafcd2a35508af1be), [`7bd0459`](https://github.com/LTplus-AG/ifc-lite/commit/7bd045963b1339a35bd73d1aad18ff29de7db692)]:
  - @ifc-lite/renderer@1.25.3
  - @ifc-lite/create@1.16.0
  - @ifc-lite/wasm@2.5.0
  - @ifc-lite/sdk@1.18.0

## 1.28.1

### Patch Changes

- Updated dependencies [[`ea7c132`](https://github.com/LTplus-AG/ifc-lite/commit/ea7c1324e77b5fde4b7d0775a013f2fdf90b26d2), [`1effb90`](https://github.com/LTplus-AG/ifc-lite/commit/1effb900edd0a70db75f90839a4cc9f8fecb8d5e), [`1effb90`](https://github.com/LTplus-AG/ifc-lite/commit/1effb900edd0a70db75f90839a4cc9f8fecb8d5e), [`b6f352f`](https://github.com/LTplus-AG/ifc-lite/commit/b6f352f75e1431cf926eca0dcb3344aead140c2f), [`35413b9`](https://github.com/LTplus-AG/ifc-lite/commit/35413b9efd0178cff6022f2b1092ac532868d6cd)]:
  - @ifc-lite/cache@2.0.0
  - @ifc-lite/drawing-2d@1.17.0
  - @ifc-lite/wasm@2.4.0
  - @ifc-lite/geometry@2.4.0

## 1.28.0

### Minor Changes

- [#987](https://github.com/LTplus-AG/ifc-lite/pull/987) [`55fd14e`](https://github.com/LTplus-AG/ifc-lite/commit/55fd14e5017f626567b10622bb41ddac3311e70c) Thanks [@louistrue](https://github.com/louistrue)! - Model comparison in the viewer ([#924](https://github.com/LTplus-AG/ifc-lite/issues/924)). A new **Compare** panel (Analysis menu)
  lets you pick two loaded models as version A/B, run a comparison, and review
  **added / changed / deleted** elements — colour-coded in 3D (green / yellow /
  red, with unchanged ghosted or hidden) and listed in the panel; clicking a row
  selects and frames the element. A **data / geometry / both** scope toggle
  switches what counts as a change.

  `@ifc-lite/geometry` now surfaces the WASM mesh pass's RTC-invariant per-entity
  geometry fingerprint: `GeometryProcessor.enableGeometryHashes()` turns it on and
  each `MeshData.geometryHash` carries the hash (threaded through the streaming +
  parallel worker paths). This feeds the geometry side of the diff: a moved or
  reshaped element reads as a geometry change, while the global georeferencing
  offset (RTC) does not — the hash is RTC-invariant.

- [#982](https://github.com/LTplus-AG/ifc-lite/pull/982) [`ca293ed`](https://github.com/LTplus-AG/ifc-lite/commit/ca293ed7080495b29dd555b191ae0095ff267e4b) Thanks [@louistrue](https://github.com/louistrue)! - feat(materials): expose material property sets and a Materials inspector tab

  Material property sets attached to an `IfcMaterial` via `IfcMaterialProperties`
  (e.g. `Pset_MaterialConcrete`) are now resolved and shown:

  - **On the selected object** — a "Material Properties" group in the inspector,
    resolved through the element's material association (fanning a layer / profile /
    constituent set out to each member material), mirroring how type psets surface
    on an occurrence.
  - **A new "Materials" hierarchy tab** — lists every base material; selecting one
    isolates its elements and shows the material's own psets plus quantities
    (volume / area / weight) aggregated across all using elements, apportioned by
    each element's material share (layer thickness / constituent fraction).

  New parser exports: `extractMaterialPropertiesOnDemand`,
  `extractMaterialPropertiesForMaterialId`, `buildMaterialUsageIndex`,
  `collectMaterialLeaves`, `resolveMaterialDefId`, `getMaterialDisplay`, and the
  `MaterialPsetGroup` / `MaterialLeaf` / `MaterialUsage` types.

### Patch Changes

- Updated dependencies [[`b33e1f7`](https://github.com/LTplus-AG/ifc-lite/commit/b33e1f7c4706fe4b0d850d3da782ea84267dd525), [`55fd14e`](https://github.com/LTplus-AG/ifc-lite/commit/55fd14e5017f626567b10622bb41ddac3311e70c), [`90060b7`](https://github.com/LTplus-AG/ifc-lite/commit/90060b7eaad7a07bdab13907c1b52bb24fbc8597), [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0), [`ca293ed`](https://github.com/LTplus-AG/ifc-lite/commit/ca293ed7080495b29dd555b191ae0095ff267e4b), [`90060b7`](https://github.com/LTplus-AG/ifc-lite/commit/90060b7eaad7a07bdab13907c1b52bb24fbc8597)]:
  - @ifc-lite/parser@3.1.0
  - @ifc-lite/geometry@2.3.0
  - @ifc-lite/diff@0.2.0
  - @ifc-lite/query@1.14.9
  - @ifc-lite/mutations@1.15.2
  - @ifc-lite/drawing-2d@1.16.2
  - @ifc-lite/export@1.19.4
  - @ifc-lite/mcp@0.3.1
  - @ifc-lite/data@2.0.1
  - @ifc-lite/sdk@1.17.1
  - @ifc-lite/clash@1.1.1
  - @ifc-lite/pointcloud@0.3.2
  - @ifc-lite/bcf@1.15.5
  - @ifc-lite/server-client@1.16.1
  - @ifc-lite/sandbox@1.15.1
  - @ifc-lite/cache@1.14.9
  - @ifc-lite/lists@1.15.1
  - @ifc-lite/renderer@1.25.1
  - @ifc-lite/extensions@0.3.1
  - @ifc-lite/wasm@2.3.0
  - @ifc-lite/spatial@1.14.7
  - @ifc-lite/lens@1.15.1
  - @ifc-lite/ids@1.15.5

## 1.27.0

### Minor Changes

- [#969](https://github.com/LTplus-AG/ifc-lite/pull/969) [`f3cb460`](https://github.com/LTplus-AG/ifc-lite/commit/f3cb4600bf67f60a200a90bc70c233effbabe76e) Thanks [@Blogbotana](https://github.com/Blogbotana)! - feat(grids): render structural grids in apps/viewer ([#967](https://github.com/LTplus-AG/ifc-lite/issues/967))

  Wire the structural-grid SDK from [#966](https://github.com/LTplus-AG/ifc-lite/issues/966) into the in-repo viewer, mirroring the
  alignment-lines stack (lines-only for now).

  - **`@ifc-lite/renderer`**: `uploadGridLines3D` / `clearGridLines3D` (+ internal
    `hasGridLines3D` / `drawGridLines3D`) — a dedicated grid line buffer drawn
    through the existing line pipeline, independent of the annotation/alignment
    overlays. Unlike alignment, grid lines don't expand model bounds (they sit
    behind a visibility toggle and routinely extend past the envelope). Also frees
    the alignment + grid line buffers on overlay `dispose()`.
  - **`@ifc-lite/viewer`**: `useGridLines3D` hook (mirrors `useAlignmentLines3D`,
    calls `GeometryProcessor.parseGridLines`), wired in `Viewport` and gated by the
    existing `ifcGrid` type-visibility toggle.

  3D tag/bubble labels and full polyline sampling for curved axes are deferred (see
  [#967](https://github.com/LTplus-AG/ifc-lite/issues/967)).

### Patch Changes

- Updated dependencies [[`f3cb460`](https://github.com/LTplus-AG/ifc-lite/commit/f3cb4600bf67f60a200a90bc70c233effbabe76e), [`778fc99`](https://github.com/LTplus-AG/ifc-lite/commit/778fc9989fc44bf1be70b81d25a635da7e857719), [`778fc99`](https://github.com/LTplus-AG/ifc-lite/commit/778fc9989fc44bf1be70b81d25a635da7e857719), [`f99666a`](https://github.com/LTplus-AG/ifc-lite/commit/f99666ae028a88f1378422dd20900929f026cd2b), [`773b508`](https://github.com/LTplus-AG/ifc-lite/commit/773b5086456de3c61bdde8a72dd3d35325e2e995)]:
  - @ifc-lite/renderer@1.25.0
  - @ifc-lite/wasm@2.2.0
  - @ifc-lite/geometry@2.2.0

## 1.26.0

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

- [#895](https://github.com/LTplus-AG/ifc-lite/pull/895) [`94d9116`](https://github.com/LTplus-AG/ifc-lite/commit/94d91161abc58b5804bd979d841d7475714ee5ad) Thanks [@louistrue](https://github.com/louistrue)! - Fix model federation: two models now load co-located at the correct scale
  instead of one being flung ~20 km away, dwarfed, or hanging on "Processing
  geometry".

  **Federation alignment (the regression).** When a model has no
  `IfcMapConversion` we synthesise a `source: 'siteLocation'` georeference from its
  `IfcSite` `RefLatitude`/`RefLongitude`/`RefElevation` so it can still be pinned on
  the location map. Since [#658](https://github.com/LTplus-AG/ifc-lite/issues/658) the federated add-model path treated that synthetic
  georef as real and ran it through the projected-CRS affine alignment — but its
  coordinates are geographic degrees plus a raw, un-unit-scaled site elevation, not
  projected metres. For the BIMcollab ARC/STR sample (which share a site GUID but
  carry `RefElevation` `0` vs `20000` mm) the height term placed the architectural
  model ~20 km below the structural one. Federation alignment now requires _true_
  georeferencing (`IfcMapConversion` + `IfcProjectedCRS`, via
  `hasStandardGeoreferencing`); site-location-only models stay in their own local
  frames where they already overlay correctly.

  **Unit scale.** The streaming geometry pre-pass (`buildPrePassStreaming`)
  resolved `unitScale` from a _partial_ entity index — only the rows up to the
  first `IFCPROJECT`. Many real exports (Revit) place `IFCPROJECT` and its
  `IFCUNITASSIGNMENT` _after_ the bulk of the geometry, so the assigned
  `IFCSIUNIT` wasn't indexed yet, `decode_by_id` failed, and resolution silently
  fell back to the metres default — rendering a millimetre model 1000× too large.
  The pre-pass now tries the partial index first (fast path for unit-first files)
  and falls back to a _complete_ index when the unit chain isn't yet decodable, so
  the scale is correct regardless of entity ordering. New
  `try_extract_length_unit_scale` in `ifc-lite-core` distinguishes "not yet
  resolvable from this index" from a genuine metres default; covered by unit tests.

  **Ingest watchdog (viewer).** The added-model ingest path
  (`parseStepBufferViewerModel`) gains the same size-aware stream watchdog the
  single-model loader already had, so a stalled geometry stream surfaces a
  recoverable error instead of hanging forever at "Processing geometry (N meshes)".
  The watchdog plus its iterator teardown are extracted into a shared
  `watchedGeometryStream` / `boundedIteratorReturn` helper (used by both loaders):
  the teardown is now bounded so an abandoned generator parked on the very stall
  the watchdog escaped can't re-wedge cleanup and swallow the timeout error.

  **Camera framing.** When a second model is added, the viewport now unions the
  bounds of all visible models and refits, so federated models are framed together
  instead of the camera staying on the first model.

- Updated dependencies [[`d6b8986`](https://github.com/LTplus-AG/ifc-lite/commit/d6b89866b4c058531ce0c5c7472a297adc6580a8), [`94d9116`](https://github.com/LTplus-AG/ifc-lite/commit/94d91161abc58b5804bd979d841d7475714ee5ad)]:
  - @ifc-lite/clash@1.1.0
  - @ifc-lite/sdk@1.17.0
  - @ifc-lite/mcp@0.3.0
  - @ifc-lite/wasm@2.1.1

## 1.25.2

### Patch Changes

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85), [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/parser@3.0.0
  - @ifc-lite/export@1.19.3
  - @ifc-lite/cache@1.14.8
  - @ifc-lite/renderer@1.23.1
  - @ifc-lite/wasm@2.0.0
  - @ifc-lite/geometry@2.0.0
  - @ifc-lite/data@2.0.0
  - @ifc-lite/extensions@0.3.0
  - @ifc-lite/create@1.15.1
  - @ifc-lite/ids@1.15.4
  - @ifc-lite/mcp@0.2.1
  - @ifc-lite/query@1.14.8
  - @ifc-lite/sdk@1.16.1
  - @ifc-lite/drawing-2d@1.16.1
  - @ifc-lite/spatial@1.14.6
  - @ifc-lite/lists@1.14.13
  - @ifc-lite/mutations@1.15.1

## 1.25.1

### Patch Changes

- [#839](https://github.com/LTplus-AG/ifc-lite/pull/839) [`8c1632c`](https://github.com/LTplus-AG/ifc-lite/commit/8c1632ceb63ff4cfdbac4f2936d54d2d3a7e2f1b) Thanks [@louistrue](https://github.com/louistrue)! - Improve IFC annotation legibility in 3D (issue [#812](https://github.com/LTplus-AG/ifc-lite/issues/812) follow-up):

  - **All annotation text now billboards to the camera.** Previously only
    IfcGridAxis tags rebuilt in the screen-aligned basis; IfcAnnotation
    text (dimensions, leader labels, room tags) kept its authored
    in-plane orientation. In oblique views that text collapsed to a
    smeared sliver of pixels — the "distorted dimension labels in
    FZK-Haus" symptom from the issue. The shader path was already
    per-instance billboard-aware, so the change is just a flag flip at
    upload time; anchor and alignment are unchanged.

  - **Grid bubbles no longer paint a white disc behind the tag.** The
    bubble interior is now transparent, so geometry behind a grid line
    reads through the bubble in 3D. The black outline ring (◯) and tag
    glyph are unchanged — the white ● fill instance has been removed
    from `emit_bubble`, which also drops one text instance per bubble.

  - **Annotation text no longer z-fights coplanar surfaces.** Now that
    every glyph billboards, the quad faces the camera with zero depth
    slope across its screen extent — which means the text pipeline's
    `depthBiasSlopeScale: -0.5` contributes ~0 and only the small `-4`
    constant survives, not enough to beat MSAA jitter on a label drawn
    exactly on a wall/floor face (visible as dimension digits strobing
    against terrain in 3D). The symbolic-overlay text shader now applies
    the same `clip.z + 5e-5 * clip.w` reverse-Z nudge the section-2D
    line pipeline already uses — depth-format-independent, slope-
    independent, and large enough to clear coplanar jitter without
    pulling the label visibly off the surface.

- Updated dependencies [[`8c1632c`](https://github.com/LTplus-AG/ifc-lite/commit/8c1632ceb63ff4cfdbac4f2936d54d2d3a7e2f1b), [`231e494`](https://github.com/LTplus-AG/ifc-lite/commit/231e494e7ee920c5219d7fa5c5c6dde4c2bced2a), [`279d897`](https://github.com/LTplus-AG/ifc-lite/commit/279d897dd6e28214930a6b0fffe01dd813141ee0), [`d83fc42`](https://github.com/LTplus-AG/ifc-lite/commit/d83fc424a6b9d2a786e2dfaabe1dc2fb8746d07c)]:
  - @ifc-lite/renderer@1.22.2
  - @ifc-lite/wasm@1.19.2

## 1.25.0

### Minor Changes

- [#815](https://github.com/LTplus-AG/ifc-lite/pull/815) [`bc1a85d`](https://github.com/LTplus-AG/ifc-lite/commit/bc1a85dd532386774bcc76025de06b4fcf493937) Thanks [@louistrue](https://github.com/louistrue)! - Make IFC annotation overlays usable in real drawings (issue [#812](https://github.com/LTplus-AG/ifc-lite/issues/812) follow-up
  to the annotation text feature):

  - **3D z-fight fix**: annotation lines, fills, and text pipelines now apply
    a reverse-Z `depthBias` / `depthBiasSlopeScale` so a label drawn exactly
    on a wall/floor face no longer disappears or strobes. This was the user-
    reported "coplanar glitch" — the per-fragment depth-equal pass plus MSAA
    jitter was the actual cause, not line weight. The pipelines remain
    `depthCompare: 'greater-equal'` so foreground geometry still occludes the
    overlay correctly.

  - **Annotations in 2D section views**: the Section 2D panel now overlays
    IfcAnnotation curves, text, and fills on the section drawing when their
    authored storey elevation falls inside the cut's view-range on the cut
    axis. New `showIfcAnnotations` flag on `drawing2DDisplayOptions` (defaults
    on) and a header toggle (Tag icon, next to Symbolic-vs-Cut) wire it up.
    The toggle is currently active only for floor-plan views (`axis='down'`);
    elevation/section axes need a separate coord-reorientation pass and are
    disabled in the UI.

  The 2D path reuses the existing module-global parse cache from
  `useSymbolicAnnotations`, so the WASM symbolic-representation parse runs
  at most once per loaded model regardless of how many overlay surfaces are
  active.

### Patch Changes

- [#827](https://github.com/LTplus-AG/ifc-lite/pull/827) [`4c87791`](https://github.com/LTplus-AG/ifc-lite/commit/4c87791aa17780ec7d3f007dddf841d5606c5cdc) Thanks [@louistrue](https://github.com/louistrue)! - Address CodeRabbit feedback from PR [#823](https://github.com/LTplus-AG/ifc-lite/issues/823):

  - Auto-populate `modelId` in the Lens rule editor when exactly one federated model is loaded, so the single-model branch (which hides the selector) no longer leaves the rule permanently invalid.
  - Fix a `ReferenceError` in `scripts/fetch-prebuilt-wasm.mjs` by routing both prebuilt-fetch and source-build flows through a shared `scripts/lib/patch-threaded-stub.mjs` helper that imports `writeFileSync` and uses a regex anchored on the default export (resilient to wasm-bindgen formatting changes).
  - Refresh the stale build-command reference in `@ifc-lite/wasm-threaded`'s package description.

  Closes [#824](https://github.com/LTplus-AG/ifc-lite/issues/824).

- Updated dependencies [[`8b48495`](https://github.com/LTplus-AG/ifc-lite/commit/8b48495bc65c8ca778c3b60f271108f641fafe02), [`78f1d10`](https://github.com/LTplus-AG/ifc-lite/commit/78f1d10aab812da682962845638daa95b86ae178), [`bc1a85d`](https://github.com/LTplus-AG/ifc-lite/commit/bc1a85dd532386774bcc76025de06b4fcf493937), [`bdb9978`](https://github.com/LTplus-AG/ifc-lite/commit/bdb997842fe38627fefbcddf250fc0136289bc84), [`a72c8d9`](https://github.com/LTplus-AG/ifc-lite/commit/a72c8d9d71da428cec6453e60c650c6cb296007c), [`ee6dbae`](https://github.com/LTplus-AG/ifc-lite/commit/ee6dbaedcc205b08728fa3e235bc3028d32b65e3), [`bc1a85d`](https://github.com/LTplus-AG/ifc-lite/commit/bc1a85dd532386774bcc76025de06b4fcf493937)]:
  - @ifc-lite/bcf@1.15.4
  - @ifc-lite/cache@1.14.7
  - @ifc-lite/export@1.19.2
  - @ifc-lite/renderer@1.22.1
  - @ifc-lite/wasm@1.19.1
  - @ifc-lite/parser@2.4.2
  - @ifc-lite/lens@1.15.0
  - @ifc-lite/ids@1.15.3

## 1.24.0

### Minor Changes

- [#659](https://github.com/LTplus-AG/ifc-lite/pull/659) [`f209e34`](https://github.com/LTplus-AG/ifc-lite/commit/f209e342c306041ea045bc108595676efa671eec) Thanks [@louistrue](https://github.com/louistrue)! - Render IfcAnnotation 2D representations as a 3D drawing-layer overlay
  (closes [#653](https://github.com/LTplus-AG/ifc-lite/issues/653)). Implements the BIMVision-style "model + annotations =
  engineering drawing" effect described by the OP.

  What's covered:

  - **Rust WASM**: new `SymbolicText` and `SymbolicFillArea` types
    carried alongside the existing symbolic polyline output. The parser
    walks `IfcTextLiteralWithExtent.Placement` and
    `IfcAnnotationFillArea.OuterBoundary`/`InnerBoundaries` (across
    `IfcPolyline` and `IfcIndexedPolyCurve`).
  - **TS hook**: `useSymbolicAnnotationsRichData()` returns 3D-lifted
    texts + fills with per-storey resolution. Module-level parse cache
    is now keyed on `byteLength + FNV-1a fingerprints of head/mid/tail`,
    so federated views with same-size IFCs no longer alias each other.
    Storey elevation handling distinguishes "no authored elevation"
    from "elevation = 0.0" (the previous sentinel collapsed both to
    the fallback Y).
  - **Renderer**: two new WebGPU pipelines — `SymbolicFillPipeline`
    (ear-clipping triangulation with rightmost-vertex bridge-edge
    hole stitching, premultiplied-alpha blend) and
    `SymbolicTextPipeline` (Canvas2D glyph atlas → instanced WebGPU
    quads). Both declare matching MSAA sample count + the 2-color-
    target attachment shape used by the main render pass, and run with
    reverse-Z `greater-equal` depth compare so they composite correctly
    against the scene.
  - **Viewport wiring**: `Viewport.tsx` calls the new hook unconditionally
    whenever the user enables the IFC Annotations toggle — no section-
    plane gating, since annotations are a free-floating drawing layer.

  Deferred (no behaviour change, follow-up):

  - `IfcStyledItem` → `IfcFillAreaStyleHatching` resolution. The parser
    stubs in a default opaque dark-grey solid fill; the renderer is
    ready to consume a hatch style once the styled-item index lands.

### Patch Changes

- Updated dependencies [[`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`8b22fc0`](https://github.com/LTplus-AG/ifc-lite/commit/8b22fc048da4fa94abbb5298aa509d90ab53cb2d), [`f209e34`](https://github.com/LTplus-AG/ifc-lite/commit/f209e342c306041ea045bc108595676efa671eec)]:
  - @ifc-lite/extensions@0.2.0
  - @ifc-lite/renderer@1.22.0
  - @ifc-lite/wasm@1.19.0

## 1.23.0

### Minor Changes

- [#688](https://github.com/LTplus-AG/ifc-lite/pull/688) [`d0ba541`](https://github.com/LTplus-AG/ifc-lite/commit/d0ba541dda3936b985c2189fbca4300cbb89df91) Thanks [@louistrue](https://github.com/louistrue)! - Add GLB export dialog with colour-source selection and visibility
  filtering (PR [#688](https://github.com/LTplus-AG/ifc-lite/issues/688)).

  The new `GLBExportDialog` in the viewer replaces the inline GLB
  export handler in `MainToolbar` with a dedicated dialog. Features:

  - **Model picker** for federated multi-model scenes.
  - **Colour source** selector: "Rendering" (the apparent display
    colour — `IfcSurfaceStyleRendering.DiffuseColour` if authored,
    falling back to `IfcSurfaceStyleShading.SurfaceColour`) or
    "Shading" (the raw `SurfaceColour`, only available when the file
    authored a distinct `DiffuseColour`).
  - **Visible-only filter** that respects the viewer's hidden /
    isolated entity sets. Mesh-vs-set comparison runs in global ID
    space so federated models with non-zero `idOffset` filter
    correctly.
  - **Metadata inclusion** toggle for IFC GlobalId / type / name
    side-tables.

  Pipeline changes underneath:

  - `MeshData` / `MeshDataJs` carry an optional `shadingColor`
    alongside `color`. The Rust styling module now extracts both
    `IfcSurfaceStyleRendering.DiffuseColour` (rendering) and
    `IfcSurfaceStyleShading.SurfaceColour` (shading) in a single
    pre-pass and returns them as separate maps; `shadingColor` is
    only populated when it actually differs from the rendering
    colour, so memory cost stays sparse on the common case.
  - The streaming geometry path
    (`convertMeshCollectionToBatch`) and the worker collector
    (`IfcLiteMeshCollector`) both copy `shadingColor` end-to-end so
    the dialog's "Shading" source works on every load path, not just
    the batch path.
  - `GLTFExporter` gains `colorSource`, `visibleOnly`,
    `hiddenEntityIds`, and `isolatedEntityIds` options. Visibility
    filtering compares mesh `expressId` (global) against the dialog-
    supplied sets (also global) — no offset arithmetic in the
    exporter.

### Patch Changes

- Updated dependencies [[`b0b19ad`](https://github.com/LTplus-AG/ifc-lite/commit/b0b19ad2ea205813e599cac02c964ecdb315c6b5), [`b0b19ad`](https://github.com/LTplus-AG/ifc-lite/commit/b0b19ad2ea205813e599cac02c964ecdb315c6b5), [`d0ba541`](https://github.com/LTplus-AG/ifc-lite/commit/d0ba541dda3936b985c2189fbca4300cbb89df91)]:
  - @ifc-lite/wasm@1.18.0
  - @ifc-lite/export@1.19.0
  - @ifc-lite/geometry@1.19.0

## 1.22.1

### Patch Changes

- [#795](https://github.com/LTplus-AG/ifc-lite/pull/795) [`bb3123a`](https://github.com/LTplus-AG/ifc-lite/commit/bb3123adcd751f4c27b4457156e2d0bae3b40e56) Thanks [@louistrue](https://github.com/louistrue)! - Fix "Add Model to Scene" hiding the first model when a second is
  loaded (issue [#661](https://github.com/LTplus-AG/ifc-lite/issues/661), PR [#792](https://github.com/LTplus-AG/ifc-lite/issues/792)). `useIfcFederation.addModel` always
  called `setIfcDataStore(parsedDataStore)` and
  `setGeometryResult(parsedGeometry)` after `storeAddModel`, with the
  new model's data. `modelSlice.addModel` only flips `activeModelId`
  for the FIRST model, so on subsequent adds those legacy setters
  wrote the new model's data into `models.get(activeModelId)` — i.e.
  into the FIRST model's per-model entry — aliasing both Map entries
  to the second model's mesh and rendering only one element.

  The fix drops those two redundant calls from `addModel`. For the
  first model `modelSlice.addModel` already mirrors the data into the
  top-level fields, and for subsequent models the legacy top-level
  fields must stay pointing at the active (first) model's data; the
  existing `setActiveModel` handler updates them on focus change.

- Updated dependencies [[`a6637a4`](https://github.com/LTplus-AG/ifc-lite/commit/a6637a41d948ec17841a0ac62586f627d0bb21fa), [`bb3123a`](https://github.com/LTplus-AG/ifc-lite/commit/bb3123adcd751f4c27b4457156e2d0bae3b40e56), [`bb3123a`](https://github.com/LTplus-AG/ifc-lite/commit/bb3123adcd751f4c27b4457156e2d0bae3b40e56), [`a6637a4`](https://github.com/LTplus-AG/ifc-lite/commit/a6637a41d948ec17841a0ac62586f627d0bb21fa)]:
  - @ifc-lite/wasm@1.17.0

## 1.22.0

### Minor Changes

- [#686](https://github.com/louistrue/ifc-lite/pull/686) [`b19865c`](https://github.com/louistrue/ifc-lite/commit/b19865cecc1f9c0dc05747d576604578f5af0408) Thanks [@louistrue](https://github.com/louistrue)! - BYOK key entry moves from an inline strip into a trust-focused modal with one tab per provider. Each tab shows an SVG that contrasts the direct browser → provider request path against the "via our server" path we never use, DevTools-verifiable trust claims, a clipboard-detect shortcut (so users who just created a key on the provider console don't have to paste), and a 60-second walkthrough. A small key icon in the chat header reopens the modal for management, and a "🔒 → api.provider.com" pill next to the model name names the actual API host whenever a BYOK route is active.

  Adds two new BYOK model IDs: `claude-opus-4-7` (Anthropic) and `gpt-5.5` (OpenAI). Note that Claude Opus 4.7 and the GPT-5 reasoning family reject classic sampling parameters (`temperature`/`top_p`/`top_k`); a new `acceptsSamplingParams` flag on `LLMModel` lets the direct stream client omit them for affected models.

  Web build: this is the first time API-key entry has a real surface outside the cramped inline strip, since `/settings` is desktop-only.

## 1.21.0

### Minor Changes

- [#650](https://github.com/louistrue/ifc-lite/pull/650) [`2ff772d`](https://github.com/louistrue/ifc-lite/commit/2ff772d0174f8cd6657f7e4090e15bc7744e8158) Thanks [@louistrue](https://github.com/louistrue)! - Arbitrary-normal section planes with face-pick (Bonsai-style) and a
  properly-rendered cap on tilted planes (#243). Click any face in the
  section tool's "Pick" mode to cut through it; the kept half-space
  defaults to the side facing the camera. The cardinal "Down / Front /
  Side" presets are unchanged.

  Renderer:

  - New `planeBasis(normal)` + `nearestCardinalAxis(normal)` exports
    derive a deterministic in-plane basis used by both the cap renderer
    and the 2D cutter — without a single shared derivation the cap hatch
    rotated when state was reconstructed.
  - `SectionPlaneRenderOptions` and `SectionPlane` gain optional
    `normal` + `distance` fields. When set, the shader clips on that
    plane verbatim (no axis mapping, no building-rotation, no
    position-percentage math) and the gizmo renders as a violet quad
    oriented from `planeBasis(normal)`.
  - `Section2DOverlayRenderer.uploadDrawing` accepts an optional
    `customPlane = { origin, tangent, bitangent }`. When supplied it
    replaces the cardinal-axis 2D→3D coordinate swap with
    `origin + tangent·x + bitangent·y`, so the cap silhouette lands
    exactly on the tilted plane (the bug PR #581 hid by suppressing the
    cap entirely for non-cardinal planes).

  Drawing-2d:

  - `SectionPlaneConfig` gains an optional `customPlane`. `SectionCutter`
    uses it verbatim for the plane equation and projects intersections
    to 2D via `(dot(p − origin, tangent), dot(p − origin, bitangent))`,
    matching the cap renderer's lift exactly.
  - `DrawingGenerator` now rebuilds the CPU cutter on each `generate()`
    call so a switch from cardinal to custom (or between custom planes)
    takes effect immediately.

  Tests: 11 new viewer tests covering normalisation, sign-preserving
  cardinal mapping, basis orthonormality, half-space flip, slice
  clearing on cardinal preset, and degenerate-normal handling. 6 new
  renderer tests covering basis derivation across cardinal axes,
  near-axis tilts, and the +Y / −Y reference-axis boundary.

### Patch Changes

- Updated dependencies [[`2ff772d`](https://github.com/louistrue/ifc-lite/commit/2ff772d0174f8cd6657f7e4090e15bc7744e8158)]:
  - @ifc-lite/renderer@1.20.0
  - @ifc-lite/drawing-2d@1.16.0

## 1.20.0

### Minor Changes

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - Per-class visibility toggles for ASPRS-classified point clouds.

  A new "Classes" section in the point cloud panel exposes a checkbox
  list of every LAS 1.4 standard class (Ground, Vegetation, Building,
  Water, Wires, Bridge deck, ...). Toggling a class hides every point
  with that classification. Works in any colour mode; the swatch
  colours mirror the splat shader's classification palette so the UI
  matches what's on screen.

  Implementation:

  - New `pointCloudClassMask: number` (u32 bitmask, default
    `0xFFFFFFFF`) on the point cloud slice. `togglePointCloudClass(id)`
    flips a single bit; `setPointCloudClassMask(mask)` replaces all 32.
  - `PointCloudRenderOptions.classMask` plumbed through the renderer.
    Stored in uniform slot `flags.w` (was unused).
  - Splat shader checks `(flags.w >> classId) & 1` per vertex; hidden
    classes get a degenerate `clipPos = vec4(0, 0, -2, 1)` so they're
    culled before rasterisation rather than wasted on a fragment-stage
    discard.
  - New `PointCloudClasses` component in the panel renders a
    `<details>` collapsible with "Show all" + per-class toggles. A
    badge surfaces "N of 32 visible" when not all are on.
  - `usePointCloudSync` forwards the mask to
    `setPointCloudOptions({ classMask })`.

  Class ids ≥32 always show — the mask only covers the standard
  range. Custom-labelled scans need a richer UI (deferred).

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - BIM ↔ scan deviation heatmap — GPU compute pipeline that colours each
  scan point by signed distance to the nearest mesh surface. Works with
  every IFC ingest path (STEP / IFCx / GLB / federated) and with every
  point cloud format (inline IFCx + streamed LAS / LAZ / PLY / PCD / E57
  / PTS / XYZ — anywhere `Scene.forEachMeshData` reaches and any node
  the splat pipeline already renders).

  Pipeline:

  1. **Per-triangle BVH** built from `Scene.forEachMeshData()` —
     reaches every CPU-side `MeshData` regardless of source. Median
     split along longest axis, max 16 tris per leaf, flattened to a
     `Float32Array` of 32-byte nodes during the build (no second
     pass).
  2. **Two GPU storage buffers** — nodes + triangles — uploaded once
     per mesh-set change. Cached by a `(meshCount, totalPositions)`
     fingerprint so re-running deviation against the same model is a
     pure dispatch.
  3. **Compute shader** with stack-based BVH descent (workgroup-size
     64). Per point: descend BVH pruning by squared point-to-AABB
     distance, run Ericson §5.1.5 closest-point-on-triangle on every
     leaf candidate, output signed distance via the closest face's
     precomputed normal.
  4. **Per-chunk deviation buffer** allocated alongside the splat
     vertex buffer (`STORAGE | VERTEX | COPY_DST`, 4 bytes per point,
     zero-initialised). Compute reads the vertex buffer's positions
     directly — no CPU copy of streamed clouds needed.
  5. **Splat shader** gains a 2nd vertex buffer (location 4 = `f32`
     deviation), a new `deviation` color mode, and a diverging
     blue → white → red `deviation_ramp`. Uniform block grows by 16
     bytes (new `deviationRange: vec4<f32>` slot for centre + half-
     range), `POINT_UNIFORM_SIZE` 208 → 224.
  6. **Public API** — `Renderer.computeDeviations({ maxRange?,
forceRebuild? })` returns `{ bvhTriangles, bvhNodes,
chunksProcessed, pointsProcessed, bounds, suggestedHalfRange }`.
     Awaits `queue.onSubmittedWorkDone` so callers see populated
     buffers when the promise resolves.
  7. **UI** — new `DeviationPanel` inside `PointCloudPanel`. Compute
     button (gated on `triangleCount > 0`), live progress + duration
     readout, range slider in millimetres (1 mm to 1 m), inline
     blue-white-red legend. Auto-suggests a half-range from the BVH
     bbox (±max-extent / 1000) and auto-switches the colour mode to
     `deviation` on success.
  8. **Slice** — `pointCloudColorMode` gains `'deviation'`, plus
     `pointCloudDeviationCenterOffset`, `pointCloudDeviationHalfRange`
     (default ±5 cm), and `pointCloudDeviationComputed`. Sync hook
     forwards the range to the renderer uniform.

  Sign convention: positive = scan point is on the outward-normal
  side of the closest triangle (typical "scan overshoots wall by
  5 mm"). Negative = inside / behind. Non-watertight BIM (typical
  IFC) means "inside the building" isn't globally defined, but
  per-surface front/back is always meaningful.

  Limitations / future work:

  - The dispatch processes every uploaded point against every
    triangle in the scene; isolated / hidden meshes still contribute
    to the BVH. A `meshFilter` predicate is a natural follow-up.
  - Histogram + auto-range from p5/p95 not yet implemented — the
    default half-range suggestion is a coarse bbox/1000 heuristic.
    Phase B will add a 2nd compute pass with atomic histogram.
  - The BVH walk uses a 64-deep per-thread stack. Pathologically
    unbalanced trees (>64 deep) silently drop the deepest branch.
    Real BIMs don't get there; SAH or surface-area cost would help
    if we ever hit it.

  Verified: full repo typecheck (24/24), 655 viewer tests, viewer
  Vite build green.

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - Near-term UX features from #611.

  **Hover XYZ readback.** GPU pick now also samples the depth texel at
  the click position and unprojects it through the inverse view-
  projection. `PickResult` carries an optional `worldXYZ`. Reverse-Z is
  honoured (depth=1 = near, 0 = far / miss). The hover tooltip shows
  `x, y, z` (2 decimals) under the entity id. Useful for measurement
  hooks and point-cloud picks where the synthetic entity has no
  surface property to display.

  **Solid-color picker.** When the point-cloud panel's colour mode is
  set to `fixed`, a native `<input type="color">` swatch appears.
  Hex round-trips through the existing `[r,g,b,a]` store tuple.

  **Colour-mode legend.** A new `PointCloudLegend` component renders
  inline beneath the colour-mode buttons:

  - Classification → list of ASPRS LAS 1.4 class id / colour swatch /
    label (Ground, Vegetation, Building, ...). Palette mirrors
    `point-shader.wgsl.ts` exactly.
  - Intensity → black-to-white gradient bar with low/high labels.
  - Height → cool-warm gradient bar (blue → cyan → green → yellow →
    red), matching the shader's `height_ramp`.
    RGB and Solid don't render a legend.

  **Cancel button for in-flight streams.** New
  `activeStreamCanceller` field on the loading slice. Both ingest
  sites (`useIfcLoader`, `useIfcFederation`) register
  `() => streamHandle.cancel()` after starting and clear on success /
  error. `StatusBar` shows a Cancel button while the canceller is
  non-null. AbortError on cancel is reported as "Cancelled" rather
  than a scary error string.

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - PTS / XYZ ASCII point cloud reader.

  Both formats are line-oriented plain-text scans common in legacy
  survey workflows. They share the same syntax — they differ only in
  the optional first-line point count (PTS may have one; XYZ never
  does). One shared decoder + streaming source handles both.

  Auto-detected per-line layouts (by column count of the first data
  line):

  - 3 cols → `X Y Z`
  - 4 cols → `X Y Z I` (intensity)
  - 6 cols → `X Y Z R G B`
  - 7 cols → `X Y Z I R G B` (canonical PTS)
  - 9 cols → `X Y Z R G B Nx Ny Nz` (XYZ-with-normals; normals dropped)
  - 10 cols → `X Y Z I R G B Nx Ny Nz` (PTS-with-normals; normals dropped)
  - For XYZ with unknown column counts ≥3 we still emit positions and
    skip the rest, so weird custom exports load instead of erroring.

  Other behaviour:

  - Comment lines (`#`, `//`) and blank lines are skipped.
  - Intensity normalisation: 0..1 vs 0..255 vs raw sensor detected from
    the observed maximum, then mapped to u16.
  - RGB normalisation: same heuristic (>1.0 → 0..255 source).
  - Whole-file decode wrapped in `AsciiPointsStreamingSource`; the
    streaming host's 25M-point cap stride-downsamples on the way out.

  Wired into the decode worker, format detection
  (`detectPointCloudFormat` returns `'pts'` / `'xyz'`), the file
  picker accept lists, drop handlers, and both `useIfcLoader` /
  `useIfcFederation` ingest branches. The "PTS / XYZ ASCII points —
  not yet supported" toast is removed from `describeUnsupportedFormat`.

  10 new unit tests cover layout probing, decoder round-trips for the
  common shapes, and the comment / header-count edge cases.

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - GPU rectangle pick (marquee select) — meshes + point clouds.

  Hold `Ctrl` (or `⌘` on macOS) and drag with the left mouse button
  in the select tool to draw a rectangle. On release, every entity
  (mesh or point cloud) whose pixel falls inside the rect becomes
  the new selection. A teal-dashed SVG outline tracks the drag.

  Implementation:

  - `Picker.pickRect(x0, y0, x1, y1, …) → Set<expressId>` renders the
    same pick pass as `pick()` and reads back the texel rect, deduping
    hits to a Set. Mesh + point splats both participate (point splats
    share the depth buffer in the pick pass).
  - A new private `Picker.renderPickPass` extracts the shared render-
    pass setup so single-pixel `pick` and rect `pickRect` don't drift.
  - `PickingManager.pickRect` applies the same visibility filtering
    (`hiddenIds`, `isolatedIds`) as `pick`. The CPU-raycast and
    dynamic-mesh-creation fallbacks `pick` uses for very large batched
    models are skipped — rect pick only sees already-hydrated meshes.
  - `Renderer.pickRect` exposes the manager's API.
  - New `RectSelectionOverlay` component renders the dashed SVG box
    while dragging; lives inside `Viewport.tsx` as a sibling of the
    canvas.
  - `useMouseControls` tracks a new `mouseState.isRectSelecting` flag,
    suppresses orbit/pan during the drag, and on mouseup runs
    `renderer.pickRect(...)` and feeds the result into
    `setSelectedEntityIds`. A 4-pixel minimum rect size avoids
    clobbering selection on a stray Ctrl-click.
  - `MouseState.isRectSelecting?: boolean` and a new
    `setRectSelection?` callback added to `UseMouseControlsParams`.

  Lasso (polygonal) pick still pending — covered by issue #611's
  mid-term list. Per-class isolation for points is a separate
  follow-up.

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - Section-plane drag preview — render at 1/4 density during slider
  drag for responsive section-cutting on huge point clouds.

  The splat shader gains a `previewStride` uniform that culls
  `(instance_index % stride) != 0` at the start of `vs_main`. The
  section-plane position slider wires `onPointerDown` to set
  `previewStride: 4` and `onPointerUp` to restore `1`, so scans of
  millions of points stay responsive while the user drags.

  Implementation:

  - `POINT_UNIFORM_SIZE` bumped from 208 → 224 to add a new
    `extras: vec4<u32>` slot. `extras.x` carries `previewStride`;
    `yzw` reserved for future per-frame state.
  - `PointCloudRenderOptions.previewStride?: number` clamped to
    [1, 256] in the renderer.
  - Vertex shader culls hidden instances by writing
    `clipPos = vec4(0, 0, -2, 1)` (outside reverse-Z `[0, 1]`) so they
    drop pre-rasterisation.
  - New `pointCloudPreviewStride` field on the point cloud slice
    (default 1) with `setPointCloudPreviewStride` action.
  - `usePointCloudSync` forwards the stride to
    `setPointCloudOptions`.
  - `SectionOverlay`'s position slider triggers stride 4 on
    drag start (pointer + keyboard), 1 on release. Only flips when
    `pointCloudAssetCount > 0` so IFC-only sessions are unaffected.

  Triangle meshes ignore the stride — they're cheap enough that
  section drag was already smooth.

  Verified: full repo typecheck (24/24), 655 viewer tests, viewer
  Vite build green.

### Patch Changes

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - Fix LAZ load failing with `WebAssembly: Response has unsupported MIME
type 'text/plain'` on real-world files (e.g. autzen-classified.laz).

  `laz-perf`'s emscripten shim resolves the wasm via `locateFile()` and
  calls `fetch("laz-perf.wasm")` relative to its own script directory.
  In a Vite-bundled module worker that path becomes `/assets/<chunk>/…`
  or just `/laz-perf.wasm` — both 404, and the SPA fallback returns
  `index.html` as `text/plain`, which `instantiateStreaming` rightly
  rejects. The async fallback then 404s the same way and aborts.

  `loadLazPerf` now resolves the wasm asset URL through Vite's
  `?url` import (`laz-perf/lib/web/laz-perf.wasm?url`), pre-fetches the
  bytes itself, and hands them to emscripten as `Module.wasmBinary` so
  the shim's own fetch is bypassed entirely. Failure modes (asset
  resolution, fetch HTTP error) now produce a precise error message
  naming the URL and status instead of the opaque emscripten "Aborted".

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - Near-term batch — correctness + robustness items from #611.

  **`computeBBox` empty / non-finite guards.** Both `e57.ts` and
  `ifcx-points.ts` now return `{0,0,0}/{0,0,0}` for empty arrays and
  skip non-finite triplets. Previously a zero-point or NaN-poisoned
  chunk produced ±Infinity bounds that broke camera fit-to-view and
  section-plane sliders.

  **Magic-byte-first format detection.** `detectPointCloudFormat` now
  probes the buffer (E57 magic, LASF magic, "ply" / "#" / ".PCD"
  ASCII tokens) before falling back to extension. A LAS file
  mistakenly named `*.ply` no longer goes down the wrong decoder. LAS
  vs LAZ still uses the extension to disambiguate (they share the
  LASF magic).

  **E57 packet-bounds + per-stream guards.** Validate that the
  DataPacket header, bytestream-length table, and each individual
  bytestream stay inside `payloadEnd = packetEnd - 4` before reading.
  Corrupt files now fail with a precise "bytestream X runs past
  packet payload" error instead of silently reading into the next
  packet.

  **`e57.ts` split (631 → 4 files).** `e57-page.ts` (header / page CRC
  / section-header resolver), `e57-xml.ts` (prototype + Data3D
  parser), `e57-decode.ts` (per-scan binary decoder), `e57.ts`
  (orchestrator + re-exports). All four under the AGENTS ~400-line
  guideline.

  **`point-cloud-renderer.ts` extract.** Pulled the uniform-block
  writer into `point-cloud-uniforms.ts` (`writePointCloudUniforms` +
  mode index maps). Renderer drops below 400 lines.

  Verified: 62 pointcloud unit tests pass, full repo typecheck
  (24/24).

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - Round 2 of CodeRabbit feedback on PR #614:

  - **E57 stride downsampling drops classifications.** `applyStride` rebuilt
    positions / colors / intensities into new arrays but never copied the
    per-point class IDs, so any non-default stride (`{ stride: 2 }` and up)
    silently lost them and `hasClassification` flipped to false.
  - **Federation abort can stomp a newer load.** The AbortError handler in
    `useIfcFederation.addModel()` wrote `progress`, `error`, and `loading`
    unconditionally — if a second `addModel()` started after the first was
    cancelled, it lost its spinner and progress to the cancelled load's
    cleanup. Added a `loadSessionRef` token (mirrors `useIfcLoader`) and
    gate state writes on `loadSessionRef.current === currentSession`.
  - **E57 Integer classification subtracts `minimum`.** Class IDs are
    absolute labels (ASPRS LAS 1.4 0..31), not range-normalised offsets.
    `raw - minimum` was corrupting class IDs whenever a producer declared
    a non-zero `minimum` on the Integer-encoded classification field. The
    Integer branch now matches the ScaledInteger branch's intent: keep
    the raw byte, clamp to 0..255.
  - **PCD probe missed `VERSION` / `FIELDS` headers.** The magic-byte
    detector only recognised `# .PCD …` comment-style headers. Real PCDs
    emitted by PCL's `pcl_io` and a few third-party tools start directly
    with `VERSION 0.7\n…` or `FIELDS x y z\n…` — these now route through
    the PCD decoder instead of falling through to extension-based
    detection (which would mis-route a renamed PCD).
  - **Catch-block logging.** Per repo convention, log point-cloud ingest
    failures in `useIfcLoader.ts` before the early return so abort vs.
    real-failure vs. stale-session paths are distinguishable in console
    triage.

  Test cleanup: drop the shadowed (and unused) ScaledInteger packet
  buffer in `e57.test.ts` so only the live `fullBuf` setup remains.

- Updated dependencies [[`8408c88`](https://github.com/louistrue/ifc-lite/commit/8408c88c4c0a1e848fade6c60474952eca1a4149), [`2334993`](https://github.com/louistrue/ifc-lite/commit/2334993827839b9f5b96ca8008c49543fb597660), [`ba7553a`](https://github.com/louistrue/ifc-lite/commit/ba7553af693939896a840074999b5f6806a94815), [`2ab0e4c`](https://github.com/louistrue/ifc-lite/commit/2ab0e4c0eafc21feb22bfc7cd96c467b8b9ff599), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e), [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e)]:
  - @ifc-lite/wasm@1.16.9
  - @ifc-lite/geometry@1.18.0
  - @ifc-lite/parser@2.4.0
  - @ifc-lite/data@1.17.0
  - @ifc-lite/renderer@1.19.0
  - @ifc-lite/pointcloud@0.3.0
  - @ifc-lite/ids@1.15.1
  - @ifc-lite/lists@1.14.12

## 1.19.2

### Patch Changes

- [#622](https://github.com/louistrue/ifc-lite/pull/622) [`28db7df`](https://github.com/louistrue/ifc-lite/commit/28db7df0fa64dc8cab0d08f4948fb1d9b67e0f70) Thanks [@louistrue](https://github.com/louistrue)! - Cesium overlay: precomputed terrain placement, ground-floor clamping,
  and a refactored camera path.

  **Placement is now resolved before the bridge is built** (no more
  "model loads at IFC OrthogonalHeight, then jumps to terrain"):

  - `terrain-elevation.ts` (new module) tries sources in fast-first
    order — sync `globe.getHeight`, sync `scene.sampleHeight`, async
    `scene.sampleHeightMostDetailed` with a 3.5 s timeout, then
    Open-Meteo as a bare-earth fallback. Implausible elevations
    (e.g. depth-buffer noise from Google Photorealistic 3D Tiles
    returning `-69184 m`) are range-checked against terrestrial bounds.
    Results are cached per-session via `clearTerrainElevationCache()`.
  - `sampleHeightMostDetailed` runs _before_ Open-Meteo so the model
    lands on the same surface the user actually sees in 3D Tiles
    (street decks, podiums) rather than the bare-earth DEM.
  - `createCesiumBridge` accepts a `placementHeightOverride` so the
    computed placement is baked into the `enuToEcef` origin altitude
    for both camera frame and model matrix from creation.

  **`findClampAnchorY` (new helper, 9 unit tests)** picks the anchor
  viewer-Y that auto-clamp pins to terrain. Primary: the
  `IfcBuildingStorey` whose elevation is closest to 0 (ground floor),
  within the model AABB. Fallback: `bounds.min.y`. Without this,
  basements and foundations dragged the model deep below the terrain
  surface.

  **`oHeightForBaseAltitude`** in the Georeferencing panel now mirrors
  the auto-clamp formula (anchor-aware, shift- and RTC-aware), so the
  "Set OrthogonalHeight to Cesium terrain elevation" button produces
  the same world position as toggling the clamp.

  **UX behaviours**

  - `cesiumTerrainClamp` defaults to `true` (slice + reset path).
  - Clamp toggle is now actually uncheckable — dropped the auto-toggle
    branch that fought the user's setting.
  - Editing OrthogonalHeight directly auto-releases the clamp so the
    edit takes effect (with clamp on, placement is intentionally
    terrain-anchored regardless of OrthogonalHeight).
  - Stale `terrainHeight` / `terrainClipY` are cleared when a re-query
    fails so the clip plane doesn't drift relative to the new bridge.
  - Effect 2d depends on `bridgeVersion` so the model matrix refreshes
    after an async bridge rebuild.

  **Camera navigation refactor.** Reported symptom: orbit/zoom
  restricted to the terrain plane. Two coupled root causes:

  1. `screenSpaceCameraController.enableInputs` was still default-true.
     Any input slipping past the overlay's `pointer-events: none`
     reached Cesium and got processed in the locked frame, fighting
     our externally-driven pose. Now flipped to `false` (master kill-
     switch) on top of the per-mode flags.
  2. `syncCamera` used `lookAtTransform(viewerToEcef)` to write
     position/direction/up in viewer-space. `lookAtTransform` _locks_
     Cesium's reference frame; rotate/tilt/zoom operations are then
     constrained to that local frame — the "stuck to terrain plane"
     behaviour. Refactored to clear `lookAtTransform` with
     `Matrix4.IDENTITY` and write position/direction/up directly in
     ECEF (Cesium's RTC handles shader precision for primitives).

  **Network hygiene.** `queryTerrainElevation` (Open-Meteo) gets a 5 s
  `AbortController` timeout and a `console.warn` so failures are
  visible instead of silently swallowed.

- [#622](https://github.com/louistrue/ifc-lite/pull/622) [`28db7df`](https://github.com/louistrue/ifc-lite/commit/28db7df0fa64dc8cab0d08f4948fb1d9b67e0f70) Thanks [@louistrue](https://github.com/louistrue)! - Apply IfcMapConversion.Scale per IFC schema (issue #595).

  Scale converts local engineering coordinates (in the project length unit)
  to map CRS units (e.g. `0.001` for a millimetre project with a metre map).
  ifc-lite's geometry pipeline already converts vertices to metres during
  extraction, so applying the raw Scale to viewer-space coordinates double-
  scaled the model — making the Cesium 3D world context unusable for files
  authored per spec.

  Introduces `getEffectiveHorizontalScale(scale, mapUnitScale, lengthUnitScale)`
  which returns `(scale × mapUnitScale) / lengthUnitScale` — the correct
  multiplier for metre-converted geometry. For files where Scale is set
  consistently with the unit difference this evaluates to 1.0 and the
  geometry passes through unchanged. Wired through:

  - `cesium-bridge.ts` — 3D model origin and the viewer→ENU rotation.
  - `CesiumOverlay.tsx::buildModelMatrix` — GLB placement.
  - `reproject.ts` — 2D map centre, footprint, and reverse-pick.
  - `useIfcFederation.ts` — multi-model alignment transform.

  Adds a visible amber warning in the Georeferencing panel when
  `Scale × mapUnitScale ≠ lengthUnitScale` (the IFC schema invariant) so
  authoring errors are discoverable. The warning surfaces both inline (in
  the expanded Coordinate Operation section) and as a small indicator on
  the collapsed section header.

- Updated dependencies [[`7c85376`](https://github.com/louistrue/ifc-lite/commit/7c853760ef96e6f0f88ebdc29c17aefae724ff43), [`7c85376`](https://github.com/louistrue/ifc-lite/commit/7c853760ef96e6f0f88ebdc29c17aefae724ff43), [`5439cce`](https://github.com/louistrue/ifc-lite/commit/5439cce34edaff1c050ce8975a330163167df6fd)]:
  - @ifc-lite/data@1.16.0
  - @ifc-lite/ids@1.15.0
  - @ifc-lite/geometry@1.17.1
  - @ifc-lite/lists@1.14.11

## 1.19.1

### Patch Changes

- Updated dependencies [[`7a7cf79`](https://github.com/louistrue/ifc-lite/commit/7a7cf79c181004f9974bd303181aeeaa97d6869d), [`7a7cf79`](https://github.com/louistrue/ifc-lite/commit/7a7cf79c181004f9974bd303181aeeaa97d6869d)]:
  - @ifc-lite/ids@1.14.11
  - @ifc-lite/mcp@0.2.0

## 1.19.0

### Minor Changes

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - E57 reader (subset) + clear errors when users drop unsupported formats.

  **E57 (ASTM E2807-11) reader.**

  - 48-byte FileHeader parser (`ASTM-E57` magic + xmlPhysicalOffset/Length
    - pageSize).
  - Page-CRC stripping: every 1024-byte physical page ends with 4 bytes
    of CRC32-C; we strip them to get the logical view that XML offsets
    reference. CRCs aren't validated (faster + still correct on
    well-formed files).
  - XML parser via `DOMParser` walks `e57Root → data3D → vectorChild` and
    extracts each scan's record count, binary fileOffset, and prototype
    fields.
  - Binary section decoder walks DataPackets, reads bytestream length
    table, decodes uncompressed Float32 / Float64 cartesianX/Y/Z plus
    optional Float colors and Integer u8 colorRed/Green/Blue.
  - ScaledIntegerNode encoding throws a clear error so the host can guide
    the user to a Float-encoded export.

  **Drop UX.** Dropping a file we can't load (Recap `.rwp/.rwi/.rwcx/.dmt`,
  `.skp`, `.zip`, Faro `.fls`, ASCII `.pts/.xyz`) now shows an
  explanatory toast describing what the format is and what to do
  (typically: "export to E57 / LAS / PLY"). Previously the drop was
  silently rejected.

  **File picker** accepts `.e57` in browser drop, the native dialog, and
  the recent-files command palette.

  7 new pointcloud unit tests cover the FileHeader parser, page-CRC
  stripping (full pages and partial trailing page), the binary packet
  walker on a hand-built single-packet scan with Float64 cartesianX/Y/Z

  - uint8 RGB, and the ScaledInteger error path.

  Tests: 48 pointcloud unit tests pass, full repo typecheck (24/24),
  test suite green (22 runs), viewer Vite build emits decode-worker
  chunk correctly.

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Fix LAZ loading + add PLY / PCD as standalone formats; sliders feel
  responsive on first contact.

  **LAZ silently failed to load.** `laz-perf` is shipped as CommonJS,
  which Vite/webpack wrap under `.default` differently across builds.
  The previous probe only checked `lazPerf.createLazPerf` and
  `lazPerf.default` (as a function), so all real-world LAZ loads threw
  "could not find createLazPerf factory". The probe now walks four
  candidate shapes (named export, `default.createLazPerf`, `default` as
  function, namespace-as-function) and reports the visible keys when
  none match.

  **PLY + PCD now load directly.** Two new streaming sources backed by
  the existing format decoders:

  - `PlyStreamingSource` — ASCII + binary little/big-endian, optional
    RGB (uchar) + intensity. Header probe (64 KB) + whole-file decode.
  - `PcdStreamingSource` — wraps `decodePcd` (already supported PCD
    ASCII / binary / binary_compressed via inline LZF).

  Both use stride downsampling for the host's 25M-point cap.

  **Format detection** sniffs `.ply` (magic "ply"), `.pcd` (`# .P` or
  `.PCD` token), and the existing `.las/.laz` paths.

  **File picker** accepts `.ply` and `.pcd` in browser drop, the native
  dialog, and the recent-files command palette.

  **Slider UX.** Default size mode is now `fixed-px` (was `attenuated`).
  The previous default felt inert because the slider in `attenuated` mode
  is the upper _cap_ on adaptive sizing — at typical wide views the
  projected world-radius sat well below the cap, so dragging the slider
  1↔20 px never engaged. `fixed-px` always uses the slider value, and
  "Auto" is one click away when users want adaptive behaviour.

  **Worker URL fix.** `worker-client.ts` now imports
  `./decode-worker.ts` (matching geometry's pattern) so Vite's worker
  plugin resolves through the source-alias path. The package's build
  script post-rewrites that to `.js` for dist consumers.

  Tests: 41 pointcloud unit tests pass (7 new for PLY ascii/binary +
  header probe + truncation), full repo typecheck (24/24), full test
  suite (22 runs green), viewer Vite build emits the decode-worker
  chunk correctly.

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Phases 1–4 of point cloud loading.

  - **LAS streaming** (`.las` files) — header parser + per-point record decoder
    for ASPRS Point Data Formats 0–10, with auto-detection of "8-bit RGB
    in u16 channels" producers and on-the-fly rescaling.
  - **LAZ streaming** (`.laz` files) — wraps `laz-perf` (Apache-2.0) as a
    runtime dep, decoded inside a Web Worker so the main thread stays
    responsive.
  - **Streaming pipeline** — Blob-backed byte source, decode worker with a
    postMessage protocol that ships chunks back as transferable typed-array
    buffers, host-side controller that paces decode, applies a 25M-point
    memory cap with stride downsampling, and reports progress / completion.
  - **Renderer streaming API** — `Renderer.beginPointCloudStream`,
    `appendPointCloudChunk`, `endPointCloudStream`, `removePointCloudAsset`,
    `setPointCloudOptions`. Streamed assets coexist with IFCx-derived
    assets in separate ownership buckets so `setPointClouds` doesn't clobber
    active streams.
  - **Color modes** — `rgb` / `classification` (ASPRS palette) / `intensity` /
    `height` (cool-warm ramp) / `fixed`. Per-point classification + intensity
    travel through the GPU vertex layout and the WGSL shader picks the
    channel based on the active mode uniform.
  - **Viewer integration** — file picker accepts `.las,.laz` (browser drop +
    native dialog), a small bottom-left panel exposes the color modes when
    point clouds are loaded, and the federation registry's `modelIndex`
    flows through streaming ingest for multi-model picking parity.

  GPU-based point picking is deferred to a follow-up; clicks on points
  return null and don't crash existing mesh selection.

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Point cloud rendering quality: splat pipeline + Eye-Dome Lighting.

  The 1-pixel `point-list` rendering looked great from far away but turned
  into a halftone screen as you zoomed in — `point-list` topology has no
  `gl_PointSize` equivalent in WebGPU, so density was fixed in screen space.

  This swaps the pipeline for instanced 6-vertex quad splats and adds a
  post-pass EDL for depth perception.

  **Splat pipeline**

  - `topology: 'triangle-list'`, vertex buffer `stepMode: 'instance'`,
    6 verts emitted per source point. Vertex shader picks a corner from
    `vertex_index` and inflates clip-space position by the active size.
  - Three size modes:
    - `fixed-px` — every splat is N pixels (1..20)
    - `adaptive-world` — splat covers a world-space radius, projected each
      frame; closer = bigger
    - `attenuated` (default) — adaptive but clamped to [1, N] px so splats
      stay visible at far plane and don't blow up to half the screen up close
  - Round shape: fragment discards corners outside the unit disc, so splats
    render as discs not squares.

  **Eye-Dome Lighting**

  - New `EdlPass` runs after the existing PostProcessor. Samples 4 (low) or
    8 (high) neighbouring depths at radius R px, computes mean log-depth-
    diff, darkens by `1 - exp(-300 * meanLog * strength)`. ~9 texture taps
    per pixel. Only active when point clouds are loaded.
  - Reverse-Z aware (`max(0, log(centre) - log(neighbour))`), early-out at
    the far plane.

  **UI**

  - `PointCloudPanel` gains size-mode buttons, a 1–20 px slider, a 1–100 mm
    world-radius slider (visible in adaptive/attenuated modes), and an EDL
    toggle with a 0–3 strength slider.
  - New `pointCloudSlice` fields: `pointCloudSizeMode`, `pointCloudPointSize`,
    `pointCloudWorldRadius`, `pointCloudRoundShape`, `pointCloudEdlEnabled`,
    `pointCloudEdlStrength`. Slice clamps numeric ranges.

  Renderer API additions: `setEdlOptions({enabled, strength, radiusPx,
highQuality})`. `setPointCloudOptions` now also accepts `sizeMode`,
  `worldRadius`, `roundShape`.

### Patch Changes

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Three Codex review fixes on the streaming ingest path.

  **Streamed point cloud assets leaked across model removal.** The
  renderer handle returned from `beginPointCloudStream` was discarded,
  and streamed nodes are intentionally outside the IFCx
  `setPointClouds` bucket, so removing a model left the GPU buffers
  allocated for the rest of the session. `FederatedModel` now carries
  an optional `pointCloudHandleId`; both ingest sites populate it; a
  new `usePointCloudLifecycle` hook diffs the model map on every
  change and frees handles for models that disappear.

  **Double cleanup on ingest failure.** The outer `try/catch` in both
  ingest sites called `removePointCloudAsset` + `incCount(-1)`, but
  `ingestPointCloud`'s `onError` already does the same before
  rethrowing. The duplicate cleanup pushed the asset counter negative
  and caused a "remove twice" warning. The outer `catch` now only
  handles store / UI state.

  **PCD header probe.** The streaming source used the file's reported
  size as the upper bound for the header probe; on truncated files
  that walked off the end with a confusing error. Capped the probe at
  4 KiB so malformed PCD headers fail with a clear "header > 4 KiB"
  message.

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Fix two regressions that prevented point clouds from rendering in the viewer:

  1. **IFCx samples extracted zero points.** The entity extractor required
     `bsi::ifc::class` on every node before assigning an `expressId`, but the
     buildingSMART Point*Cloud*\*.ifcx fixtures place `pcd::base64` /
     `points::array` / `points::base64` on nodes that carry only USD
     `xformop`. Those nodes now also become first-class entities (synthetic
     `IfcGeographicElement` type) so the point cloud extractor can emit
     them. Added regression assertions in `verify-dist-hello-wall.mjs`.

  2. **`.las` / `.laz` files were silently ignored on single-file load.**
     The drop / picker single-file path goes through `useIfcLoader.loadFile`,
     which only branched on `ifcx` / `glb` / `ifc`. Added the LAS/LAZ branch
     there and wired it into the streaming ingest. Camera fit-to-view now
     triggers from `usePointCloudSync` for points-only scenes (the geometry
     streaming hook bails out early when there are no meshes).

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Fix `TypeError: entities.getTypeName is not a function` when picking a
  point on a streamed point cloud (LAS / LAZ / PLY / PCD / E57).

  The synthetic `IfcDataStore` that `pointCloudIngest.ts` builds for
  point-cloud-only models stubbed `entities` with only a handful of
  methods (`getId`, `getType`, `getName`, `getGlobalId`) and used method
  names that don't match the real `EntityTable` interface. Picking
  selects the synthetic expressId, which routes through the regular
  property / hover / properties-panel pipeline — that pipeline calls
  `entities.getTypeName`, `entities.getTypeEnum`,
  `properties.getForEntity`, etc., and crashed on the missing
  `getTypeName`.

  `emptyDataStore()` now produces a stub that matches the real shape:

  - `entities`: `count=1`, `expressId=Uint32Array([id])`, `typeEnum`,
    plus `getTypeName` → `'IfcGeographicElement'`, `getName` → file
    name, `getGlobalId` → `pointcloud-<id>`, and `getTypeEnum`,
    `getByType`, `hasGeometry`, `getExpressIdByGlobalId`,
    `getGlobalIdMap` covered.
  - `properties`: real `PropertyTable` shape — `entityIndex`,
    `psetIndex`, `propIndex`, `getForEntity`, `getPropertyValue`,
    `findByProperty` (all empty / no-op).
  - `quantities` / `relationships`: matching empty stubs.
  - `entityIndex.byType` includes `IFCGEOGRAPHICELEMENT → [id]` so type
    filters resolve.

  `emptyDataStore` now takes the synthetic `expressId` and `fileName` so
  the stub round-trips real data instead of `undefined`.

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Round 3 of point cloud fixes — correctness gaps that block multi-model
  sessions and silent rendering stalls.

  **Federation relabel for streamed point clouds.**
  `ingestPointCloud` now emits a synthetic entry on
  `geometryResult.pointClouds`. Without this, `useIfcFederation`'s
  `idOffset` fold + `relabelPointCloudAsset` call never fired for
  LAS/LAZ/PLY/PCD/E57 streams, so picked `expressId`s for streamed
  assets collided across federated models.

  **Sync-throw cleanup.** Wrap `streamPointCloud()` in `try/catch`
  inside `ingestPointCloud`. The renderer asset and asset-count
  increment happen before the worker spins up, so a sync throw during
  validation/worker setup used to leak both. We now `removePointCloudAsset`

  - `onCountChange(-1)` before re-throwing.

  **`setPointClouds()` shrinks bounds correctly.** The replace path
  called `expandModelBoundsForPointClouds` (grow-only). Reloading IFCx
  with a smaller scan kept stale extents until `clear`. Switched to
  `recomputeModelBounds()` so bounds re-baseline from current state.

  **`requestRender()` after every mutation.** `appendPointCloudChunk`,
  `setPointCloudOptions`, `setEdlOptions`, `setPointClouds`,
  `addPointClouds`, `clearPointClouds`, `removePointCloudAsset`,
  `endPointCloudStream` now schedule a frame. Previously streamed
  chunks could sit invisible until an unrelated camera move triggered
  the next render.

  **Worker cancel race.** `worker-client.next()` now re-checks
  `signal.aborted` after `await session.send()`. A chunk that won the
  race against `cancel()` would otherwise still call `onChunk` after
  the host returned to the caller.

  **Multi-scan E57 rejection.** `parseE57Xml` now records `hasPose` per
  Data3D entry. `decodeE57` rejects multi-scan files where any entry
  carries a `<pose>` element, with a clear "registered multi-scan;
  re-export as merged" error. Previously such files silently
  concatenated in scan-local space and rendered misaligned.

  Verified: 62 pointcloud unit tests (1 new for pose flag), full repo
  typecheck (24/24), viewer Vite build green.

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Address CodeRabbit + Codex review feedback on PR #608.

  Critical visual / correctness fixes:

  - Point splats rendered ~2× too large because the shader treated the
    user-facing `pointSizePx` (diameter) as the splat radius. Fixed in
    both the live splat shader and the picker shader so click targets
    match the rendered disc.
  - Routed every detected point-cloud format (`ply`, `pcd`, `e57`) through
    the streaming ingest in both `useIfcLoader` (single-file drop) and
    `useIfcFederation` (multi-file). Previously only `las/laz` got the
    pointcloud branch; `ply/pcd/e57` fell through into the IFC STEP path.
  - Federation: applied `idOffset` to `geometryResult.pointClouds` too so
    multi-pointcloud-model loads don't collide on local `expressId`.
  - `expressId` defaulted to `1` on every ingest, so multiple inline LAS
    loads collided. Now uses a process-local synthetic counter.
  - E57 integer color channels are commonly u16 (0..65535); reader was
    forcing u8 reads, distorting RGB. Now picks element width from the
    declared min/max range.
  - PCD `applyStride` preserved positions + colors but dropped intensity
    and classification, so those color modes silently broke on files
    past the 25M-point downsample cap.
  - Inline `uploadAssetToGpu` forwards `intensities` + `classifications`
    (added to `PointCloudAsset.chunk` shape).
  - Model bounds recomputed after `removePointCloudAsset` /
    `clearPointClouds` — previously stayed oversized, breaking
    fit-to-view and section sliders.
  - `usePointCloudLifecycle` disposes a model's GPU asset when the model
    stays in the store but its `pointCloudHandleId` changes (re-stream of
    the same file used to leak the old handle).
  - `resetViewerState` now clears the point-cloud slice runtime fields so
    loading a new file doesn't inherit the previous file's color mode /
    size / EDL state.

  Correctness / robustness:

  - `streamPointCloud`'s host now closes the source on probe + onOpen
    failures (single try/finally wrapping the whole open-and-decode
    flow), so worker-backed sources don't leak the decoder on parse
    errors or aborts.
  - `worker-client.close()` clears cached `info`; subsequent `open()`
    actually re-opens instead of returning stale info next to a null
    `sourceId`.
  - `LasStreamingSource.open()` and `LazStreamingSource.open()` are
    atomic on failure: state is committed only after every step
    succeeds, so a retry rerruns the probe + RGB-scale detection
    cleanly. LAZ also frees malloc'd wasm pointers in the catch path.
  - PLY decoder rejects files where `vertex` isn't the first element
    (decoder reads from `header.bodyOffset`; non-leading vertex would
    silently produce garbage).
  - `decodePointsArray` validates each `colors[i]` is a `[r,g,b]` triple
    before indexing, so malformed schemas fail with a clear message.
  - `useIfcLoader` LAS/LAZ/PLY/PCD/E57 branch is guarded by
    `loadSessionRef` on both error and success paths so a newer load can
    replace an in-flight one without overwriting the newer model state;
    stale renderer handle is freed.

  Critical webhook fixes:

  - `ViewportOverlays.tsx` had three imports between executable code;
    hoisted them above the `const isDesktop = isTauri()` declaration.
  - `edl-pass.ts` used `0u` for `texture_depth_multisampled_2d`'s
    `sample_index`; WGSL spec requires `i32`.
  - `pcd.test.ts` switched from `__dirname` to
    `fileURLToPath(import.meta.url)` so it works outside vitest's
    CommonJS-compat shim.

  UX polish:

  - `PointCloudPanel` toggle buttons expose `aria-pressed` so screen
    readers announce the active option.
  - `pointCloudSlice` setters reject `NaN`/`Infinity` (Math.min/max
    passes them through unchanged).
  - `BlobByteSource.read` clamps a negative `start` to `0`.
  - File-dialog filters split GLB out of the IFC bucket into a "Mesh
    Files" group.

  The flattenMatrix transpose flagged in the review is actually correct
  for USD's row-major-with-translation-in-row-3 convention (verified by
  inspecting the Point_Cloud_S1 sample's transform; the rendered scan is
  at the right world position). Added a clarifying comment so future
  reviewers don't reach for the wrong fix.

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Round 2 of CodeRabbit review fixes — correctness + robustness.

  P1 (real correctness):

  - Federation: streamed point clouds now get the post-`idOffset` global
    expressId in picking output. New `Renderer.relabelPointCloudAsset()`
    updates a per-asset uniform (`flags.x`) the shader prefers over the
    per-vertex attribute, so federation is just a metadata write — no
    GPU buffer rewrite. `useIfcFederation.addModel` calls it after the
    pointClouds offset is applied.
  - Section-plane range now folds in `pointCloudRenderer.getBounds()`, so
    pure point-cloud scenes don't fall through to `[-100, 100]` and mixed
    scenes don't clip points outside a smaller mesh-only range.
  - `recomputeModelBounds()` now recomputes from scratch (mesh baseline +
    current pc bounds) instead of growing-only. Previously, removing one
    of several point clouds left stale oversized extents until every
    point cloud was gone.
  - `streamPointCloud` validates `chunkSize > 0` upfront; `LasStreamingSource`
    and `LazStreamingSource` reject `maxPoints <= 0`. Prevents
    zero-progress decode loops from accidental misuse.
  - E57 merge uses `some()` instead of `every()`; mixed-attribute files
    no longer drop colour/intensity for the whole merged cloud just
    because one scan lacks the channel.
  - E57 intensity is now allocated for `Integer`-encoded prototypes too
    (was silently dropped); `ScaledInteger` throws a clear error.

  P2 (robustness):

  - `xml-mini` rejects truncated input — unclosed elements throw instead
    of silently returning a partial tree.
  - `worker-client.next()` now sends a `kind: 'abort'` to the worker when
    the signal fires mid-flight. Previously cancel returned to the caller
    while the worker kept decoding.
  - `decodePointsArray` rejects empty arrays (was producing ±Infinity
    bbox); `decodePointsBase64` rejects empty strings (no silent
    downgrade to uncoloured cloud).
  - `transformPositionsZUpToYUp` guards against zero / non-finite
    homogeneous `w` (malformed `usd::xformop` matrices).

  P3 (polish):

  - `POINT_CLOUD_DEFAULTS` is now an exported constant shared by the
    slice initializer and `resetViewerState`, so the two paths can't
    drift.
  - Replaced `as any` cast around `AbortSignal.any` with a typed
    intersection.
  - Doc comment on `pointCloudSizeMode` now matches the actual default
    (`fixed-px`).

  Verified: 61 pointcloud unit tests pass, full repo typecheck (24/24),
  test suite green (22 runs), viewer Vite build emits decode-worker
  chunk correctly.

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Streaming point clouds (LAS / LAZ / PLY / PCD / E57) now arrive in
  the renderer's Y-up convention, matching the IFCx ingest path.

  Without this, scans rendered rotated 90° onto their side because the
  renderer is Y-up internally and LIDAR / surveying formats store data
  Z-up by convention. The IFCx path applied the swap inside
  `pointcloud-extractor.ts`; the streaming path went straight from the
  worker's decoded chunk into `appendPointCloudChunk`, skipping the
  swap.

  `ingestPointCloud` now wraps `onChunk` to re-orient positions and
  bbox before forwarding to the renderer:
  Z-up: X=right, Y=forward, Z=up
  Y-up: X=right, Y=up, Z=back (negate Y to keep right-hand rule)

  Mirrors the geometry / pointcloud extractors' existing handling.

- Updated dependencies [[`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1)]:
  - @ifc-lite/pointcloud@0.2.0
  - @ifc-lite/renderer@1.18.0
  - @ifc-lite/geometry@1.17.0
  - @ifc-lite/parser@2.3.0

## 1.18.0

### Minor Changes

- [#598](https://github.com/louistrue/ifc-lite/pull/598) [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c) Thanks [@louistrue](https://github.com/louistrue)! - Add Element tool — instant 3D appearance, off-surface placement, 3D ghost preview.

  Three UX-blocker fixes that turn the Add Element tool into a real
  authoring surface (previously every drop emitted STEP into the overlay
  but the user saw nothing in the 3D scene until export+reparse).

  - **Instant 3D appearance.** Every `add*` action now also builds a
    renderer-frame mesh for the new element and injects it via the
    same `appendGeometryBatch` action `duplicateEntity` uses. Walls,
    beams, and members are oriented thickness-extruded boxes;
    columns, doors, and windows are axis-aligned boxes;
    slabs / roofs / plates / spaces are polygon extrusions (with fan
    triangulation good enough for typical room shapes). Storey
    elevation is read from the spatial hierarchy so multi-storey
    placements drop on the right floor. The new mesh is tagged with
    the federation-aware globalId so picking + selection work
    immediately and the property panel opens on the new entity.
  - **Off-surface placement.** A new
    `raycastStoreyFloor()` helper unprojects the cursor to a ray and
    intersects the storey floor plane (renderer Y =
    `storeyElevation`). The hover preview and click handler both
    fall back to it when the scene raycast misses, so columns can
    drop onto empty floor outside the existing geometry. Snap-to-
    surface still wins whenever there is a mesh under the cursor.
  - **3D ghost preview.** The SVG overlay now projects the about-to-
    commit element's 8 corners (or polygon ring) to screen and
    renders the silhouette via a convex-hull outline. Single-click
    types (column / door / window) show the ghost on hover before
    any clicks; two-click types (wall / beam / member) show it once
    the start point is placed. The ghost reads live per-type form
    params, so adjusting Width / Height / Thickness updates it in
    real time.

  Also includes a panel polish: when the active type is `space` an
  **Auto Spaces** section appears with snap tolerance, min area,
  height, naming pattern, and IfcSpaceTypeEnum settings + Preview /
  Generate buttons that drive the wall-graph face finder.

- [#598](https://github.com/louistrue/ifc-lite/pull/598) [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c) Thanks [@louistrue](https://github.com/louistrue)! - Annotate-in-3D — drop pins on the scene with notes.

  Press `P` (or pick the new `MapPin` button on the main toolbar),
  click anywhere in the 3D scene, type a note. A pin lands at the
  world point you clicked on, persists to localStorage, and re-anchors
  itself as you orbit / pan. Pins are 14px amber dots with a
  1-character glyph (numbered ≤ 9, dot beyond), drop shadow, idle-pulse
  on first paint (respects `prefers-reduced-motion`), emerald selection
  ring matching the existing constructive accent.

  Flow:

  - `P` toggles the Annotate tool. Toolbar gains a `MapPin` button
    with an amber active-tone, distinct from the primary blue used
    for Select / Walk / Measure / Section.
  - Cursor switches to crosshair while annotating.
  - Click → raycast into the scene → on hit, an inline note input
    drops at the click site with a guiding "What's worth noting?"
    label and the entity context inline (e.g. `· IfcSlab #2036`).
    Misses are silent — annotations are anchored to surface points
    by design, not floating in space.
  - `Enter` saves, `⇧Enter` newline, `Esc` cancels. Outside-click
    saves a non-empty draft and silently cancels an empty one.
  - Click an existing pin → popover with note + relative time +
    pen / trash icons. Edit mode mirrors the drop-input treatment.
  - Tool stays active across drops so you can drop several pins
    in sequence.

  Architecture:

  - New `annotationsSlice` — Map-keyed store (`begin/commit/cancel
Draft`, `update`, `remove`, `select`, `clearAll`). Notes are
    clamped at 2000 chars, soft-warned at 200. Persists to
    `ifc-lite:annotations:v1` in localStorage and survives a fresh
    slice instantiation. Covered by 9 unit tests.
  - New DOM-billboard overlay (`AnnotationLayer`) sitting on top of
    the WebGPU canvas. A single rAF loop re-projects every pin's
    world position to screen via `cameraCallbacks.projectToScreen`,
    skipping `setState` when nothing changed (so the loop is cheap
    when the camera is still). Pointer-events: none on the wrapper
    so empty space passes through to canvas controls; pins +
    popover opt back into pointer events explicitly.
  - `AnnotationPin`, `AnnotationPopover`, `AnnotationDropInput` —
    composable components, all amber-accented, edge-clamped,
    backdrop-blurred where it matters.

  Pins are NOT IFC entities — they live alongside the model as an
  authoring overlay. Future PRs will wire BCF round-trip and
  IfcAnnotation export, plus an annotations-list panel and category
  tags.

- [#598](https://github.com/louistrue/ifc-lite/pull/598) [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c) Thanks [@louistrue](https://github.com/louistrue)! - Auto Spaces — diagnostics, broader wall coverage, and a sweep of
  review feedback.

  **Auto Spaces detection.** The "no enclosed regions detected"
  failure mode now surfaces actionable counts — both in devtools
  and in the panel itself.

  - `extract-walls.ts` now tries the standard `Axis` representation
    (`IfcShapeRepresentation` with `RepresentationIdentifier='Axis'`,
    `IfcPolyline` items) **before** falling back to the
    `addWallToStore` rectangle-profile convention. That covers
    walls authored by Revit / ArchiCAD / IfcOpenShell — the previous
    extractor only handled walls placed via the Add Element tool.
    The placement chain is read once and the polyline endpoints are
    transformed through it, so rotated walls work.
  - Every wall that gets dropped is recorded with a typed reason
    (`no-axis-or-rect-profile`, `placement-not-resolvable`,
    `zero-length-axis`, …) — the panel summarises them as
    `"3× no-axis-or-rect-profile, 1× zero-length-axis"`.
  - `detectEnclosedAreas` exposes a
    `detectEnclosedAreasWithStats(...)` companion that returns
    per-stage counts (vertices, edges-after-split, faces total,
    outer / below-min-area drops, largest area). The intersection
    splitter's iteration cap now scales with input size
    (`max(100, segments * 10)`) so dense floor plans don't bail
    out early.
  - `generateSpacesFromWalls` always logs a `console.info`
    one-liner and threads a new `debug?: boolean` flag down to the
    extractor + detector for verbose tracing. The viewer's Auto
    Spaces panel exposes a "Verbose console logging" checkbox.
  - The Auto Spaces diagnostic block now shows the graph stats
    (`123v / 456e / 78f`), the drop counts, and per-reason wall
    skips. Two amber hints fire automatically when walls were
    extracted but no faces formed (likely snap tolerance), or
    when nothing extracted (likely an unsupported geometry shape).

  **Review-feedback sweep (PR #598).**

  - `addElementMeshes.linearBox()` and the SVG `linearBoxCorners`
    helper honour each endpoint's Y so a sloped beam previews as
    a sloped prism instead of being flattened to the start.
  - `bridge-store.requireStoreyId` rejects `0` (EXPRESS ids are
    1-based, `#0` is never valid).
  - `addWindow` / `addDoor` `tsParamTypes` include
    `UserDefinedPartitioningType` / `UserDefinedOperationType`
    so typed sandbox callers can hit the IFC4 round-trip without
    casts.
  - `AnnotationLayer.resolveEntityType` no longer falls back to
    `ifcDataStore` when the annotation's `modelId` is missing
    from a federated `models` map (would resolve the wrong
    entity in multi-model sessions). Single-model sessions keep
    the fallback.
  - `addDoorToStore` / `addWindowToStore` validate
    `OperationType` / `PartitioningType` against the IFC4 enum
    and re-route unknown values through
    `.USERDEFINED.` + `User-defined…Type` so custom labels
    round-trip cleanly.
  - `addWallToStore` defaults `PredefinedType` to `.NOTDEFINED.`
    (was `.STANDARD.`) to match the rest of the in-store
    builders.
  - `duplicateInStore` / `resolveDuplicateSource` allow
    `OwnerHistory` to be `null` (IFC4 made it optional). The
    duplicate emits a bare `$` token instead of `#null` for the
    omitted case.
  - `StoreEditor.addEntity` accepts an injected schema-aware
    normalizer (`setEntityTypeNormalizer`); `@ifc-lite/sdk`
    registers `normalizeIfcTypeName` + `isKnownType` at load
    time so direct callers — CLI scripts, sandbox bridge,
    unit tests — see registry-grade rejection of typos like
    `IfcWal`, plus canonical PascalCase on `EntityRef.type`.

- [#598](https://github.com/louistrue/ifc-lite/pull/598) [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c) Thanks [@louistrue](https://github.com/louistrue)! - Auto Spaces — generate IfcSpace volumes from a storey's walls.

  Pick the **Space** type in the Add Element panel and the new **Auto
  Spaces** section appears underneath the dimensions. Hit **Preview** to
  see every enclosed region the wall graph forms (live SVG overlay,
  labelled with area), then **Generate** to commit one IfcSpace per
  region. Settings: snap tolerance (collapse sloppy wall ends), min area
  (drop closets and slivers), height (extrusion), name pattern, and
  IfcSpaceTypeEnum.

  **`@ifc-lite/create`** — three new modules, all parser-pure:

  - `auto-space-detect.ts` — planar-graph face finder. Snap →
    resolve crossings → DCEL half-edge graph → leftmost-turn cycle
    walk → drop unbounded faces → filter by min area. Handles
    multi-component layouts (two non-touching rooms find both),
    T-junctions, and snap-induced corner merges. 8 fixture tests.
  - `extract-walls.ts` — pulls every wall axis on a target storey
    from a parsed `IfcDataStore`. Walks
    IfcRelContainedInSpatialStructure → IfcWall → placement chain →
    IfcRectangleProfileDef.XDim. Optional overlay reader includes
    walls created via the Add Element tool without a re-parse.
  - `generate-spaces.ts` — orchestration: extract → detect → emit
    via `addSpaceToStore` polygon mode. `dryRun` runs detection only.

  **`@ifc-lite/viewer`** — `mutationSlice.generateSpacesFromWalls`
  returns the detection result. `AddElementPanel` gains the Auto Spaces
  section; `AddElementOverlay` projects detected outlines back to screen
  using the storey's elevation so the preview tracks the camera in
  real time.

- [#598](https://github.com/louistrue/ifc-lite/pull/598) [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c) Thanks [@louistrue](https://github.com/louistrue)! - Add the `bim.store.*` namespace — high-level editing of an already-parsed
  `IfcDataStore` via the existing mutation overlay. Closes the merge-roundtrip
  gap from #592 (you can edit `IfcRectangleProfileDef.XDim` or drop a fresh
  `IfcColumn` into a model without round-tripping through a script + re-parse).

  **`@ifc-lite/mutations`** — new `StoreEditor` facade plus four
  `MutablePropertyView` extensions: positional-attribute mutations, overlay
  entity creation/deletion (with watermark seeding), and three helpers used by
  the viewer's undo/redo (`removePositionalMutation`, `restoreFromTombstone`,
  `restoreNewEntity`).

  **`@ifc-lite/create`** — new `in-store/` module: `addColumnToStore` builds a
  12-entity IfcColumn sub-graph (placement, profile, extruded solid,
  representation, product shape, rel-contained-in-spatial-structure) anchored
  to a target `IfcBuildingStorey`. `resolveSpatialAnchor` walks the parsed
  store to find the IfcOwnerHistory, the 'Body' representation context, and
  the storey's local placement.

  **`@ifc-lite/sdk`** — new `StoreNamespace` exposed as `bim.store` on
  `BimContext`. Methods: `addEntity`, `removeEntity`, `setPositionalAttribute`,
  `addColumn`. Backed by `StoreBackendMethods` on `BimBackend`; the
  `RemoteBackend` proxy round-trips them through the transport.

  **`@ifc-lite/sandbox`** — `bim.store.*` is bridged into the QuickJS sandbox
  with full TypeScript types via `bim-globals.d.ts` and an LLM cheat sheet in
  the system prompt. Gated on a new `store: true` permission (default
  `false`, mirrors the existing `mutate` permission pattern).

  **`@ifc-lite/cli`** — `HeadlessBackend.store` is now functional (was a
  no-op before). Scripts run via the CLI can edit a parsed model and export it
  with mutations applied.

  **`@ifc-lite/viewer`** — three new UI surfaces:

  - Raw STEP tab in `PropertiesPanel` — lists every positional STEP argument
    with an inline pen-icon editor for scalar values (numbers, refs, enums,
    null). Mutated rows show a purple dot and tinted background.
  - `EntityContextMenu` gains "Delete entity" (red, calls `removeEntity`
    with toast + undo support) and "Add column here…" (emerald, only enabled
    when the right-clicked entity is an `IfcBuildingStorey`).
  - `AddColumnDialog` modal — storey picker sorted by elevation, position
    (storey-local metres), cross-section, height, name, optional collapsible
    for Description/ObjectType/Tag. Anchor-resolution failures surface
    inline, not as thrown exceptions.

  Plus four new actions on `mutationSlice` (`setPositionalAttribute`,
  `removeEntity`, `addColumn`, dialog open/close) backed by per-model
  `StoreEditor` caches, with undo/redo wired for `UPDATE_POSITIONAL_ATTRIBUTE`,
  `CREATE_ENTITY`, and `DELETE_ENTITY`.

  **`@ifc-lite/parser`** — `package.json` `exports` re-ordered to put `types`
  before `import` so downstream consumers using TS5 `nodenext` resolution
  pick up the type declarations.

  **`@ifc-lite/geometry`** — re-exports `MetadataBootstrapEntitySummary` and
  `MetadataBootstrapSpatialNode` from the package index (used by viewer
  desktop services).

  **`@ifc-lite/renderer`** — `GPUBufferDescriptor` ambient declaration gains
  `mappedAtCreation?: boolean`. Internal change; the renderer was already
  using it at runtime to skip a Mojo IPC round-trip on Chrome/Dawn.

- [#598](https://github.com/louistrue/ifc-lite/pull/598) [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c) Thanks [@louistrue](https://github.com/louistrue)! - Duplicate-from-selection — pick any IfcRoot product, hit `⌘D` (or
  right-click → Duplicate), get a fully-functional clone. The
  duplicate is a first-class entity in the property panel, exports
  cleanly to STEP with all its property associations preserved, and
  ships in 6 directional variants sized to the source's bounding box.

  **`@ifc-lite/create`**

  - New `duplicateInStore(editor, source, options)` pure builder.
    Emits a fresh placement chain (`IfcCartesianPoint` →
    `IfcAxis2Placement3D` → `IfcLocalPlacement`) plus the duplicate
    `IfcRoot` with a new GUID and the source's `Representation`
    reference reused (geometry shared). Optional fresh
    `IfcRelContainedInSpatialStructure` anchors to the source's
    storey. Offset is configurable via `options.offset` — the slice
    sizes it to the source's bbox.
  - New `resolveDuplicateSource(store, expressId)` walks the parsed
    `IfcDataStore` for placement / parent / location / storey /
    associations.
  - New `SourceAssociation` shape captures one
    `IfcRelDefines*` / `IfcRelAssociates*` edge that references
    the source. The builder replays each one against the duplicate
    so the exported STEP carries identical psets / qsets /
    materials / classifications / documents / type binding —
    without modifying any existing rel.
  - Resolver scans the five association rel types
    (`IFCRELDEFINESBYPROPERTIES`, `IFCRELDEFINESBYTYPE`,
    `IFCRELASSOCIATESMATERIAL`, `…CLASSIFICATION`, `…DOCUMENT`)
    by direct numeric membership in `RelatedObjects`.
  - `DuplicateBuildResult.associationRelIds: number[]` exposes the
    fresh rel ids for caller introspection.
  - 7 unit tests in `duplicate.test.ts`: full graph emission,
    custom offset, no-storey path, root-placement parent, attribute
    count guard, association replay (3 rel types in one go), and
    the no-associations case.

  **`@ifc-lite/mutations`**

  - New `setEntityAlias(overlayId, sourceId | null)` /
    `getEntityAlias(id)` / `resolveBaseEntityId(id)` public surface
    on `MutablePropertyView`. Aliases redirect base property and
    quantity reads from the duplicate to its source — so the
    duplicate inherits psets/qsets without eagerly cloning them
    into the overlay.
  - Override slots stay scoped to the original (overlay) id, so
    edits on the duplicate don't bleed into the source. Verified
    by 4 new unit tests including the source-untouched path,
    chain-cap (one hop, not transitive), and the self-alias guard.

  **`@ifc-lite/viewer`**

  - New `duplicateEntity(modelId, sourceExpressId, direction?)`
    slice action. Wraps the create-package builder, sets the
    mutation-view alias, and clones the source's mesh data into
    the geometry result with the offset applied — so the duplicate
    appears in 3D the moment the action fires, not just in the
    export overlay. Per-vertex `entityIds` arrays are filled with
    the new globalId so picking and selection resolve correctly.
  - New `DuplicateDirection` type (`+X` / `-X` / `+Y` / `-Y` /
    `+Z` / `-Z`). Magnitude per axis = the source's bounding-box
    dimension on that axis, so a 3m wall steps 3m and a 0.4m
    column steps 0.4m. Falls back to a 1m step when the source
    has no mesh in geometry.
  - Right-click menu's "Duplicate" item is now a `DuplicateRow`:
    primary clickable label on the left (defaults to +X), 6 axis
    chips on the right (→ ← ↗ ↙ ↑ ↓). Tooltips spell out
    "+X (east)" through "−Z (down)".
  - `⌘D` defaults to +X. `⇧⌘D` = +Z (up), `⌥⌘D` = +Y (north) —
    modifier shortcuts for power users without forcing a mouse
    trip to the chip row. Selection moves to the new globalId so
    a Cmd+D chain ("stamp a row of columns") works without
    re-clicking.
  - **`resolveGlobalIdFromModels` two-pass overlay fallback** —
    the federation resolver previously gated each model's id range
    at parse-time `maxExpressId`, which excluded every
    overlay-allocated id from selection. The fix: a second pass
    consults each model's mutation view via `getNewEntity(localId)`
    so overlay duplicates resolve to the right model with the
    right local id. Without this, the property panel saw the
    duplicate as "UNKNOWN / Unknown / no property sets" because
    the alias couldn't take effect on a wrongly-resolved id.
  - PropertiesPanel falls back to the overlay `NewEntity` record
    for type / name / GUID / Description / ObjectType when the
    parsed `entityNode` comes up empty. The bSDD attribute list
    synthesises from the schema-defined positional names. The
    Materials / Classifications / Documents / structural
    Relationships sections all route through a new
    `lookupExpressId` (alias-resolved) so they query the source's
    parsed maps directly.

  After: a freshly-duplicated wall is genuinely first-class — name
  reads, properties show, quantities show, material layers show,
  classifications show, documents show, and a round-tripped STEP
  file carries every association.

- [#576](https://github.com/louistrue/ifc-lite/pull/576) [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742) Thanks [@louistrue](https://github.com/louistrue)! - Add the full IfcTask / 4D construction-schedule experience to the viewer.

  **Gantt panel** — a lower-panel workspace combining a task tree, a zoomable
  SVG timeline with task bars / milestones / dependency arrows / playback
  cursor, a toolbar (work-schedule filter, play / pause / loop / speed, time
  scale), and an empty state. Live Gantt ↔ 3D selection highlight (one-way,
  no isolation) and playback-driven visibility through the rendererʼs
  hidden-entity channel.

  **Schedule editing** — Inspector Task card (name, identification,
  predefined type, milestone, start / finish / duration with any-two-of-three
  reconciliation, assigned products, delete with cascade). Undo / redo
  (descriptor-based lightweight snapshots for field edits; full snapshot for
  structural edits), store-scoped transactions (drag-coalesced), add / delete /
  reorder tasks. IFC STEP export routes through a centralised schedule splice
  helper so generated / edited schedules round-trip cleanly on every export
  surface.

  **Generate from hierarchy** — a Generate Schedule dialog produces a work
  schedule + tasks from the modelʼs spatial hierarchy (Storey / Building) or
  geometry (Height-slice, with optional Class / Type / Name subgroup). Linked
  FS dependencies and ghost-preparation look-ahead are opt-in.

  **4D animation** — Synchro-style phased lifecycle (preparation ghost →
  ramp-in → active task-type colour → settling fade → complete), demolition
  inversion, customizable palette, and configurable palette intensity /
  look-ahead / hide-untasked products. Animation layers live in a priority-
  composited overlay registry (`registerOverlayLayer`), with a single
  compositor hook owning the write to the rendererʼs hidden-entity + colour-
  override channels.

  **LLM integration** — built-in "Construction schedule (4D)" script template,
  PDF / spreadsheet chat attachments, and `bim.schedule.*` read APIs reachable
  from the sandbox.

- [#598](https://github.com/louistrue/ifc-lite/pull/598) [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c) Thanks [@louistrue](https://github.com/louistrue)! - Raw STEP tab — drill into `#N` references and a tighter dev-leaning
  visual treatment.

  **Reference drill-through**

  - Each `#N` token in the Raw STEP card is now a clickable chip.
    Click → drills into the target entity and shows its positional
    arguments inline; the breadcrumb at the top of the card tracks
    the path back to the 3D-selected entity.
  - **Auto-skip wrappers** — when the click target itself has only
    a single positional arg and that arg is also a `#N`, the card
    follows the chain in one click and lands on the first
    "meaningful" entity. Capped at 16 hops to defend against
    cyclic STEP graphs. So a real-world case like
    `IfcRelDefinesByProperties → IfcPropertySet` steps cleanly,
    and pure pass-through wrappers don't waste user clicks.
  - Drill state resets when the 3D selection changes — drilling
    stays scoped to a single click. Each breadcrumb segment is
    clickable to jump back to that depth.
  - Editing a `#N` ref still works via the pen icon — clicking the
    chip itself navigates instead of entering edit mode, but the
    hover-revealed pen still flips to inline-edit so a user can
    re-type the reference target.
  - Tombstoned entities short-circuit the auto-follow so the drill
    doesn't render a deleted entity's body.

  **True STEP literals on display**

  - Tokens are read directly from the source bytes via a new
    `extractRawStepTokens` helper, so refs render as `#42`, enums
    stay `.AREA.`, and strings keep their on-disk quoted form. The
    EntityExtractor's parsed JS shape strips reference prefixes
    (it parses `#42` into the integer `42`), so the previous
    formatter had no way to recover the distinction — `OwnerHistory`
    would render as `18` instead of `#18`. Fixed.
  - Overlay overrides serialize back through `serializeStepToken`
    for parity with the unmodified base tokens.

  **Overlay-aware row display**

  - Edits to positional attributes now reflect immediately in the
    row body. Previously the card re-extracted from the source
    buffer and ignored the overlay map, so the displayed value
    snapped back to the original after Save (only the purple
    overlay-override dot updated correctly).

  **Dev-leaning tab styling**

  - Raw STEP tab restyled — replaces the "Raw" plain-text label
    with a `</>` bracket glyph, shrinks the trigger to icon-only
    width via `flex: 0 0 auto`. Frees up width so Properties /
    Quantities / bSDD keep their text visible at the default
    panel size, and signals "developer view" with a terminal-green
    accent on hover / active state.

  **Add-Column UI removed**

  - The original `AddColumnDialog` + context-menu "Add column
    here…" + EditToolbar "Column" button — premature for the
    current workflow (single hard-coded element type with no
    geometry preview). Removed cleanly:
    `AddColumnDialog.tsx` (deleted), the `addColumnDialog` slice
    state, the constructive `MenuItem` tone (only used by that
    item), and the context-menu / toolbar entry points.
  - Kept: the `addColumn` slice action and the
    `bim.store.addColumn` SDK surface — those still drive scripts
    and programmatic flows, just no UI affordance for now.

  **Tombstoned mesh actually disappears**

  - Delete entity now pairs the overlay tombstone with
    `hideEntity(globalId)` so the rendered mesh is hidden from the
    GPU buffers (and stops being pickable). Undo of `DELETE_ENTITY`
    pairs `restoreFromTombstone` with `showEntity` so the entity
    returns to the scene; redo re-hides. Symmetrical round-trip.

- [#588](https://github.com/louistrue/ifc-lite/pull/588) [`b75f0cc`](https://github.com/louistrue/ifc-lite/commit/b75f0cccb06c89f5e30272d6c04f986f3b47e574) Thanks [@louistrue](https://github.com/louistrue)! - Replace the SQL tab in the advanced search modal with a clean
  chip-based **Filter** tab. Storey / IFC type / Predefined type / Name /
  Property / Quantity rules compose with AND/OR + IsSet/IsNotSet and
  run through an in-memory evaluator that scales to 4M-entity models
  via `entityIndex.byType` / `spatialHierarchy.byStorey` prefilter,
  cheap-first per-entity rule ordering, and async chunked yielding
  with cancel + progress. The DuckDB engine, SQL editor, schema
  browser, templates, error rewriter, and saved-SQL-queries module
  have been removed — Builder is the whole UI now, with a single Run
  button and CSV/JSON export. Builder dropdowns are schema-aware
  (storeys + IFC types load eagerly, pset / qto names load lazily on
  first use), the inline search-bar query promotes to a Name rule
  with one click, multi-model row clicks route to the correct model,
  and saved presets persist named `{name, combinator, rules}`
  snapshots in localStorage.

### Patch Changes

- [#588](https://github.com/louistrue/ifc-lite/pull/588) [`b75f0cc`](https://github.com/louistrue/ifc-lite/commit/b75f0cccb06c89f5e30272d6c04f986f3b47e574) Thanks [@louistrue](https://github.com/louistrue)! - Address PR #588 review feedback that survived the Filter migration:

  - Inline-bar Enter now flushes the 80ms debounce by re-scanning against
    the live `searchQuery`, so committing inside the debounce window
    selects the entity matching what the input shows (not the prior
    query) and records the correct recent.
  - The 50ms `frameSelection` timer in the inline bar is tracked via a
    ref and cleared on rapid selection changes / unmount instead of
    leaking orphan callbacks.
  - Shift+Enter additive selection in the inline bar and the row-level
    additive path in the Search modal now TOGGLE via `toggleEntitySelection`,
    so the same interaction can deselect a previously-added row.
  - New `addEntitiesToSelection` batch action on the selection slice;
    the Search modal's "Select all" path uses it so a 5K-row select-all
    dispatches one Zustand `set` instead of N.
  - Tier-0 scoring now keeps the max across name/type/objectType/description
    fields (matching Tier-1's behaviour). Without this, an entity with a
    substring name hit and a type-exact hit ranked lower than it should
    on Tier-0, breaking the comparable-ordering guarantee when results
    came from a mix of Tier-0 and Tier-1 models.

- Updated dependencies [[`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742), [`16d7a63`](https://github.com/louistrue/ifc-lite/commit/16d7a6361a78bb39a2bd61bba6990db5d3df0c04), [`945bb30`](https://github.com/louistrue/ifc-lite/commit/945bb30061ca044f4a51001f7299c17350ce99cf), [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`370e084`](https://github.com/louistrue/ifc-lite/commit/370e084e94e8fce930bddf948344c4b639d196f3), [`18c6a37`](https://github.com/louistrue/ifc-lite/commit/18c6a37f1cc1426daa32ee60457dd0580a5257f5)]:
  - @ifc-lite/mutations@1.15.0
  - @ifc-lite/sdk@1.15.0
  - @ifc-lite/sandbox@1.15.0
  - @ifc-lite/parser@2.2.0
  - @ifc-lite/geometry@1.16.6
  - @ifc-lite/renderer@1.17.0
  - @ifc-lite/query@1.14.7
  - @ifc-lite/wasm@1.16.7
  - @ifc-lite/export@1.18.0

## 1.17.6

### Patch Changes

- [#563](https://github.com/louistrue/ifc-lite/pull/563) [`7a6eb5e`](https://github.com/louistrue/ifc-lite/commit/7a6eb5e249a00a61d4e7b5574e017c949b083966) Thanks [@louistrue](https://github.com/louistrue)! - Rotate mesh normals alongside positions when aligning federated models and honour georef mutations during alignment, so secondary models keep correct shading and stay aligned when their georeferencing is edited after load.

- [#563](https://github.com/louistrue/ifc-lite/pull/563) [`7a6eb5e`](https://github.com/louistrue/ifc-lite/commit/7a6eb5e249a00a61d4e7b5574e017c949b083966) Thanks [@louistrue](https://github.com/louistrue)! - Extract LLM stream routing into a shared helper and handle Codex's truncation marker so long responses are no longer cut off mid-sentence. BYOK guard logic moves into its own module with unit tests covering the direct-stream path.

- Updated dependencies [[`7a6eb5e`](https://github.com/louistrue/ifc-lite/commit/7a6eb5e249a00a61d4e7b5574e017c949b083966), [`7a6eb5e`](https://github.com/louistrue/ifc-lite/commit/7a6eb5e249a00a61d4e7b5574e017c949b083966)]:
  - @ifc-lite/wasm@1.16.6

## 1.17.5

### Patch Changes

- [#561](https://github.com/louistrue/ifc-lite/pull/561) [`8f4df0e`](https://github.com/louistrue/ifc-lite/commit/8f4df0e50e22419353829114b5af80cfd5d45805) Thanks [@louistrue](https://github.com/louistrue)! - 3D section cap with screen-space hatches, driven by exact cut polygons.

  ### `@ifc-lite/renderer`

  - **3D cut surface (cap) rendering.** `Section2DOverlayRenderer` gained
    a fill pipeline that paints the user's cap style on top of the exact
    polygons `SectionCutter` produces from triangle-plane intersection.
    Eight built-in screen-space hatch patterns are supplied via the new
    `section-cap-style.ts` module: `solid`, `diagonal`, `crossHatch`,
    `horizontal`, `vertical`, `concrete` (clean dot grid, ISO 128-50),
    `brick`, `insulation`. Pattern ids match the numeric branches in the
    fill fragment shader and are pinned by unit tests so changes can't
    drift silently. New `Section2DOverlayCapStyle` shape carries fill,
    stroke, pattern id, spacing/angle/width, and a secondary cross-hatch
    angle.
  - **Outline + fill toggle independently.** `Section2DOverlayOptions`
    has new `showFills` and `showOutlines` booleans, both honoured by
    `Section2DOverlayRenderer.draw()`, so callers can hide the cut hatch
    without losing the line drawing or vice versa.
  - **Cap respects model depth.** Both fill and outline pipelines test
    with `depthCompare: 'greater-equal'` (reverse-Z) and don't write
    depth, so when the camera looks through closer model geometry the
    cap is occluded naturally. Cap polygons live exactly on the plane,
    so equal-depth ties tie cleanly with greater-equal.
  - **Cap fill landed exactly on the plane.** Removed the old 0.3 m
    vertical bias that made the hatch visibly drift off the slider
    position; the fill now sits on the cut surface itself.
  - **Depth format unified at `depth24plus-stencil8`.** Main, instanced,
    section-plane preview, and 2D overlay pipelines all declare the same
    depth/stencil format and route through `PIPELINE_CONSTANTS.DEPTH_FORMAT`
    so the literal lives in exactly one place. All in-pass pipelines also
    declare both colour attachments (main colour + objectId, the latter
    with `writeMask: 0`) so WebGPU validation passes regardless of which
    shaders render inside the section render pass.
  - **`flipped` flag plumbed end-to-end.** Main and instanced fragment
    shaders pack `enabled` (bit 0) + `flipped` (bit 1) into one flag slot
    and negate the keep side when flipped — slider position stays where
    it is, only the kept half swaps.
  - **`SectionCapStyle`, `HatchPatternId`, `DEFAULT_CAP_STYLE`, and
    `HATCH_PATTERN_IDS` exported from the package** as the canonical
    styling primitives consumed by the viewer store and the fill shader.
  - **Renderer log on first section enable** (`[Section] Y-up bounds
used for clip: …`) so a user can verify the slider range matches
    their geometry without opening a debugger.

  ### `@ifc-lite/drawing-2d`

  - **Plane equation no longer changes when `flipped`.** Both
    `SectionCutter` and `gpu-section-cutter` now build the plane normal
    from `getAxisNormal(axis, false)` regardless of the flipped flag.
    Previously the flipped normal was paired with an unchanged
    `planeDistance`, which described a different plane (`y = -position`
    instead of `y = position`) — the cutter then looked for intersections
    far outside the model and produced an empty 2D drawing. `flipped` is
    still honoured by `projectTo2D` so the resulting drawing mirrors
    correctly when viewed from the opposite side.

  ### `viewer`

  - **`SectionCapControls` panel.** New compact controls inside the
    expanded Section panel: independent Display toggles for _Surfaces_
    (cap fill) and _Lines_ (outline), hatch pattern dropdown, fill +
    stroke colour pickers, and Spacing / Angle / Width number inputs in
    a 3-col grid. The hatch fieldset disables itself when Surfaces are
    off so users can't tweak settings that don't apply. Every control
    has an explicit `id`/`htmlFor` association via `useId()` for
    assistive tech.
  - **Flip button reflects state.** Now toggles `variant` to `default`,
    carries `aria-pressed`, and swaps `aria-label`/`title` between
    "Flip cut direction" and "Unflip cut direction".
  - **Auto-enable on slider/axis change.** Moving the position slider or
    picking a direction now sets `enabled: true` so users no longer get
    stuck in a no-op "preview mode" wondering why nothing cuts. The
    bottom toggle relabelled "Clip on/off" instead of the old
    "Cutting/Preview" wording that read as if the cut was always live.
  - **2D panel auto-fits on Flip.** `useViewControls` now triggers
    `fitToView` on `sectionPlane.flipped` change as well as axis change,
    so flipping doesn't park the polygons off-screen and leave the
    panel blank.
  - **Cap style persists across reloads.** `showCap`, `showOutlines`,
    and the full `capStyle` (fill, stroke, pattern, spacing, angle,
    width, secondary angle) round-trip to `localStorage` under the keys
    `ifc-lite:section-cap-show`, `ifc-lite:section-outlines-show`, and
    `ifc-lite:section-cap-style`. `resetSectionPlane()` clears them so
    the default button actually resets. `resetViewerState()` (called on
    every IFC load) preserves persisted cap settings and only clears
    axis/position/enabled/flipped — so opening a new file no longer
    wipes the user's hatch and colour choices.
  - **Cap style types deduplicated.** `SectionCapHatchId` and
    `SectionCapStyle` in the viewer store are now re-exports of the
    renderer's `section-cap-style.ts`, so adding a new pattern only
    requires editing the renderer.
  - **localStorage failures are diagnosable.** Every persistence catch
    in `sectionSlice` now logs via `console.warn` instead of a bare
    `catch {}` — quota / private-mode / serialisation failures still
    fall back gracefully but show up in devtools.

- Updated dependencies [[`8f4df0e`](https://github.com/louistrue/ifc-lite/commit/8f4df0e50e22419353829114b5af80cfd5d45805), [`7000011`](https://github.com/louistrue/ifc-lite/commit/7000011d6eb372c2dadf7c82f6e76a0583c6abc1)]:
  - @ifc-lite/renderer@1.16.0
  - @ifc-lite/drawing-2d@1.15.3
  - @ifc-lite/wasm@1.16.5

## 1.17.4

### Patch Changes

- [#531](https://github.com/louistrue/ifc-lite/pull/531) [`fb6851d`](https://github.com/louistrue/ifc-lite/commit/fb6851dba2491bf8c540d9dbcc7026584da0572e) Thanks [@louistrue](https://github.com/louistrue)! - Fix browser build warnings and improve streaming reliability

  - Silence FileDialog Tauri warnings in browser builds (expected fallback path)
  - Fix closeGeometryIterator ReferenceError when geometry processor throws before iterator creation
  - Guard timer-based queue pump behind document.hidden to prevent redundant GPU flushes in foreground tabs

- Updated dependencies [[`643b30f`](https://github.com/louistrue/ifc-lite/commit/643b30ff031d389fe0cb1caf7de6989d79629e4b), [`fb6851d`](https://github.com/louistrue/ifc-lite/commit/fb6851dba2491bf8c540d9dbcc7026584da0572e)]:
  - @ifc-lite/geometry@1.16.5
  - @ifc-lite/wasm@1.16.4
  - @ifc-lite/renderer@1.15.2

## 1.17.3

### Patch Changes

- [#507](https://github.com/louistrue/ifc-lite/pull/507) [`7b0a5f6`](https://github.com/louistrue/ifc-lite/commit/7b0a5f6a395e49d2dc846b3c955b0ba01b75c88b) Thanks [@louistrue](https://github.com/louistrue)! - Fix type properties and type info display when selecting occurrence elements

- Updated dependencies [[`7b0a5f6`](https://github.com/louistrue/ifc-lite/commit/7b0a5f6a395e49d2dc846b3c955b0ba01b75c88b), [`7b0a5f6`](https://github.com/louistrue/ifc-lite/commit/7b0a5f6a395e49d2dc846b3c955b0ba01b75c88b)]:
  - @ifc-lite/renderer@1.14.9

## 1.17.2

### Patch Changes

- [#447](https://github.com/louistrue/ifc-lite/pull/447) [`e532dfe`](https://github.com/louistrue/ifc-lite/commit/e532dfef16bedbdb7b106d610b88a97e723721c3) Thanks [@louistrue](https://github.com/louistrue)! - Enable visibility filter by default in list results table so rows are filtered by 3D visibility state out of the box

- Updated dependencies [[`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0), [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0), [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0), [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0)]:
  - @ifc-lite/renderer@1.14.7
  - @ifc-lite/wasm@1.16.0
  - @ifc-lite/drawing-2d@1.15.0
  - @ifc-lite/export@1.17.0
  - @ifc-lite/geometry@1.16.0
  - @ifc-lite/server-client@1.15.0

## 1.17.1

### Patch Changes

- [#439](https://github.com/louistrue/ifc-lite/pull/439) [`a672eec`](https://github.com/louistrue/ifc-lite/commit/a672eec196ec77b0229b0953f9a1b59991f814a6) Thanks [@louistrue](https://github.com/louistrue)! - Add Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers to vercel.json for SharedArrayBuffer support in production deployments.

- Updated dependencies [[`a672eec`](https://github.com/louistrue/ifc-lite/commit/a672eec196ec77b0229b0953f9a1b59991f814a6), [`a672eec`](https://github.com/louistrue/ifc-lite/commit/a672eec196ec77b0229b0953f9a1b59991f814a6)]:
  - @ifc-lite/wasm@1.15.0
  - @ifc-lite/geometry@1.15.0

## 1.17.0

### Minor Changes

- [#422](https://github.com/louistrue/ifc-lite/pull/422) [`506c65d`](https://github.com/louistrue/ifc-lite/commit/506c65da730a655ad6745a8e7a063435f335ff0d) Thanks [@louistrue](https://github.com/louistrue)! - Add 3D BCF topic marker overlay that positions markers above referenced geometry, tracks camera movement in real-time, and supports click/hover interactions with the BCF panel

### Patch Changes

- [#422](https://github.com/louistrue/ifc-lite/pull/422) [`506c65d`](https://github.com/louistrue/ifc-lite/commit/506c65da730a655ad6745a8e7a063435f335ff0d) Thanks [@louistrue](https://github.com/louistrue)! - Make BCF 3D overlay markers opt-in with a MapPin toggle button in the BCF panel header, defaulting to off for zero performance cost when unused

- [#419](https://github.com/louistrue/ifc-lite/pull/419) [`87ce884`](https://github.com/louistrue/ifc-lite/commit/87ce8841175e64394445833e66bd77a8a68668e9) Thanks [@louistrue](https://github.com/louistrue)! - Enable visibility filter by default in list results table so rows are filtered by 3D visibility state out of the box

- Updated dependencies [[`506c65d`](https://github.com/louistrue/ifc-lite/commit/506c65da730a655ad6745a8e7a063435f335ff0d), [`506c65d`](https://github.com/louistrue/ifc-lite/commit/506c65da730a655ad6745a8e7a063435f335ff0d)]:
  - @ifc-lite/bcf@1.15.0

## 1.16.0

### Minor Changes

- [#368](https://github.com/louistrue/ifc-lite/pull/368) [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8) Thanks [@louistrue](https://github.com/louistrue)! - Use Material Symbols IFC class icons in hierarchy panel for improved visual clarity

### Patch Changes

- [#368](https://github.com/louistrue/ifc-lite/pull/368) [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8) Thanks [@louistrue](https://github.com/louistrue)! - Add double-escape keyboard shortcut to close all panels and return to starting view

- [#368](https://github.com/louistrue/ifc-lite/pull/368) [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8) Thanks [@louistrue](https://github.com/louistrue)! - Refactor internals across parser, renderer, export, and viewer packages

- [#368](https://github.com/louistrue/ifc-lite/pull/368) [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8) Thanks [@louistrue](https://github.com/louistrue)! - Show all package versions in viewer

- Updated dependencies [[`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8), [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8)]:
  - @ifc-lite/wasm@1.14.4
  - @ifc-lite/parser@2.1.1
  - @ifc-lite/renderer@1.14.4
  - @ifc-lite/export@1.15.1

## 1.15.0

### Minor Changes

- [#354](https://github.com/louistrue/ifc-lite/pull/354) [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f) Thanks [@louistrue](https://github.com/louistrue)! - Include IfcSpace elements in storey isolation and add combinable class/type/storey filters

### Patch Changes

- [#354](https://github.com/louistrue/ifc-lite/pull/354) [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f) Thanks [@louistrue](https://github.com/louistrue)! - Fix viewer.isolate() hiding everything when passed spatial structure elements like storeys

- [#354](https://github.com/louistrue/ifc-lite/pull/354) [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f) Thanks [@louistrue](https://github.com/louistrue)! - Add dynamic IFCX schema import detection for IFC5 export

- [#354](https://github.com/louistrue/ifc-lite/pull/354) [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f) Thanks [@louistrue](https://github.com/louistrue)! - Fix mutation state not resetting when opening a new file

- Updated dependencies [[`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f), [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f), [`40bf3d0`](https://github.com/louistrue/ifc-lite/commit/40bf3d00cb5d5ef3512b96cd5e066442adcaab87), [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f)]:
  - @ifc-lite/ids@1.14.4
  - @ifc-lite/export@1.15.0
  - @ifc-lite/parser@2.1.0
  - @ifc-lite/encoding@1.14.4
  - @ifc-lite/lists@1.14.4

## 1.14.4

### Patch Changes

- [#339](https://github.com/louistrue/ifc-lite/pull/339) [`691f8a5`](https://github.com/louistrue/ifc-lite/commit/691f8a57ad51c0649de0dbcd17f4b7ecd48e7da7) Thanks [@louistrue](https://github.com/louistrue)! - Expose the Script Editor from a new Panels menu and consolidate auxiliary panel toggles in the viewer toolbar.

- Updated dependencies [[`ba9040c`](https://github.com/louistrue/ifc-lite/commit/ba9040c6ff3204f3a936dd2f481c4cd8a4e6f5b5)]:
  - @ifc-lite/parser@2.0.0
  - @ifc-lite/export@1.14.4
  - @ifc-lite/query@1.14.4

## 1.14.3

### Patch Changes

- Updated dependencies [[`07851b2`](https://github.com/louistrue/ifc-lite/commit/07851b2161b4cfcaa2dfc1b0f31a6fcc2db99e45), [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0), [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0), [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0)]:
  - @ifc-lite/mutations@1.14.3
  - @ifc-lite/wasm@1.14.3
  - @ifc-lite/sandbox@1.14.3
  - @ifc-lite/geometry@1.14.3
  - @ifc-lite/export@1.14.3
  - @ifc-lite/bcf@1.14.3
  - @ifc-lite/cache@1.14.3
  - @ifc-lite/data@1.14.3
  - @ifc-lite/drawing-2d@1.14.3
  - @ifc-lite/encoding@1.14.3
  - @ifc-lite/ids@1.14.3
  - @ifc-lite/lens@1.14.3
  - @ifc-lite/lists@1.14.3
  - @ifc-lite/parser@1.14.3
  - @ifc-lite/query@1.14.3
  - @ifc-lite/renderer@1.14.3
  - @ifc-lite/server-client@1.14.3
  - @ifc-lite/spatial@1.14.3

## 1.14.2

### Patch Changes

- Updated dependencies [[`740f7a7`](https://github.com/louistrue/ifc-lite/commit/740f7a7228413657d13014565d9e457f0e00e8a3), [`740f7a7`](https://github.com/louistrue/ifc-lite/commit/740f7a7228413657d13014565d9e457f0e00e8a3)]:
  - @ifc-lite/export@1.14.2
  - @ifc-lite/parser@1.14.2
  - @ifc-lite/bcf@1.14.2
  - @ifc-lite/cache@1.14.2
  - @ifc-lite/data@1.14.2
  - @ifc-lite/drawing-2d@1.14.2
  - @ifc-lite/encoding@1.14.2
  - @ifc-lite/geometry@1.14.2
  - @ifc-lite/ids@1.14.2
  - @ifc-lite/lens@1.14.2
  - @ifc-lite/lists@1.14.2
  - @ifc-lite/mutations@1.14.2
  - @ifc-lite/query@1.14.2
  - @ifc-lite/renderer@1.14.2
  - @ifc-lite/sandbox@1.14.2
  - @ifc-lite/server-client@1.14.2
  - @ifc-lite/spatial@1.14.2
  - @ifc-lite/wasm@1.14.2

## 1.14.1

### Patch Changes

- Updated dependencies [[`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0), [`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0), [`071d251`](https://github.com/louistrue/ifc-lite/commit/071d251708388771afd288bc2ef01b4d1a074607), [`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0), [`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0)]:
  - @ifc-lite/renderer@1.14.1
  - @ifc-lite/spatial@1.14.1
  - @ifc-lite/geometry@1.14.1
  - @ifc-lite/wasm@1.14.1
  - @ifc-lite/parser@1.14.1
  - @ifc-lite/sandbox@1.14.1
  - @ifc-lite/bcf@1.14.1
  - @ifc-lite/cache@1.14.1
  - @ifc-lite/data@1.14.1
  - @ifc-lite/drawing-2d@1.14.1
  - @ifc-lite/encoding@1.14.1
  - @ifc-lite/export@1.14.1
  - @ifc-lite/ids@1.14.1
  - @ifc-lite/lens@1.14.1
  - @ifc-lite/lists@1.14.1
  - @ifc-lite/mutations@1.14.1
  - @ifc-lite/query@1.14.1
  - @ifc-lite/server-client@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/bcf@1.14.0
  - @ifc-lite/cache@1.14.0
  - @ifc-lite/data@1.14.0
  - @ifc-lite/drawing-2d@1.14.0
  - @ifc-lite/encoding@1.14.0
  - @ifc-lite/export@1.14.0
  - @ifc-lite/geometry@1.14.0
  - @ifc-lite/ids@1.14.0
  - @ifc-lite/lens@1.14.0
  - @ifc-lite/lists@1.14.0
  - @ifc-lite/mutations@1.14.0
  - @ifc-lite/parser@1.14.0
  - @ifc-lite/query@1.14.0
  - @ifc-lite/renderer@1.14.0
  - @ifc-lite/sandbox@1.14.0
  - @ifc-lite/server-client@1.14.0
  - @ifc-lite/spatial@1.14.0
  - @ifc-lite/wasm@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies [[`3bc1cda`](https://github.com/louistrue/ifc-lite/commit/3bc1cdabcff1d9992ec6799ddbd83a169152fa3c), [`3bc1cda`](https://github.com/louistrue/ifc-lite/commit/3bc1cdabcff1d9992ec6799ddbd83a169152fa3c)]:
  - @ifc-lite/renderer@1.13.0
  - @ifc-lite/bcf@1.13.0
  - @ifc-lite/cache@1.13.0
  - @ifc-lite/data@1.13.0
  - @ifc-lite/drawing-2d@1.13.0
  - @ifc-lite/encoding@1.13.0
  - @ifc-lite/export@1.13.0
  - @ifc-lite/geometry@1.13.0
  - @ifc-lite/ids@1.13.0
  - @ifc-lite/lens@1.13.0
  - @ifc-lite/lists@1.13.0
  - @ifc-lite/mutations@1.13.0
  - @ifc-lite/parser@1.13.0
  - @ifc-lite/query@1.13.0
  - @ifc-lite/sandbox@1.13.0
  - @ifc-lite/server-client@1.13.0
  - @ifc-lite/spatial@1.13.0
  - @ifc-lite/wasm@1.13.0

## 1.12.0

### Minor Changes

- [#268](https://github.com/louistrue/ifc-lite/pull/268) [`2562382`](https://github.com/louistrue/ifc-lite/commit/25623821fa6d7e94b094772563811fb01ce066c7) Thanks [@louistrue](https://github.com/louistrue)! - Add IFC5 (IFCX) export with full schema conversion and USD geometry

  New `Ifc5Exporter` converts IFC data from any schema (IFC2X3/IFC4/IFC4X3) to the IFC5 IFCX JSON format:

  - Entity types converted to IFC5 naming (aligned with IFC4X3)
  - Properties mapped to IFCX attribute namespaces (`bsi::ifc::prop::`)
  - Tessellated geometry converted to USD mesh format with Z-up coordinates
  - Spatial hierarchy mapped to IFCX path-based node structure
  - Color and presentation exported as USD attributes

  The export dialog is simplified: schema selection now drives the output format automatically (IFC5 → `.ifcx`, others → `.ifc`). No separate format picker needed.

  Schema converter fixes:

  - Skipped entities become IFCPROXY placeholders instead of being dropped, preventing dangling STEP references
  - Alignment entities (IFCALIGNMENTCANT, etc.) are preserved for IFC4X3/IFC5 targets

### Patch Changes

- Updated dependencies [[`2562382`](https://github.com/louistrue/ifc-lite/commit/25623821fa6d7e94b094772563811fb01ce066c7)]:
  - @ifc-lite/export@1.12.0
  - @ifc-lite/bcf@1.12.0
  - @ifc-lite/cache@1.12.0
  - @ifc-lite/data@1.12.0
  - @ifc-lite/drawing-2d@1.12.0
  - @ifc-lite/encoding@1.12.0
  - @ifc-lite/geometry@1.12.0
  - @ifc-lite/ids@1.12.0
  - @ifc-lite/lens@1.12.0
  - @ifc-lite/lists@1.12.0
  - @ifc-lite/mutations@1.12.0
  - @ifc-lite/parser@1.12.0
  - @ifc-lite/query@1.12.0
  - @ifc-lite/renderer@1.12.0
  - @ifc-lite/sandbox@1.12.0
  - @ifc-lite/server-client@1.12.0
  - @ifc-lite/spatial@1.12.0
  - @ifc-lite/wasm@1.12.0

## 1.11.3

### Patch Changes

- [#258](https://github.com/louistrue/ifc-lite/pull/258) [`6c5f36d`](https://github.com/louistrue/ifc-lite/commit/6c5f36ddb4ae1879788f433a45c8bab5eabeb496) Thanks [@louistrue](https://github.com/louistrue)! - Improve large-file load performance targeting ~3–5 s savings on a 326 MB IFC file.

  - Replace O(total_accumulated) `.reduce()` calls in `appendGeometryBatch` with O(batch_size) incremental totals
  - Defer data model parser to after geometry streaming completes (no main-thread CPU contention with WASM)
  - Accumulate color updates locally during streaming; apply single `updateMeshColors()` at complete
  - Disable IndexedDB caching for files above 150 MB (source buffer required for on-demand extraction)

- Updated dependencies []:
  - @ifc-lite/bcf@1.11.3
  - @ifc-lite/cache@1.11.3
  - @ifc-lite/data@1.11.3
  - @ifc-lite/drawing-2d@1.11.3
  - @ifc-lite/encoding@1.11.3
  - @ifc-lite/export@1.11.3
  - @ifc-lite/geometry@1.11.3
  - @ifc-lite/ids@1.11.3
  - @ifc-lite/lens@1.11.3
  - @ifc-lite/lists@1.11.3
  - @ifc-lite/mutations@1.11.3
  - @ifc-lite/parser@1.11.3
  - @ifc-lite/query@1.11.3
  - @ifc-lite/renderer@1.11.3
  - @ifc-lite/sandbox@1.11.3
  - @ifc-lite/server-client@1.11.3
  - @ifc-lite/spatial@1.11.3
  - @ifc-lite/wasm@1.11.3

## 1.11.1

### Patch Changes

- [#240](https://github.com/louistrue/ifc-lite/pull/240) [`a423e83`](https://github.com/louistrue/ifc-lite/commit/a423e8390afcb78f2de57203b26715df726335ed) Thanks [@louistrue](https://github.com/louistrue)! - Fix deferred IFC style colors not applying on first load by separating persistent mesh color updates from transient overlay color updates.

  This restores expected glass transparency and keeps first-load and cache-load colors consistent.

- Updated dependencies [[`02876ac`](https://github.com/louistrue/ifc-lite/commit/02876ac97748ca9aaabfc3e5882ef9d2a37ca437)]:
  - @ifc-lite/geometry@1.11.1
  - @ifc-lite/bcf@1.11.1
  - @ifc-lite/cache@1.11.1
  - @ifc-lite/data@1.11.1
  - @ifc-lite/drawing-2d@1.11.1
  - @ifc-lite/encoding@1.11.1
  - @ifc-lite/export@1.11.1
  - @ifc-lite/ids@1.11.1
  - @ifc-lite/lens@1.11.1
  - @ifc-lite/lists@1.11.1
  - @ifc-lite/mutations@1.11.1
  - @ifc-lite/parser@1.11.1
  - @ifc-lite/query@1.11.1
  - @ifc-lite/renderer@1.11.1
  - @ifc-lite/sandbox@1.11.1
  - @ifc-lite/server-client@1.11.1
  - @ifc-lite/spatial@1.11.1
  - @ifc-lite/wasm@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies [[`5a18e6c`](https://github.com/louistrue/ifc-lite/commit/5a18e6cccbc94d244c78a571b9f2c4863326190d), [`ca7fd20`](https://github.com/louistrue/ifc-lite/commit/ca7fd2015923e5a1a330ccbc4e95d259f9ce9c6f)]:
  - @ifc-lite/renderer@1.11.0
  - @ifc-lite/wasm@1.11.0
  - @ifc-lite/bcf@1.11.0
  - @ifc-lite/cache@1.11.0
  - @ifc-lite/data@1.11.0
  - @ifc-lite/drawing-2d@1.11.0
  - @ifc-lite/encoding@1.11.0
  - @ifc-lite/export@1.11.0
  - @ifc-lite/geometry@1.11.0
  - @ifc-lite/ids@1.11.0
  - @ifc-lite/lens@1.11.0
  - @ifc-lite/lists@1.11.0
  - @ifc-lite/mutations@1.11.0
  - @ifc-lite/parser@1.11.0
  - @ifc-lite/query@1.11.0
  - @ifc-lite/sandbox@1.11.0
  - @ifc-lite/server-client@1.11.0
  - @ifc-lite/spatial@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [[`3823bd0`](https://github.com/louistrue/ifc-lite/commit/3823bd03bb0b5165d811cfd1ddfed671b8af97d8)]:
  - @ifc-lite/renderer@1.10.0
  - @ifc-lite/data@1.10.0
  - @ifc-lite/parser@1.10.0
  - @ifc-lite/wasm@1.10.0
  - @ifc-lite/ids@1.10.0
  - @ifc-lite/lists@1.10.0
  - @ifc-lite/bcf@1.10.0
  - @ifc-lite/cache@1.10.0
  - @ifc-lite/drawing-2d@1.10.0
  - @ifc-lite/encoding@1.10.0
  - @ifc-lite/export@1.10.0
  - @ifc-lite/geometry@1.10.0
  - @ifc-lite/lens@1.10.0
  - @ifc-lite/mutations@1.10.0
  - @ifc-lite/query@1.10.0
  - @ifc-lite/sandbox@1.10.0
  - @ifc-lite/server-client@1.10.0
  - @ifc-lite/spatial@1.10.0

## 1.9.0

### Minor Changes

- [#227](https://github.com/louistrue/ifc-lite/pull/227) [`67c0064`](https://github.com/louistrue/ifc-lite/commit/67c00640a0ca344337e5e79d80888d329df9130d) Thanks [@louistrue](https://github.com/louistrue)! - Add scripting platform with sandboxed TypeScript execution and full BIM SDK.

  New packages:

  - `@ifc-lite/sandbox` — sandboxed script runner that transpiles and executes user TypeScript in a Web Worker with BIM globals (`bim.query`, `bim.select`, `bim.viewer`, etc.) isolated from the host page.
  - `@ifc-lite/sdk` — BIM SDK defining the full host↔sandbox message protocol and all namespaces: `query`, `mutate`, `viewer`, `spatial`, `export`, `lens`, `bcf`, `ids`, `drawing`, `list`, `events`.

  New viewer features:

  - **Command Palette** — `Cmd/Ctrl+K` fuzzy-search launcher for viewer actions and scripts.
  - **Script Panel** — full-screen code editor (CodeMirror) with run/stop controls, output log, and CSV download.
  - **6 built-in script templates** — quantity takeoff, fire-safety check, MEP equipment schedule, envelope check, space validation, federation compare.
  - **Recent files** — persisted list of previously opened IFC files.

- [#227](https://github.com/louistrue/ifc-lite/pull/227) [`67c0064`](https://github.com/louistrue/ifc-lite/commit/67c00640a0ca344337e5e79d80888d329df9130d) Thanks [@louistrue](https://github.com/louistrue)! - Respect system color-scheme preference on initial load.

  The app previously hardcoded dark mode. Now:

  - An inline script in `index.html` applies the correct theme class before first paint, eliminating flash of wrong theme.
  - The Zustand UI store reads from `localStorage` first, then falls back to the browser's `prefers-color-scheme` media query.
  - Theme preference persists across reloads via `localStorage`.

### Patch Changes

- [#227](https://github.com/louistrue/ifc-lite/pull/227) [`67c0064`](https://github.com/louistrue/ifc-lite/commit/67c00640a0ca344337e5e79d80888d329df9130d) Thanks [@louistrue](https://github.com/louistrue)! - Fix scripting CSV exports missing property and quantity data.

  - `@ifc-lite/sdk` export namespace now resolves quantity-set dot-paths (`Qto_WallBaseQuantities.NetVolume`) in addition to property-set paths, so quantity columns are no longer empty in exports.
  - All 6 built-in script templates (quantity takeoff, fire-safety check, MEP schedule, envelope check, space validation, data-quality audit) updated to dynamically discover and include relevant property/quantity columns instead of hardcoding minimal attribute lists.

- Updated dependencies [[`67c0064`](https://github.com/louistrue/ifc-lite/commit/67c00640a0ca344337e5e79d80888d329df9130d)]:
  - @ifc-lite/sandbox@1.9.0
  - @ifc-lite/bcf@1.9.0
  - @ifc-lite/cache@1.9.0
  - @ifc-lite/data@1.9.0
  - @ifc-lite/drawing-2d@1.9.0
  - @ifc-lite/encoding@1.9.0
  - @ifc-lite/export@1.9.0
  - @ifc-lite/geometry@1.9.0
  - @ifc-lite/ids@1.9.0
  - @ifc-lite/lens@1.9.0
  - @ifc-lite/lists@1.9.0
  - @ifc-lite/mutations@1.9.0
  - @ifc-lite/parser@1.9.0
  - @ifc-lite/query@1.9.0
  - @ifc-lite/renderer@1.9.0
  - @ifc-lite/server-client@1.9.0
  - @ifc-lite/spatial@1.9.0
  - @ifc-lite/wasm@1.9.0

## 1.8.0

### Minor Changes

- [#212](https://github.com/louistrue/ifc-lite/pull/212) [`5d4dd1e`](https://github.com/louistrue/ifc-lite/commit/5d4dd1e40539b02af666ef8329c749d708a09e17) Thanks [@louistrue](https://github.com/louistrue)! - Add annotation selection, deletion, move, and text re-editing in 2D drawings

  - Click any annotation (measure, polygon area, text box, cloud) to select it — highlighted with a dashed blue border and corner handles
  - Press Delete/Backspace to remove the selected annotation
  - Drag to reposition any selected annotation
  - Double-click text annotations to re-enter edit mode
  - Escape exits annotation tools back to Select/Pan mode and deselects
  - "Select / Pan" option added to annotation toolbar dropdown
  - Performance: ephemeral drag state uses local refs instead of store updates, stable coordinate callbacks via refs, hit-test reads from storeRef to prevent callback cascade

### Patch Changes

- Updated dependencies [[`7ae9711`](https://github.com/louistrue/ifc-lite/commit/7ae971119ad92c05c521a4931105a9a977ffc667), [`06ddd81`](https://github.com/louistrue/ifc-lite/commit/06ddd81ce922d8f356836d04ff634cba45520a81), [`0b6880a`](https://github.com/louistrue/ifc-lite/commit/0b6880ac9bafee78e8b604e8df5a8e14dc74bc28)]:
  - @ifc-lite/renderer@1.8.0
  - @ifc-lite/lens@1.8.0
  - @ifc-lite/export@1.8.0
  - @ifc-lite/bcf@1.8.0
  - @ifc-lite/cache@1.8.0
  - @ifc-lite/data@1.8.0
  - @ifc-lite/drawing-2d@1.8.0
  - @ifc-lite/encoding@1.8.0
  - @ifc-lite/geometry@1.8.0
  - @ifc-lite/ids@1.8.0
  - @ifc-lite/lists@1.8.0
  - @ifc-lite/mutations@1.8.0
  - @ifc-lite/parser@1.8.0
  - @ifc-lite/query@1.8.0
  - @ifc-lite/server-client@1.8.0
  - @ifc-lite/spatial@1.8.0
  - @ifc-lite/wasm@1.8.0

## 1.7.0

### Minor Changes

- [#204](https://github.com/louistrue/ifc-lite/pull/204) [`057bde9`](https://github.com/louistrue/ifc-lite/commit/057bde9e48f64c07055413c690c6bdabb6942d04) Thanks [@louistrue](https://github.com/louistrue)! - Add orthographic projection, pinboard, lens, type tree, and floorplan views

  ### Renderer

  - Orthographic reverse-Z projection matrix in math utilities
  - Camera projection mode toggle (perspective/orthographic) with seamless switching
  - Orthographic zoom scales view size instead of camera distance
  - Parallel ray unprojection for orthographic picking

  ### Viewer

  - **Orthographic projection**: Toggle button, unified Views dropdown, numpad `5` keyboard shortcut
  - **Automatic Floorplan**: Per-storey section cuts with top-down ortho view, dropdown in toolbar
  - **Pinboard**: Selection basket with Pin/Unpin/Show, entity isolation via serialized EntityRef Set
  - **Tree View by Type**: IFC type grouping mode alongside spatial hierarchy, localStorage persistence
  - **Lens**: Rule-based 3D colorization/filtering with built-in presets (By IFC Type, Structural Elements), full panel UI with color legend and rule evaluation engine

- [#200](https://github.com/louistrue/ifc-lite/pull/200) [`6c43c70`](https://github.com/louistrue/ifc-lite/commit/6c43c707ead13fc482ec367cb08d847b444a484a) Thanks [@louistrue](https://github.com/louistrue)! - Add schema-aware property editing, full property panel display, and document/relationship support

  - Property editor validates against IFC4 standard (ISO 16739-1:2018): walls get wall psets, doors get door psets, etc.
  - Schema-version-aware property editing: detects IFC2X3/IFC4/IFC4X3 from FILE_SCHEMA header
  - New dialogs for adding classifications (12 standard systems), materials, and quantities in edit mode
  - Quantity set definitions (Qto\_) with schema-aware dialog for standard IFC4 base quantities
  - On-demand classification extraction from IfcRelAssociatesClassification with chain walking
  - On-demand material extraction supporting all IFC material types: IfcMaterial, IfcMaterialLayerSet, IfcMaterialProfileSet, IfcMaterialConstituentSet, IfcMaterialList, and \*Usage wrappers
  - On-demand document extraction from IfcRelAssociatesDocument with DocumentReference→DocumentInformation chain
  - Type-level property merging: properties from IfcTypeObject HasPropertySets merged with instance properties
  - Structural relationship display: openings, fills, groups, and connections
  - Advanced property type parsing: IfcPropertyEnumeratedValue, BoundedValue, ListValue, TableValue, ReferenceValue
  - Georeferencing display (IfcMapConversion + IfcProjectedCRS) in model metadata panel
  - Length unit display in model metadata panel
  - Classifications, materials, documents displayed with dedicated card components
  - Type-level material/classification inheritance via IfcRelDefinesByType
  - Relationship graph fallback for server-loaded models without on-demand maps
  - Cycle detection in material resolution and classification chain walking
  - Removed `any` types from parser production code in favor of proper `PropertyValue` union type

### Patch Changes

- [#202](https://github.com/louistrue/ifc-lite/pull/202) [`e0af898`](https://github.com/louistrue/ifc-lite/commit/e0af898608c2f706dc2d82154c612c64e2de010c) Thanks [@louistrue](https://github.com/louistrue)! - Fix empty Description, ObjectType, and Tag columns in lists and show all IFC attributes in property panel

  - Lists: add on-demand attribute extraction fallback with per-provider caching for Description, ObjectType, and Tag columns that were previously always empty
  - Property panel: show ALL string/enum IFC attributes dynamically using the schema registry (Name, Description, ObjectType, Tag, PredefinedType, etc.) instead of hardcoding only Name/Description/ObjectType
  - Parser: add `extractAllEntityAttributes()` for schema-aware full attribute extraction, extend `extractEntityAttributesOnDemand()` to include Tag (IfcElement index 7)
  - Query: add `EntityNode.tag` getter and `EntityNode.allAttributes()` method for comprehensive attribute access
  - Performance: cache `getAttributeNames()` inheritance walks, hoist module-level constants
  - Fix type name casing bug where multi-word UPPERCASE STEP types (e.g., IFCWALLSTANDARDCASE) failed schema lookup

- Updated dependencies [[`0967cfe`](https://github.com/louistrue/ifc-lite/commit/0967cfe9a203141ee6fc7604153721396f027658), [`057bde9`](https://github.com/louistrue/ifc-lite/commit/057bde9e48f64c07055413c690c6bdabb6942d04), [`e0af898`](https://github.com/louistrue/ifc-lite/commit/e0af898608c2f706dc2d82154c612c64e2de010c), [`6c43c70`](https://github.com/louistrue/ifc-lite/commit/6c43c707ead13fc482ec367cb08d847b444a484a)]:
  - @ifc-lite/encoding@1.7.0
  - @ifc-lite/lists@1.7.0
  - @ifc-lite/renderer@1.7.0
  - @ifc-lite/parser@1.7.0
  - @ifc-lite/query@1.7.0
  - @ifc-lite/data@1.7.0
  - @ifc-lite/cache@1.7.0
  - @ifc-lite/export@1.7.0
  - @ifc-lite/ids@1.7.0
  - @ifc-lite/bcf@1.7.0
  - @ifc-lite/drawing-2d@1.7.0
  - @ifc-lite/geometry@1.7.0
  - @ifc-lite/lens@1.7.0
  - @ifc-lite/mutations@1.7.0
  - @ifc-lite/server-client@1.7.0
  - @ifc-lite/spatial@1.7.0
  - @ifc-lite/wasm@1.7.0

## 1.6.0

### Minor Changes

- Initial tracked version
