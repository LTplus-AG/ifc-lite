# @ifc-lite/parser

## 4.2.0

### Minor Changes

- [#2753](https://github.com/LTplus-AG/ifc-lite/pull/2753) [`6ce17fa`](https://github.com/LTplus-AG/ifc-lite/commit/6ce17fa903d38ab8ee3e6ebaf6da8453726d3ce2) Thanks [@mpancera](https://github.com/mpancera)! - Index `IfcRelConnectsPortToElement` and `IfcRelConnectsPorts`, so plant topology is traversable.
  
  The ports themselves were always parsed — they are `IfcProduct` subtypes and land in the `EntityTable` like any other product — but neither relationship was in the index, so nothing recorded which element a port belonged to or which port it was joined to. A distribution system therefore read as a set of unrelated parts, and there was no way to answer "what is this pump connected to" from the store.
  
  - `RelationshipType` gains `ConnectsPortToElement = 44` and `ConnectsPorts = 45`, keeping the existing 40-range grouping for connection relationships.
  - Both need their own branch in `extractRelFast`: their two ends are single references at attributes 4 and 5, which neither existing branch reads. The default branch takes attribute 5 as a list, and the `IfcRelConnectsElements` branch skips one attribute first because that entity carries an optional `ConnectionGeometry` ahead of its ends.
  - `IfcRelConnectsPorts.RealizingElement` (the optional element that realises a connection, e.g. a length of duct) is deliberately not read. It is a third party to the connection rather than one of its two ends, and treating it as one would invent an edge between a port and that element.
  
  A plant is walked as element → `ConnectsPortToElement` inverse → its ports → `ConnectsPorts` → the opposite ports → `ConnectsPortToElement` forward → their elements.

### Patch Changes

- [#2887](https://github.com/LTplus-AG/ifc-lite/pull/2887) [`79322b6`](https://github.com/LTplus-AG/ifc-lite/commit/79322b6e76049be0df3b07149c711414bd80863e) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `extractPropertyRelFast` silently dropping `IfcRelDefinesByProperties` relationships whose `RelatingPropertyDefinition` is a grouped `IfcPropertySetDefinitionSet` instead of a single property/quantity set reference.
  
  `RelatingPropertyDefinition` is typed `IfcPropertySetDefinitionSelect`, whose
  second alternative (`IfcPropertySetDefinitionSet`, a `SET [1:?] OF
  IfcPropertySetDefinition`) is schema-legal in both bundled IFC4 and IFC4X3
  schemas and is written as a parenthesised ref list, e.g. `([#20](https://github.com/LTplus-AG/ifc-lite/issues/20),[#21](https://github.com/LTplus-AG/ifc-lite/issues/21))`, not a
  bare `[#20](https://github.com/LTplus-AG/ifc-lite/issues/20)`. The byte-level scanner read this attribute with `readRefId`,
  which only recognises a bare `#id`; on the list form it saw the opening `(`
  instead of `#`, returned `-1`, and the whole relationship was discarded --
  every related object in the `RelatedObjects` set silently lost all
  properties and quantities from that pset group, with no error surfaced.
  
  `extractPropertyRelFast` now reads the attribute with `readRefList`, which
  already accepts both a bare ref and a parenthesised list, and returns
  `relatingDefs: number[]` instead of a single `relatingDef: number`. The two
  other consumers of this shared scanner (`IfcRelAssociatesMaterial` /
  `...Classification` / `...Document`) are unaffected: none of their
  `Relating*` selects admit a SET alternative, so they always see a
  length-1 list.

- [#2740](https://github.com/LTplus-AG/ifc-lite/pull/2740) [`7869a90`](https://github.com/LTplus-AG/ifc-lite/commit/7869a90f35384ceba40b7ce4f3e9fadbe6990fa8) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `buildEntityRefsFromIndex` dropping the entity type when a line break
  follows `#id=` directly (`[#1](https://github.com/LTplus-AG/ifc-lite/issues/1)=\nIFCWALL($);`).
  
  This is legal STEP — a newline directly after `#id=` appears in real
  fixtures — and the tokenizer's own `scanEntitiesFast` / `scanEntities`
  already handle it. `buildEntityRefsFromIndex` is the fast path taken when
  the streaming geometry pre-pass has already built the entity index; its
  whitespace skip after `=` only recognised space and tab, so a record
  starting with a newline resolved to `type: ''` and the entity was silently
  misclassified. The skip now also recognises `LF` and `CR`, matching the
  type-end scan a few lines below it in the same function.

- [#2813](https://github.com/LTplus-AG/ifc-lite/pull/2813) [`ad50aa9`](https://github.com/LTplus-AG/ifc-lite/commit/ad50aa9751c31f6895944e26ce19fe8cbbf3018e) Thanks [@louistrue](https://github.com/louistrue)! - An `.ifczip` compressed on macOS is no longer rejected. Finder writes an
  AppleDouble sidecar (`__MACOSX/._<name>`) beside each entry, and it keeps the
  original extension, so `__MACOSX/._model.ifc` was counted as a second model and
  the archive failed with "contains 2 model files — expected exactly one".
  
  Entries whose BASENAME begins with `._` are now excluded from the model-entry
  scan on both the browser and server paths. A genuine second model still fails as
  before, and a real model inside a folder named `__MACOSX` is still found.

- [#2822](https://github.com/LTplus-AG/ifc-lite/pull/2822) [`105eb31`](https://github.com/LTplus-AG/ifc-lite/commit/105eb31e7ccdd697f74db3bc9fac41396cdc6faa) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Two Web Worker resource leaks, same shape as the confirmed `collab`/`collab-server`
  leaks: a `Worker` is spawned, a fallible step runs right after it (a
  `postMessage` structured-clone), and the failure path had no handle to the
  worker it had already created.
  
  `packages/geometry/src/geometry-parallel.ts`: the process-worker pool's
  init loop (spawn, then `postMessage({type:'init', ...})` and five more
  `set-*` messages per worker) ran before the function's own try/finally, so
  a `postMessage` throw partway through the loop (a `wasmModule`
  structured-clone failure is the realistic trigger — the same class of
  error `dispatchJobsChunkInternal` already guards against) left every
  worker spawned so far un-terminated; the finally that owns teardown for
  the rest of the pipeline never saw the throw. The loop now has its own
  try/catch that terminates every worker pushed to `workers` so far before
  rethrowing.
  
  `packages/parser/src/scan-worker-inline.ts`: `scanEntitiesInWorker`
  declared its `Worker` with `const` inside the try that also calls
  `postMessage`, so the catch block — which only had `reject(err)` — could
  not reach it if `postMessage` threw after construction (a detached-buffer
  or memory-pressure clone failure). The `worker` binding now lives outside
  the try so the catch can terminate it before rejecting.

- [#2883](https://github.com/LTplus-AG/ifc-lite/pull/2883) [`5254699`](https://github.com/LTplus-AG/ifc-lite/commit/52546994268440a468de81ce6ac0b385e6ef73d7) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Resolve `IfcElectricalDistributionPoint`'s inheritance chain in the TS parser.
  
  `IfcElectricalDistributionPoint` is deprecated IFC2x3 syntax that no bundled
  schema table (`ENTITIES_IFC2X3`/`IFC4`/`IFC4X3`) carries as a class — none has
  an entry for it at all. `rust/core/src/legacy_entities.rs` handles this by
  name ("IFC2x3 names that have no IFC4x3 enum variant") and resolves it to
  `IfcDistributionElement`. `ifc-schema.ts`'s `ENTITY_NAME_ALIASES` table
  carries a comment claiming it "mirrors `rust/core/src/legacy_entities.rs` so
  the two sides stay in lockstep", but only ported the three IFC4.3 stratum
  leaves — this entity, and 16 other Rust-side legacy names, were never added.
  Of those, only this one is a real gap: the other 16 (`IfcBeamStandardCase`,
  `IfcWindowStyle`, `IfcProxy`, ...) already resolve directly, since they exist
  in `ENTITIES_IFC4`.
  
  Before this change, `getInheritanceChain('IfcElectricalDistributionPoint')`
  returned `[]` in the TS parser while the Rust core resolved the same entity
  name to `IfcDistributionElement` with geometry — a real cross-language
  divergence on a legal (if deprecated) STEP entity. `ENTITY_NAME_ALIASES` now
  carries the same mapping, so `getInheritanceChain` includes
  `IfcDistributionElement` for this class, matching the Rust core.
- Updated dependencies [[`be6b43c`](https://github.com/LTplus-AG/ifc-lite/commit/be6b43c2b334811422c1cbfbea5d6e6d1b9a401d), [`0ed2582`](https://github.com/LTplus-AG/ifc-lite/commit/0ed2582b71973fa6d16307999ed2ea59f7a2db3f), [`a29b040`](https://github.com/LTplus-AG/ifc-lite/commit/a29b04069fec3c6b726f49fc58054e535c255034), [`cc19a8d`](https://github.com/LTplus-AG/ifc-lite/commit/cc19a8d4a79a5e8563a90ab663b28e1b93ef9c18), [`36e4eca`](https://github.com/LTplus-AG/ifc-lite/commit/36e4eca3b19a2fe02f1679acc9a2a43cd90aa163), [`a7b8a20`](https://github.com/LTplus-AG/ifc-lite/commit/a7b8a201eaecd411a4246421893e887bf55aafd3), [`6ce17fa`](https://github.com/LTplus-AG/ifc-lite/commit/6ce17fa903d38ab8ee3e6ebaf6da8453726d3ce2)]:
  - @ifc-lite/data@3.4.0
  - @ifc-lite/wasm@5.0.0
  - @ifc-lite/ifcx@2.3.7

## 4.1.0

### Minor Changes

- [#2530](https://github.com/LTplus-AG/ifc-lite/pull/2530) [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6) Thanks [@BIMvoice](https://github.com/BIMvoice)! - clash: drop IFC type objects from the clash and duplicate candidate set

  An `IfcWallType`/`IfcSpaceType`/`IfcDoorStyle` carries the `RepresentationMaps`
  template that its occurrences instantiate. The mesher turns that template into
  geometry, which lands on top of the very occurrences that use it — so the type
  read as a duplicate of its own occurrence, and clashed against elements it never
  physically touches. On one public sample model this accounted for 114 of 282
  reported clashes and for the model's only reported duplicate.

  Type objects are now filtered out alongside the other non-physical types, which
  also closes the gap the earlier `IfcSpace` exclusion left open: the space was
  excluded by name while `IfcSpaceType` sailed straight through.

  `isIfcTypeLikeEntity` is now exported from `@ifc-lite/parser` so the clash
  adapter uses the same predicate the parser classifies entities with.

- [#2529](https://github.com/LTplus-AG/ifc-lite/pull/2529) [`5086c57`](https://github.com/LTplus-AG/ifc-lite/commit/5086c5729b6ae8ad967aafa91d96dfdb37327599) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `extractAllEntityAttributes` now names attributes across the bundled schema union (IFC2X3 + IFC4 + IFC4X3) instead of through the IFC4 codegen pin alone, so an entity of an IFC4.3 infrastructure class stops reporting no attributes at all.

  The pin answers an **empty** attribute list — not a wrong one — for every class it does not carry, and 251 real classes are outside it: the IFC2X3 ones IFC4 dropped, and the whole IFC4.3 infrastructure vocabulary (`IfcCourse`, `IfcPavement`, `IfcKerb`, `IfcSignal`, `IfcRail`, `IfcRoad`, `IfcBearing`, …). Empty is the damaging shape: a caller looking an attribute up by name finds nothing, and nothing is indistinguishable from an unset slot, so every consumer answered "absent" with no error and no diagnostic. The same pinned-registry family as the membership defects [#2001](https://github.com/LTplus-AG/ifc-lite/issues/2001), [#2003](https://github.com/LTplus-AG/ifc-lite/issues/2003) and the `Tag` defect [#2021](https://github.com/LTplus-AG/ifc-lite/issues/2021), which fixed one lookup this way and left the general one.

  The consumer where it was measurable is the model diff. Both fingerprint adapters (`@ifc-lite/cli`'s and the viewer's) read `PredefinedType` through this function, so on an IFC4.3 element the attribute was absent from the fingerprint on **both** revisions and a cleared or changed `PredefinedType` compared equal to itself. On an infrastructure revision pair whose products were compared against an independent parse of the raw STEP text, a cleared `PredefinedType` was the _only_ edit on 19 of 23 modified products — a comparison blind to it under-reports by roughly a factor of four while looking healthy. `@ifc-lite/ids`' `PredefinedType` facet and the viewer's PredefinedType display read the same function and had the same hole.

  Additive at the parser surface, but a **minor**, not a patch, because downstream behaviour on IFC4X3 models legitimately changes: `getAttributeNamesAcrossSchemas` returns the pinned result unchanged whenever the pin has one, so no IFC2X3 or IFC4 entity's attribute list moves (measured on a real IFC4 revision pair: the added / deleted / modified GlobalId sets are byte-identical before and after) — while on the 251 previously-empty classes every consumer of this function now sees attributes it never saw. That includes `@ifc-lite/ids` (attribute and `PredefinedType` facets can flip a verdict on an infrastructure model), `@ifc-lite/mcp`'s attribute queries, the CLI headless backend, and both diff fingerprint adapters.

  Two sibling lookups in the same file still go through the pin and are deliberately left alone: `getRawNamedAttributes` (the query layer's coercion path) and `getRootAttrIndices`, whose `known` flag gates columnar `EntityTable` membership and so has a materially larger blast radius than an attribute read.

### Patch Changes

- Updated dependencies [[`5cf117d`](https://github.com/LTplus-AG/ifc-lite/commit/5cf117d1eb16dba7f3e7be67114e26ce3ec44a8f)]:
  - @ifc-lite/wasm@4.6.0
  - @ifc-lite/ifcx@2.3.6

## 4.0.3

### Patch Changes

- [#2539](https://github.com/LTplus-AG/ifc-lite/pull/2539) [`cd72412`](https://github.com/LTplus-AG/ifc-lite/commit/cd724127245fcb767894642cd0994baaba88ff7d) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Forward a geometry/parser worker's wasm panic-location stash to the main thread.

  A follow-up to the wasm-trap source-location attribution: the Rust panic hook stashes
  `{ location, at }` on whichever realm's JS global it runs in, but a panic inside a geometry
  process worker or the parser worker left that stash stranded in the worker's own realm, invisible
  to the main thread's `attachWasmPanicLocation` gate — so "Geometry worker error: unreachable" (and
  the equivalent parser-worker error) still arrived without a location.

  Both workers now read + consume their own realm's stash on the `{type:'error'}` message they post
  back, and the main-thread pools (`geometry-parallel.ts`'s process-worker pool AND its streaming
  pre-pass worker, `worker-parser.ts`) re-plant it on the main realm's global before the load error
  propagates — so the existing consume-once, TTL-guarded attachment gate in the viewer picks a worker
  trap up exactly as it would a main-thread one. The re-plant only happens when the accompanying error
  message itself looks wasm-trap-shaped, so a stash forwarded alongside an ordinary, non-trap worker
  error (the worker always forwards whatever it has, regardless of the error that triggered it) can't
  sit on the main realm's global and mislabel an unrelated later trap. Location only, never the panic
  message, matching the existing privacy contract.

- Updated dependencies [[`cd72412`](https://github.com/LTplus-AG/ifc-lite/commit/cd724127245fcb767894642cd0994baaba88ff7d)]:
  - @ifc-lite/wasm@4.5.1

## 4.0.2

### Patch Changes

- [#2359](https://github.com/LTplus-AG/ifc-lite/pull/2359) [`7ee619f`](https://github.com/LTplus-AG/ifc-lite/commit/7ee619f8c6a7490982136d5677674f4f6355a568) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix two corrupted cells in the generated CRC32 lookup table (index 111 and 245), which were hand-typed literals that had silently drifted from the correct reflected CRC-32 (polynomial `0xEDB88320`) values. `packages/codegen` now renders this table from a single `buildCRC32Table()` source of truth in both its TypeScript and Rust templates instead of hand-typing a second copy, so the two cannot diverge again.

  The 256-entry `TYPE_IDS` map shipped for every named entity in the schema was never affected — those ids are computed with the correct table at generation time. The corruption only affected `crc32Hash()` / `crc32_hash()` at runtime for entity keywords that are NOT in the map, i.e. the `IfcType::from_str` `Unknown(crc32_hash(...))` fallback reached for unrecognized/vendor-extension entity keywords, which could get a silently wrong stable id for names whose hash computation happened to touch one of the two corrupted cells.

  `packages/codegen/generated/ifc4/type-ids.ts`, `packages/parser/src/generated/type-ids.ts`, `rust/core/src/generated/schema.rs`, and `packages/codegen/generated/ifc4x3/type-ids.ts` were all regenerated to correct the same two cells; each diff is exactly those two constants. The `ifc4x3` copy (see the companion changeset) is not imported by `packages/parser` or `rust/core`, so it had no runtime reader today, but it is a checked-in generated artifact and now matches the canonical table like the other three.

  `formatCRC32TableLiteral()` now validates `perLine` and throws for a zero, negative, or non-integer value instead of silently producing a broken or extremely slow result. No caller passes a non-default `perLine` today, so this is a hardening of the exported helper's contract rather than a behavioral fix to generated output — with the default (`perLine = 6`), this hardening by itself leaves the four regenerated artifacts above unchanged.

- [#2542](https://github.com/LTplus-AG/ifc-lite/pull/2542) [`1de1696`](https://github.com/LTplus-AG/ifc-lite/commit/1de16969db1c56f4901e4af49da74085bae3b3fe) Thanks [@louistrue](https://github.com/louistrue)! - Skip `/* */` comments when scanning for entities, so a commented-out record stays commented out

  The entity scanners looked for `#` anywhere in the buffer, including inside a
  STEP comment. A record that has been commented out is still a well-formed
  `#id = TYPE(...);`, so every shape check downstream accepted it and it was
  parsed as a live entity. Round-tripped through `StepExporter`, those revived
  records are written into the output as real ones, taking express ids from gaps
  in the source numbering.

  The guard added in [#856](https://github.com/LTplus-AG/ifc-lite/issues/856) cannot catch this. It requires a `#<digits>` to be
  followed by `=`, which rejects a bare `[#1](https://github.com/LTplus-AG/ifc-lite/issues/1)` in prose and accepts a commented-out
  record, because that record has its `=`. The comment has to be skipped as a
  region, which is what the Rust `EntityScanner` already does.

  All three copies of the scan loop are fixed, not just the one: `scanEntities`,
  `scanEntitiesFast`, and the string-embedded `WORKER_CODE` in
  `scan-worker-inline.ts`. The worker matters most, because `scanIfcEntities`
  tries it before the wasm scan and before the tokenizer, so in a browser it is
  the copy that runs. Each skips comment regions, counts the newlines it jumps so
  line numbers stay right, stops at an unterminated comment rather than resuming
  inside it, and leaves a lone `/` alone. Comments do not nest, per ISO 10303-21,
  so the first `*/` closes the region.

  The scanners now also consume a string literal whole when they meet one outside
  a record. HEADER records carry no `#`, so the outer loops walk them byte by
  byte, and their string values are the one place those loops reliably meet
  quoted text. A `FILE_DESCRIPTION` reading `'rev /* pending'` would otherwise
  open a comment that never closes and drop the entire DATA section of a legal
  file. The same skip fixes a defect that predates this change: `[#12](https://github.com/LTplus-AG/ifc-lite/issues/12)=IFCWALL(x)`
  inside a HEADER description was read as a record.

  `scanEntities` additionally now advances past a record it has matched. It used
  to leave its cursor at the record's opening parenthesis and re-walk the body
  with no string state, which was harmless while an interior `#` merely failed
  the `=` guard and would not have been once the same loop began reacting to
  `/*`: a slash-star inside a string literal would have opened a comment and
  swallowed the rest of the file. The Rust scanner advances for the same reason.

- Updated dependencies [[`b4b3e0c`](https://github.com/LTplus-AG/ifc-lite/commit/b4b3e0cfa8ffa9185e96dc266dd6fdc3fef34797)]:
  - @ifc-lite/encoding@2.0.0
  - @ifc-lite/data@3.2.4

## 4.0.1

### Patch Changes

- [#2497](https://github.com/LTplus-AG/ifc-lite/pull/2497) [`7c686f9`](https://github.com/LTplus-AG/ifc-lite/commit/7c686f9ac39f78a707dc083c798b6ef3d255e171) Thanks [@louistrue](https://github.com/louistrue)! - `parseStepValue` decodes ISO 10303-21 backslash directives, and the decoder that does it now lives in one place ([#2490](https://github.com/LTplus-AG/ifc-lite/issues/2490)).

  **What changes for a caller.** `@ifc-lite/data`'s `parseStepValue` un-doubled the two lexical doublings (`''` and `\\`) with a directive-blind pair of regexes and stopped there, so a string literal taken from a real IFC file came back with its directives intact: `'\X2\00FC\X0\'` returned those nine characters where the shared decoder returns `ü`, and `'\X2\00FC\X0\\'` returned `\X2\00FC\X0\` where it should return `ü\`. `\X\HH`, `\S\x` and `\Px\` were equally untouched, and the same gap applied inside a list, since `parseStepList` recurses through the same function. All of those now decode. Values written by this module's own escaper are unaffected — it emits non-ASCII raw and never emits a directive, so every `\\` it produces really is a doubled reverse solidus and the round trip was, and remains, exact. That is why this was invisible from inside the package: the reader was the exact inverse of the writer, and only a literal from somewhere else could tell them apart. `parseStepValue` is a public export, so that is a supported way to reach it.

  **Why the escaper does not move with it.** The pair is still closed. Emitting non-ASCII raw stays valid against the new reader — there are no backslashes to double and nothing to decode — and the directive-precedence rule in the shared scan is what keeps a value that merely LOOKS like a directive round-tripping as literal text: `\X2\00FC\X0\` written out as `\\X2\\00FC\\X0\\` reads back as those characters rather than decoding to `ü`. Switching the writer to emit `\X2\` directives would also round-trip, and is a separate decision about output bytes rather than a correctness fix.

  **One decoder instead of two.** The implementation is now `decodeStepStringLiteral`, exported from `@ifc-lite/encoding` (the additive API, hence the minor there). `packages/parser/src/source-header.ts` had written the same scan privately in [#2486](https://github.com/LTplus-AG/ifc-lite/issues/2486) after its own directive-blind regex corrupted non-ASCII header fields on round trip; that copy is deleted and both readers call the shared one. Its behaviour is unchanged — the code moved verbatim — so header parsing is byte-for-byte what it was. Two independent copies of a decoder this subtle is exactly how the second directive-blind regex survived, and the resolution is genuinely not two passes: a doubling pass run first eats a directive's own terminator whenever an escaped backslash follows it (`\X2\00FC\X0\` + `\\` ends in three backslashes), leaving an unterminated `\X2\` that never decodes.

  **A new dependency edge, `@ifc-lite/data` -> `@ifc-lite/encoding`.** It is acyclic — `@ifc-lite/encoding` has no dependencies of its own and imports nothing from `@ifc-lite/data` — and free in practice: every package that consumes `@ifc-lite/data` (parser, export, sdk, bcf, create, lists) already installs `@ifc-lite/encoding`. Released as a patch for `@ifc-lite/data`: no exported API changes, and the behavioural difference is a decode that was missing.

- Updated dependencies [[`63496ec`](https://github.com/LTplus-AG/ifc-lite/commit/63496ec0ae63c54c3bcbc5ecaec537877dc48831), [`eb39b27`](https://github.com/LTplus-AG/ifc-lite/commit/eb39b27f5eba186b23b3a683c25fff2c60084d9c), [`7c686f9`](https://github.com/LTplus-AG/ifc-lite/commit/7c686f9ac39f78a707dc083c798b6ef3d255e171)]:
  - @ifc-lite/wasm@4.4.0
  - @ifc-lite/encoding@1.16.0
  - @ifc-lite/data@3.2.3

## 4.0.0

### Major Changes

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

### Minor Changes

- [#2377](https://github.com/LTplus-AG/ifc-lite/pull/2377) [`2e16736`](https://github.com/LTplus-AG/ifc-lite/commit/2e167367037fa3b5d1d2d5d26dd4fb7ac169e2f5) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Add `extractClassificationSystemsOnDemand(store)`, a cheap and exact per-model listing of the distinct `IfcClassification` system names present (e.g. Uniclass, OmniClass, a national system) — walks only the `IfcClassification` entities via the `byType` index, not a per-element scan. Used by the viewer's model-level info panel to show all classification systems used in a model, not just the first.

- [#2353](https://github.com/LTplus-AG/ifc-lite/pull/2353) [`958aef1`](https://github.com/LTplus-AG/ifc-lite/commit/958aef125743682da75c3da7b41991abd9d36d32) Thanks [@louistrue](https://github.com/louistrue)! - Add block-compressed storage for `IfcDataStore.source`, and let a source switch to it in place ([#2183](https://github.com/LTplus-AG/ifc-lite/issues/2183)).

  Inert in this release: nothing constructs a compressed source yet. It is the machinery plus its proofs, landing separately from the switch that turns it on so the switch can be reverted on its own.

  The source is the whole IFC file, held resident for the model's lifetime because property and attribute reads slice it synchronously during React render. On a 342 MB model that is 327 MB of the viewer's main-thread heap. Deflating it into fixed-size blocks and inflating on demand trades that for ~67 MB plus a small cache.

  Sized from measurement rather than taste, using fflate on the real 342.7 MB model:

  | block      | stored    | saved      | inflate p50 / p99 / max   |
  | ---------- | --------- | ---------- | ------------------------- |
  | 16 KiB     | 77 MB     | 265 MB     | 0.08 / 0.25 / 1.70 ms     |
  | **64 KiB** | **67 MB** | **275 MB** | **0.18 / 0.35 / 0.40 ms** |
  | 256 KiB    | 64 MB     | 278 MB     | 0.69 / 0.93 / 1.32 ms     |

  64 KiB: 256 KiB buys 3 MB more for 3.8x the per-miss latency and a much worse tail, which is the wrong trade for a synchronous read on the render path.

  The cache is 32 MB. A full per-entity sweep touches 5161 of 5229 blocks — essentially each block once, because expressId order tracks byte offset in STEP — so it is a sequential scan, not a thrash, and capacity is nearly irrelevant to it (32 MB and 256 MB are within 7%). Capacity is therefore sized for the interactive working set, where the worst measured case (a 1000-product selection) touches 500 blocks.

  **The swap is in place, and that is load-bearing rather than stylistic.** `attachDataStoreAccessors` captures the accessor in a `BufferEntitySource` held for the store's lifetime, so `getEntity` reads through that object, while `getProperties` builds a fresh extractor from `store.source` on every call. Replacing the property instead of mutating the object would leave entities served from the old resident buffer and properties from the compressed one — both alive, nothing saved, and the two read paths silently disagreeing.

  Fixed here for the same reason: `parseColumnar` built **two** accessors over the same bytes, one for `source` and one inside `BufferEntitySource`. Harmless while both are resident views; fatal once the source can compress, because the entity path would keep its own resident accessor and the original buffer would never be released. Measured both ways — with two accessors the buffer survives GC after a swap, with one it is collected.

  New exports: `compressSource`, `compressSourceInPlace`, `shouldCompressSource`, `sourceBlockStats`, `COMPRESSION_MIN_BYTES`, `DEFAULT_BLOCK_SIZE`, `DEFAULT_CACHE_BYTES`, and the `CompressedSource`, `BlockedPayload`, `BlockStoreCounters` types. `sourceBytesFromTransferable` now rehydrates the `blocked` arm, so a source crosses a worker boundary as ~67 MB of blocks instead of 343 MB of bytes, with no inflation on either side.

  Adds `fflate` as a dependency of `@ifc-lite/parser`; it was already a viewer dependency.

- [#2291](https://github.com/LTplus-AG/ifc-lite/pull/2291) [`09d67c7`](https://github.com/LTplus-AG/ifc-lite/commit/09d67c780bf68f58dec3f77920927857c752f8da) Thanks [@louistrue](https://github.com/louistrue)! - Widen the byte-range readers so they accept either the raw source bytes or the `IfcSourceBytes` accessor ([#2183](https://github.com/LTplus-AG/ifc-lite/issues/2183)). Behaviour-neutral groundwork: every widened helper normalises through `asSourceBytes` and reads via `decodeUtf8`/`slice`, and no call site changes shape. (`IfcDataStore.source` still held a `Uint8Array` at this step; the type flip lands in the same release, below.)

  `@ifc-lite/parser` now exports `asSourceBytes` and the `IfcSourceBytes` type. They were internal in the previous step because nothing outside the package consumed them; the widened readers in `@ifc-lite/export`, `@ifc-lite/cli` and the viewer are that consumer, and `IfcDataStore.source` is on its way to the type regardless.

  Widened: `BufferEntitySource`, `extractLengthUnitScale`, `extractProjectUnits`, `SpatialHierarchyBuilder.build`, `buildEntityRefsFromIndex`, `collectReferencedEntityIds`, `collectStyleEntities`, `collectRefsInByteRange`, and the CLI's dangling-reference scan.

### Patch Changes

- Updated dependencies [[`d75786f`](https://github.com/LTplus-AG/ifc-lite/commit/d75786f631047d234f204289426f708f0be8674b), [`273b068`](https://github.com/LTplus-AG/ifc-lite/commit/273b06827ef1469f63c396d204474a9f2400c642), [`58fbc63`](https://github.com/LTplus-AG/ifc-lite/commit/58fbc634994742c79375830c1983508752fd78e9), [`a220406`](https://github.com/LTplus-AG/ifc-lite/commit/a2204062ba1fc555e4529896cbc82efccc7a5146), [`c866bee`](https://github.com/LTplus-AG/ifc-lite/commit/c866bee62a7d6e40b15a7de63948354cbbe049a7), [`262b9df`](https://github.com/LTplus-AG/ifc-lite/commit/262b9df485e4bfd3760f73c30d93bb518e599b72), [`d9490e6`](https://github.com/LTplus-AG/ifc-lite/commit/d9490e6e2ecacb65aea42fcaef73fd292a4c3095), [`deb54d3`](https://github.com/LTplus-AG/ifc-lite/commit/deb54d3ff75f35c3c9206c8ea9a1e875426352c6)]:
  - @ifc-lite/data@3.2.2
  - @ifc-lite/encoding@1.15.1
  - @ifc-lite/ifcx@2.3.4

## 3.15.1

### Patch Changes

- [#2126](https://github.com/LTplus-AG/ifc-lite/pull/2126) [`3c2ffa6`](https://github.com/LTplus-AG/ifc-lite/commit/3c2ffa6a1bd0a04d3d73e2ea7c0fb1a2233599a9) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `extractLengthUnitScale` now warns, once per model, when it falls back to an unconfirmed `1.0` (meters) instead of resolving the file's declared length unit ([#2104](https://github.com/LTplus-AG/ifc-lite/issues/2104)).

  The function has always returned `1.0` for two different situations that look identical to every caller: a file that genuinely declares meters, and a file whose unit declaration could not be resolved at all (no `IfcProject`, no `UnitsInContext`, a malformed `IfcUnitAssignment`, an unrecognised SI prefix, or no length unit present in the assignment). Only 2 of the 11 `return 1.0` paths warned before this change; the other 9 returned the same plausible-looking value silently, so a model authored in millimetres with a broken unit declaration read as metres with no signal that the value was a guess — a 1000x scale error indistinguishable from a valid file.

  8 of those silent paths now call a warning helper before returning `1.0`; a 9th (an `IfcSIUnit` with no prefix, which is a genuine, confirmed "this file declares meters", not an unknown) intentionally still does not warn. The warning is latched per `entityIndex` (i.e. per parsed model) rather than per call, so callers that re-derive the scale many times for the same store — `extractWallSegmentsForStorey` runs once per storey, `resolveSpatialAnchor` once per generated space — do not flood the console with repeats of the same diagnosis; a different model still gets its own warning.

  No signature or return-value change: `extractLengthUnitScale` still returns a `number`, and every existing caller's fallback-to-`1.0` behaviour is unchanged. This is the "make it visible" remedy, not the "let each caller decide" remedy — the function has 15+ call sites and the large majority (geometry/coordinate scaling: `columnar-parser.ts`, `extract-walls.ts`, `resolve-anchor.ts`, `resolve-source.ts`, `kmz-export.ts`, `lod0-generator.ts`, `demesh-session.ts`, `useIfcCache.ts`, `length-unit-scale.ts`, `effective-georef.ts`) need a plain number to keep scaling coordinates and have no sensible operation to refuse on `null`; a `null`-returning signature change was evaluated and rejected as a placebo for those call sites specifically because they'd all just coalesce it back to `1` immediately. The handful of read/reporting call sites (the MCP `units` tool, the viewer's unit-metadata panels) could act on a distinguishable "unknown", and can still choose to key off the `console.warn` if closer coupling turns out to be worth it later.

- Updated dependencies [[`d85ef9b`](https://github.com/LTplus-AG/ifc-lite/commit/d85ef9bb725843f682463496e7a8f2d2ab9b83f1), [`befc108`](https://github.com/LTplus-AG/ifc-lite/commit/befc1083e377315231006352cb3fe95949e92b47)]:
  - @ifc-lite/wasm@4.3.1
  - @ifc-lite/data@3.2.1
  - @ifc-lite/ifcx@2.3.3

## 3.15.0

### Minor Changes

- [#1963](https://github.com/LTplus-AG/ifc-lite/pull/1963) [`d008604`](https://github.com/LTplus-AG/ifc-lite/commit/d0086043fa88f488d19942ffe9241d80bab4be6a) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `IfcLagTime` exporting a lead time (a negative lag) with the wrong sign. When a sequence carried a negative `timeLagSeconds` and no `timeLagDuration`, the serializer's fallback reconstructed an `IfcLagTime` from the magnitude alone — so a 2-day lead (the successor may start 2 days _before_ its predecessor finishes) exported as a 2-day lag, and a consumer reading the file would schedule the successor 2 days _late_ instead of early: a 4-day swing, silently.

  The fix: `secondsToIso8601Duration` and `parseIso8601Duration` now form a signed codec (both exported from `@ifc-lite/parser`, consolidated out of two previously-separate implementations). A negative `timeLagSeconds` encodes to the ISO 8601-2 signed form (`-P2D`) instead of either losing its sign or being dropped, and the decoder reads that sign back on import, so a lead round-trips through `ifc-lite` losslessly: `-172800` seconds → `-P2D` → `-172800` seconds.

  **Interop caveat, accepted deliberately:** strict ISO 8601 durations have no sign. `-P2D` is ISO 8601-2, which `IfcDuration`'s unconstrained `STRING` type accepts, but some third-party `^P...` IfcDuration parsers reject the leading `-` outright and will drop the lag rather than read it. That is judged the better failure mode than the alternative this replaces (silently exporting the wrong sign) or dropping the lag from every export including our own re-imports — a lead is real scheduling information, and losing it in our own round trip is a worse defect than a third-party parser occasionally rejecting the field. If a consumer's `IfcDuration` parser needs unsigned durations, it will surface as that consumer failing to read the lag, not as a wrong schedule.

  Reachable from the construction-schedule importer, where a CSV predecessor such as `1FS-2 days` yields a negative lag.

  **Also fixed in the same codec:** `secondsToIso8601Duration` rounded its seconds component (`Math.round`), so a sub-second lag degraded to `PT0S` — data loss in the very consolidation meant to make the round trip lossless. A fractional value now survives as a decimal on the seconds component (ISO 8601 permits this), formatted to avoid exponent notation for very small magnitudes, and is pinned with an encode → decode round-trip test.

  **Second-round fixes (same codec, same PR):**

  - `secondsToIso8601Duration` now renders every finite magnitude as plain decimal using the shortest round-trip digit string, instead of a `toFixed(9)` floor. This closes two gaps at once: precision beyond nine fractional digits is no longer truncated, and magnitudes at or above `1e21` no longer fall into JS exponent notation (`"PT1e+21S"`) — a string the codec's own parser rejects as invalid. The full round trip now holds for `NaN`, `±Infinity`, `Math.PI`, `1e21`, `1e-10`, and ordinary values.
  - `secondsToIso8601Duration` now returns `undefined` for non-finite input (`NaN`, `±Infinity`) instead of `PT0S`. `PT0S` is a legitimate zero-lag value, so returning it for broken input fabricated a real-looking answer from a malformed one (a plausible source: a broken MSPDI `LinkLag` producing `NaN` after `Math.round`). Callers already treat `undefined` as "emit no `IFCLAGTIME`", so this refuses rather than invents, with no caller changes needed.
  - `parseIso8601Duration` now rejects a trailing bare `T` with no time component (`"P1DT"`, `"-P1DT"`), consistent with the existing rejection of bare `"P"`/`"PT"`.
  - `schedule-serializer.ts` now emits `IFCLAGTIME` for an explicit `timeLagSeconds: 0`. The prior truthiness check (`seq.timeLagSeconds ? ... : undefined`) treated an explicit zero the same as "absent" and dropped it, while an explicit `timeLagDuration: 'PT0S'` was already emitted through the neighboring `??`. Both spellings of a zero lag now behave the same.

  **Third-round fix (same codec, same PR):** `parseIso8601Duration` now rejects a component large enough to overflow to `±Infinity` (e.g. a 320-digit year component), instead of returning that `Infinity` as though it were a real duration. `secondsToIso8601Duration` already refused non-finite input on encode; the decoder accepting a magnitude its own encoder could never produce was the same asymmetry in the other direction, and `Infinity` seconds would otherwise propagate into `timeLagSeconds` and any downstream arithmetic. Malformed input is refused (`undefined`) rather than accepted, and the round trip continues to hold for every finite, representable value, including the existing table (`NaN`, `±Infinity`, `Math.PI`, `1e21`, `1e-10`, `86400`, `-172800`, `P1DT`, `P1DT1H`).

## 3.14.0

### Minor Changes

- [#2041](https://github.com/LTplus-AG/ifc-lite/pull/2041) [`c65bdbe`](https://github.com/LTplus-AG/ifc-lite/commit/c65bdbe033494e71e35e0222895fa1d017f0fd76) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `bim.store.addEntity` and the MCP `entity_create` tool now reject abstract IFC classes ([#2035](https://github.com/LTplus-AG/ifc-lite/issues/2035)).

  `IfcProduct`, `IfcRoot`, `IfcRelationship` and the other ~123 EXPRESS `ABSTRACT SUPERTYPE`s are real classes, so the existing `isKnownType` guard accepted them — `addEntity('IfcProduct', …)` wrote `#N=IFCPRODUCT(...)` into the overlay and out to the exported file, which is not valid IFC.

  `@ifc-lite/parser` now exports `isInstantiable(type)`, answering `known && !abstract` from the same cross-schema union (2X3 + 4 + 4X3) `isKnownType` already resolves against. `@ifc-lite/sdk` wires it into both the `bim.store.addEntity` guard and the shared entity-type normalizer that `@ifc-lite/mutations`' `StoreEditor.addEntity` consumes — the same choke point the MCP `entity_create` tool goes through via `ensureEditor()`. Passing an abstract type now throws instead of silently authoring an invalid STEP record.

## 3.13.0

### Minor Changes

- [#2001](https://github.com/LTplus-AG/ifc-lite/pull/2001) [`a2ca053`](https://github.com/LTplus-AG/ifc-lite/commit/a2ca0535c14cd1bf9d55713584766dff55430158) Thanks [@louistrue](https://github.com/louistrue)! - **schema**: export `getInheritanceChainAcrossSchemas(type)` — the inheritance chain resolved against every bundled IFC schema (IFC2X3 + IFC4 + IFC4X3), leaf → root.

  The already-exported `getInheritanceChainForEntity` comes from the generated registry, which is pinned to IFC4*ADD2_TC1, so it answers an empty chain for any class that pin does not carry: 23 `IfcObjectDefinition` classes IFC4 dropped from IFC2X3 (`IfcMove`, `IfcOrderAction`, `IfcScheduleTimeControl`, `IfcSpaceProgram`, …) and 77 IFC4X3 additions (`IfcRoad`, `IfcBridge`, `IfcAlignment`, `IfcCourse`, …). Code that decides \_what kind of thing* an entity is — as `ifc-lite diff` does — reads an empty chain as "unknown" and gets those classes wrong on schemas that are still very common in the wild.

  This is the counterpart of the existing `getAttributeNamesAcrossSchemas`, and is the same function the columnar parser has always used internally to categorize entities. For classes the pin does know, both functions agree on every ancestor that matters; note that the two return their chains in opposite order, so pick the leaf by name rather than by position.

- [#2031](https://github.com/LTplus-AG/ifc-lite/pull/2031) [`e4d2db5`](https://github.com/LTplus-AG/ifc-lite/commit/e4d2db5f11798e3ec78f45249139d69aa1e65275) Thanks [@louistrue](https://github.com/louistrue)! - **schema**: `isKnownType` and `normalizeIfcTypeName` now answer for every bundled IFC schema (IFC2X3 + IFC4 + IFC4X3), not just the IFC4_ADD2_TC1 codegen pin (issue [#2003](https://github.com/LTplus-AG/ifc-lite/issues/2003)).

  Both read `isKnownEntity` / `getEntityMetadata`, which are generated from the pin and answer "unknown" for any class it does not carry. Measured on the bundled tables: 251 real classes, including 100 `IfcObjectDefinition` ones — the IFC2X3 classes IFC4 dropped (`IfcMove`, `IfcScheduleTimeControl`, `IfcSpaceProgram`, `IfcServiceLife`, `IfcOrderAction`, …) and the IFC4X3 infrastructure classes it never had (`IfcRoad`, `IfcSignal`, `IfcAlignment`, `IfcRailway`, `IfcMarineFacility`, …). `normalizeIfcTypeName` had the same blind spot from the other side: it fell through to "preserve as-is", so `'IFCROAD'` stayed `'IFCROAD'` instead of canonicalizing to `'IfcRoad'`.

  Both now resolve against the schema union first and fall back to the pin, the same order `getInheritanceChainAcrossSchemas` uses.

  `isKnownType` is still a guard, not a pass-through. Typos (`IfcWal`, `IfcRoadd`), vendor extensions, and the 138 EXPRESS _defined types_ the upstream SchemaInfo tables carry as entity rows are all still rejected — 132 named by the cross-schema `IFC_DATA_TYPES` table (`IfcLengthMeasure`, `IfcBoolean`, `IfcCountMeasure`, …) and 6 more that only the pin's own `SCHEMA_REGISTRY.types` map names (`IfcBinary`, `IfcArcIndex`, `IfcLineIndex`, `IfcComplexNumber`, `IfcCompoundPlaneAngleMeasure`, `IfcPropertySetDefinitionSet`). None of the 776 pinned classes appears in either table, so no IFC4 answer changes.

  It answers known-ness, not instantiability: abstract supertypes (`IfcProduct`, `IfcRoot`) are real IFC classes and still answer `true`, exactly as they did before. Rejecting those is a separate, pre-existing question — `main` already accepts 123 of them — tracked in [#2035](https://github.com/LTplus-AG/ifc-lite/issues/2035).

  **data**: exports `IFC_DATA_TYPES`, the raw bundled defined-type table, for the same reason the `ENTITIES_*` tables are exported: a synchronous guard deciding "is this a class I may instantiate?" has to subtract the defined types, and the existing `findDataType` is async.

- [#2011](https://github.com/LTplus-AG/ifc-lite/pull/2011) [`a5cc568`](https://github.com/LTplus-AG/ifc-lite/commit/a5cc568a642d7dd8d17f1ed7858844f9289bc841) Thanks [@louistrue](https://github.com/louistrue)! - Export `resolveEntityNameAlias(type)`, which resolves an entity name through the legacy-alias table (`IfcSolidStratum` / `IfcVoidStratum` / `IfcWaterStratum` → `IfcGeotechnicalStratum`) and returns the name unchanged otherwise.

  Consumers that index the bundled schema union themselves — the STEP exporter's enum-slot resolution is the first — have to canonicalize exactly the way `getAttributeNamesAcrossSchemas` does, or their slot indices refer to a different attribute list than the names those indices are meant to index into. The table already has two homes (here and `rust/core/src/legacy_entities.rs`); exporting the resolver keeps a third from appearing. `getAttributeNamesAcrossSchemas` and the union inheritance walk now route through it too, so it is the one code path rather than a copy that can drift.

### Patch Changes

- Updated dependencies [[`59792cc`](https://github.com/LTplus-AG/ifc-lite/commit/59792cc7d15bba68708a88475861f499f7b15647), [`40e9c59`](https://github.com/LTplus-AG/ifc-lite/commit/40e9c5931fab27b0de05655e08804562dd794389), [`af869bd`](https://github.com/LTplus-AG/ifc-lite/commit/af869bd6c8133d8d13c9d62edecf04c37baa0245), [`e4782e8`](https://github.com/LTplus-AG/ifc-lite/commit/e4782e8362c0899d0df1070d5eafb70ef18481b6), [`e4d2db5`](https://github.com/LTplus-AG/ifc-lite/commit/e4d2db5f11798e3ec78f45249139d69aa1e65275), [`c868444`](https://github.com/LTplus-AG/ifc-lite/commit/c868444e94348a34cbea2b130968a6c7affc474e), [`8967a03`](https://github.com/LTplus-AG/ifc-lite/commit/8967a033704a7edbb03140291df7a8536d3dd892)]:
  - @ifc-lite/wasm@4.3.0
  - @ifc-lite/data@3.2.0

## 3.12.0

### Minor Changes

- [#1968](https://github.com/LTplus-AG/ifc-lite/pull/1968) [`0571583`](https://github.com/LTplus-AG/ifc-lite/commit/05715834ce94a1f8e5dc20d6a60b7468190c2e88) Thanks [@louistrue](https://github.com/louistrue)! - Fix type-inherited properties disappearing when the occurrence carries a property set of the same name ([#1913](https://github.com/LTplus-AG/ifc-lite/issues/1913)).

  IFC inherits type properties **per property**, not per property set. An occurrence and its `IfcTypeProduct` routinely both carry a set of the same name holding different properties — `Pset_CoveringCommon` with `IsExternal`/`Reference` on an `IfcCovering` and `SurfaceSpreadOfFlame`/`Combustible`/`ThermalTransmittance` on its `IfcCoveringType` is a plain Revit export. Both the IDS bridge and the viewer's Lens adapter treated a name collision as "occurrence replaces type" and dropped the entire inherited set, making every type-only property in it invisible.

  For IDS that meant a property that is present, and that other tools resolve, was reported missing: `Property "SurfaceSpreadOfFlame" not found in "Pset_CoveringCommon". Available: Pset_CoveringCommon.IsExternal, Pset_CoveringCommon.Reference`. For Lens it silently removed those properties from grouping and filtering.

  `@ifc-lite/parser` gains `mergeInheritedPropertySets(ownSets, inheritedSets)`, which unions the two per property with the occurrence winning on a property-name collision (the more specific definition), matching `IfcRelDefinesByType` semantics. Both consumers now use it, so the rule has one home rather than two divergent copies. Neither input is mutated — cached extractor results stay intact.

  Only the collision case changes. A type set whose name the occurrence does not use was already appended and still is; a property defined on both sides still resolves to the occurrence's value; a property on neither side is still absent.

### Patch Changes

- Updated dependencies [[`8793ffd`](https://github.com/LTplus-AG/ifc-lite/commit/8793ffd4948840fbd96bf745d8e9db71e139d350)]:
  - @ifc-lite/wasm@4.2.2

## 3.11.0

### Minor Changes

- [#1844](https://github.com/LTplus-AG/ifc-lite/pull/1844) [`6869d5c`](https://github.com/LTplus-AG/ifc-lite/commit/6869d5ced2d19ac4ab8b2591847f3ffd52236d14) Thanks [@louistrue](https://github.com/louistrue)! - Serialize whole numbers on REAL-typed STEP attributes with a decimal point.
  `setPositionalAttribute`, `addEntity`, and the in-store builders' own emitted
  geometry now consult the schema registry, so an integral value in a REAL-backed
  slot (`IfcLengthMeasure` coordinates, profile dimensions, extrusion depth, …)
  exports as `450.` rather than a bare `450` INTEGER literal that strict
  validators (`ifcopenshell.validate`) reject. Integer-typed slots are left
  untouched; the `{ real }` marker still works for genuinely ambiguous selects.
  Positional names resolve across the schema union so IFC4X3-only alignment/civil
  entities are covered too. Exposes `getAttributeNamesAcrossSchemas` from
  `@ifc-lite/parser`.

### Patch Changes

- [#1851](https://github.com/LTplus-AG/ifc-lite/pull/1851) [`6842c56`](https://github.com/LTplus-AG/ifc-lite/commit/6842c56c72065fd9f43ac282cacb766b7808c282) Thanks [@louistrue](https://github.com/louistrue)! - Parser worker: skip the ~3.9 MB WASM scanner compile on the streaming cold-load
  path where it is never used. When the host promises an entity-index handoff
  (`waitForEntityIndex`, gated on files ≥2 MB), the geometry pre-pass builds the
  index and the entity scanner resolves from it, short-circuiting before the WASM
  scan ever runs — so eager-compiling the engine binary there only stole a core
  from the concurrent pre-pass. The compile is now deferred: eager on the
  no-handoff path, and lazy on the fallback branch if the promised index never
  arrives. Behaviour is unchanged (a new test pins that a pre-scanned index
  resolves with no `wasmApi`).

- [#1857](https://github.com/LTplus-AG/ifc-lite/pull/1857) [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f) Thanks [@louistrue](https://github.com/louistrue)! - Route `getStoreyByElevation` through the shared `findStoreyByElevation` resolver from `@ifc-lite/data` (issue [#1841](https://github.com/LTplus-AG/ifc-lite/issues/1841)).

  Both packages previously shipped their own always-snap-to-nearest implementations: the worker-transport rehydration in `@ifc-lite/parser` (`data-store-transport.ts`) and the IFCX hierarchy builder (`hierarchy-builder.ts`). Both now apply the same 1m tolerance and deterministic tie-break as the fresh-parse path, so a Z resolves to the same storey regardless of entry path or which side of the worker boundary the store was read from.

- [#1921](https://github.com/LTplus-AG/ifc-lite/pull/1921) [`428c5ae`](https://github.com/LTplus-AG/ifc-lite/commit/428c5ae54bac236a3950f451ee12a0dc23226336) Thanks [@louistrue](https://github.com/louistrue)! - The WASM engine binary (`ifc-lite_bg.wasm`) is now downloaded resiliently and identifiably from every entry point.

  `IfcLiteBridge.init()` — the main-thread initialisation, and the only self-fetching `init()` in the codebase that still lacked one — now runs through `initWasmWithRetry`, the same one-shot retry both the geometry and parser workers have used since [#1363](https://github.com/LTplus-AG/ifc-lite/issues/1363). A single blip on the ~1.3 MB engine download no longer fails the whole model load; a first-time visitor pulling the binary cold is the case this protects.

  `initWasmWithRetry` also names the binary when the final failure names nothing. A network-level rejection propagates raw out of wasm-bindgen's loader — WebKit words it `TypeError: Load failed`, Chromium `TypeError: Failed to fetch` — with an empty stack, so neither the user-facing message nor error tracking could tell what had failed to load. Such a failure is now rethrown as `Failed to load the WASM engine binary (ifc-lite_bg.wasm) in <label>: <original>`, with the original preserved as `.cause`. Messages that already identify themselves (any `wasm` / `WebAssembly` phrasing, and failed module imports) are passed through byte-for-byte so the stale-deployment matchers keep working.

  No public API surface changed.

- Updated dependencies [[`0cfb88b`](https://github.com/LTplus-AG/ifc-lite/commit/0cfb88b3ac3e5615c7e125c5076ea75cf2039a09), [`382fa7c`](https://github.com/LTplus-AG/ifc-lite/commit/382fa7cf97c04bad07963e25052cbaeb6c2ba7e3), [`6792dd1`](https://github.com/LTplus-AG/ifc-lite/commit/6792dd11ad7049acb7329221ea8809d6333aefb7), [`35c157d`](https://github.com/LTplus-AG/ifc-lite/commit/35c157d9a0513f368e83c4884465b5ad162c6ba0), [`401ab18`](https://github.com/LTplus-AG/ifc-lite/commit/401ab1842662c4e8ca26eae01b879f0290962b6d), [`8799484`](https://github.com/LTplus-AG/ifc-lite/commit/87994844a5edb66404fa12b0719c89f5ec026c4d), [`22bffac`](https://github.com/LTplus-AG/ifc-lite/commit/22bffac737efa9bdd6ca583518f637593cb4d4bc), [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f), [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f), [`b716fd7`](https://github.com/LTplus-AG/ifc-lite/commit/b716fd7b045c918dc1bd2ecc1da6fed21e59f110)]:
  - @ifc-lite/wasm@4.2.0
  - @ifc-lite/encoding@1.15.0
  - @ifc-lite/data@3.0.0
  - @ifc-lite/ifcx@2.3.2

## 3.10.1

### Patch Changes

- [#1800](https://github.com/LTplus-AG/ifc-lite/pull/1800) [`3441fb9`](https://github.com/LTplus-AG/ifc-lite/commit/3441fb9e902daea8ed7d6f1a692e75618bbecb7e) Thanks [@louistrue](https://github.com/louistrue)! - Preserve the STEP token kind (Enum vs quoted String) through the columnar parser ([#1799](https://github.com/LTplus-AG/ifc-lite/issues/1799)). `EntityExtractor` now records which top-level attributes were bare enumeration tokens (`.USERDEFINED.`) in a new optional `IfcEntity.enumAttrIndices` side channel — the value representation is unchanged (enums are still stored as dotted strings), so existing consumers are unaffected. `extractRootAttributesFromEntity` rejects enum tokens on the unknown-type fixed-index fallback by token KIND instead of the [#1779](https://github.com/LTplus-AG/ifc-lite/issues/1779) dotted-string shape heuristic: a quoted string that merely looks like an enum (`'.USERDEFINED.'`) now survives, exactly matching the Rust server path's `AttributeValue::String` / `AttributeValue::Enum` split, while a bare `PredefinedType` enum landing on a fallback slot (e.g. IFC4X3 `IfcAlignment` attr 7) is still blanked.

- Updated dependencies [[`3441fb9`](https://github.com/LTplus-AG/ifc-lite/commit/3441fb9e902daea8ed7d6f1a692e75618bbecb7e), [`eb414a4`](https://github.com/LTplus-AG/ifc-lite/commit/eb414a4aa62f81434911df41a7b1d6ccf6f054c3)]:
  - @ifc-lite/data@2.8.0
  - @ifc-lite/wasm@4.1.1

## 3.10.0

### Minor Changes

- [#1793](https://github.com/LTplus-AG/ifc-lite/pull/1793) [`502c61b`](https://github.com/LTplus-AG/ifc-lite/commit/502c61bc7c0ae1ac313ed93ab335fdd942471c72) Thanks [@louistrue](https://github.com/louistrue)! - Render IFC4 `IfcImageTexture` surface textures from `.ifcZIP` containers ([#1781](https://github.com/LTplus-AG/ifc-lite/issues/1781)).

  - parser: new `unwrapIfcZipWithResources` surfaces sibling raster images (the files `IfcImageTexture.URLReference` points at) alongside the model entry, keyed by lowercased basename; `unwrapIfcZip` is unchanged.
  - geometry/wasm: `IfcImageTexture` now resolves to a lightweight reference (`textureId` = the `IfcSurfaceTexture` express id, URL, repeat flags) instead of being dropped — the host decodes the image once per id, so a 4096² JPEG shared by dozens of face sets is decoded and uploaded exactly once. `IfcIndexedTriangleTextureMap` with a null `TexCoordIndex` (the SketchUp IFC Manager export shape) now maps UVs 1:1 with the face set's coordinates per spec. Textured face sets on ORDINARY occurrences (direct `Body` items, not just type-product representation maps) now carry UVs + texture through the sub-mesh path, and blob/pixel texture decodes are Arc-shared instead of cloned per face set.
  - renderer: textured meshes with an external image reference render through the existing WebGPU textured pipeline via a refcounted shared-texture registry (one GPU texture per `textureId`, uploaded from the viewer-decoded `ImageBitmap`); per-mesh [#961](https://github.com/LTplus-AG/ifc-lite/issues/961) blob/pixel uploads are unchanged.
  - viewer: `.ifcZIP` loads decode sibling images with `createImageBitmap` and attach them to arriving meshes; textured models skip the binary geometry cache (which cannot persist textures yet) instead of silently losing textures on the second open.

- [#1762](https://github.com/LTplus-AG/ifc-lite/pull/1762) [`05c8bdf`](https://github.com/LTplus-AG/ifc-lite/commit/05c8bdf348c5afae8978293cd324d45104e24940) Thanks [@louistrue](https://github.com/louistrue)! - Material association hardening (follow-up to [#1755](https://github.com/LTplus-AG/ifc-lite/issues/1755)):

  - **Multiple `IfcRelAssociatesMaterial` per element** are no longer lost. New `resolveAllMaterialDefIds` / `extractAllMaterialsOnDemand` surface every association (relationship-graph backed, ordered by rel express id). The single-entry `onDemandMaterialMap` "primary" is now deterministic — the association with the LOWEST rel express id wins — and the viewer cache rebuild applies the same rule, so a cache load can no longer disagree with a fresh parse. Models where the old last-wins rule picked a later association may report a different primary material in single-value surfaces (MCP/CLI/SDK).
  - `buildMaterialUsageIndex` lists elements under EVERY associated material, so the By Material tab and per-material totals include secondary associations.
  - `extractMaterialPropertiesOnDemand` aggregates `Pset_Material*` across all associations instead of only the primary.
  - **IDS**: material facets now check every association — a requirement satisfied only by an element's second association no longer false-fails.
  - **Constituent-set fractions**: constituents without an authored `Fraction` receive an equal share of the unallocated remainder instead of weight 0, so they contribute to per-material quantity totals.

### Patch Changes

- [#1797](https://github.com/LTplus-AG/ifc-lite/pull/1797) [`6102a22`](https://github.com/LTplus-AG/ifc-lite/commit/6102a222a6a71afcdab89855f1dcfa9437d3994f) Thanks [@louistrue](https://github.com/louistrue)! - Fix `extractRootAttributesFromEntity` leaking STEP bare-enum tokens into string display attributes for types the schema registry doesn't recognise ([#1779](https://github.com/LTplus-AG/ifc-lite/issues/1779)). On the unknown-type fixed-index fallback, a PredefinedType enum landing on attribute 7 (e.g. IFC4X3 `IfcAlignment`) is stored by the extractor as a dotted string (`.USERDEFINED.`) and used to surface as the element's `Tag`. It's now rejected (rendered blank), mirroring the Rust server path — so the `Tag`, `Description`, and `ObjectType` list columns match across parse paths. Known types are unaffected (their schema indices point at genuine string slots).

- Updated dependencies [[`2a7c7ff`](https://github.com/LTplus-AG/ifc-lite/commit/2a7c7ffe0ac27a8cc315e5d4a633c56469646cf0), [`502c61b`](https://github.com/LTplus-AG/ifc-lite/commit/502c61bc7c0ae1ac313ed93ab335fdd942471c72), [`7194c95`](https://github.com/LTplus-AG/ifc-lite/commit/7194c95002f2c84cd3c9444d710a50190a976a90)]:
  - @ifc-lite/wasm@4.1.0
  - @ifc-lite/data@2.7.0
  - @ifc-lite/ifcx@2.3.1

## 3.9.1

### Patch Changes

- [#1757](https://github.com/LTplus-AG/ifc-lite/pull/1757) [`7ef3622`](https://github.com/LTplus-AG/ifc-lite/commit/7ef36225d863ec64dfb254cf0767d4ab9d034849) Thanks [@louistrue](https://github.com/louistrue)! - Fix By Material tab / material totals missing materials associated to TYPE entities ([#1755](https://github.com/LTplus-AG/ifc-lite/issues/1755)). `buildMaterialUsageIndex` now expands `IfcRelAssociatesMaterial` targets that are type entities (e.g. `IfcDoorType`) to their occurrences via forward `IfcRelDefinesByType` edges, with occurrence-level associations taking precedence (IFC semantics) and no double counting. Previously the usage index keyed such materials to the type entity itself, which the viewer's By Material tree dropped via its geometry filter and the totals panel mis-attributed.

- [#1772](https://github.com/LTplus-AG/ifc-lite/pull/1772) [`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7) Thanks [@louistrue](https://github.com/louistrue)! - Fix deterministic GlobalId first character and STEP header escape round-trip.

  `deterministicGlobalId` masked its first output character with the full 6-bit alphabet, but a valid 22-char IFC GlobalId encodes only 2 bits in its first character (128 = 2 + 21\*6). The id is now stamped from the hash's 128-bit state MSB-first exactly like `uuidToIfcGuid`'s compression, so it always decodes to a well-formed 128-bit UUID and re-encodes bit-exactly. This also fixes a severe entropy loss in the previous stamping: it read each state word's LOW 6 bits while evolving it with a 32-bit multiply (which never propagates high bits downward), leaving ~24 bits of effective entropy and real collisions at ~10k seeds; the full-state stamping is collision-free across 100k adversarial seeds.

  Header string round-trip no longer corrupts ISO-10303-21 escapes: `parseSourceHeader` now decodes `\X2\`, `\X\`, `\S\` and `\Px\` directives to real Unicode (via the canonical `decodeIfcString`) instead of leaving them for the writer's backslash-doubling escaper to mangle (`Tr\X2\00FC\X0\mpler` no longer becomes `Tr\\X2\\00FC\\X0\\mpler`), and collapses the `\\` escape to a single literal backslash first, so `C:\temp` is byte-stable across repeated write/read cycles instead of growing backslashes. The shared STEP string escaper (data) also collapses control characters to a space so a header/attribute value can never inject a physical line break.

- [#1773](https://github.com/LTplus-AG/ifc-lite/pull/1773) [`0d400ed`](https://github.com/LTplus-AG/ifc-lite/commit/0d400edd61a71108c2affd0923fb561affbfe9fe) Thanks [@louistrue](https://github.com/louistrue)! - Harden IFC string decoding, material-usage resolution, the worker scanner, and the binary cache.

  - encoding: `decodeIfcString` no longer throws a `RangeError` on a `\X4\` sequence whose 8-hex value exceeds the Unicode maximum (`0x10FFFF`); it now emits U+FFFD instead. The previous throw propagated uncaught through the columnar batch-name path and aborted the entire model load. Surrogate values in `\X4\` and lone surrogates in `\X2\` also decode to U+FFFD now (surrogate pairs split across `\X2\` groups still combine), matching the Rust decoder (`char::from_u32` / `String::from_utf16_lossy`) so both parse paths yield identical strings.
  - parser: `onDemandMaterialMap` is now list-valued, so a second `IfcRelAssociatesMaterial` targeting the same element is preserved instead of last-wins overwritten. `buildMaterialUsageIndex` gains a relationship-graph fallback for server-loaded stores: it works on the real server store shape (empty `source` buffer, facade relationship graph with closure-only accessors), with `collectMaterialLeaves` surfacing each definition as one opaque full-weight leaf when no source is available. An empty index built from a store with no material inputs at all is no longer memoised (so a later-populated store can rebuild). `IfcMaterialConstituent` weights now always sum to 1: siblings without an explicit `Fraction` share the remainder instead of collapsing to weight 0, sets where explicit fractions already fill the whole are renormalised (`{1.0, unset}` -> 2/3, 1/3 rather than 1.5x totals), and non-finite or non-positive fractions/layer thicknesses are treated as unset.
  - parser: the inline worker scanner's type-name cache now byte-verifies on a hit (matching `tokenizer.ts`), so a 32-bit hash collision can no longer alias two distinct type names on the default scan path.
  - parser: batch GlobalId+Name extraction now collapses STEP doubled single-quotes (`''` -> `'`), matching `EntityExtractor`, so names like `John''s Wall` render correctly.
  - cache: the writer no longer sets the dead `HasSpatial` header flag (no Spatial section is written or read), and the string-table read path preserves positions via `StringTable.fromArray` instead of re-interning (which deduped, shifting later indices when a duplicate was present). On-disk format is unchanged.

- Updated dependencies [[`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7), [`0d400ed`](https://github.com/LTplus-AG/ifc-lite/commit/0d400edd61a71108c2affd0923fb561affbfe9fe), [`2d2a2fb`](https://github.com/LTplus-AG/ifc-lite/commit/2d2a2fb672bba182bc57e3f59c2da4909583fa49), [`564a800`](https://github.com/LTplus-AG/ifc-lite/commit/564a800e997322d863aac84127497ef4f8310ac3), [`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7), [`2cd5f43`](https://github.com/LTplus-AG/ifc-lite/commit/2cd5f439d202894fde34961cc4b3bfbe9ad2d140)]:
  - @ifc-lite/data@2.6.0
  - @ifc-lite/encoding@1.14.11
  - @ifc-lite/wasm@4.0.1

## 3.9.0

### Minor Changes

- [#1748](https://github.com/LTplus-AG/ifc-lite/pull/1748) [`ae6079f`](https://github.com/LTplus-AG/ifc-lite/commit/ae6079f0d2d8a3dbc923dfd468817c7f3e2f9b4a) Thanks [@louistrue](https://github.com/louistrue)! - Lists/Schedules now resolve Type-level properties and quantities on instance rows ([#1745](https://github.com/LTplus-AG/ifc-lite/issues/1745)). A column mapped to a pset/qto that lives on an element's `IfcTypeProduct` (via `IfcRelDefinesByType`) — e.g. `Pset_WallCommon.FireRating` or `Qto_WallBaseQuantities.Width` defined once on `IfcWallType` — now falls back to the type when the instance has no local value, so it no longer renders a blank cell. Instance-level values still take precedence, and the same fallback applies to list filter conditions.

  `@ifc-lite/parser` gains `extractTypeQuantitiesOnDemand` (and the `extractQsetsFromIds` helper) mirroring the existing `extractTypePropertiesOnDemand`. `@ifc-lite/lists` gains optional `getTypePropertySets` / `getTypeQuantitySets` accessors on `ListDataProvider`; providers that don't implement them keep their previous behaviour (no fallback).

## 3.8.5

### Patch Changes

- Updated dependencies [[`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`8f3fafd`](https://github.com/LTplus-AG/ifc-lite/commit/8f3fafd7cc777e60cdc006956f8336680723c440), [`a2c31a1`](https://github.com/LTplus-AG/ifc-lite/commit/a2c31a185e868d15183df8360badb001789bd978), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486)]:
  - @ifc-lite/ifcx@2.3.0
  - @ifc-lite/wasm@4.0.0

## 3.8.4

### Patch Changes

- [#1700](https://github.com/LTplus-AG/ifc-lite/pull/1700) [`422d47d`](https://github.com/LTplus-AG/ifc-lite/commit/422d47dde37c7168ce4a547fc0a4f966649c1762) Thanks [@louistrue](https://github.com/louistrue)! - Harden the immediate-Container spatial level ([#1591](https://github.com/LTplus-AG/ifc-lite/issues/1591) follow-up):

  - The spatial hierarchy now records an aggregated-descendant containment walk for ANY spatial container node, not just storeys, via a new optional `SpatialHierarchy.elementToContainer` map (also carried across data-store transport). A part nested through an IfcElementAssembly under an IfcBridgePart / IfcRoadPart / IfcSpatialZone now resolves that container instead of a blank cell. Storey-only `elementToStorey` semantics are unchanged.
  - The list engine matches the spatial level string case-insensitively, so a hand-edited / imported list carrying `container` resolves the Container level rather than silently falling back to the storey name. An empty or unrecognised level still defaults to Storey.

- Updated dependencies [[`422d47d`](https://github.com/LTplus-AG/ifc-lite/commit/422d47dde37c7168ce4a547fc0a4f966649c1762)]:
  - @ifc-lite/data@2.5.3

## 3.8.3

### Patch Changes

- [#1699](https://github.com/LTplus-AG/ifc-lite/pull/1699) [`ec53138`](https://github.com/LTplus-AG/ifc-lite/commit/ec53138f252578253b55e1caf28a23dc9cc61de9) Thanks [@louistrue](https://github.com/louistrue)! - IFC5 system membership reaches the viewer's Groups tab: the ifcx composer now
  emits AssignsToGroup relationship edges from the `bsi::ifc::system::partofsystem`
  attribute (group -> member, matching STEP direction), and the on-demand group
  member/relationship extractors fall back to the EntityTable when a store has no
  STEP byte-span index (IFCX stores ingest with an empty entityIndex.byId).
- Updated dependencies [[`c953b98`](https://github.com/LTplus-AG/ifc-lite/commit/c953b9835bdcd59398d57f800721ab8c9b09753a), [`ec53138`](https://github.com/LTplus-AG/ifc-lite/commit/ec53138f252578253b55e1caf28a23dc9cc61de9)]:
  - @ifc-lite/wasm@3.0.15
  - @ifc-lite/ifcx@2.2.3

## 3.8.2

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

- [#1680](https://github.com/LTplus-AG/ifc-lite/pull/1680) [`bc1531f`](https://github.com/LTplus-AG/ifc-lite/commit/bc1531f899e5f8d18d1a6ff1ef6d997236a01243) Thanks [@louistrue](https://github.com/louistrue)! - Harden huge-file loads against stale deployments and the wasm32 ceiling. (1) A geometry or pre-pass worker whose SCRIPT fails to load (a redeploy rotated the hashed asset; the 404 is served as text/plain and the browser blocks the worker with an empty-message onerror) now dispatches the existing version-skew recovery event so the viewer reloads once onto the current deployment, instead of dying with "Pre-pass worker failed: undefined". (2) The parser skips the byte-level WASM entity scan for sources over 2.5GB: the buffer copy plus entity index cannot fit in wasm32's 4GB address space, so the scan always trapped with `unreachable executed` before the JS tokeniser fallback ran anyway.

- Updated dependencies [[`41794cd`](https://github.com/LTplus-AG/ifc-lite/commit/41794cde27d31904773bf2042eb0a0331aadf770), [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a), [`d0647c9`](https://github.com/LTplus-AG/ifc-lite/commit/d0647c9a1801fc03b7c5d32314e53ef922c56f2f), [`633882f`](https://github.com/LTplus-AG/ifc-lite/commit/633882fa15940f5faddb9dcb32031fcf3f38e287), [`40ac0a8`](https://github.com/LTplus-AG/ifc-lite/commit/40ac0a85d5aaac1b6fed9ad96b3e2f9d0378d65b), [`47bf759`](https://github.com/LTplus-AG/ifc-lite/commit/47bf759b1b801d44f6a0ba7408f65d368096cb04)]:
  - @ifc-lite/wasm@3.0.14
  - @ifc-lite/data@2.5.2
  - @ifc-lite/encoding@1.14.10
  - @ifc-lite/ifcx@2.2.2

## 3.8.1

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

- Updated dependencies [[`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39), [`84cd5aa`](https://github.com/LTplus-AG/ifc-lite/commit/84cd5aa3b59bfb5cb5599423f22406f56f3c0e6c), [`2c52076`](https://github.com/LTplus-AG/ifc-lite/commit/2c5207631c3dbc164ffde0147a3cd71104006d36), [`a90182b`](https://github.com/LTplus-AG/ifc-lite/commit/a90182bac110fdd4c15b8b51866e31deefc0378e)]:
  - @ifc-lite/data@2.5.1
  - @ifc-lite/encoding@1.14.9
  - @ifc-lite/ifcx@2.2.1
  - @ifc-lite/wasm@3.0.13

## 3.8.0

### Minor Changes

- [#1642](https://github.com/LTplus-AG/ifc-lite/pull/1642) [`d758460`](https://github.com/LTplus-AG/ifc-lite/commit/d758460dce1a564286a9af5579b0a2ba72dfa81d) Thanks [@louistrue](https://github.com/louistrue)! - Carry a spatial node's IFC `LongName` through the hierarchy so the spatial structure can show both the short code and the descriptive label, e.g. "01" + "Main Residence" (issue [#1634](https://github.com/LTplus-AG/ifc-lite/issues/1634)):

  - `@ifc-lite/data`: `SpatialNode` gains an optional `longName?: string` (the descriptive name, kept only when present and distinct from `name`). Additive and optional; existing consumers are unaffected.
  - `@ifc-lite/parser`: `SpatialHierarchyBuilder` now reads `LongName` off the source record by schema attribute _name_ and populates `SpatialNode.longName`. Resolving by name (not a fixed index) keeps it correct across the IfcRoot family, since `IfcProject` carries `LongName` at a different index than the `IfcSpatialStructureElement` subtypes; the lookup spans the bundled schema union (2X3 + 4 + 4X3) via the new `getAttributeNamesAcrossSchemas`, so IFC4.3 facility/infra containers (`IfcFacility`, `IfcBridge`, `IfcRoad`, …) outside the parser's IFC4 codegen pin resolve too. When `Name` is empty it falls back to `LongName` for the primary label. The source-less `buildFromCache` path leaves it undefined, exactly like storey elevation. `data-store-transport` serializes the new field so the worker→main transfer preserves it.
  - `@ifc-lite/ifcx`: the IFCX/IFC5 hierarchy builder populates `SpatialNode.longName` from `bsi::ifc::prop::LongName` for parity.

### Patch Changes

- Updated dependencies [[`729ea8b`](https://github.com/LTplus-AG/ifc-lite/commit/729ea8b75e60677d152c07438c29ede1b2d60a9d), [`a1748d1`](https://github.com/LTplus-AG/ifc-lite/commit/a1748d120fe3d33035db268131678a3a0ef74dde), [`d758460`](https://github.com/LTplus-AG/ifc-lite/commit/d758460dce1a564286a9af5579b0a2ba72dfa81d)]:
  - @ifc-lite/wasm@3.0.10
  - @ifc-lite/data@2.5.0
  - @ifc-lite/ifcx@2.2.0

## 3.7.0

### Minor Changes

- [#1580](https://github.com/LTplus-AG/ifc-lite/pull/1580) [`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47) Thanks [@louistrue](https://github.com/louistrue)! - New `@ifc-lite/parser` exports resolve a file's declared `IfcUnitAssignment` into per-unit-type display symbols + SI scale factors, and map a property's IFC measure value type onto the unit it's shown in (issue [#1573](https://github.com/LTplus-AG/ifc-lite/issues/1573)):

  - `extractProjectUnits(source, entityIndex) -> ProjectUnits` — reads `IfcSIUnit` (with prefixes), `IfcDerivedUnit` (composed, e.g. `m³/s`), `IfcConversionBasedUnit` (°, ft, ...) and `IfcMonetaryUnit` from `IFCPROJECT.UnitsInContext`. Never throws: an absent/malformed assignment yields an empty `ProjectUnits` (every measure falls back to its SI default symbol).
  - `ProjectUnits.unitForMeasure(measureType)` / `.resolvedForUnitType(unitType)` / `.monetary()` — the per-measure and per-unit-type display resolvers.
  - `measureUnit(measureType) -> MeasureUnit | undefined` — maps an IFC measure value type name (e.g. `"IFCVOLUMETRICFLOWRATEMEASURE"`) to its unit-type token, or `{kind: 'monetary'}` / `{kind: 'dimensionless'}` for currency and unit-less measures.
  - `ResolvedUnit` (`{symbol, siScale}`) and `MeasureUnit` types.

  The viewer uses this to show property/quantity values with the file's actual declared unit instead of always assuming SI, and (issue [#1573](https://github.com/LTplus-AG/ifc-lite/issues/1573) proposal 2) to power a non-destructive per-unit-type display-unit converter. The implementation is pinned to shared parity test vectors against the Rust mirror in `rust/core/src/project_units/` (`packages/parser/src/project-units.parity.test.ts`), so the two can't drift.

### Patch Changes

- Updated dependencies [[`1d53646`](https://github.com/LTplus-AG/ifc-lite/commit/1d536460663b8ce607fb648ab2e996ac445ff651), [`fcbb667`](https://github.com/LTplus-AG/ifc-lite/commit/fcbb6679dd752f5b8be670c6a9e2d3fdc0b57e3d), [`7c65f23`](https://github.com/LTplus-AG/ifc-lite/commit/7c65f232952dcf0c1f7f6ebee3605fd556323035), [`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47)]:
  - @ifc-lite/wasm@3.0.5
  - @ifc-lite/data@2.4.0

## 3.6.0

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

- Updated dependencies [[`52dd7a1`](https://github.com/LTplus-AG/ifc-lite/commit/52dd7a16788375a9507c40fbde106b78236801db)]:
  - @ifc-lite/wasm@3.0.4

## 3.5.2

### Patch Changes

- Updated dependencies [[`8e43ecf`](https://github.com/LTplus-AG/ifc-lite/commit/8e43ecf540b88b942a4ec2127dd9bcf24ec244fa), [`796f50a`](https://github.com/LTplus-AG/ifc-lite/commit/796f50a3b0072dd2c07b60ef84e3f1d2996444e2), [`d1e16f9`](https://github.com/LTplus-AG/ifc-lite/commit/d1e16f944ea9f3a35a7153959f13db168a35c229), [`a46dcdf`](https://github.com/LTplus-AG/ifc-lite/commit/a46dcdf68d05e8cdec4199167647f2dfa3c62cb6), [`6d2cb21`](https://github.com/LTplus-AG/ifc-lite/commit/6d2cb21a170413c6c98aadf10d254667b2ed2b53), [`66f31ac`](https://github.com/LTplus-AG/ifc-lite/commit/66f31acb761209f7cf78e83ef01c02a1ec3dc13a), [`3d25765`](https://github.com/LTplus-AG/ifc-lite/commit/3d25765edc2cee40268a6d5a27d4055f88f76489), [`6a515ba`](https://github.com/LTplus-AG/ifc-lite/commit/6a515ba31bbe31bb6f018f7476cc9616e4691448), [`b66ff1d`](https://github.com/LTplus-AG/ifc-lite/commit/b66ff1dd915a0ff4f60198a511adb7ed7f714079)]:
  - @ifc-lite/wasm@3.0.0
  - @ifc-lite/ifcx@2.1.6
  - @ifc-lite/data@2.3.0
  - @ifc-lite/encoding@1.14.8

## 3.5.1

### Patch Changes

- [#1423](https://github.com/LTplus-AG/ifc-lite/pull/1423) [`d567c4e`](https://github.com/LTplus-AG/ifc-lite/commit/d567c4eb55edf7f2e68f67709c3716cda0bf5360) Thanks [@louistrue](https://github.com/louistrue)! - perf(georef): memoize `extractGeoreferencingOnDemand` per store

  On models without an `IfcMapConversion`, the on-demand georeferencing extractor
  scans and decodes every `IfcPropertySet` from the source buffer to find
  `ePset_MapConversion` / `ePset_ProjectedCRS`. On property-set-heavy models that
  is tens of thousands of entity decodes per call, and the viewer invokes it on
  the render path (once per streamed geometry batch), so the cost compounded to
  O(batches x propertySets) and could stall large-model loads by an order of
  magnitude. The result is a pure function of the immutable source + entityIndex
  (georef edits are layered on top later in `getEffectiveGeoreference`), so the
  extraction is now memoized per store via a `WeakMap`, collapsing it to a single
  scan per model. Not-yet-loaded stores (missing source/entityIndex) are not
  cached, so a store that fills in later still recomputes.

## 3.5.0

### Minor Changes

- [#1388](https://github.com/LTplus-AG/ifc-lite/pull/1388) [`8a4ce69`](https://github.com/LTplus-AG/ifc-lite/commit/8a4ce694ea1d8c1b0f25310f8a1addb3ff649f14) Thanks [@mehmet-ylcnky](https://github.com/mehmet-ylcnky)! - Re-export EntityTable and SpatialHierarchy types from @ifc-lite/data, allowing consumers to import store types directly from @ifc-lite/parser.

## 3.4.1

### Patch Changes

- [#1404](https://github.com/LTplus-AG/ifc-lite/pull/1404) [`f746659`](https://github.com/LTplus-AG/ifc-lite/commit/f746659ada2c918d88ea8458240e5d91b3f348f4) Thanks [@louistrue](https://github.com/louistrue)! - Fix IFC2X3 `ePset_MapConversion` / `ePset_ProjectedCRS` georeferencing so the authored EPSG code is read (not a fallback `EPSG:4326`), and route those models into the Cesium / federation pipeline.

  IFC2X3 has no native `IfcMapConversion`/`IfcProjectedCRS`, so tools like `ifc-georeferencer` store georeferencing in property sets per the buildingSMART guide. Three bugs dropped these models to the legacy `IfcSite` lat/long (`EPSG:4326`), so two files differing only by CRS (`EPSG:7415` RD+NAP vs `EPSG:28992` RD) both displayed the same wrong CRS:

  - The pset-name match was case-sensitive (`ePSet_`/`EPset_`) and missed the real-world `ePset_` casing — now matched case-insensitively in both the TS (`extractGeoreferencing`) and Rust (`GeoRefExtractor`) extractors.
  - The ePSet path never read `ePset_ProjectedCRS.Name` (nor `MapConversion.TargetCRS`), so the EPSG code was discarded — now surfaced, with typed `IFCLABEL(...)`/`IFCLENGTHMEASURE(...)` values unwrapped.
  - The viewer's on-demand extractor never loaded the property sets at all — now pulls in the georef ePSets + their values (only when no `IfcMapConversion` exists, deferred-atom safe).

  The viewer's Cesium/federation gate accepts the `ePSetMapConversion` source, and ePSet offsets are scaled by the project length unit (millimetres for these files) so the model reprojects to the correct location instead of ~1000× out of range. The offline reproject fallback for the compound `EPSG:7415` (datum reported as `RD`) now carries the Kadaster `+towgs84` shift.

- Updated dependencies [[`f746659`](https://github.com/LTplus-AG/ifc-lite/commit/f746659ada2c918d88ea8458240e5d91b3f348f4)]:
  - @ifc-lite/wasm@2.13.4

## 3.4.0

### Minor Changes

- [#1347](https://github.com/LTplus-AG/ifc-lite/pull/1347) [`297ae7b`](https://github.com/LTplus-AG/ifc-lite/commit/297ae7bc232519fe06a25d6ea20f39290e8a7ed2) Thanks [@louistrue](https://github.com/louistrue)! - `SpatialHierarchyBuilder` is now the single source for spatial-hierarchy construction. Added `buildFromCache(entities, relationships)` for cache restores (no source buffer, so storey elevations stay empty and `getStoreyByElevation` returns null), alongside the existing `build(...)` for fresh parses. Both entry points share one `buildNode`, so they can no longer drift: the fresh path now also applies the aggregate-descendant storey mapping (an `IfcBuildingElementPart` under an `IfcWall` resolves to that wall's storey), and the cache path now also has the cyclic-`IfcRelAggregates` guard. The viewer's duplicate `rebuildSpatialHierarchy` becomes a thin wrapper over `buildFromCache`.

### Patch Changes

- Updated dependencies [[`c7c58c0`](https://github.com/LTplus-AG/ifc-lite/commit/c7c58c09e40fe40be5cc14cadf95beac18130ea5), [`18187fa`](https://github.com/LTplus-AG/ifc-lite/commit/18187facd6fa6fec15a23ef5e3263353730c5d8b)]:
  - @ifc-lite/wasm@2.13.2

## 3.3.2

### Patch Changes

- [#1291](https://github.com/LTplus-AG/ifc-lite/pull/1291) [`39400ee`](https://github.com/LTplus-AG/ifc-lite/commit/39400ee5bb48c1554656e1ac7aaf8a06ba2274cf) Thanks [@louistrue](https://github.com/louistrue)! - Fix Exploded level-display mode leaving geometry behind ([#1289](https://github.com/LTplus-AG/ifc-lite/issues/1289)).

  Two independent defects made Exploded mode look broken:

  - GPU-instanced occurrences (repeated geometry emitted via `IfcMappedItem`, e.g.
    windows / mullions) were never lifted with their storey, because the per-entity
    translate only touched the flat `meshDataMap` and not the instanced shard. They
    stayed at their native elevation while the rest of the storey rose ("objects
    left behind"). `Scene.translateInstancedEntity` now shifts each occurrence's
    transform in both the CPU instance record and the GPU buffer, plus its cached
    world AABB, so pick / measure / section / export stay correct. This also fixes
    moving an instanced element with the gizmo.

  - A storey whose `Elevation` attribute is null (common in Revit / ArchiCAD
    exports) was dropped from the elevation map, so Exploded mode had a single
    floor to order ("only one floor"). The spatial-hierarchy builder now falls back
    to the storey's `ObjectPlacement` Z when the attribute is missing.

- Updated dependencies [[`df607ef`](https://github.com/LTplus-AG/ifc-lite/commit/df607effd3a4cf2e0fb2898e14cb385df6d8e8d0)]:
  - @ifc-lite/wasm@2.11.1

## 3.3.1

### Patch Changes

- [#1190](https://github.com/LTplus-AG/ifc-lite/pull/1190) [`d5aa38d`](https://github.com/LTplus-AG/ifc-lite/commit/d5aa38db57e90ecd69512cfad426a902a0eccebf) Thanks [@louistrue](https://github.com/louistrue)! - Recover from transient WASM engine-load failures and humanise the error.

  When the `ifc-lite_bg.wasm` binary fails to download (non-OK HTTP status, a cold
  CDN edge, a mid-deploy race, or a blocking proxy/antivirus), wasm-bindgen's
  streaming loader rethrows a cryptic `Failed to execute 'compile' on
'WebAssembly': HTTP status code is not ok`. The geometry and parser workers now
  retry `init()` once on such fetch/HTTP-shaped failures, and the viewer maps the
  failure to actionable guidance ("reload the page") instead of surfacing the raw
  TypeError. Captured exceptions are tagged with a stable `error_kind` for triage.

## 3.3.0

### Minor Changes

- [#1143](https://github.com/LTplus-AG/ifc-lite/pull/1143) [`248f2c0`](https://github.com/LTplus-AG/ifc-lite/commit/248f2c09a4d61fa27dfeaba5511a2a641d4cd278) Thanks [@louistrue](https://github.com/louistrue)! - Preserve source IFC HEADER fields on round-trip export. Re-exporting an
  imported file previously regenerated a fresh ifc-lite header, silently dropping
  the source `FILE_DESCRIPTION` items (any `ViewDefinition [...]` label and vendor
  identifier / coordinate-reference strings) and flattening the exact
  `FILE_SCHEMA` token (e.g. `IFC4X3_ADD2` → `IFC4X3`, which some toolchains
  reject).

  The parser now captures the verbatim HEADER onto a new
  `IfcDataStore.sourceHeader` (`IfcSourceHeader`, exported from `@ifc-lite/data`;
  parser also exports `parseSourceHeader`), threaded through the worker transport.
  `StepExporter` reproduces the source `FILE_DESCRIPTION` items and the exact
  `FILE_SCHEMA` token when not converting schemas, falling back to parsing the
  source bytes for cache-restored stores. Provenance stays honest:
  `preprocessor_version` is set to `ifc-lite` while the source authoring tool is
  kept as `originating_system`, and when mutations exist exactly one
  `Re-exported by ifc-lite, N modification(s)` item is appended without removing
  the source items. `generateHeader` now accepts description/author/organization
  arrays plus a free-form schema token and STEP-escapes all fields; it also emits
  a properly parenthesised `FILE_DESCRIPTION` list (the prior single-string form
  was malformed STEP). Created-from-scratch (`IfcCreator`) and federated/merged
  exports are unaffected — they keep their own provenance headers by design.

### Patch Changes

- [#1151](https://github.com/LTplus-AG/ifc-lite/pull/1151) [`bfd9004`](https://github.com/LTplus-AG/ifc-lite/commit/bfd9004daa17f481a7b33b5c3c11f620e6cd894d) Thanks [@louistrue](https://github.com/louistrue)! - De-duplicate the STEP serializer into a single source of truth. The
  schema-agnostic STEP serialization logic (`serializeValue`, `generateHeader`,
  `parseStepValue`, `ref`/`enumVal`/`isEntityRef`/`isEnumValue`, and the
  registry-injected `toStepLineWithRegistry` / `generateStepFileWithRegistry`)
  previously existed as four hand-synced copies — the codegen template plus three
  generated `serializers.ts` files — which had already silently drifted (the
  runtime copy carried a `?? []` hardening the template lacked). It now lives once
  in `@ifc-lite/data`; the per-schema bundles (parser runtime + codegen outputs)
  are thin re-exports that only bind their own `SCHEMA_REGISTRY` to the
  registry-coupled helpers, so the copies can never diverge again. A codegen test
  asserts the generated bundle stays a thin re-export rather than re-inlining
  logic.

  Also fixes the broken `generate:ifc4` script (it pointed at a non-existent
  `schemas/IFC4.exp`; the real file is `schemas/IFC4_ADD2_TC1.exp`). No public
  behaviour change: `@ifc-lite/parser` re-exports the same serializer symbols as
  before; `@ifc-lite/data` gains the shared primitives; `@ifc-lite/codegen` now
  declares `@ifc-lite/data` as a dependency since the generated bundle imports it.

- [#1145](https://github.com/LTplus-AG/ifc-lite/pull/1145) [`ddae2b0`](https://github.com/LTplus-AG/ifc-lite/commit/ddae2b0024f071d00f9e6e4b77e0be3965412ec3) Thanks [@louistrue](https://github.com/louistrue)! - Resolve names for IfcGroup-family entities and make zones/systems listable ([#1075](https://github.com/LTplus-AG/ifc-lite/issues/1075) follow-up).

  `IfcZone`, `IfcGroup`, `IfcSystem` and `IfcDistributionSystem` are not `IfcProduct` subtypes, so the columnar parser categorised them as `CAT_SKIP` and never added them to the `EntityTable`. As a result `getName()` returned `''` (the UI showed "Group #<id>"), `getByType()` could not find them (so they were absent from lists), and the "By Zone" lens fell back to an arbitrary first group because `getTypeName()` returned `Unknown`. `IfcSpatialZone` was in the table but its `Name` was never extracted.

  This routes the group family into the `EntityTable` with `Name` (falling back to `LongName` for systems/zones that leave `Name` empty) plus `Description` and `ObjectType` (the system designation), and extracts names for the previously-unnamed "other relevant" products (including `IfcSpatialZone`). New `IfcSystem` / `IfcDistributionSystem` `IfcTypeEnum` entries make systems addressable by `getByType`. Zones, spatial zones and systems are now selectable in the list builder and ship a "Zones & Systems" preset, the relationship card and "By Zone" lens legend show real names (with an `ObjectType` fallback for unnamed systems), and selecting a group surfaces its attributes.

  The cache `FORMAT_VERSION` is bumped (6 → 7) so models cached before the fix re-parse and pick up the resolved names.

- Updated dependencies [[`bfd9004`](https://github.com/LTplus-AG/ifc-lite/commit/bfd9004daa17f481a7b33b5c3c11f620e6cd894d), [`248f2c0`](https://github.com/LTplus-AG/ifc-lite/commit/248f2c09a4d61fa27dfeaba5511a2a641d4cd278), [`ddae2b0`](https://github.com/LTplus-AG/ifc-lite/commit/ddae2b0024f071d00f9e6e4b77e0be3965412ec3)]:
  - @ifc-lite/data@2.1.0

## 3.2.0

### Minor Changes

- [#1071](https://github.com/LTplus-AG/ifc-lite/pull/1071) [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe) Thanks [@louistrue](https://github.com/louistrue)! - Georeferencing TS↔Rust parity (alignment audit phase 1):

  - `@ifc-lite/parser`: `extractGeoreferencing` gains the IFC2x3 `ePSet_MapConversion` fallback with the same precedence as the Rust extractor (`IfcMapConversion` → ePSet → legacy `IfcSite` lat/long); `GeoreferenceInfo.source` union widens to include `'ePSetMapConversion'`.
  - `@ifc-lite/server-client`: `Georeferencing` gains optional `crs_description`, `map_zone`, `map_unit`, `map_unit_scale`, and `source` fields — the server now reports MapUnit-scaled conversions (e.g. 0.001 for millimetre-based files), picks the FIRST authored `IfcMapConversion` like the browser parser, normalises non-unit X-axis directions so `transform_matrix` agrees with `rotation_degrees`, and recognises site-only models via the `IfcSite.RefLatitude/RefLongitude` fallback.

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

### Patch Changes

- [#1071](https://github.com/LTplus-AG/ifc-lite/pull/1071) [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe) Thanks [@louistrue](https://github.com/louistrue)! - Client/server alignment fixes:

  - `@ifc-lite/create`: `IfcCreator` now generates spec-valid 128-bit GlobalIds via the canonical `@ifc-lite/encoding` encoder (previously ~94% of generated ids failed `isValidIfcGuid` and silently changed identity on guid→uuid→guid round-trips, e.g. in BCF).
  - `@ifc-lite/export`: schema-downgrade `IFCPROXY` placeholders now carry spec-valid GlobalIds instead of synthetic `PROXY_…` markers.
  - `@ifc-lite/parser`: `extractLengthUnitScale` now mirrors the canonical Rust extractor when an `IfcMeasureWithUnit` ValueComponent is unreadable — defaults the value to 1.0 and still applies the UnitComponent SI-prefix instead of falling through to metres (property scaling can no longer desync from geometry scaling).
  - `@ifc-lite/geometry`: removed the dead legacy worker protocol (`process`/`prepass`/`prepass-fast` messages) — the streaming protocol (`stream-start`/`stream-chunk`/`stream-end` + `prepass-streaming`) is the only path; the wasm `buildPrePassFast` export is gone. Streaming pre-pass loads now apply aggregate void propagation (window/door cuts on aggregated parts) in parity with one-shot loads and the server.
  - `@ifc-lite/server-client`: `ProcessingStats` gains optional `total_csg_failures` / `products_with_failures` fields — the server now reports the same CSG failure diagnostics the browser console shows.

- [#1071](https://github.com/LTplus-AG/ifc-lite/pull/1071) [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe) Thanks [@louistrue](https://github.com/louistrue)! - Client surface alignment (audit follow-ups):

  - `@ifc-lite/server-client`: `ServerConfig.token` sends `Authorization: Bearer` on every request (servers running `IFC_SERVER_API_TOKEN` were unreachable from the TS client); the `ParseResponse` / `ProcessingStats` / `MeshData` mirrors gain the optional fields the Rust server actually serves (`mesh_coordinate_space`, transforms, scan/lookup/preprocess timings, mesh metadata).
  - `@ifc-lite/geometry`: the worker-pool converter now carries `shadingColor` across the worker boundary — GLB "Shading" export no longer degrades on the default (parallel) load path; dead legacy wasm bindings removed (`IfcAPI.parse`, `parseStreaming`, `scanRelevantEntitiesFastBytes`, `MeshCollection.localToWorld`).
  - `@ifc-lite/export`: `assembleStepBytes` deduplicated into `step-serialization` (was copied byte-for-byte in the STEP and merged exporters).

- Updated dependencies [[`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe)]:
  - @ifc-lite/data@2.0.3

## 3.1.3

### Patch Changes

- [#1055](https://github.com/LTplus-AG/ifc-lite/pull/1055) [`594b90c`](https://github.com/LTplus-AG/ifc-lite/commit/594b90c99cf5e2bc40735232e0b02691be7b2ed1) Thanks [@louistrue](https://github.com/louistrue)! - fix(ids): make IDS validation usable on large models with code-list IDS packs.

  Validating a 550k-entity model against an 848-spec IDS document took ~19
  minutes of CPU, produced multi-GB reports, and the CLI then hung forever
  after printing its results. Four root fixes:

  - parser: `yieldToEventLoop` leaked one open `MessageChannel` per yield;
    in Node an open `MessagePort` holds a libuv handle, so every CLI command
    on a large file kept the process alive after completion. Ports now close
    (helper consolidated into one shared module).
  - ids: `validateIDS` wraps the accessor in a per-run memoizing cache so
    property sets / types / attributes are extracted once per entity instead
    of once per entity _per specification_ (O(specs×entities) source
    re-parses → O(entities)). Enumeration constraints additionally compile
    into exact-match sets (real-world code lists carry 800+ values).
  - ids: per-entity result strings are now bounded — enumeration constraints
    render at most 10 values in failure messages, and the entity-independent
    requirement description is formatted once per requirement instead of per
    entity result (reports for failing models dropped from GBs to MBs).
  - cli: `ifc-lite ids` now uses the canonical `@ifc-lite/ids/bridge`
    accessor (the drifted local copy missed type-inherited property sets),
    reports real progress (`spec 312/848 (37%)` instead of
    `undefined (undefined/undefined)`), and skips retaining passing entity
    results for human-readable output (`--json` is unchanged).

  Behavior change (intentional): the CLI's PASS/FAIL verdict and exit code
  now come from the validator's per-spec status, which counts
  cardinality-only failures — a `minOccurs="1"` specification that matches
  zero entities now correctly FAILs (exit 1) where it previously passed
  silently. `bim.ids.summarize` likewise prefers the per-spec status when
  the report carries one, so `--json` and text mode agree on the verdict.

  Measured on the same model + IDS pack: 848 specs 19min→2min, 117 specs
  3.4min→12s, both with a clean exit instead of a hang.

## 3.1.2

### Patch Changes

- [#1048](https://github.com/LTplus-AG/ifc-lite/pull/1048) [`f4ad10f`](https://github.com/LTplus-AG/ifc-lite/commit/f4ad10f2fef12e720b0966060a928d0a4e2b32b1) Thanks [@louistrue](https://github.com/louistrue)! - fix(georef): apply IfcMapConversion.Scale to the height axis. Per IFC4x3,
  the map conversion scale applies equally to x, y and z, but
  computeTransformMatrix and transformToLocal left z unscaled — models whose
  source and map coordinate systems use different units placed geometry at
  the wrong elevation. (Same fix applied to the Rust GeoReference
  local_to_map/map_to_local/to_matrix, released with the crates.)
- Updated dependencies [[`71c3e92`](https://github.com/LTplus-AG/ifc-lite/commit/71c3e92bae778fe7e5c34d9fcce5abfbd4f3ede5), [`c003017`](https://github.com/LTplus-AG/ifc-lite/commit/c0030175e82f194183b60492c1de34eca6b5d691)]:
  - @ifc-lite/ifcx@2.1.5
  - @ifc-lite/wasm@2.6.0

## 3.1.1

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc)]:
  - @ifc-lite/data@2.0.2
  - @ifc-lite/encoding@1.14.7
  - @ifc-lite/ifcx@2.1.4
  - @ifc-lite/wasm@2.5.1

## 3.1.0

### Minor Changes

- [#980](https://github.com/LTplus-AG/ifc-lite/pull/980) [`b33e1f7`](https://github.com/LTplus-AG/ifc-lite/commit/b33e1f7c4706fe4b0d850d3da782ea84267dd525) Thanks [@louistrue](https://github.com/louistrue)! - Add `attachDataStoreAccessors(store)`, the single home for wiring an `IfcDataStore`'s lazy `getEntity` / `getEntitiesByType` / `getProperties` / `getQuantities` accessors. The fresh-parse worker→main transport path now uses it instead of duplicating the wiring inline.

  This fixes a crash when querying a model loaded from the on-disk cache: the cache format only serialises data, so a restored store was missing these accessor methods, and opening the Properties panel for a cached entity threw `store.getEntity is not a function` (the viewer's cache-restore path now calls `attachDataStoreAccessors`).

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

- Updated dependencies [[`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0), [`90060b7`](https://github.com/LTplus-AG/ifc-lite/commit/90060b7eaad7a07bdab13907c1b52bb24fbc8597)]:
  - @ifc-lite/data@2.0.1
  - @ifc-lite/ifcx@2.1.3
  - @ifc-lite/wasm@2.3.0

## 3.0.0

### Major Changes

- [#874](https://github.com/LTplus-AG/ifc-lite/pull/874) [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85) Thanks [@louistrue](https://github.com/louistrue)! - Remove unused public exports that had zero consumers anywhere in the monorepo (coordinated breaking change). Each was verified against internal code, the other apps, the examples, the scaffolding templates, and the docs before removal.

  - **@ifc-lite/geometry**: drop `LODGenerator` / `LODConfig` / `LODMesh` (`lod.ts`), `DEFAULT_MATERIALS` / `getDefaultColor` / `getDefaultMaterialColor` / `MaterialColor` (`default-materials.ts`), and `calculateDynamicBatchSize`.
  - **@ifc-lite/parser**: drop `StyleExtractor` (and its `IFCMaterial` / `StyleMapping` types) and `OpfsSourceBuffer`.
  - **@ifc-lite/data**: drop `isBuildingLikeSpatialTypeName` — the enum-based `isBuildingLikeSpatialType` and the other spatial-type predicates stay.
  - **@ifc-lite/extensions**: drop `slugify` and `suggestedExtensionId`; the sibling id helpers (`suggestedCommandId`, `flavorImportedId`, `flavorMergedId`, `DEFAULT_FLAVOR_ID`) are retained.
  - **@ifc-lite/wasm**: drop the debug-only `debugProcessEntity953` / `debugProcessFirstWall` methods and the never-wired `scanEntityIndexShard` (Path C sharded-scan) export.

  Also removes the dead `ifc-lite-engine` crate (no workspace dependents) and the no-op `serde` feature on `ifc-lite-core` (it gated no code).

### Patch Changes

- [#874](https://github.com/LTplus-AG/ifc-lite/pull/874) [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85) Thanks [@louistrue](https://github.com/louistrue)! - Centralize IFC STEP entity scan selection behind a typed scanner helper, remove the unused duplicate `parseEntityOnDemand` implementation, keep the legacy `parse()` adapter on the shared scan path, route LOD exports through shared/adaptive ingestion paths, persist cache entity-index columns to avoid cache reload rescans, and update public docs away from legacy sync parse/geometry paths.

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85), [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/wasm@2.0.0
  - @ifc-lite/data@2.0.0
  - @ifc-lite/ifcx@2.1.2

## 2.4.2

### Patch Changes

- [#834](https://github.com/LTplus-AG/ifc-lite/pull/834) [`bdb9978`](https://github.com/LTplus-AG/ifc-lite/commit/bdb997842fe38627fefbcddf250fc0136289bc84) Thanks [@louistrue](https://github.com/louistrue)! - Three IFC geometry fixes plus a Dutch / metric-export properties-panel fix.

  - **[#820](https://github.com/LTplus-AG/ifc-lite/issues/820) — `IfcTrimmedCurve` parameter values now respect `PLANEANGLEUNIT`.**
    `process_trimmed_conic` previously called `.to_radians()` unconditionally,
    silently shrinking a 240° arc to ~4° on files that declare
    `IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)` (e.g. the Renga-exported
    `RadianValuesOverPI.ifc` wall whose trim values are `5.7596`/`9.9484`
    radians). Added `extract_plane_angle_to_radians` to `ifc_lite_core::units`
    and a lazy lookup on `EntityDecoder` so the right scale (1.0 for RADIAN
    files, π/180 for DEGREE conversion-based units) is applied without
    per-call IFC scanning.

  - **[#821](https://github.com/LTplus-AG/ifc-lite/issues/821) — `IfcBooleanResult.DIFFERENCE` falls back to the un-cut host when
    the subtract emits an empty mesh from a non-empty host.** Revit IFC2x3
    exports (e.g. `TallBuilding.ifc`) sometimes author top-trim
    `IfcPolygonalBoundedHalfSpace` planes that land exactly on the wall's top
    with `AgreementFlag = .T.`, making the spec-strict half-space material
    region exactly cover the wall body — the strict subtract returns nothing
    and the wall vanishes. Production viewers (BIMVision, IfcOpenShell) revert
    to the host in this case; the processor now does the same and records the
    loss as `BoolFailureReason::DifferenceEmptiedHost` so it surfaces in CSG
    diagnostics rather than disappearing silently.

  - **[#819](https://github.com/LTplus-AG/ifc-lite/issues/819) — `IfcTriangulatedFaceSet` flat-shades by default.** Without
    per-vertex `Normals` the downstream normal accumulator was smooth-averaging
    face normals across every shared vertex, smearing crisp facet edges into
    muddy gradients on faceted geometry (visible on the
    `IFC4TessellationComplex.ifc` dome compared to BIMVision's flat-shaded
    render). The processor now duplicates vertices per-triangle and writes
    per-face normals, matching what `IfcPolygonalFaceSet` already does and
    the IfcOpenShell / web-ifc default.

  - **Layer thickness display in the properties panel** (`MaterialCard`)
    showed "60.0 m" for a 60 mm prefab slab on `LENGTHUNIT=MILLI.METRE`
    files. `material-resolver` now multiplies the raw `IfcMaterialLayer.LayerThickness`
    by `store.lengthUnitScale` before storing it, so `formatThickness` sees a
    proper metres value and reports "60.0 mm".

  Adds three regression tests pinned to fixtures under `tests/models/issues/`:

  - `issue_819_triangulated_normals.rs`
  - `issue_820_trimmed_curve_planeangleunit.rs`
  - `issue_821_difference_emptied_host.rs`

  Catalogue updated; fixtures will be uploaded to the `fixtures-v1` release.

- Updated dependencies [[`bdb9978`](https://github.com/LTplus-AG/ifc-lite/commit/bdb997842fe38627fefbcddf250fc0136289bc84), [`ee6dbae`](https://github.com/LTplus-AG/ifc-lite/commit/ee6dbaedcc205b08728fa3e235bc3028d32b65e3)]:
  - @ifc-lite/wasm@1.19.1

## 2.4.1

### Patch Changes

- [#658](https://github.com/louistrue/ifc-lite/pull/658) [`bfb5e1b`](https://github.com/louistrue/ifc-lite/commit/bfb5e1bdc917ab771de4540b6c5686b9fb0e5fa7) Thanks [@louistrue](https://github.com/louistrue)! - Restore IFC2X3 georeferencing extraction from legacy site locations and standard map conversion data so Cesium placement and inspector metadata stay available for older models.

## 2.4.0

### Minor Changes

- [#629](https://github.com/louistrue/ifc-lite/pull/629) [`2ab0e4c`](https://github.com/louistrue/ifc-lite/commit/2ab0e4c0eafc21feb22bfc7cd96c467b8b9ff599) Thanks [@louistrue](https://github.com/louistrue)! - **Parse IFC off the main thread.** The browser viewer now runs `IfcParser.parseColumnar`
  inside a dedicated `WorkerParser` worker that shares the source bytes via
  `SharedArrayBuffer` with the existing geometry workers. Parse and geometry
  streaming run in parallel without contending for main-thread time, cutting
  upload-to-interactive wall-clock by roughly 2× on medium-to-large files.

  New public APIs:

  - `@ifc-lite/parser`

    - `WorkerParser` (browser-only, exported from `@ifc-lite/parser/browser`)
    - `data-store-transport`: `toTransport(store)` / `fromTransport(payload, source)`
      plus the `DataStoreTransport` payload type. Lets any consumer ship a
      fully-typed `IfcDataStore` across a `postMessage` boundary with the
      typed-array buffers in the transfer list and closures rebuilt on receipt.

  - `@ifc-lite/data`

    - `entityTableFromColumns` / `entityTableToColumns`
    - `propertyTableFromColumns` / `propertyTableToColumns`
    - `quantityTableFromColumns` / `quantityTableToColumns`
    - `relationshipGraphFromColumns` / `relationshipGraphToColumns`
    - `relationshipEdgesFromColumns`, `relationshipGraphFromEdges`, `buildCSR`
    - `StringTable.fromArray(strings)`
    - `EntityTable.rawTypeName` is now exposed (optional column) so the
      unknown-type display fallback round-trips through column transports.

  - `@ifc-lite/geometry`

    - `processParallel(buffer, coordinator, sharedRtcOffset?, existingSab?, options?)`:
      `existingSab` lets the geometry workers reuse a SAB the caller already
      populated. The new fifth argument is `ProcessParallelOptions` with:
      - `onEntityIndex(ids, starts, lengths)`: invoked once the streaming
        pre-pass has built the entity index. Hosts forward the SAB-shared
        columns to `WorkerParser.setEntityIndex(...)` so the parser skips
        its own ~10 s WASM scan.
      - `useSingleController`: opt-in (off by default) to the experimental
        single-controller + wasm-bindgen-rayon path. See
        `docs/architecture/single-controller-rayon-design.md` §12 for the
        post-mortem on when this helps and when it regresses.
    - `GeometryProcessor.processParallel` and `processAdaptive` accept the
      same options to plumb them through.
    - `StreamingGeometryEvent` gains a `workerMemory` variant carrying
      per-worker WASM heap + mesh-byte counts for memory accounting.

  - `@ifc-lite/parser` (additions on top of the worker entry above)
    - `WorkerParser.setEntityIndex(ids, starts, lengths)`: hand a pre-built
      entity index to the worker's `IfcAPI`. Pairs with the geometry
      pre-pass's `onEntityIndex` callback above.
    - `WorkerParserOptions.waitForEntityIndex`: when true, the worker blocks
      its WASM scan until `setEntityIndex` arrives (60 s watchdog falls
      back to the regular scan if it never does).
    - `IfcParser.parseColumnar`: signature widened to accept
      `ArrayBuffer | SharedArrayBuffer` (was `ArrayBuffer`); the SAB-backed
      parser worker no longer needs an `as unknown as ArrayBuffer` cast.

  The viewer auto-falls back to the in-process `IfcParser` when
  `crossOriginIsolated` is `false` or the worker spawn throws, so behavior is
  unchanged in environments without SAB.

### Patch Changes

- Updated dependencies [[`8408c88`](https://github.com/louistrue/ifc-lite/commit/8408c88c4c0a1e848fade6c60474952eca1a4149), [`ba7553a`](https://github.com/louistrue/ifc-lite/commit/ba7553af693939896a840074999b5f6806a94815), [`2ab0e4c`](https://github.com/louistrue/ifc-lite/commit/2ab0e4c0eafc21feb22bfc7cd96c467b8b9ff599)]:
  - @ifc-lite/wasm@1.16.9
  - @ifc-lite/data@1.17.0
  - @ifc-lite/ifcx@2.1.1

## 2.3.0

### Minor Changes

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Phase 0 of full point cloud loading: render the buildingSMART IFCx
  pointcloud samples (`pcd::base64`, `points::array`, `points::base64`).

  - New `@ifc-lite/pointcloud` package: renderer-agnostic decoders for PCD
    (ASCII / binary / binary_compressed via inline LZF) and the two inline
    IFCx point schemas. Pure TS, no three.js, no WebGPU.
  - `@ifc-lite/geometry` adds `PointCloudAsset` and `GeometryResult.pointClouds`.
  - `@ifc-lite/ifcx` adds `extractPointClouds()` and surfaces decoded scans
    on `IfcxParseResult.pointClouds`. The mesh extractor is unchanged.
  - `@ifc-lite/parser` re-exports the new `PointCloudExtraction` type.
  - `@ifc-lite/renderer` gains a WGSL `topology: 'point-list'` pipeline,
    per-asset GPU buffers, and `Renderer.setPointClouds()` /
    `Renderer.addPointClouds()`. Points share the depth buffer and section
    plane state with the triangle pipeline.

### Patch Changes

- Updated dependencies [[`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1), [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1)]:
  - @ifc-lite/ifcx@2.1.0

## 2.2.0

### Minor Changes

- [#576](https://github.com/louistrue/ifc-lite/pull/576) [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742) Thanks [@louistrue](https://github.com/louistrue)! - Add IFC 4D / construction scheduling extractor (`extractScheduleOnDemand`).
  Parses `IfcTask`, `IfcTaskTime`, `IfcRelSequence`, `IfcRelAssignsToProcess`,
  `IfcRelAssignsToControl`, `IfcRelNests`, `IfcWorkSchedule`, `IfcWorkPlan`, and
  `IfcLagTime` from the source buffer and returns a normalized
  `ScheduleExtraction` — hierarchy, assigned products, typed dependency edges
  (FS/SS/FF/SF with `IfcLagTime` resolved to seconds), and work-schedule
  grouping — that UIs can drive a Gantt view and 4D animation from.

- [#576](https://github.com/louistrue/ifc-lite/pull/576) [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742) Thanks [@louistrue](https://github.com/louistrue)! - Add schedule-serializer + deterministic-GlobalId helpers.

  **`serializeScheduleToStep(extraction, options)`** emits a `ScheduleExtraction`
  back into IFC-STEP lines (`IfcWorkSchedule`, `IfcWorkPlan`, `IfcTask`,
  `IfcTaskTime`, `IfcRelNests`, `IfcRelSequence`, `IfcLagTime`,
  `IfcRelAssignsToControl`, `IfcRelAssignsToProcess`), resolving cross-entity
  references by expressId and reporting per-type line counts in `stats`.
  Pairs with the existing `extractScheduleOnDemand` to make schedule data
  fully round-trippable through a STEP export.

  **`deterministicGlobalId(seed)`** — 128-bit double-FNV-1a hash encoded as a
  22-char IFC GlobalId. Deterministic (same seed ⇒ same id), collision-safe
  across schedule-generation seeds, and exposed as a single source of truth
  for every caller that previously kept a private copy of the algorithm.

### Patch Changes

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

- [#578](https://github.com/louistrue/ifc-lite/pull/578) [`16d7a63`](https://github.com/louistrue/ifc-lite/commit/16d7a6361a78bb39a2bd61bba6990db5d3df0c04) Thanks [@louistrue](https://github.com/louistrue)! - Surface on-demand properties and quantities through the query API.

  `parseColumnar` intentionally leaves the pre-parsed `store.properties` / `store.quantities` tables empty and populates `onDemandPropertyMap` / `onDemandQuantityMap` instead, but `QueryResultEntity` only read from the empty pre-parsed tables. As a result `query.ofType(...).includeProperties().includeQuantities().execute()` always returned elements with empty `properties` / `quantities`, even when the IFC file contained them (issue #577).

  `loadPropertiesFromStore` / `loadQuantitiesFromStore` in `query-result-entity.ts` now fall back to `extractPropertiesOnDemand` / `extractQuantitiesOnDemand` when the pre-parsed tables are empty and the on-demand maps are present. This applies to the `properties` / `quantities` getters, the `loadProperties` / `loadQuantities` eager loaders, and the `getProperty()` accessor.

  Also normalizes untagged STEP enumeration tokens (`.T.` / `.F.` / `.U.` / `.X.`) emitted by some authoring tools in the `NominalValue` slot of `IfcPropertySingleValue`: `.T.` / `.F.` now decode to real JS booleans and `.U.` / `.X.` to a Logical `null`, matching the behavior of the conformant `IFCBOOLEAN(...)` / `IFCLOGICAL(...)` typed form.

## 2.1.9

### Patch Changes

- [#552](https://github.com/louistrue/ifc-lite/pull/552) [`aeb5edf`](https://github.com/louistrue/ifc-lite/commit/aeb5edf89605d103582f68866c92d69ef6cb4635) Thanks [@louistrue](https://github.com/louistrue)! - Fix `ERR_MODULE_NOT_FOUND` when the published packages are loaded by Node's native ESM resolver (SSR, serverless, Vitest Node mode, CI test runners, etc.).

  Several relative imports in the source omitted the `.js` extension. Under the old workspace `moduleResolution: "bundler"` TypeScript tolerated them and emitted the specifiers verbatim, so `dist/*.js` shipped extensionless relative imports. Bundlers (Vite/webpack/esbuild) resolved them transparently, but Node's native ESM resolver strictly requires the file extension and threw `ERR_MODULE_NOT_FOUND` — most visibly in `@ifc-lite/renderer`'s `dist/snap-detector.js` importing `./raycaster`.

  All offending relative imports have been rewritten to include explicit `.js` (or `/index.js` for directory imports), and every publishable package's TypeScript config now uses `module: "nodenext"` + `moduleResolution: "nodenext"` so the TypeScript compiler rejects extensionless relative imports at build time, preventing regressions. Every published package has been smoke-imported via `node --input-type=module` to verify the fix end-to-end.

## 2.1.8

### Patch Changes

- [#526](https://github.com/louistrue/ifc-lite/pull/526) [`cb59771`](https://github.com/louistrue/ifc-lite/commit/cb59771997e3837a511f584842bce98cd710864e) Thanks [@louistrue](https://github.com/louistrue)! - Fix parser entity index regression and remove debug console statements from production code.

## 2.1.7

### Patch Changes

- [#513](https://github.com/louistrue/ifc-lite/pull/513) [`082eadd`](https://github.com/louistrue/ifc-lite/commit/082eaddd10b158d1b3fe6067f9abf949596a0162) Thanks [@louistrue](https://github.com/louistrue)! - Optimize memory usage by adding `CompactEntityIndexBuilder` for streaming entity index construction and `EntityTable.getTypeEnum()` for lightweight type lookups without full attribute extraction.

- Updated dependencies [[`082eadd`](https://github.com/louistrue/ifc-lite/commit/082eaddd10b158d1b3fe6067f9abf949596a0162)]:
  - @ifc-lite/data@1.15.2

## 2.1.6

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

- Updated dependencies [[`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5)]:
  - @ifc-lite/data@1.15.1
  - @ifc-lite/encoding@1.14.6
  - @ifc-lite/ifcx@2.0.2

## 2.1.5

### Patch Changes

- [#461](https://github.com/louistrue/ifc-lite/pull/461) [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7) Thanks [@louistrue](https://github.com/louistrue)! - Clean up package build health for georeferencing work by fixing parser generation issues, making export tests resolve workspace packages reliably, removing build scripts that masked TypeScript failures, tightening workspace test/build scripts, productizing CLI LOD generation, centralizing IFC GUID utilities in encoding, and adding mutation test coverage for property editing flows.

- Updated dependencies [[`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7), [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7)]:
  - @ifc-lite/data@1.15.0
  - @ifc-lite/encoding@1.14.5

## 2.1.4

### Patch Changes

- [#432](https://github.com/louistrue/ifc-lite/pull/432) [`113bafc`](https://github.com/louistrue/ifc-lite/commit/113bafc07436c809a8cb24d8682cf63ae5ed99e9) Thanks [@louistrue](https://github.com/louistrue)! - Recognize IFC4.3 facility and facility-part spatial containers when building parser hierarchies so infrastructure models render a usable spatial tree.

- Updated dependencies [[`113bafc`](https://github.com/louistrue/ifc-lite/commit/113bafc07436c809a8cb24d8682cf63ae5ed99e9)]:
  - @ifc-lite/data@1.14.6

## 2.1.3

### Patch Changes

- [#411](https://github.com/louistrue/ifc-lite/pull/411) [`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515) Thanks [@louistrue](https://github.com/louistrue)! - Fix large model loading with streaming columnar parser, inline scan worker, and improved geometry bridge. Refactor relationship graph for better memory efficiency and add spatial index builder utilities.

- Updated dependencies [[`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515)]:
  - @ifc-lite/data@1.14.5

## 2.1.2

### Patch Changes

- [#372](https://github.com/louistrue/ifc-lite/pull/372) [`d2ebb34`](https://github.com/louistrue/ifc-lite/commit/d2ebb3457e261934df41c8f7f647531de6198078) Thanks [@louistrue](https://github.com/louistrue)! - Fix multiple CLI bugs and add new query features:

  **Bug fixes:**

  - **info/diff**: Resolve "Unknown" entity type spam by using IFC_ENTITY_NAMES map for UPPERCASE→PascalCase conversion
  - **loader**: Reject non-IFC files (missing ISO-10303-21 header) and empty files with clear error messages
  - **props**: Return proper error for nonexistent entity IDs instead of empty JSON structure
  - **bcf list**: Fix empty topics by adding Map serialization support to JSON output
  - **query --where**: Fix boolean property matching (IsExternal=true now works); error on malformed syntax instead of silently returning all results
  - **query --relationships**: Add structural relationship types (VoidsElement, FillsElement, ConnectsPathElements, AssignsToGroup, etc.) to parser; handle 1-to-1 relationships
  - **query --spatial**: Fall back to IfcBuilding containment when no IfcBuildingStorey exists
  - **eval**: Support const/let/var and multi-statement expressions (auto-wraps in async IIFE)
  - **model.active().schema**: Add `schema` alias so scripts can access schema version

  **New features:**

  - **query --where operators**: Support `!=`, `>`, `<`, `>=`, `<=`, `~` (contains) in addition to `=`
  - **query --sum**: Aggregate a quantity across matched entities with disambiguation warnings when similar quantities exist (e.g., `--sum GrossSideArea`)
  - **query --storey**: Filter entities by storey name (e.g., `--storey Erdgeschoss`)
  - **query --quantity-names**: List all available quantities per entity type with qset context, sample values, and ambiguity warnings — critical for LLM-driven quantity analysis
  - **query --group-by**: Pivot table grouped by type, material, or any property (e.g., `--group-by material`)
  - **query --spatial --summary**: Show element type counts per storey instead of listing every element
  - **eval**: Auto-return last expression value in multi-statement mode (no explicit `return` needed)
  - **validate**: Check quantity completeness — warns when building elements lack quantity sets
  - **--version**: Show version number in help output

- Updated dependencies [[`d2ebb34`](https://github.com/louistrue/ifc-lite/commit/d2ebb3457e261934df41c8f7f647531de6198078)]:
  - @ifc-lite/data@1.14.4

## 2.1.1

### Patch Changes

- [#368](https://github.com/louistrue/ifc-lite/pull/368) [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8) Thanks [@louistrue](https://github.com/louistrue)! - Refactor internals across parser, renderer, export, and viewer packages

## 2.1.0

### Minor Changes

- [#354](https://github.com/louistrue/ifc-lite/pull/354) [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f) Thanks [@louistrue](https://github.com/louistrue)! - Replace hardcoded IFC schema with codegen from EXPRESS schema, adding full type entity support (776 entities)

### Patch Changes

- [#354](https://github.com/louistrue/ifc-lite/pull/354) [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f) Thanks [@louistrue](https://github.com/louistrue)! - Add dynamic IFCX schema import detection for IFC5 export

- Updated dependencies [[`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f), [`40bf3d0`](https://github.com/louistrue/ifc-lite/commit/40bf3d00cb5d5ef3512b96cd5e066442adcaab87)]:
  - @ifc-lite/ifcx@2.0.1
  - @ifc-lite/encoding@1.14.4

## 2.0.0

### Major Changes

- [#336](https://github.com/louistrue/ifc-lite/pull/336) [`ba9040c`](https://github.com/louistrue/ifc-lite/commit/ba9040c6ff3204f3a936dd2f481c4cd8a4e6f5b5) Thanks [@louistrue](https://github.com/louistrue)! - Remove the legacy single-parent `ComposedNode.parent` field and `getPathToRoot()` export from the IFCX composition API. IFCX extraction now relies on explicit traversal frames instead of mutable parent pointers, and the build now verifies built `dist` output against the Hello Wall IFCX fixtures.

### Patch Changes

- Updated dependencies [[`ba9040c`](https://github.com/louistrue/ifc-lite/commit/ba9040c6ff3204f3a936dd2f481c4cd8a4e6f5b5), [`ba9040c`](https://github.com/louistrue/ifc-lite/commit/ba9040c6ff3204f3a936dd2f481c4cd8a4e6f5b5)]:
  - @ifc-lite/ifcx@2.0.0

## 1.14.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.3
  - @ifc-lite/ifcx@1.14.3

## 1.14.2

### Patch Changes

- [#316](https://github.com/louistrue/ifc-lite/pull/316) [`740f7a7`](https://github.com/louistrue/ifc-lite/commit/740f7a7228413657d13014565d9e457f0e00e8a3) Thanks [@louistrue](https://github.com/louistrue)! - Improve IFC type detection for style-based IFC2X3 entities and keep type-owned property extraction consistent with mixed-source type metadata.

- Updated dependencies []:
  - @ifc-lite/data@1.14.2
  - @ifc-lite/ifcx@1.14.2

## 1.14.1

### Patch Changes

- [#283](https://github.com/louistrue/ifc-lite/pull/283) [`071d251`](https://github.com/louistrue/ifc-lite/commit/071d251708388771afd288bc2ef01b4d1a074607) Thanks [@louistrue](https://github.com/louistrue)! - fix: support large IFC files (700MB+) in geometry streaming

  - Add error handling to `collectInstancedGeometryStreaming()` to prevent infinite hang when WASM fails
  - Add adaptive batch sizing for large files in `processInstancedStreaming()`
  - Add 0-result detection warnings when WASM returns no geometry
  - Replace `content.clone()` with `Option::take()` in all async WASM methods to halve peak memory usage

- Updated dependencies []:
  - @ifc-lite/data@1.14.1
  - @ifc-lite/ifcx@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.0
  - @ifc-lite/ifcx@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.13.0
  - @ifc-lite/ifcx@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.12.0
  - @ifc-lite/ifcx@1.12.0

## 1.11.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.3
  - @ifc-lite/ifcx@1.11.3

## 1.11.1

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.1
  - @ifc-lite/ifcx@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.0
  - @ifc-lite/ifcx@1.11.0

## 1.10.0

### Minor Changes

- [#203](https://github.com/louistrue/ifc-lite/pull/203) [`3823bd0`](https://github.com/louistrue/ifc-lite/commit/3823bd03bb0b5165d811cfd1ddfed671b8af97d8) Thanks [@louistrue](https://github.com/louistrue)! - Add visual enhancement post-processing (contact shading, separation lines, edge contrast) and fix geometry parsing / entity type resolution

  **Renderer — visual enhancements:**

  - Add fullscreen post-processing pass (`PostProcessor`) with depth-based contact shading and object-ID-based separation lines for improved visual clarity between adjacent elements
  - Add configurable edge contrast enhancement via shader uniforms with adjustable intensity
  - New `VisualEnhancementOptions` API with independent quality presets (`off` / `low` / `high`), intensity, and radius for contact shading, separation lines, and edge contrast
  - Automatically disable expensive effects on mobile devices

  **Renderer — render pipeline changes:**

  - Add second render target (`rgba8unorm` object ID texture) to all render pipelines (opaque, transparent, overlay, instanced) for per-entity boundary detection
  - Expand vertex format from 6 to 7 floats (position + normal + entityId) across all pipelines and the picker
  - Encode entity IDs into the object ID texture via 24-bit RGB encoding in fragment shaders
  - Depth texture now created with `TEXTURE_BINDING` usage for post-processor sampling
  - Edge contrast rendering made conditional via uniform flags (`flags.z` / `flags.w`) instead of always-on

  **Renderer — geometry & scene:**

  - `GeometryManager` interleaves entity ID into the 7th float of each vertex buffer
  - `Scene` batching writes entity IDs per-vertex into merged buffers for instanced rendering

  **Data — entity type system expansion:**

  - Add ~30 new `IfcTypeEnum` entries: chimney, shading device, building element part, element assembly, reinforcing bar/mesh/tendon, discrete accessory, mechanical fastener, flow controller/moving device/storage device/treatment device/energy conversion device, duct/pipe/cable segments, furniture, proxy, annotation, transport element, civil element, geographic element
  - Add ~11 new type definition enums: pile type, member type, plate type, footing type, covering type, railing type, stair type, ramp type, roof type, curtain wall type, building element proxy type
  - Map `*StandardCase` variants (e.g. `IFCSLABSTANDARDCASE`, `IFCCOLUMNSTANDARDCASE`) to their base enum values for correct grouping
  - Expand `TYPE_STRING_TO_ENUM` and `TYPE_ENUM_TO_STRING` maps with all new types
  - Add new `ifc-entity-names.ts` with 888-line UPPERCASE → PascalCase lookup table (all IFC4X3 entity names) for correct display of any IFC entity type
  - Add `rawTypeName` field to `EntityTableBuilder` storing normalized type name as string index
  - `getTypeName()` now falls back to `rawTypeName` for types not in the enum, eliminating "Unknown" display for valid IFC types

  **Parser:**

  - Add diagnostic `console.debug` logging for spatial entity extraction and `console.warn` on extraction failures

  **WASM / Rust geometry engine:**

  - Replace overly broad geometry entity filter (`starts_with("IFC") && !ends_with("TYPE") && ...`) with explicit whitelist of ~120 IfcProduct subtypes in `has_geometry_by_name`, preventing non-product entities (e.g. `IfcDimensionalExponents`, `IfcSurfaceStyleRendering`) from being sent to geometry processing
  - Add `SolidModel` to the accepted representation types in the geometry router (6 match arms)
  - Use smooth per-vertex normals for extruded circular profiles (cylinder side walls) with `is_approximately_circular_profile` heuristic that detects circular vs polygonal profiles by coefficient of variation of radii from centroid
  - Increase circle tessellation from 24 to 36 segments for profiles (circle, circle hollow, trimmed curve, ellipse)
  - Increase swept disk solid tube segments from 12 to 24 for smoother pipes
  - Fix `PolygonalFaceSet` processing: generate flat-shaded meshes with per-face normals via `build_flat_shaded_mesh` and fix closed-shell winding orientation via `orient_closed_shell_outward`
  - Improve geometry extraction statistics: separate "no representation" (expected) from actual processing failures in diagnostic logging
  - Add `console.debug` logging for entities skipped due to missing representation

  **Viewer app:**

  - Add visual enhancement state to Zustand UI slice with 10 configurable properties (enabled, edge contrast enabled/intensity, contact shading quality/intensity/radius, separation lines enabled/quality/intensity/radius)
  - Wire `VisualEnhancementOptions` through `Viewport`, `useAnimationLoop`, and `useRenderUpdates` via memoized ref pattern
  - Show IFC type name instead of "Unknown" for spatial entities with generic names in the tree hierarchy
  - Expand `useThemeState` hook with all visual enhancement selectors

### Patch Changes

- Updated dependencies [[`3823bd0`](https://github.com/louistrue/ifc-lite/commit/3823bd03bb0b5165d811cfd1ddfed671b8af97d8)]:
  - @ifc-lite/data@1.10.0
  - @ifc-lite/ifcx@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.9.0
  - @ifc-lite/ifcx@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.8.0
  - @ifc-lite/ifcx@1.8.0

## 1.7.0

### Minor Changes

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

- Updated dependencies [[`6c43c70`](https://github.com/louistrue/ifc-lite/commit/6c43c707ead13fc482ec367cb08d847b444a484a)]:
  - @ifc-lite/data@1.7.0
  - @ifc-lite/ifcx@1.7.0

## 1.4.0

### Patch Changes

- 0191843: feat: Add BCF (BIM Collaboration Format) support

  Adds full BCF 2.1 support for issue tracking and collaboration in BIM workflows:

  **BCF Package (@ifc-lite/bcf):**

  - Read/write BCF 2.1 .bcfzip files
  - Full viewpoint support with camera position, components, and clipping planes
  - Coordinate system conversion between Y-up (viewer) and Z-up (IFC/BCF)
  - Support for multiple snapshot naming conventions
  - IFC GlobalId mapping for component references

  **Viewer Integration:**

  - BCF panel integrated into properties panel area (resizable, same layout)
  - Topic management with filtering and status updates
  - Viewpoint capture with camera state, selection, and snapshot
  - Viewpoint activation with smooth camera animation and visibility state
  - Import/export BCF files compatible with BIMcollab and other tools
  - Email setup nudge in empty state for easy author configuration
  - Smart filename generation using model name for downloads

  **Renderer Fixes:**

  - Fix screenshot distortion caused by WebGPU texture row alignment
  - Add GPU-synchronized screenshot capture for accurate snapshots

  **Parser Fixes:**

  - Extract GlobalIds for all geometry entities (not just spatial) to enable BCF component references

  **Bug Fixes:**

  - Fix BCF viewpoint visibility not clearing isolation mode
  - Add localStorage error handling for private browsing mode
  - Fix BCF XML schema compliance for BIMcollab compatibility:
    - Correct element order (Selection before Visibility)
    - Move ViewSetupHints to Components level (not inside Visibility)
    - Write OriginatingSystem/AuthoringToolId as child elements (not attributes)
    - Always include required Visibility element

## 1.3.0

### Minor Changes

- [#130](https://github.com/louistrue/ifc-lite/pull/130) [`cc4d3a9`](https://github.com/louistrue/ifc-lite/commit/cc4d3a922869be5d4f8cafd4ab1b84e6bd254302) Thanks [@louistrue](https://github.com/louistrue)! - Add IFC5 federated loading support with layer composition

  ## Features

  - **Federated IFCX Loading**: Load multiple IFCX files that compose into a unified model

    - Supports the IFC5/IFCX Entity-Component-System architecture
    - Later files in the composition chain override earlier files (USD-inspired semantics)
    - Properties from overlay files merge with base geometry files

  - **Models Panel Integration**: Show all federated layers in the Models panel

    - Each layer (base + overlays) displayed as a separate entry
    - Overlay-only files (no geometry) shown with data indicator
    - Toggle visibility per layer

  - **Add Overlay via "+" Button**: Add IFCX overlay files to existing models
    - Works with both single-file and already-federated IFCX models
    - Automatically re-composes with new overlay as strongest layer
    - Preserves original files for future re-composition

  ## Fixes

  - **Property Panel Layout**: Long property strings no longer push other values off-screen

    - Changed from flexbox to CSS grid layout
    - Individual horizontal scroll on each property value

  - **3D Selection Highlighting**: Fixed race condition that broke highlighting after adding overlays

    - Geometry now comes exclusively from models Map (not legacy state)
    - Meshes correctly tagged with modelIndex for multi-model selection

  - **ID Range Tracking**: Fixed maxExpressId calculation for proper entity resolution
    - resolveGlobalIdFromModels now correctly finds entities across federated layers

  ## Technical Details

  - New `LayerStack` class manages ordered composition with strongest-to-weakest semantics
  - New `PathIndex` class enables efficient cross-layer entity lookups
  - `parseFederatedIfcx` function handles multi-file composition
  - Viewer auto-detects when multiple IFCX files are loaded together

### Patch Changes

- [#119](https://github.com/louistrue/ifc-lite/pull/119) [`fe4f7ac`](https://github.com/louistrue/ifc-lite/commit/fe4f7aca0e7927d12905d5d86ded7e06f41cb3b3) Thanks [@louistrue](https://github.com/louistrue)! - Fix WASM safety, improve DX, and add test infrastructure

  - Replace 60+ unsafe unwrap() calls with safe JS interop helpers in WASM bindings
  - Clean console output with single summary line per file load
  - Pure client-side by default (no CORS errors in production)
  - Add unit tests for StringTable, GLTFExporter, store slices
  - Add WASM contract tests and integration pipeline tests
  - Fix TypeScript any types and data corruption bugs

- Updated dependencies [[`fe4f7ac`](https://github.com/louistrue/ifc-lite/commit/fe4f7aca0e7927d12905d5d86ded7e06f41cb3b3), [`cc4d3a9`](https://github.com/louistrue/ifc-lite/commit/cc4d3a922869be5d4f8cafd4ab1b84e6bd254302)]:
  - @ifc-lite/data@1.3.0
  - @ifc-lite/ifcx@1.3.0

## 1.2.1

### Patch Changes

- 8cb195d: Fix Ubuntu setup issues and monorepo resolution.
  - Fix `@ifc-lite/parser` worker resolution for Node.js/tsx compatibility
  - Fix `create-ifc-lite` to properly replace `workspace:` protocol in templates

## 1.2.0

### Minor Changes

- ed8f77b: ### New Features

  - **IFC5 (IFCX) Format Support**: Added full support for IFC5/IFCX file format parsing, enabling compatibility with the latest IFC standard
  - **IFCX Property/Quantity Display**: Enhanced viewer to properly display IFCX properties and quantities
  - **IFCX Coordinate System Handling**: Fixed coordinate system transformations for IFCX files

  ### Bug Fixes

  - **Fixed STEP Escaping**: Corrected STEP file escaping issues that affected IFCX parsing
  - **Fixed IFC Type Names**: Improved IFC type name handling for better compatibility

- f4fbf8c: ### New Features

  - **Type visibility controls**: Toggle visibility of spatial elements (IfcSpace, IfcOpeningElement, IfcSite) in the viewer toolbar
  - **Enhanced CSG operations**: Improved boolean geometry operations using the `csgrs` library for better performance and accuracy
  - **Full IFC4X3 schema support**: Migrated to generated schema with all 876 IFC4X3 types

  ### Bug Fixes

  - **Fixed unit conversion**: Files using millimeters (.MILLI. prefix) now render at correct scale instead of 1000x too large
  - **Fixed IFCPROJECT detection**: Now scans entire file to find IFCPROJECT instead of only first 100 entities, fixing issues with large IFC files

- ed8f77b: ### Performance Improvements

  - **Lite Parsing Mode**: Added optimized parsing mode for large files (>100MB) with 5-10x faster parsing performance
  - **On-Demand Property Extraction**: Implemented on-demand property extraction for instant property access, eliminating upfront table building overhead
  - **Fast Semicolon Scanner**: Added high-performance semicolon-based scanner for faster large file processing
  - **Single-Pass Data Extraction**: Optimized to single-pass data extraction for improved parsing speed
  - **Async Yields**: Added async yields during data parsing to prevent UI blocking
  - **Bulk Array Extraction**: Optimized data model decoding with bulk array extraction for better performance
  - **Dynamic Batch Sizing**: Implemented dynamic batch sizing for improved performance in IFC processing with adaptive batch sizes based on file size

  ### New Features

  - **On-Demand Parsing Mode**: Consolidated to single on-demand parsing mode for better memory efficiency
  - **Targeted Spatial Parsing**: Added targeted spatial parsing in lite mode for efficient hierarchy building

  ### Bug Fixes

  - **Fixed Relationship Graph**: Added DefinesByProperties to relationship graph in lite mode
  - **Fixed On-Demand Maps**: Improved forward relationship lookup for rebuilding on-demand maps
  - **Fixed Property Extraction**: Restored on-demand property extraction when loading from cache

### Patch Changes

- ed8f77b: ### Bug Fixes

  - **Fixed Color Parsing**: Fixed TypedValue wrapper handling in color parsing
  - **Fixed Storey Visibility**: Fixed storey visibility toggle functionality
  - **Fixed Background Property Parsing**: Added background property parsing support
  - **Fixed Geometry Support**: Added IfcSpace/Opening/Site geometry support
  - **Fixed TypeScript Generation**: Fixed TypeScript generation from EXPRESS schema types
  - **Fixed Renderer Safeguards**: Added renderer safeguards for proper IFC type names

- ### Bug Fixes

  - **Fixed IFC elevation units**: IFC files store elevation values in the file's native units (e.g., mm), but they were being displayed as meters without conversion. Now properly extracts and applies length unit scale from IFCPROJECT -> IFCUNITASSIGNMENT -> IFCSIUNIT/IFCCONVERSIONBASEDUNIT, supporting SI prefixes (MILLI, CENTI, etc.) and imperial units (FOOT, INCH).
  - **Fixed IFCMEASUREWITHUNIT scale**: When extracting conversion factors from IFCMEASUREWITHUNIT, the ValueComponent is now correctly multiplied by the UnitComponent's scale factor (e.g., INCH defined as 25.4mm = 0.0254m).
  - **Fixed missing IFCUNITASSIGNMENT handling**: Added guards against missing IFCUNITASSIGNMENT attributes to prevent parsing errors.

- f7133a3: ### Performance Improvements

  - **Zero-copy WASM memory to WebGPU upload**: Implemented direct memory access from WASM linear memory to WebGPU buffers, eliminating intermediate JavaScript copies. This provides 60-70% reduction in peak RAM usage and 40-50% faster geometry-to-GPU pipeline.

  - **Optimized cache and spatial hierarchy**: Eliminated O(n²) lookups in cache and spatial hierarchy builder, implemented instant cache lookup with larger batches, and optimized batch streaming for better performance.

  - **Parallelized data model parsing**: Added parallel processing for data model parsing and streaming of cached geometry with deferred hash computation and yielding before heavy decode operations.

  ### New Features

  - **Zero-copy benchmark suite**: Added comprehensive benchmark suite to measure zero-copy performance improvements and identify bottlenecks.

  - **GPU geometry API**: Added new GPU-ready geometry API with pre-interleaved vertex data, pre-converted coordinates, and pointer-based direct WASM memory access.

  ### Bug Fixes

  - **Fixed O(n²) batch recreation**: Eliminated inefficient batch recreation in zero-copy streaming pipeline.

  - **Updated WASM and TypeScript definitions**: Updated WASM bindings and TypeScript definitions for geometry classes to support zero-copy operations.

- Updated dependencies [ed8f77b]
  - @ifc-lite/ifcx@1.2.0

## 1.2.0

### Minor Changes

- [#66](https://github.com/louistrue/ifc-lite/pull/66) [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5) Thanks [@louistrue](https://github.com/louistrue)! - ### New Features

  - **IFC5 (IFCX) Format Support**: Added full support for IFC5/IFCX file format parsing, enabling compatibility with the latest IFC standard
  - **IFCX Property/Quantity Display**: Enhanced viewer to properly display IFCX properties and quantities
  - **IFCX Coordinate System Handling**: Fixed coordinate system transformations for IFCX files

  ### Bug Fixes

  - **Fixed STEP Escaping**: Corrected STEP file escaping issues that affected IFCX parsing
  - **Fixed IFC Type Names**: Improved IFC type name handling for better compatibility

- [#39](https://github.com/louistrue/ifc-lite/pull/39) [`f4fbf8c`](https://github.com/louistrue/ifc-lite/commit/f4fbf8cf0deef47a813585114c2bc829b3b15e74) Thanks [@louistrue](https://github.com/louistrue)! - ### New Features

  - **Type visibility controls**: Toggle visibility of spatial elements (IfcSpace, IfcOpeningElement, IfcSite) in the viewer toolbar
  - **Enhanced CSG operations**: Improved boolean geometry operations using the `csgrs` library for better performance and accuracy
  - **Full IFC4X3 schema support**: Migrated to generated schema with all 876 IFC4X3 types

  ### Bug Fixes

  - **Fixed unit conversion**: Files using millimeters (.MILLI. prefix) now render at correct scale instead of 1000x too large
  - **Fixed IFCPROJECT detection**: Now scans entire file to find IFCPROJECT instead of only first 100 entities, fixing issues with large IFC files

- [#66](https://github.com/louistrue/ifc-lite/pull/66) [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5) Thanks [@louistrue](https://github.com/louistrue)! - ### Performance Improvements

  - **Lite Parsing Mode**: Added optimized parsing mode for large files (>100MB) with 5-10x faster parsing performance
  - **On-Demand Property Extraction**: Implemented on-demand property extraction for instant property access, eliminating upfront table building overhead
  - **Fast Semicolon Scanner**: Added high-performance semicolon-based scanner for faster large file processing
  - **Single-Pass Data Extraction**: Optimized to single-pass data extraction for improved parsing speed
  - **Async Yields**: Added async yields during data parsing to prevent UI blocking
  - **Bulk Array Extraction**: Optimized data model decoding with bulk array extraction for better performance
  - **Dynamic Batch Sizing**: Implemented dynamic batch sizing for improved performance in IFC processing with adaptive batch sizes based on file size

  ### New Features

  - **On-Demand Parsing Mode**: Consolidated to single on-demand parsing mode for better memory efficiency
  - **Targeted Spatial Parsing**: Added targeted spatial parsing in lite mode for efficient hierarchy building

  ### Bug Fixes

  - **Fixed Relationship Graph**: Added DefinesByProperties to relationship graph in lite mode
  - **Fixed On-Demand Maps**: Improved forward relationship lookup for rebuilding on-demand maps
  - **Fixed Property Extraction**: Restored on-demand property extraction when loading from cache

### Patch Changes

- [#66](https://github.com/louistrue/ifc-lite/pull/66) [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5) Thanks [@louistrue](https://github.com/louistrue)! - ### Bug Fixes

  - **Fixed Color Parsing**: Fixed TypedValue wrapper handling in color parsing
  - **Fixed Storey Visibility**: Fixed storey visibility toggle functionality
  - **Fixed Background Property Parsing**: Added background property parsing support
  - **Fixed Geometry Support**: Added IfcSpace/Opening/Site geometry support
  - **Fixed TypeScript Generation**: Fixed TypeScript generation from EXPRESS schema types
  - **Fixed Renderer Safeguards**: Added renderer safeguards for proper IFC type names

- [#52](https://github.com/louistrue/ifc-lite/pull/52) [`f7133a3`](https://github.com/louistrue/ifc-lite/commit/f7133a31320fdb8e8744313f46fbfe1718f179ff) Thanks [@louistrue](https://github.com/louistrue)! - ### Performance Improvements

  - **Zero-copy WASM memory to WebGPU upload**: Implemented direct memory access from WASM linear memory to WebGPU buffers, eliminating intermediate JavaScript copies. This provides 60-70% reduction in peak RAM usage and 40-50% faster geometry-to-GPU pipeline.

  - **Optimized cache and spatial hierarchy**: Eliminated O(n²) lookups in cache and spatial hierarchy builder, implemented instant cache lookup with larger batches, and optimized batch streaming for better performance.

  - **Parallelized data model parsing**: Added parallel processing for data model parsing and streaming of cached geometry with deferred hash computation and yielding before heavy decode operations.

  ### New Features

  - **Zero-copy benchmark suite**: Added comprehensive benchmark suite to measure zero-copy performance improvements and identify bottlenecks.

  - **GPU geometry API**: Added new GPU-ready geometry API with pre-interleaved vertex data, pre-converted coordinates, and pointer-based direct WASM memory access.

  ### Bug Fixes

  - **Fixed O(n²) batch recreation**: Eliminated inefficient batch recreation in zero-copy streaming pipeline.

  - **Updated WASM and TypeScript definitions**: Updated WASM bindings and TypeScript definitions for geometry classes to support zero-copy operations.

- Updated dependencies [[`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5)]:
  - @ifc-lite/ifcx@1.2.0
