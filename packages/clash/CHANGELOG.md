# @ifc-lite/clash

## 1.6.6

### Patch Changes

- [#2571](https://github.com/LTplus-AG/ifc-lite/pull/2571) [`495cc38`](https://github.com/LTplus-AG/ifc-lite/commit/495cc388ea95f6e55aee76ea37bcf6d11c99558b) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Report it when `groupClashes({ by: 'cluster' })` consolidates nothing, instead of silently returning one group per clash.

  Measured on a real MEP model (self-clash among drainage `IfcFlowSegment`s, distribution-run contact points scattered several metres apart): cluster grouping at the default 1.5 m epsilon produced 15 groups from 18 clashes — barely different from no grouping at all. The default epsilon was investigated separately and deliberately kept: across 12 public models there is no defensible constant (raising it to 2.0 m collapses an unrelated structural model's 10 real clashes into one group), so this is not a tuning fix.

  Adds `isClusterGroupingIneffective(clashes, groups)` to `@ifc-lite/clash`: a narrow, exact check — true only when every clash landed in its own singleton group (`groups.length === clashes.length`, with more than one clash) — deliberately not a fuzzy "mostly ineffective" threshold, which would repeat the epsilon problem with a different undefensible constant.

  `ifc-lite clash --bcf ... --group cluster` now prints a stderr note when this fires, naming the other grouping modes (`rule`, `typePair`, `element`) rather than picking one — none of them is a reliable universal answer either: on the measured model, `--group element` produced _more_ groups than clashes (33 from 18), since it files each clash under both participating elements rather than merging along the run.

- [`081ed7e`](https://github.com/LTplus-AG/ifc-lite/commit/081ed7e7e38072ecb307c01c0512cd911be886a6) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Stop treating spatial containers as clash bodies in the STEP adapter.

  `NON_CLASHABLE_TAGS` dropped `IfcSpace` and `IfcSpatialZone` ([#1464](https://github.com/LTplus-AG/ifc-lite/issues/1464)) but nothing else from the spatial structure, so any container that carries tessellated geometry became a clash body and collided with the elements assigned to it. That is not a coordination problem — a storey's geometry is its extent, and by construction it encloses its contents.

  It bites hardest on IFC4.3 infrastructure models, where storeys and facility parts routinely carry real bodies. On one road/bridge certification model a default `ifc-lite clash` run reported 235 clashes, of which 89 (37.9%) were an `IfcBuildingStorey` against an element it contains.

  The check is now derived from the schema instead of enumerated: an element is dropped when `getInheritanceChainAcrossSchemas` puts `IfcSpatialElement` or `IfcSpatialStructureElement` in its chain. That walks the bundled IFC2X3 + IFC4 + IFC4X3 union, so `IfcSite`, `IfcBuilding`, `IfcBuildingStorey`, `IfcExternalSpatialElement` and the IFC4.3 facility leaves (`IfcFacility`, `IfcFacilityPart`, `IfcBridge`, `IfcRoad`, `IfcRailway`, `IfcMarineFacility`, …) are all covered without a second hand-maintained list, and `IfcSpatialStructureElement` is checked alongside `IfcSpatialElement` because IFC2X3 has no `IfcSpatialElement`. The two hand-listed space entries are removed as redundant.

  Elements _contained in_ a container are unaffected — they still clash with each other, and still carry the storey name as metadata. Measured on the road/bridge model: 235 → 146 clashes, 89 pairs removed and none added, every removed pair involving `IfcBuildingStorey`. Building-model controls: 274 → 274 and 469 → 469 with byte-identical pair sets; 282 → 279 on a third, the three removed pairs all being the site's own terrain body.

  No API surface change.

## 1.6.5

### Patch Changes

- [#2424](https://github.com/LTplus-AG/ifc-lite/pull/2424) [`dae94e2`](https://github.com/LTplus-AG/ifc-lite/commit/dae94e23f7514945ca60f7074f50f196a90dfc5d) Thanks [@louistrue](https://github.com/louistrue)! - Cancel clash detection when the script run that asked for it ends.

  A sandbox run that exceeded `limits.timeoutMs`, or a sandbox disposed mid-run, stopped _waiting_ for `bim.clash.run` / `bim.clash.matrix` but never stopped the engine: it kept intersecting geometry to completion in the background, on the user's machine, for a result that was discarded on arrival. The bridge now hands every call an `AbortSignal` and aborts it on both paths, and the clash namespace forwards it as `ClashSettings.signal`.

  `@ifc-lite/sandbox` is a minor rather than a patch because `BridgeCallContext.hostSignal` is new capability surface for schema authors, reachable through the `@ifc-lite/sandbox/schema` subpath. Nothing was removed or renamed.

  `ClashSettings.signal` also now works the way its name implies. The TypeScript engine checked it periodically but only yielded to the event loop when an `onProgress` callback was supplied — and every realistic canceller (a deadline timer, a cancel button, a host teardown) fires _from_ the event loop, so without `onProgress` the flag could never flip mid-run. A caller that supplies a signal now gets the periodic yields too, the check runs every 256 candidate pairs rather than every 1024, and the signal is rechecked immediately after each yield, since the yield is the window the abort arrives in.

  One bound is worth stating plainly: those handlers can only run during a yield, and the first yield comes after ~50 ms of held thread time, so a run that finishes inside that window completes rather than cancelling. Cancellation is for runs long enough to be worth cancelling.

  No API changed shape: `ClashSettings.signal` already existed, and cancellation stays opt-in for direct engine callers.

- Updated dependencies [[`1843d9f`](https://github.com/LTplus-AG/ifc-lite/commit/1843d9f13a7a10183f780ae0a1df9dd225938e73), [`8b09cfd`](https://github.com/LTplus-AG/ifc-lite/commit/8b09cfdadafaea9806e79b73deb9119ea66b5aa4), [`d260a35`](https://github.com/LTplus-AG/ifc-lite/commit/d260a35669e379e5f465861294391c95ee48cb3d), [`a220406`](https://github.com/LTplus-AG/ifc-lite/commit/a2204062ba1fc555e4529896cbc82efccc7a5146), [`c866bee`](https://github.com/LTplus-AG/ifc-lite/commit/c866bee62a7d6e40b15a7de63948354cbbe049a7), [`262b9df`](https://github.com/LTplus-AG/ifc-lite/commit/262b9df485e4bfd3760f73c30d93bb518e599b72), [`2e16736`](https://github.com/LTplus-AG/ifc-lite/commit/2e167367037fa3b5d1d2d5d26dd4fb7ac169e2f5), [`d89960a`](https://github.com/LTplus-AG/ifc-lite/commit/d89960aaab08387fbd2307c0f238bd112c684933), [`51ec81b`](https://github.com/LTplus-AG/ifc-lite/commit/51ec81b125532cd0efe4f004c7ab01f4efe55cb8), [`958aef1`](https://github.com/LTplus-AG/ifc-lite/commit/958aef125743682da75c3da7b41991abd9d36d32), [`de7bd04`](https://github.com/LTplus-AG/ifc-lite/commit/de7bd04619a43a32900b188e0507b95e7542d8c8), [`09d67c7`](https://github.com/LTplus-AG/ifc-lite/commit/09d67c780bf68f58dec3f77920927857c752f8da)]:
  - @ifc-lite/bcf@1.17.0
  - @ifc-lite/query@1.14.16
  - @ifc-lite/ifcx@2.3.4
  - @ifc-lite/parser@4.0.0
  - @ifc-lite/geometry@3.7.1

## 1.6.4

### Patch Changes

- [#1877](https://github.com/LTplus-AG/ifc-lite/pull/1877) [`0cfb88b`](https://github.com/LTplus-AG/ifc-lite/commit/0cfb88b3ac3e5615c7e125c5076ea75cf2039a09) Thanks [@louistrue](https://github.com/louistrue)! - Report mesh-level penetration depth for contained contact pairs. When one element's AABB is contained in the other's, hard-clash findings previously reported the AABB signed gap (how deep the small box sits inside the big one) as the penetration depth, overstating depth for designed face contacts such as opening fills. Both the TS and WASM kernels now measure the depth at the crossing triangles' vertices (max point-to-surface inside the other solid), falling back to the AABB estimate only when no such vertex lies inside.

- Updated dependencies [[`0cfb88b`](https://github.com/LTplus-AG/ifc-lite/commit/0cfb88b3ac3e5615c7e125c5076ea75cf2039a09), [`35c157d`](https://github.com/LTplus-AG/ifc-lite/commit/35c157d9a0513f368e83c4884465b5ad162c6ba0), [`401ab18`](https://github.com/LTplus-AG/ifc-lite/commit/401ab1842662c4e8ca26eae01b879f0290962b6d), [`6842c56`](https://github.com/LTplus-AG/ifc-lite/commit/6842c56c72065fd9f43ac282cacb766b7808c282), [`6869d5c`](https://github.com/LTplus-AG/ifc-lite/commit/6869d5ced2d19ac4ab8b2591847f3ffd52236d14), [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f), [`b716fd7`](https://github.com/LTplus-AG/ifc-lite/commit/b716fd7b045c918dc1bd2ecc1da6fed21e59f110), [`428c5ae`](https://github.com/LTplus-AG/ifc-lite/commit/428c5ae54bac236a3950f451ee12a0dc23226336), [`3dc3eb5`](https://github.com/LTplus-AG/ifc-lite/commit/3dc3eb56bd372ddd0e317347db1cad888dffd609)]:
  - @ifc-lite/wasm@4.2.0
  - @ifc-lite/parser@3.11.0
  - @ifc-lite/ifcx@2.3.2
  - @ifc-lite/geometry@3.5.0
  - @ifc-lite/query@1.14.14

## 1.6.3

### Patch Changes

- Updated dependencies [[`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`8f3fafd`](https://github.com/LTplus-AG/ifc-lite/commit/8f3fafd7cc777e60cdc006956f8336680723c440), [`a2c31a1`](https://github.com/LTplus-AG/ifc-lite/commit/a2c31a185e868d15183df8360badb001789bd978), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`a1bbd6c`](https://github.com/LTplus-AG/ifc-lite/commit/a1bbd6c209ded2da1405a8d1c816a193601ae625)]:
  - @ifc-lite/ifcx@2.3.0
  - @ifc-lite/geometry@3.2.0
  - @ifc-lite/wasm@4.0.0
  - @ifc-lite/parser@3.8.5

## 1.6.2

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

- [#1683](https://github.com/LTplus-AG/ifc-lite/pull/1683) [`3267aaf`](https://github.com/LTplus-AG/ifc-lite/commit/3267aaf5dfe98f9550695d44c1d12644f2c04b88) Thanks [@louistrue](https://github.com/louistrue)! - Internal replacement of the hand-written clash math (vec3, aabb, triangle-intersect) with Plato-generated single-source code. The generated kernel is post-processed by a deterministic codemod that rewrites scalar dispatch to native operators and lifts the former Number/Boolean prototype helpers into a module-scoped namespace, so there is no prototype pollution. A second codemod phase flattens the pure method bodies into tuple-native kernels (inlining + common-subexpression elimination), removing all per-call object allocation. The public API is identical, results are bit-identical, and the end-to-end TS clash engine benchmarks about 20 percent faster than the previous hand-written math.

- Updated dependencies [[`41794cd`](https://github.com/LTplus-AG/ifc-lite/commit/41794cde27d31904773bf2042eb0a0331aadf770), [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a), [`d0647c9`](https://github.com/LTplus-AG/ifc-lite/commit/d0647c9a1801fc03b7c5d32314e53ef922c56f2f), [`633882f`](https://github.com/LTplus-AG/ifc-lite/commit/633882fa15940f5faddb9dcb32031fcf3f38e287), [`40ac0a8`](https://github.com/LTplus-AG/ifc-lite/commit/40ac0a85d5aaac1b6fed9ad96b3e2f9d0378d65b), [`47bf759`](https://github.com/LTplus-AG/ifc-lite/commit/47bf759b1b801d44f6a0ba7408f65d368096cb04), [`26de705`](https://github.com/LTplus-AG/ifc-lite/commit/26de705b8608b9cd75e90411288c7ada96b3352b), [`bc1531f`](https://github.com/LTplus-AG/ifc-lite/commit/bc1531f899e5f8d18d1a6ff1ef6d997236a01243)]:
  - @ifc-lite/wasm@3.0.14
  - @ifc-lite/bcf@1.16.2
  - @ifc-lite/geometry@3.1.4
  - @ifc-lite/ifcx@2.2.2
  - @ifc-lite/parser@3.8.2
  - @ifc-lite/query@1.14.13
  - @ifc-lite/spatial@1.14.12

## 1.6.1

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

- Updated dependencies [[`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39), [`84cd5aa`](https://github.com/LTplus-AG/ifc-lite/commit/84cd5aa3b59bfb5cb5599423f22406f56f3c0e6c), [`2c52076`](https://github.com/LTplus-AG/ifc-lite/commit/2c5207631c3dbc164ffde0147a3cd71104006d36), [`a90182b`](https://github.com/LTplus-AG/ifc-lite/commit/a90182bac110fdd4c15b8b51866e31deefc0378e)]:
  - @ifc-lite/bcf@1.16.1
  - @ifc-lite/ifcx@2.2.1
  - @ifc-lite/parser@3.8.1
  - @ifc-lite/query@1.14.12
  - @ifc-lite/spatial@1.14.11
  - @ifc-lite/wasm@3.0.13

## 1.6.0

### Minor Changes

- [#1619](https://github.com/LTplus-AG/ifc-lite/pull/1619) [`6be7ad4`](https://github.com/LTplus-AG/ifc-lite/commit/6be7ad477e1f20d6ba1a90e5b5db4645fc48a960) Thanks [@louistrue](https://github.com/louistrue)! - Clash-to-BCF export (`createBCFFromClashResult`) now records a markup `<Header>` source file per distinct model each clash group spans, derived from the group members' `model` names. A cross-model clash topic therefore round-trips the provenance of both models it references (issue [#1591](https://github.com/LTplus-AG/ifc-lite/issues/1591)). Topics with no resolvable model name are unaffected.

### Patch Changes

- Updated dependencies [[`6be7ad4`](https://github.com/LTplus-AG/ifc-lite/commit/6be7ad477e1f20d6ba1a90e5b5db4645fc48a960), [`8c01c19`](https://github.com/LTplus-AG/ifc-lite/commit/8c01c19a09d9fa550329ad482b7a3ddf2b5c9d96), [`6b9418d`](https://github.com/LTplus-AG/ifc-lite/commit/6b9418d2bbd6765d33c60ecf04eb47362c8b856a)]:
  - @ifc-lite/bcf@1.16.0
  - @ifc-lite/wasm@3.0.9

## 1.5.0

### Minor Changes

- [#1577](https://github.com/LTplus-AG/ifc-lite/pull/1577) [`218e613`](https://github.com/LTplus-AG/ifc-lite/commit/218e613b06cc5ca2a74c84f72e039b430be6caee) Thanks [@louistrue](https://github.com/louistrue)! - Add a coordination REVIEW state for clashes, distinct from the detection classification ([#1468](https://github.com/LTplus-AG/ifc-lite/issues/1468)). A clash can now carry an `open` / `resolved` / `accepted` review status plus an optional comment, keyed by a new durable `clashReviewKey` that (unlike `Clash.id`) is independent of the ephemeral runtime `model` id, so a review re-attaches to the same clash across a reload, a re-run, or a model revision. `createBCFFromClashResult` gains an optional `reviewStatusOf` resolver: when given, each BCF topic's `TopicStatus` follows the least-resolved status among its members (`aggregateReviewStatus`), mapped to a BCF status via `reviewStatusToBcfTopicStatus` (max-interop: `open` -> `Open`, `resolved`/`accepted` -> `Closed`), and the finer review breakdown is recorded in the topic description so the resolved-vs-accepted split is not lost. Without the resolver, the previous flat `status` behaviour is unchanged. New exports: `clashReviewKey`, `aggregateReviewStatus`, `reviewStatusToBcfTopicStatus`, and the `ClashReviewStatus` / `ClashReview` types plus `CLASH_REVIEW_STATUSES` / `DEFAULT_CLASH_REVIEW_STATUS` constants.

### Patch Changes

- Updated dependencies [[`0762522`](https://github.com/LTplus-AG/ifc-lite/commit/076252241ec4201462f7fcf0555c83606de5fecd), [`d7a3205`](https://github.com/LTplus-AG/ifc-lite/commit/d7a3205524e023f936b29ee1bc113d1d10e3b0b1), [`52dd7a1`](https://github.com/LTplus-AG/ifc-lite/commit/52dd7a16788375a9507c40fbde106b78236801db), [`b157b48`](https://github.com/LTplus-AG/ifc-lite/commit/b157b4841bfa795f8a937a9be20c21b645757fbe)]:
  - @ifc-lite/geometry@3.1.0
  - @ifc-lite/parser@3.6.0
  - @ifc-lite/wasm@3.0.4

## 1.4.1

### Patch Changes

- Updated dependencies [[`8e43ecf`](https://github.com/LTplus-AG/ifc-lite/commit/8e43ecf540b88b942a4ec2127dd9bcf24ec244fa), [`796f50a`](https://github.com/LTplus-AG/ifc-lite/commit/796f50a3b0072dd2c07b60ef84e3f1d2996444e2), [`d1e16f9`](https://github.com/LTplus-AG/ifc-lite/commit/d1e16f944ea9f3a35a7153959f13db168a35c229), [`6d2cb21`](https://github.com/LTplus-AG/ifc-lite/commit/6d2cb21a170413c6c98aadf10d254667b2ed2b53), [`66f31ac`](https://github.com/LTplus-AG/ifc-lite/commit/66f31acb761209f7cf78e83ef01c02a1ec3dc13a), [`3d25765`](https://github.com/LTplus-AG/ifc-lite/commit/3d25765edc2cee40268a6d5a27d4055f88f76489), [`6a515ba`](https://github.com/LTplus-AG/ifc-lite/commit/6a515ba31bbe31bb6f018f7476cc9616e4691448), [`b66ff1d`](https://github.com/LTplus-AG/ifc-lite/commit/b66ff1dd915a0ff4f60198a511adb7ed7f714079)]:
  - @ifc-lite/wasm@3.0.0
  - @ifc-lite/geometry@3.0.0
  - @ifc-lite/ifcx@2.1.6
  - @ifc-lite/query@1.14.11
  - @ifc-lite/parser@3.5.2
  - @ifc-lite/spatial@1.14.10

## 1.4.0

### Minor Changes

- [#1469](https://github.com/LTplus-AG/ifc-lite/pull/1469) [`731579f`](https://github.com/LTplus-AG/ifc-lite/commit/731579f6a981b5e55e36b8ff949dc5a51003ec08) Thanks [@louistrue](https://github.com/louistrue)! - Clash detection no longer treats non-physical / non-product geometry as a clash
  candidate ([#1464](https://github.com/LTplus-AG/ifc-lite/issues/1464)). Spatial volumes (`IfcSpace`, `IfcSpatialZone`), voids
  (`IfcOpeningElement`/`IfcOpeningStandardCase`), `IfcVirtualElement`, reference
  geometry (`IfcGrid`, `IfcGridAxis`, `IfcAnnotation`) and non-product material
  associations are dropped from the candidate set in `elementsFromStep`, so a
  "detect all" run and per-rule runs only ever consider real building elements
  instead of surfacing phantom clashes that no rule referenced.

## 1.3.0

### Minor Changes

- a7f257e: Show the focused clash's REAL contact interface instead of an AABB box (#1402). New `@ifc-lite/clash/contact`: `contactClusters(meshA, meshB)` returns the contact patches — the shared-face polygon for coplanar/flush overlaps (surface), the intersection line for crossings (line), or a point — classified by area/length, via a Moller triangle-triangle test plus shared-face clustering (coplanar pairs Sutherland-Hodgman clipped on their common plane and unioned into a boundary polygon; cross pairs unioned along the intersection line). Computed on demand for the single focused pair. The renderer gains `setClashContactLines()` to draw the contact polygon outlines / intersection lines; the viewer prefers this over the box.

### Patch Changes

- a7f257e: Fix clash false positives and overstated contact regions (#1362, #1402). The coplanar-overlap fallback now confirms a real shared volume (point-in-solid probe) before reporting a hard clash, so skewed or abutting members that only touch at a face are no longer flagged. Hard verdicts now report a tight contact AABB (clamped to the element overlap) instead of the full whole-element AABB overlap. The focused-clash region box draws this tight contact region (on by default, marking the penetration; toggle in clash settings), replacing the former whole-element box. The TS reference engine and the Rust/WASM kernel stay byte-compatible.
- Updated dependencies [1b148c1]
  - @ifc-lite/geometry@2.13.1

## 1.2.0

### Minor Changes

- [#1285](https://github.com/LTplus-AG/ifc-lite/pull/1285) [`593f02b`](https://github.com/LTplus-AG/ifc-lite/commit/593f02b471a894fd14d395edcfef575de7879738) Thanks [@louistrue](https://github.com/louistrue)! - Add duplicate / overlapping-element detection and result-analysis helpers.

  `findDuplicates(elements)` runs a cheap AABB + triangle-count pass (uniform hash
  grid, no narrow phase) to flag accidentally duplicated or coincident objects —
  the first thing reviewers look for in a single discipline model ([#1280](https://github.com/LTplus-AG/ifc-lite/issues/1280)). It
  returns a normal `ClashResult` (rule id `duplicates`) so the panel, grouping and
  BCF export render it with no special-casing.

  New pure helpers in `analysis.ts`: `penetrationDepth`, `isTouching` (identify
  zero-distance face/edge contacts, [#1273](https://github.com/LTplus-AG/ifc-lite/issues/1273)), `sortClashes` by severity / overlap
  depth / signed distance ([#1274](https://github.com/LTplus-AG/ifc-lite/issues/1274)), and `SEVERITY_RANK`.

### Patch Changes

- Updated dependencies [[`39400ee`](https://github.com/LTplus-AG/ifc-lite/commit/39400ee5bb48c1554656e1ac7aaf8a06ba2274cf), [`84c9f6e`](https://github.com/LTplus-AG/ifc-lite/commit/84c9f6e09eba2747b37da8f74aa7de23cb9f96d3), [`df607ef`](https://github.com/LTplus-AG/ifc-lite/commit/df607effd3a4cf2e0fb2898e14cb385df6d8e8d0)]:
  - @ifc-lite/parser@3.3.2
  - @ifc-lite/geometry@2.9.2
  - @ifc-lite/wasm@2.11.1

## 1.1.4

### Patch Changes

- [#1114](https://github.com/LTplus-AG/ifc-lite/pull/1114) [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb) Thanks [@louistrue](https://github.com/louistrue)! - Per-element local frame: eliminate f32 "fan" corruption on building-scale and georeferenced models.

  When a mesh is stored at f32 precision while its vertices sit at building-scale world coordinates (a model whose extent reaches ~200 m from the coordinate origin), the f32 mantissa only resolves ~15 µm there, so vertices closer than one ULP collapse to the same value and the triangles joining them fan out as long needles across the model. Lowering the global RTC threshold is the wrong lever (it is reserved for >10 km federation re-basing), and a single global recentre still leaves the model genuinely spanning ~200 m.

  Each element's vertices are now stored RELATIVE to a per-element `MeshData.origin` (the f64 AABB centre, snapped to the kernel reconcile grid `1/65536 m`), so the f32 coordinates stay element-small and collapse-free at any building or georef scale; the world position is `origin + position`. The renderer reconstructs world space with a per-batch model-matrix translate around a single shared scene origin (so abutting elements in different colour batches stay bit-coincident with no seam z-fighting), and the selection-highlight / GPU-picker buffers replicate the batch's exact f32 path so highlights are bit-coincident with no depth bias. The local frame is ON for the wasm (viewer) path and opt-in for native/server, so determinism snapshots and server output stay absolute-coordinate byte-identical.

  Every world-space consumer of element geometry now folds `origin` (`world = origin + position`): camera/scene bounds, the CPU raycast + BVH narrow phase, snap detection, the section cutters (CPU + GPU), the BIM↔scan deviation BVH, the spatial index, clash (world-frame triangles fed to both the TS and Rust kernels), the glTF / IFC5 / Parquet exporters, the Cesium GLB overlay, the construction-projection outline + storey-band derivation, and the federation alignment / mesh-duplicate paths. `MeshData.origin` is serialized in the geometry cache (format version 6, which auto-heals stale entries). Position differences (normals, edge vectors, areas) are origin-invariant and unchanged.

  This composes with the sub-grid sliver hygiene pass: the local frame removes the f32-storage fans, and `Mesh::clean_degenerate` removes the sub-grid slivers the finer-grained CSG host emits.

- Updated dependencies [[`d2086aa`](https://github.com/LTplus-AG/ifc-lite/commit/d2086aa0c5ab5e4d4f98cb25498f58a88c24443c), [`4af01aa`](https://github.com/LTplus-AG/ifc-lite/commit/4af01aabe1c669864c3c3d1757789d7de81beaec), [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb), [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8), [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb), [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8), [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8), [`977b41d`](https://github.com/LTplus-AG/ifc-lite/commit/977b41db04a83d912f85cc9167cd564ffcb0aafb), [`e42b703`](https://github.com/LTplus-AG/ifc-lite/commit/e42b70324a9d5caab23257d52e96df0198d8caa9), [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb)]:
  - @ifc-lite/geometry@2.7.0
  - @ifc-lite/wasm@2.8.1
  - @ifc-lite/spatial@1.14.9

## 1.1.3

### Patch Changes

- [#1071](https://github.com/LTplus-AG/ifc-lite/pull/1071) [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe) Thanks [@louistrue](https://github.com/louistrue)! - Dead-code and dependency hygiene: remove unused internal barrels/shims (clash engine-ts re-exports, collab doc barrel, sdk transport/types) and drop unused dependencies (renderer/cli: @ifc-lite/wasm; cli/mcp: @ifc-lite/encoding; mcp: @types/node out of runtime dependencies; collab: ws devDeps; data: @types/proj4). No public API changes.

- Updated dependencies [[`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`da1999f`](https://github.com/LTplus-AG/ifc-lite/commit/da1999fc6e482fa3d668b9aa98a840d2bb838112)]:
  - @ifc-lite/parser@3.2.0
  - @ifc-lite/geometry@2.6.1

## 1.1.2

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc)]:
  - @ifc-lite/bcf@1.15.6
  - @ifc-lite/geometry@2.4.1
  - @ifc-lite/ifcx@2.1.4
  - @ifc-lite/parser@3.1.1
  - @ifc-lite/query@1.14.10
  - @ifc-lite/spatial@1.14.8
  - @ifc-lite/wasm@2.5.1

## 1.1.1

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

- Updated dependencies [[`b33e1f7`](https://github.com/LTplus-AG/ifc-lite/commit/b33e1f7c4706fe4b0d850d3da782ea84267dd525), [`55fd14e`](https://github.com/LTplus-AG/ifc-lite/commit/55fd14e5017f626567b10622bb41ddac3311e70c), [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0), [`ca293ed`](https://github.com/LTplus-AG/ifc-lite/commit/ca293ed7080495b29dd555b191ae0095ff267e4b), [`90060b7`](https://github.com/LTplus-AG/ifc-lite/commit/90060b7eaad7a07bdab13907c1b52bb24fbc8597)]:
  - @ifc-lite/parser@3.1.0
  - @ifc-lite/geometry@2.3.0
  - @ifc-lite/query@1.14.9
  - @ifc-lite/ifcx@2.1.3
  - @ifc-lite/bcf@1.15.5
  - @ifc-lite/wasm@2.3.0
  - @ifc-lite/spatial@1.14.7

## 1.1.0

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

- Updated dependencies [[`94d9116`](https://github.com/LTplus-AG/ifc-lite/commit/94d91161abc58b5804bd979d841d7475714ee5ad)]:
  - @ifc-lite/wasm@2.1.1
