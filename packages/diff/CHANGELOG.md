# @ifc-lite/diff

## 0.7.0

### Minor Changes

- [#2529](https://github.com/LTplus-AG/ifc-lite/pull/2529) [`5086c57`](https://github.com/LTplus-AG/ifc-lite/commit/5086c5729b6ae8ad967aafa91d96dfdb37327599) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fingerprint an entity's resolved material names, so a re-specified element reads as modified

  `DataFingerprintInput` gains an optional `materials?: string[]`, hashed into `buildDataFingerprint` and surfaced as a `material` key by `buildComponentFingerprints`. Material was absent from the projection entirely, so an element whose material changed was reported as unchanged in every channel.

  Callers supply **resolved names**, never entity references: an `IfcMaterial`'s express id is reassigned on every save, so a reference comparison reports a change for every material-bearing element of every re-exported model. Names must be resolved through the full indirection (`IfcMaterialLayerSetUsage`, `IfcMaterialProfileSetUsage`, the layer/profile/constituent sets and their wrappers, `IfcMaterialList`), not just a directly attached `IfcMaterial`.

  The field is optional and an empty array hashes identically to omitting it, so an adapter that does not supply materials is unaffected: the `Materials` key is written only for an entity that names one, and no existing fingerprint moves.

## 0.6.0

### Minor Changes

- [#2018](https://github.com/LTplus-AG/ifc-lite/pull/2018) [`d42fbf1`](https://github.com/LTplus-AG/ifc-lite/commit/d42fbf1c7a4abed637b7e80e28cbed69088bc943) Thanks [@louistrue](https://github.com/louistrue)! - Report WHICH tier produced each content match ([#1891](https://github.com/LTplus-AG/ifc-lite/issues/1891)). `ContentMatch` gains an optional `tier: ContentMatchTier` — `'geometry-hash'` (tier 1, an agreeing world geometry hash), `'residue-1-1'` (tier 2, the 1:1 leftover resting on the data hash alone), `'positional'` (tier 3, mutual nearest neighbour on bounding-box centres), or `'unresolved'` (a reported `duplicated`/`deduplicated`/`ambiguous` group, which retires nothing).

  `kind` says what the pass claims happened; `tier` says on what evidence, and the two are independent. A `renamed` can come from an agreeing world hash or from the pass's one destructive path — the same record, two very different amounts of evidence — so a consumer that wants to weigh a match, or a validation harness that wants to score the tiers separately, had no way to tell them apart. Inference does not close the gap: `renamed`-with-equal-hashes is reachable from both tier 1 and tier 3, which is exactly the ambiguity that matters on a model full of repeated components.

  Additive and optional, so existing consumers are unaffected. Every record the pass emits now carries it.

- [#2015](https://github.com/LTplus-AG/ifc-lite/pull/2015) [`0adb741`](https://github.com/LTplus-AG/ifc-lite/commit/0adb7413b869c9d50bdcdae5c00a730d17c2823f) Thanks [@louistrue](https://github.com/louistrue)! - `EntityFingerprint` gains an optional `volume` — the enclosed volume of the entity's geometry, in the caller's units cubed (issue [#1891](https://github.com/LTplus-AG/ifc-lite/issues/1891)).

  Purely additive: no existing option reads it, and a diff that supplies it is byte-identical to one that does not until `detectSplitMerge` is enabled.

  Absent means **not proved** — never zero, and never "differs". The producer this contract was written against emits a value only where the meshed geometry was provably a single closed orientable solid, so roughly a third of a real model's elements carry none. That is what makes the field usable while sparse: the engine treats it asymmetrically, requiring a COMPLETE set of volumes before one can confirm a claim while letting a PARTIAL sum already refute one. A `NaN`, zero or negative value is ignored exactly as if the field were absent; resolve your producer's absent-sentinel at its boundary rather than passing one through.

- [#2015](https://github.com/LTplus-AG/ifc-lite/pull/2015) [`0adb741`](https://github.com/LTplus-AG/ifc-lite/commit/0adb7413b869c9d50bdcdae5c00a730d17c2823f) Thanks [@louistrue](https://github.com/louistrue)! - Add opt-in **split / merge detection** to `diffModels` (issue [#1891](https://github.com/LTplus-AG/ifc-lite/issues/1891)) — one wall that became three, three panels that became one slab. Neither is a rename, a move or a reshape, so content matching left all four elements sitting in the residue as unrelated adds and deletes.

  `detectSplitMerge: true` (effective only alongside `matchUnpairedByContent`) adds a fourth stage over that residue and reports what it finds on `ModelDiff.splitMerges`, as `SplitMergeClaim`s.

  **Purely additive.** A claim never retires a `DiffEntry` and never touches `counts`: a split binds `k + 1` entities on ONE evidence chain, so a single wrong claim would delete `k + 1` real changes. A UI groups the underlying add/deletes under the claim. For the same reason no claim ever becomes an identity-map entry — identity is not a relation that survives being split. Running on the residue rather than on the raw diff is load-bearing too: renames and moves must be retired first, or a re-GUIDed wall plus one genuinely-new fixture inside its box fakes a volume-conserving "split" out of two unrelated things.

  `confidence` names three evidence profiles instead of scoring them, because the difference between them is a difference in KIND of evidence: `verified` (pieces inside the whole's extent + complete volumes agreeing within `splitVolumeTolerance`), `extent` (inside the extent + per-axis interval coverage, volume missing somewhere and never refuted), and `displaced` (a cluster that moved out of the old extent, accepted only on complete volumes, congruent sorted extents, and a pairing unique in both directions).

  Volume is used **asymmetrically**, which is what makes the sparse new `EntityFingerprint.volume` useful: as proof it requires completeness, as refutation a partial sum already suffices — if what is known overruns the whole, no unknown brings it back down. A failed volume test is a REFUTATION, never a reason to fall back to the weaker tier; the extent tier exists for the absence of evidence only. Subsets are never enumerated: the tolerance is exactly why, since a widened band lets several subsets qualify and a non-unique answer is an abstention here. The one bounded exception is a single same-class interloper inside the container whose own volume explains the whole overshoot, which is reported on `claim.excluded`.

  Defaults: `splitVolumeTolerance` 0.03, `splitPaddingMin` 0.05, `splitPaddingRatio` 0.01, `maxSplitPieces` 256 (a performance bail, never a semantic rule — a precast slab field really is dozens of panels). All four are coerced through the same non-finite guard as the existing tolerances.

  `ModelDiff.splitMerges` is **absent** rather than empty when the stage did not run — off, without `matchUnpairedByContent`, or under either geometry abstention. Presence records that the detector ran; emptiness records that it ran and found nothing. The two are different answers and a caller may rely on the distinction.

  New exported types: `SplitMergeClaim`, `SplitMergeConfidence`, `SplitMergeKind`. Default `false` — existing callers get byte-identical results.

  What it deliberately cannot see is documented rather than hidden: cross-class splits, two or more same-class interlopers in one container, `extent` firing on a redesign in place or on a perimeter enclosing an unfilled middle, `displaced` abstaining between two congruent clusters in a repetitive building, moved splits under a non-90° rotation, and a real split that changed more than 3% of its material while carrying full volume data.

- [#1992](https://github.com/LTplus-AG/ifc-lite/pull/1992) [`dc000cf`](https://github.com/LTplus-AG/ifc-lite/commit/dc000cff25a647d2a224f34a063f84b3d2d84ca8) Thanks [@louistrue](https://github.com/louistrue)! - **diff**: content matching can now produce and consume an **identity map**, so an accepted match from one comparison feeds the next and re-GUIDed elements stop reappearing as churn on every run (issue [#1891](https://github.com/LTplus-AG/ifc-lite/issues/1891)).

  - `identityMapFromContentMatches(diff.contentMatches)` derives `{ base, here, reason }` claims — the same vocabulary a published layer carries in its provenance manifest `identity_map`. Claims are minted only from matches the engine committed to (a 1:1 `renamed`, `moved`, or `reshaped`). `ambiguous`, `duplicated`, and `deduplicated` groups mint nothing, and neither does an N:N `renamed` group: every bijection there is observationally identical, so picking one would write a coin flip down as fact. `reason` records the evidence (`content-match:renamed`) rather than a bare `"derived"`.
  - `DiffOptions.keyAliases` (head key → base key) replays accepted claims as key normalization _before_ the key-based pass indexes anything, so an aliased pair is classified by key and never reaches the content pass. `DiffEntry.key` becomes the base key while the head entity keeps its own key on `entry.head.key` — nothing in either file is rewritten. A stale alias, an alias onto a key another live head entity holds, or two aliases claiming one base key are all dropped, degrading to the un-aliased result rather than throwing or fabricating an entry; `ModelDiff.appliedKeyAliases` echoes back what took effect.
  - A JSON sidecar (`createIdentityMapSidecar`, `serializeIdentityMapSidecar`, `parseIdentityMapSidecar`, `validateIdentityMapSidecar`, `identityMapSidecarMismatches`, `keyAliasesFromSidecar`) carries claims for plain-file workflows, pinning the content digest of **both** revisions they were verified against. A floating rename list says nothing about which two files a human reviewed; the pin is how a consumer refuses one replayed against the wrong pair. A document that claims two different `base` identities for one `here` key is refused outright, alongside an unknown version and a malformed entry: it is self-contradictory against _every_ pair of files, so applying either claim would be picking an arbitrary winner and writing it back out as if it had been reviewed.

  Purely additive: omitting `keyAliases` leaves existing callers byte-identical.

  **cli**: `ifc-lite diff` gains `--by-content`, `--identity-out <file>`, and `--identity-in <file>`. `--by-content` routes the two files through the real `@ifc-lite/diff` engine with content-keyed matching, so a from-scratch re-export stops reading as "everything was deleted and re-added"; the identity flags write and replay the sidecar. `--identity-out` is reproducible: identical inputs write byte-identical output, so a checked-in sidecar produces an empty git diff when nothing changed. The path compares **data only** — the Node CLI has no geometry pipeline, so it passes `scope: 'data'` rather than pretending to see shape changes. The default behaviour of `ifc-lite diff` (type counts, `--by-entity`) is unchanged.

  `--identity-out` refuses to run when it names either input model, comparing the resolved paths and — when the target already exists — the actual file behind them, so a symlink, a hard link or a case-insensitive filesystem cannot let a JSON sidecar land on top of an IFC file. An unreadable input model is reported with its path and the underlying error instead of raising a bare `ENOENT`, and the command now requires exactly two positional paths rather than quietly diffing the first two of three.

  `--by-content` compares every `IfcObjectDefinition`, decided from the schema registry's inheritance chain rather than from whether the columnar parser kept the entity in its `EntityTable`. Two consequences: non-product `IfcObject`s — `IfcTask`, `IfcActor`, `IfcWorkPlan`, construction resources — are compared for the first time (the table does not hold them, so they reported an empty GlobalId and dropped out silently), and resource entities that are not `IfcRoot` at all stop being compared under a false key. The parser fills the table's GlobalId column positionally, so an `IfcMaterial`, `IfcSurfaceStyle`, `IfcClassification` or `IfcProjectedCRS` was entering the comparison keyed on its _Name_ — which on the bundled sample models meant 7–9 colliding keys per file, a material and a surface style of the same name landing on one entry. `IfcRelationship` and `IfcPropertyDefinition` stay out, now by rule rather than by accident.

- [#2033](https://github.com/LTplus-AG/ifc-lite/pull/2033) [`2716893`](https://github.com/LTplus-AG/ifc-lite/commit/2716893ac9d825fc529f3fd8164d9a6f766e87f8) Thanks [@louistrue](https://github.com/louistrue)! - **diff**: `buildDataFingerprint` and `buildComponentFingerprints` now hash a new optional `DataFingerprintInput.tag`, and it belongs to **type objects only**. A type object carries no geometry hash, so its data fingerprint is the whole of the evidence a content match has about it — and same-named types are ordinary: the Duplex sample has eight `IfcFurnitureType` entities all named `800 mm`, identical in every other hashed attribute and separable only by `Tag`. They shared one content bucket and `matchUnpairedByContent` correctly abstained on all eight. Measured on the content-matching fixture (`scripts/xmatch`), recall on geometry-less objects went from 0.468 to 1 on Duplex, 0.680 to 0.880 on AC20-FZK-Haus and 0.718 to 0.768 on a Revit export, with precision staying at 1.000 and zero false pairs throughout.

  Supply `tag` for an `IfcTypeObject` subtype and **not** for an occurrence — that is what the CLI, MCP and viewer adapters do, deciding it from the cross-schema inheritance chain. `IfcElement.Tag` is the authoring tool's own element id (Revit writes its `ElementId`), so two tools exporting one design disagree on it for every element; since `dataHash` is the content bucket key, hashing it on occurrences would break exactly the re-export matching this pass exists for. Re-tagging a type does not move the fingerprint of any element assigned to it: type assignments still project the assigned type's name and IFC class only.

  **Every cached fingerprint is invalidated.** `buildDataFingerprint` and `buildComponentFingerprints` (its `attr:core` sub-hash) return different strings for the same input than they did before, whether or not you supply a `tag` — the projection now always carries a `Tag` field. Nothing in this repo persists these values, and base and head are always fingerprinted by the same build, so a normal diff, merge or compare is unaffected. Any caller that has stored fingerprints across sessions must recompute them; comparing a pre-upgrade hash with a post-upgrade one reports everything as changed. Stored identity-map sidecars are not affected: they carry GlobalId aliases and model digests, no fingerprint values.

  **cli**: `ifc-lite diff --by-content` now tells two same-named type objects apart when they differ only in `Tag`, so a re-export whose furniture, door and window _types_ share a name no longer reports them as an unresolved ambiguous group. On the Duplex sample the command abstained on 25 of 47 geometry-less objects and now pairs all 47. Two consequences to expect: pairs you previously had to resolve by hand are now reported as `renamed`, and a type object whose `Tag` genuinely changed between the two files now reports as added and deleted rather than matched, because its content really did change. An ordinary element's `Tag` is still not compared, so nothing about occurrence matching moves. Fingerprints from this version do not compare against fingerprints from an older one; replaying an existing identity-map sidecar is unaffected, since a sidecar stores GlobalIds rather than hashes.

  The lookup also spans every bundled schema, so `Tag` is now found on IFC4X3-only type objects (`IfcRailType`, `IfcTrackElementType`, `IfcSignalType`, …). Routed through the IFC4 codegen pin it silently found nothing on those classes, which meant infrastructure models got none of the benefit above while IFC2X3 and IFC4 models got all of it.

  **mcp**: the same change to `model_diff` with `by_content: true`, from the same adapter — same-named type objects are separated by `Tag`, so an agent gets `renamed` pairs where it used to get an ambiguous group it could not act on, including on IFC4X3 infrastructure classes. `entity_set_attribute` on `Tag` now moves the fingerprint of a queued-edit **type object** (and only a type object), so `model_diff` reflects that edit instead of ignoring it. Hash values differ from previous versions, so anything an agent stored and compares across an upgrade must be recomputed.

- [#1989](https://github.com/LTplus-AG/ifc-lite/pull/1989) [`620f4d2`](https://github.com/LTplus-AG/ifc-lite/commit/620f4d2100b397d33d2e61440950b7a31660dbb8) Thanks [@louistrue](https://github.com/louistrue)! - **diff**: make `matchUnpairedByContent` work on models full of repeated components.

  Unpaired entities were bucketed by (`ifcType`, `dataHash`) and paired only when a bucket held exactly one entity per side. A real model is mostly repeated components, so that paired only the unique minority: three data-identical doors at three different unmoved positions, all re-GUIDed by a re-export, landed in one bucket, reported a single `ambiguous` group, and pairs nothing at all.

  Each bucket is now refined hierarchically from the inside. Geometry stays out of the _outer_ bucket key on purpose — with it there, an element that genuinely moved would never meet its own previous revision and every real move would revert to add+delete noise.

  - entities carrying a `geometryHash` are sub-bucketed by it. One per side, or the same count `N` on both sides, retires as `renamed`. `undefined` hashes are excluded: `undefined` agreeing with `undefined` is vacuous, not evidence.
  - a 1:1 leftover pairs as `renamed`, `moved`, or the new `reshaped` kind.
  - an N:M leftover is paired by iterated mutual nearest neighbour under a distance cap — a base and a head pair only when each is the other's _unique_ nearest — which abstains by construction on a symmetric layout instead of guessing. The collision guard is part of that pairing test, so a pair it rejects stays in the candidate pool and the later rounds still see it. Groups above 128 per side report as `ambiguous`.

  New API:

  - `EntityFingerprint.aabb?: { min, max }` — optional world-space bounding box, both revisions in the same frame and units. It separates `moved` from `reshaped`, carries `ContentMatch.distance`, and enables the positional pairing above. Without it the pass degrades to the previous behaviour: `moved` for a 1:1 leftover, `ambiguous` for a group.
  - `ContentMatchKind` gains `'reshaped'` — the bounding boxes changed size, or agreed entirely while the geometry hash changed (a re-tessellation). An axis-aligned box cannot separate a re-tessellation from a reshape confined to the interior, and this does not pretend it can.
  - `ContentMatch.distance?: number` — centre displacement in the caller's units, clamped to `0` below `moveTolerance`.
  - `DiffOptions.moveTolerance` (default `2e-3`), `reshapeTolerance` (default `1e-3`), `maxMoveDistance` (default `10`). The two tolerances are lifted from `MOVE_EPS`/`RESHAPE_EPS` in the viewer's `describeChange.ts`, which encode issue [#1197](https://github.com/LTplus-AG/ifc-lite/issues/1197) (a phantom "moved 1.09 m" on a wall that never moved).

  Also fixed, in **both** matching passes: when one revision was fingerprinted by a build that produces geometry hashes and the other by a build that does not, every one-sided `undefined` read as "the geometry differs". The content pass reported the whole model as `moved`; the key-based pass reported every key-matched entity as `modified` with `changeKinds: ['geometry']`, so two revisions that may be identical read as a wholly changed model. Neither pass now uses geometry to classify anything in that case — a capability difference between two fingerprinting runs is not a model change. Both derive the decision from one shared helper so they cannot drift apart. The abstention needs a _whole side_ to carry no hashes: with both sides hashing, a single entity gaining or losing geometry is still a real change and is still reported, and `excludeTypes` is applied before the scan so a dropped entity is not evidence that its side hashes.

  **`DiffCounts` changes for that previously broken case, and only for it.** A mixed-capability comparison that used to return every matched entity as `modified`/`['geometry']` now returns them as `unchanged` (or `modified` on data alone under `scope: 'both'`/`'data'`): `counts.modified` falls and `counts.unchanged` rises by the same number. This is a false positive being replaced with the truth, not a lost signal, and it applies whether or not `matchUnpairedByContent` is set. The cost is the mirror case: a base revision that genuinely carries no geometry at all, compared against a head that added geometry to everything, is indistinguishable from a capability difference and now reports `unchanged`. `DiffState` and `DiffEntry` are unchanged in shape.

  Behaviour change for existing callers of `matchUnpairedByContent`: a bucket with `N` entities per side that agree on both the data hash and the world geometry hash now retires as one `renamed` match carrying all `N` per side, where it previously reported an `ambiguous` group and retired nothing. `renamed` therefore no longer implies exactly one entity per side; `moved`/`reshaped` still do. `DiffState`, `DiffEntry`, and `DiffCounts` are unchanged, so exhaustive switches over `DiffState` keep compiling.

- [#1987](https://github.com/LTplus-AG/ifc-lite/pull/1987) [`ed63063`](https://github.com/LTplus-AG/ifc-lite/commit/ed63063c952bd1804ce83922da80635f03c77193) Thanks [@louistrue](https://github.com/louistrue)! - **diff**: widen `stableHash` from 32-bit to 64-bit FNV-1a (offset basis `0xcbf29ce484222325`, prime `0x100000001b3`, the same offset basis and prime as `rust/processing/src/determinism.rs`, though not byte-compatible with it: this walks UTF-16 code units and the Rust side hashes bytes, so only ASCII input agrees). Output is now 16 zero-padded lowercase hex chars instead of up to 8.

  `matchUnpairedByContent` treats `dataHash` equality as identity — its 1:1 branch retires a real `added` and a real `deleted` — and 32 bits was too narrow for that: collisions between plausible IFC content were findable by enumeration, and exposure grows with the square of the number of fingerprints compared.

  **diff**: `buildDataFingerprint` and `buildComponentFingerprints` no longer hash the assigned type's `GlobalId`; an assigned type is now identified by its `name` and its IFC class. `IfcTypeObject` is an `IfcRoot`, so a from-scratch re-export regenerates the _type's_ GlobalId along with every product's — which changed the content hash of every _typed_ element (walls, doors, windows: most of a real model) on exactly the re-export where nothing substantive changed, and made those elements unable to content-match. `TypeAssignmentInput.globalId` is kept as a field and still accepted, it just no longer participates in any hash. The trade is a real loss of discrimination: two _different_ type entities that share a name and an IFC class now look identical, so re-pointing an element between them does not move its `dataHash`. That needs duplicate type names within one class, and only shows on elements otherwise identical in every attribute, property and quantity.

  **Every fingerprint value changes.** `stableHash`, `buildDataFingerprint`, and `buildComponentFingerprints` all return different strings for the same input than they did before. Nothing in this repo persists these values — base and head are always fingerprinted by the same build, so a normal diff or merge is unaffected — but any caller that has stored fingerprints across sessions and compares old values to new ones must recompute them. Comparing a pre-upgrade hash with a post-upgrade one reports everything as changed.

  **merge**: `snapshotOf` is built on `@ifc-lite/diff`'s `stableHash`, so the `hash` on every `ComponentSnapshot` it returns — and on the `ComponentSnapshot`s carried by `MergeConflict` — changes value with this release. Nothing about the API's shape or its equality semantics changes: two snapshots of the same attributes still hash equal, and a merge or conflict detection run entirely on this version behaves exactly as before. **Stored snapshots do not compare equal across the upgrade**: a hash persisted by an older version will not match the one this version computes for the same attributes, and any comparison that spans the two reports a spurious difference. Recompute rather than migrate. This is an explicit `minor` rather than the automatic dependency `patch` changesets would otherwise apply, because the observable output of a public export changed.

  The collision guards in `diffModels` (bucket by `ifcType`, require `components` agreement) are unchanged, as is the documented residual: a collision confined to `attr:core` still cannot be detected, because FNV-1a's per-character update is a bijection on its state at any width. `buildComponentFingerprints` deliberately drops the type's `GlobalId` too, rather than keeping it as extra collision evidence: the guard's soundness rests on components hashing slices of exactly what `dataHash` hashes whole, and a `type-assignment` sub-hash that saw the GlobalId would veto the genuine re-export matches this release enables.

### Patch Changes

- [#1999](https://github.com/LTplus-AG/ifc-lite/pull/1999) [`7261f1a`](https://github.com/LTplus-AG/ifc-lite/commit/7261f1a6a8595350d3ec400212e293a8924d57bf) Thanks [@louistrue](https://github.com/louistrue)! - **diff**: make the canonical sorts a total order, so `dataHash` cannot depend on the order an adapter walked its relationships.

  `sortedEntries`, `sortedPropertySets` and `sortedQuantitySets` ordered records by `name` alone. `Array.prototype.sort` is stable, so two records sharing a name kept their _input_ order — and the sorted result is serialized and hashed, so the same content supplied in two orders produced two different fingerprints. Same-named property sets are an ordinary IFC arrangement (a type pset and an occurrence pset of one name), so this was reachable, not theoretical.

  Records now tiebreak on their own serialized content. Fingerprint values change only for entities that actually carry same-named collections; everything else is byte-identical.

## 0.5.0

### Minor Changes

- [#1961](https://github.com/LTplus-AG/ifc-lite/pull/1961) [`15f5335`](https://github.com/LTplus-AG/ifc-lite/commit/15f53357f30a38d6aef7c9e4394c14400f5222e5) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Add opt-in content-keyed matching to `diffModels` for comparing model revisions where GlobalIds are unreliable (issue [#1891](https://github.com/LTplus-AG/ifc-lite/issues/1891)). A model re-exported from scratch gets entirely new GlobalIds, so the existing GlobalId-keyed diff reports every element as deleted-and-added even when nothing substantive changed.

  Pass `{ matchUnpairedByContent: true }` to run a second pass, after the normal key-based pass, over the entities that came out `added`/`deleted`. It buckets them by `EntityFingerprint.dataHash` and reports the result via the new `ModelDiff.contentMatches: ContentMatch[]` field:

  - exactly one leftover base entity and one leftover head entity sharing a data hash is an unambiguous match, reported as `renamed` (geometry hash also agrees — only the identity changed) or `moved` (it doesn't). The corresponding `added`/`deleted` pair is removed from `entries`/`byKey`/`counts` in favor of this single record. Under `scope: 'data'`, where the caller has excluded geometry from the comparison, every 1:1 match is reported as `renamed` rather than deriving `moved` from an out-of-scope signal.
  - more than one candidate on either side is `duplicated` (one base entity, several head entities), `deduplicated` (several base entities, one head entity), or `ambiguous` (more than one on both sides).

  **Collision policy.** `dataHash` is a 32-bit FNV-1a value — collisions between genuinely different content are reachable rather than theoretical, and the tests pin three real ones. The 1:1 path is the only destructive one — it retires a real `added` and a real `deleted`. It therefore also requires the two entities to agree on `ifcType` (already part of the hashed payload, so this can never reject a genuine match) and, when both sides supply `components`, on every component sub-hash. This narrows the window without closing it: FNV-1a's per-character update is a bijection on its 32-bit state, so a collision between two entities differing only in `Name` also collides `attr:core` and is undetectable here. The component check bites when the differing content sits in a pset/qset slice. Ambiguous groups retire nothing, so a collision landing in one only costs an extra candidate to inspect.

  **Ambiguity policy.** Ambiguous/duplicated/deduplicated groups are reported as-is — every candidate on both sides, via `ContentMatch.base`/`.head` — and the original `added`/`deleted` entries are left untouched in `entries` rather than collapsed into a guessed pairing. The alternative considered and rejected was picking the first candidate on each side (`candidates[0]`-style); the repo shipped exactly that class of silent-pick bug last week ([#1923](https://github.com/LTplus-AG/ifc-lite/issues/1923)), and there is no principled way to decide _which_ base entity became _which_ head entity when several share a content hash. Resolving the group to a specific pairing, if desired, is left to the caller.

  `DiffState`/`DiffEntry` are deliberately unchanged — a content match is reported only via the new `contentMatches` field, never by inventing a new `DiffEntry.state`, so an existing exhaustive `switch`/`Record` over `DiffState` elsewhere in a consumer keeps compiling unmodified.

  Split and Merged (detecting a _partial_ geometric overlap between one entity and several others, as requested in [#1891](https://github.com/LTplus-AG/ifc-lite/issues/1891)) are deliberately not implemented: they need a geometric-similarity threshold and a policy for partial overlap that has no single correct answer. Left for a follow-up once that policy is decided.

  Default `false` (unset) — existing callers of `diffModels` get byte-identical results; this is purely additive.

  Not wired into the viewer's Compare panel, the MCP `diff` tool, or the CLI in this change — those are separate reviews.

## 0.4.0

### Minor Changes

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Layer PRs foundation (docs/architecture/layer-prs):

  - **ifcx**: deletion-overlay tombstones (`ifclite::deleted`) with shadow/resurrect semantics and child-path shadowing in both composition engines; `bakeLayers` tombstone-free materialization; canonical serialization with blake3 content addressing (`computeLayerId`, `computeStackHash`); provenance manifest v1 (`createProvenanceManifest`, `getProvenance`/`setProvenance`, `validateProvenance`).
  - **diff**: opt-in per-componentKey sub-hash mode (`buildComponentFingerprints`) and `changedComponents` on diff entries; the whole-blob `dataHash` default is unchanged.
  - **extensions**: scope-claim grammar — capability expressions extended with entity selectors (`model.mutate:Pset_FireSafety*@IfcWall&storey=EG`), with grant-coverage and op-level enforcement matching.
  - **mutations**: `changeSetToOps` expressId→GlobalId bridge with blake3 content-derived identity fallback recorded for the manifest `identity_map`.
  - **collab**: `extractMinimalLayer` now expresses deletions (entity tombstones plus `null` removals), closing the documented additive-only deferral; new `publishLayer` freezes a draft into an immutable, content-addressed, provenance-stamped layer.
  - **merge** (new package): three-way merge engine over (entity, componentKey) states with explicit conflict records, resolution application, merge-layer emission with `manifest.merge`, revert (inverse-op layers), and rebase.

## 0.3.2

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

## 0.3.1

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

## 0.3.0

### Minor Changes

- [#1559](https://github.com/LTplus-AG/ifc-lite/pull/1559) [`d942bed`](https://github.com/LTplus-AG/ifc-lite/commit/d942bedffe31d0a682c1aa8bb9fe3e3dc0f63104) Thanks [@louistrue](https://github.com/louistrue)! - Add `excludeTypes` to `diffModels` - a blacklist of IFC classes to leave out of the comparison entirely (issue [#1470](https://github.com/LTplus-AG/ifc-lite/issues/1470)). An entity whose `ifcType` matches is dropped from both revisions before matching, so it never appears in `entries`, `byKey`, or `counts`. This is how the viewer's Compare panel lets a user ignore connective noise like `IfcOpeningElement` (the void a removed window leaves behind), which reads as a spurious deletion on its own. Matching is case-insensitive and trims whitespace; the applied, normalized blacklist is echoed on the result as `ModelDiff.excludedTypes` (empty when nothing was excluded). Backward compatible: omitting `excludeTypes` is unchanged behaviour.

## 0.2.1

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.

## 0.2.0

### Minor Changes

- [#939](https://github.com/LTplus-AG/ifc-lite/pull/939) [`90060b7`](https://github.com/LTplus-AG/ifc-lite/commit/90060b7eaad7a07bdab13907c1b52bb24fbc8597) Thanks [@louistrue](https://github.com/louistrue)! - New package `@ifc-lite/diff`: a headless, store-agnostic model-diff engine.
  `diffModels` classifies entities across two revisions as added / modified /
  deleted / unchanged, with a `scope` toggle (`data` | `geometry` | `both`) that
  selects whether attribute/property differences, geometry-fingerprint
  differences, or both count as a modification. Ships `buildDataFingerprint` (a
  canonical, order-independent data hash) and consumes the RTC-invariant geometry
  hashes exposed from the WASM mesh pass.
