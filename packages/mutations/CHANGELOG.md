# @ifc-lite/mutations

## 1.24.1

### Patch Changes

- [#2109](https://github.com/LTplus-AG/ifc-lite/pull/2109) [`4c739be`](https://github.com/LTplus-AG/ifc-lite/commit/4c739be2aba74ad6868b6dca51dad441c6fa9903) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Document that `MutablePropertyView.importMutations()` is not a full inverse of `exportMutations()` for overlay-created entities ([#2044](https://github.com/LTplus-AG/ifc-lite/issues/2044)).

  A `CREATE_ENTITY` record only carries the expressId in the mutation history, not the entity's type and attributes, so `importMutations()` cannot rebuild the entity from the record alone — it logs a `console.warn` and skips the record, dropping every other mutation recorded against that same id in the same batch too. This behaviour was already correct (fixed in [#2045](https://github.com/LTplus-AG/ifc-lite/issues/2045)), but was undocumented on the public surface: neither the package README nor the `exportMutations`/`importMutations` JSDoc (which reaches the published `.d.ts`) said so. Both now state the asymmetry plainly and point at `restoreNewEntity()` as the companion path a caller must use to carry a created entity across before calling `importMutations()`. No runtime behaviour changes.

- [#2045](https://github.com/LTplus-AG/ifc-lite/pull/2045) [`f493930`](https://github.com/LTplus-AG/ifc-lite/commit/f4939309aed136979bd5cc1f95a25c2a0ebe779f) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Stop `importMutations` from orphaning property/attribute/quantity edits under a created entity it skipped ([#2044](https://github.com/LTplus-AG/ifc-lite/issues/2044)).

  `applyMutations` deliberately skips `CREATE_ENTITY` records — the history alone doesn't carry the type+attributes payload, so callers must restore it via `restoreNewEntity()` — but it still replayed every property, attribute, quantity, and positional-attribute mutation recorded against that entity's expressId. The receiving view ended up with a property set (or attribute/quantity/type edit) keyed to an id that existed in neither the source buffer nor `newEntities` — surfaced by `getForEntity()` and counted as a pending change by `hasChanges()` / `hasPendingChanges()`.

  `applyMutations` now skips every mutation recorded against an id whose `CREATE_ENTITY` it skipped in the same batch _and_ which nothing else supplied. Both halves matter: keying off the skip set rather than "id absent from `newEntities`" leaves replay against a normal, pre-existing source-buffer entity unaffected, and requiring the id to be absent from `newEntities` keeps the documented recovery flow — `restoreNewEntity()` first, then `importMutations()` — from having its own edits dropped as orphans. The round trip for an overlay-created entity is now lossy (the entity and its edits are both dropped) instead of corrupting (edits surviving without their entity). The `console.warn` now also states that dependent mutations were dropped.

  `applyMutations` also now builds that skip set in a dedicated first pass over the whole input array before applying anything, instead of populating it incrementally as the main loop reaches each `CREATE_ENTITY`. `exportMutations()` always produces an append-ordered array, so this wasn't reachable through any current caller, but `applyMutations`/`importMutations` are documented to accept an arbitrary `Mutation[]` (e.g. an imported change set). Under the old single-pass logic, a dependent mutation appearing before its own `CREATE_ENTITY` in such an array would see an empty skip set and replay anyway — the same orphaning bug, reached via ordering instead of the original bug shape. The two-pass version is order-independent.

- Updated dependencies [[`befc108`](https://github.com/LTplus-AG/ifc-lite/commit/befc1083e377315231006352cb3fe95949e92b47)]:
  - @ifc-lite/data@3.2.1

## 1.24.0

### Minor Changes

- [#1967](https://github.com/LTplus-AG/ifc-lite/pull/1967) [`14b8e45`](https://github.com/LTplus-AG/ifc-lite/commit/14b8e45b2d4aa6c2490f6e7263d8f84731ea812e) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `MutablePropertyView.getModifiedEntityCount()` and `hasChanges()` to read the live overlay instead of the append-only `mutationHistory` (issue [#1915](https://github.com/LTplus-AG/ifc-lite/issues/1915)). Undo does not pop `mutationHistory` — it either re-applies the inverse or clears the overlay entry directly — so after an undo, `getModifiedEntityCount()` could over-report entities that no longer have any pending change, disagreeing with `hasPendingChanges()`. Both methods now agree with `hasPendingChanges()` in every case, including entities restored via `restoreNewEntity` (which never touches `mutationHistory` at all).

  Add `getEffectiveChanges()`, returning every change the overlay currently carries — attribute, property, quantity, pset/qset add-or-delete, retype, and entity create/delete — with `previousValue` derived from the base data (property table / on-demand extractor / the new optional `AttributeExtractor`, set via `setAttributeExtractor()`), never from `mutationHistory`, so an undo→redo cycle reports the true original value instead of a stale history entry. For a tombstoned entity, only its `entity-deleted` row is reported — any attribute/property/quantity/retype edits made before the delete are dropped, matching the STEP exporter's own behavior of skipping those mutations for a deleted entity. Backs the export-review dialog in `@ifc-lite/viewer`, which lets a user see what an "Export Changes" click will actually apply before committing to it.

  Fix `deleteEntity` to purge, rather than leave orphaned, a forgotten-created entity's property/quantity/attribute/type overlay entries, its `newPsets`/`newQsets` entries, and its own `mutationHistory` records. Previously only the export-review enumeration filtered these out; `StepExporter` itself still read them directly (`getMutations()`, `getForEntity()`, `getQuantitiesForEntity()`), so a create → edit → delete entity could leave a dangling `IFCPROPERTYSET` / `IFCRELDEFINESBYPROPERTIES` in the exported file pointing at an expressId that was never actually created, invisible to the review dialog. The purged data is stashed internally and restored by `restoreNewEntity`, so undo of the delete brings back the rows, the modified-entity count, and what the exporter would see — not just the bare entity record.

  Fix two related overlay leaks that kept `getModifiedEntityCount()` disagreeing with `getEffectiveChanges()`: deleting the last property of an auto-created (in-session-only) property set left an empty, still-truthy `Map` in `newPsets` (and the equivalent for `newQsets`/quantities); and deleting an in-session-only property left a `DELETE` tombstone marker in `propertyMutations` that had no base value to mask. `collectModifiedEntityIds()` is now derived directly from `getEffectiveChanges()` instead of a second hand-rolled walk over the overlay maps, so the two structurally cannot diverge again.

  Fix `getEffectiveChanges()` to drop no-op rows: undoing an edit re-applies the inverse and lands the overlay back at the base value, so `previousValue === newValue` — previously still reported as a change (e.g. `Status: Original -> Original`) even though the user had undone it.

  Add `EffectiveChange.deleted`, set on a `'property' | 'quantity'` row only when the overlay entry is a genuine DELETE operation. Previously a row's `newValue` alone was the only signal callers had for "this will be removed on export" — but a SET whose stored value is `null` (an unset Boolean added from bSDD, issue [#1107](https://github.com/LTplus-AG/ifc-lite/issues/1107), which is present-but-empty, not absent) stringifies to `undefined` too, the same as a DELETE's `newValue`. The export-review dialog in `@ifc-lite/viewer` now renders that distinction: a SET-to-null value reads as empty, not as a row export will drop.

  Fix `deletePropertySet` for a property set that only ever existed in-session (created via `createPropertySet`, never present in the base file): deleting it no longer records a `deletedPsets` entry, so `getEffectiveChanges()`/the review dialog no longer report a `pset-deleted` row — and `hasPendingChanges()`/`hasChanges()` no longer stay dirty — for an add-then-remove that nets to no change at all. Same reasoning `deleteProperty` already applied one level down: a purely in-session entry has nothing in the base data to mask, so there is nothing to report as deleted. Also clears the now-orphaned per-property `SET` mutations the in-session pset's `createPropertySet` call recorded, and applies the same empty-map cleanup to `newPsets` that `deleteProperty` already had (an empty `Map` is still truthy). A property set that genuinely exists in the base file is unaffected and still reports `pset-deleted` as before.

  Fix `restoreNewEntity` reordering `mutationHistory` for a create → edit → delete → restore sequence on an overlay-created entity. `deleteEntity` purges the entity's history via `stashAndPurgeEntityOverlay` before pushing its own `DELETE_ENTITY` record, and `unstashEntityOverlay` was re-appending the stashed `CREATE_ENTITY`/`CREATE_PROPERTY` records at the tail of `mutationHistory` — behind that `DELETE_ENTITY`, instead of restoring create-before-delete order. That defeated `applyMutations()`'s `skippedCreateIds` guard (issue [#2036](https://github.com/LTplus-AG/ifc-lite/issues/2036)) on replay: the `DELETE_ENTITY` was processed before the `CREATE_ENTITY` it should pair with, so it tombstoned an id `skippedCreateIds` hadn't seen yet. The practical effect was silent data loss through the public `exportMutations()` → `importMutations()` round trip — an entity that was only ever created, edited, and (transiently) deleted-then-restored in the same session came back as a bare tombstone (`isDeleted() === true`) instead of untouched, and repeated undo/redo cycles piled up additional stale tombstones ahead of the create. `unstashEntityOverlay` now drops the superseded `DELETE_ENTITY` instead of re-appending behind it — the create and the delete cancel, the same reasoning already applied to `forgottenCreatedEntities` in the effective-changes filter one layer down. A tombstoned _source_ entity restored via `restoreFromTombstone` is a separate code path and is unaffected.

## 1.23.1

### Patch Changes

- [#2050](https://github.com/LTplus-AG/ifc-lite/pull/2050) [`d9abe5b`](https://github.com/LTplus-AG/ifc-lite/commit/d9abe5b48eee9066ff1b21d7408350f152c9f4f1) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Drop component ops for entities whose final change-set state is `tombstone-entity` ([#2048](https://github.com/LTplus-AG/ifc-lite/issues/2048)).

  `changeSetToOps` folds `entityOps` (last-write-wins per entity) and `components` (per componentKey) in the same pass over the mutation list, but previously emitted every accumulated component op regardless of whether the entity ended up deleted. A `CREATE_PROPERTY` mutation followed later by `DELETE_ENTITY` for the same entity produced both a `tombstone-entity` op and a `set-component` op carrying the now-meaningless property values — which `apps/viewer`'s `buildDeltaNodes` merged onto the same `IfcxNode`, publishing live property values alongside `IFCLITE_ATTR.DELETED: true`.

  Component ops are now filtered against each entity's final `entityOps` state after both passes complete (not during the fold, since an entity's terminal state — LWW — is only known once the whole mutation list has been consumed). An entity tombstoned and then recreated in the same change set keeps its components, since `entityOps` resolves to `add-entity` for that identity.

## 1.23.0

### Minor Changes

- [#2036](https://github.com/LTplus-AG/ifc-lite/pull/2036) [`a8e58a2`](https://github.com/LTplus-AG/ifc-lite/commit/a8e58a2b5e75db8388835c77b2688240667f68ab) Thanks [@louistrue](https://github.com/louistrue)! - `deleteEntity` now tombstones an overlay-created entity as well as forgetting it ([#2012](https://github.com/LTplus-AG/ifc-lite/issues/2012)).

  It used to only remove the entity from the new-entity list, which made `isDeleted()` answer `false` for something that no longer exists. Every consumer that asks "was this deleted" therefore got the wrong answer about a created-then-deleted entity, and could only work around it by asking a different question instead — which is what `StepExporter` does on main today, and what its comment says it is doing.

  The entity is still dropped from `getNewEntities()`, so something created and deleted in one session is emitted nowhere. `restoreNewEntity` lifts the tombstone, so undo of a delete is still a complete inverse.

  `getTombstones()` now names created-and-deleted ids as well as source ones. A consumer that counts entities must intersect it with the store's own index rather than subtracting its size, or a created-then-deleted entity is subtracted twice.

### Patch Changes

- Updated dependencies [[`e4d2db5`](https://github.com/LTplus-AG/ifc-lite/commit/e4d2db5f11798e3ec78f45249139d69aa1e65275)]:
  - @ifc-lite/data@3.2.0

## 1.22.0

### Minor Changes

- [#1966](https://github.com/LTplus-AG/ifc-lite/pull/1966) [`80051a5`](https://github.com/LTplus-AG/ifc-lite/commit/80051a51868b7343c4c3e08e335c0d5bdf900424) Thanks [@louistrue](https://github.com/louistrue)! - Fix undone attribute edits being resurrected on STEP export ([#1957](https://github.com/LTplus-AG/ifc-lite/issues/1957)).

  `StepExporter` reconstructed attribute values by replaying `MutablePropertyView.getMutations()` — the append-only mutation history. Undo applies its reverse edit with `skipHistory: true`, so a superseded `UPDATE_ATTRIBUTE` record keeps its stale `newValue` forever and the exporter baked the pre-undo value into the output. The editor showed the reverted value; the file did not. Silent, with no error and nothing in the output signalling it, and directional: it restored data the user had explicitly reverted.

  The exporter now reads attribute values from the overlay via the new `MutablePropertyView.getAttributeMutationsByEntity()`, which returns the current state — an undone edit has had its overlay entry reset to the pre-edit value, or removed outright when the attribute was newly set. This makes attributes consistent with every other overlay-backed path in the exporter: property sets (`getForEntity`), quantities (`getQuantitiesForEntity`), positional attributes (`getPositionalMutationsForEntity`) and retypes (`getEntityTypeMutation`) already read current state, so attributes were the sole outlier rather than an instance of a general pattern.

  **Scope.** Only the attribute path was affected. Property and quantity edits take their _values_ from the overlay and use the history only to decide which pset names to re-emit, so an undone property edit was already re-emitted with its correct current value. Georeferencing edits reach the exporter through `ExportOptions.georefMutations`, not through the view, and are untouched.

  `getAttributeMutationsByEntity()` and the existing `getAttributeMutationsForEntity()` are both backed by a new entityId-keyed secondary index, mirroring the one already used for property and quantity mutations. That also removes a full-map `startsWith` scan from the per-entity accessor, which the properties panel calls on every selection.

  No migration: the overlay and the history are both in-process state, and any edit that was not undone exports exactly as before.

## 1.21.1

### Patch Changes

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

- [#1850](https://github.com/LTplus-AG/ifc-lite/pull/1850) [`22bffac`](https://github.com/LTplus-AG/ifc-lite/commit/22bffac737efa9bdd6ca583518f637593cb4d4bc) Thanks [@louistrue](https://github.com/louistrue)! - Type-qualify SELECT-typed and IfcValue-family STEP attributes on export. A
  defined-type SELECT member (a boolean in an `IfcTranslationalStiffnessSelect`
  slot, a length in `IfcSizeSelect`) now serializes as the ISO 10303-21 required
  `IFCBOOLEAN(.T.)` / `IFCLENGTHMEASURE(3.)` rather than a bare `.T.` / `3` that
  strict validators reject and that loses the member type on round-trip. The
  exporter auto-qualifies unambiguous slots from the schema registry with no
  caller change; a new write-only `{ typed: { type, value } }` marker on
  `IfcAttributeValue` pins the type for ambiguous selects and the `IfcValue`
  family (`NominalValue`, quantity values) and subsumes `{ real }`. Completes the
  `setPositionalAttribute` / `addEntity` follow-up to [#1839](https://github.com/LTplus-AG/ifc-lite/issues/1839).
- Updated dependencies [[`6792dd1`](https://github.com/LTplus-AG/ifc-lite/commit/6792dd11ad7049acb7329221ea8809d6333aefb7), [`22bffac`](https://github.com/LTplus-AG/ifc-lite/commit/22bffac737efa9bdd6ca583518f637593cb4d4bc), [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f)]:
  - @ifc-lite/data@3.0.0

## 1.21.0

### Minor Changes

- [#1769](https://github.com/LTplus-AG/ifc-lite/pull/1769) [`2a7c7ff`](https://github.com/LTplus-AG/ifc-lite/commit/2a7c7ffe0ac27a8cc315e5d4a633c56469646cf0) Thanks [@Blogbotana](https://github.com/Blogbotana)! - Demesher: selective per-element mesh simplification with lightweight IFC re-export ([#1767](https://github.com/LTplus-AG/ifc-lite/issues/1767)). `@ifc-lite/export` gains `DemeshSession` — pick elements (usually the heaviest, see `heaviest(n)`), escalate simplification one level per `simplify()` call (levels 1-4 = internal-cavity removal + vertex-clustering decimation at target ratios 0.5/0.25/0.10/0.03, level 5 = bounding-box collapse) with render-ready replacement meshes for live scene updates, then export a lighter IFC separately via `exportIfc()`, which authors `IfcTriangulatedFaceSet` geometry and prunes the replaced representation subgraphs (IFC2X3 input auto-upconverts to IFC4). Also exported: `applySimplifiedGeometry` and the supporting types.

  `@ifc-lite/geometry` gains `GeometryProcessor.simplifyMeshes()` backed by the new wasm `simplifyMeshes` API (`SimplifiedMeshes`). `@ifc-lite/cli` gains `ifc-lite simplify <file.ifc> --level 1..5 [--ids ...] --out light.ifc [--json]` for dev/testing. `@ifc-lite/data` / `@ifc-lite/mutations` widen `IfcAttributeValue` with a write-only `{ real: number }` marker (serialized by `stepReal()` in `@ifc-lite/export`) so tessellation coordinates always carry a decimal point.

### Patch Changes

- Updated dependencies [[`2a7c7ff`](https://github.com/LTplus-AG/ifc-lite/commit/2a7c7ffe0ac27a8cc315e5d4a633c56469646cf0), [`7194c95`](https://github.com/LTplus-AG/ifc-lite/commit/7194c95002f2c84cd3c9444d710a50190a976a90)]:
  - @ifc-lite/data@2.7.0

## 1.20.0

### Minor Changes

- [#1731](https://github.com/LTplus-AG/ifc-lite/pull/1731) [`cd6c9bd`](https://github.com/LTplus-AG/ifc-lite/commit/cd6c9bda1066b7c7cda19e164d787d15b57e3483) Thanks [@louistrue](https://github.com/louistrue)! - `changeSetToOps` serializes entity retypes (`UPDATE_ENTITY_TYPE` → a `bsi::ifc::class` opinion, with `PredefinedType` on the core-attribute channel) instead of silently dropping them, and reports unrepresentable mutation types in a new `skipped` result field so callers can warn instead of under-publishing.

## 1.19.0

### Minor Changes

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Layer PRs foundation (docs/architecture/layer-prs):

  - **ifcx**: deletion-overlay tombstones (`ifclite::deleted`) with shadow/resurrect semantics and child-path shadowing in both composition engines; `bakeLayers` tombstone-free materialization; canonical serialization with blake3 content addressing (`computeLayerId`, `computeStackHash`); provenance manifest v1 (`createProvenanceManifest`, `getProvenance`/`setProvenance`, `validateProvenance`).
  - **diff**: opt-in per-componentKey sub-hash mode (`buildComponentFingerprints`) and `changedComponents` on diff entries; the whole-blob `dataHash` default is unchanged.
  - **extensions**: scope-claim grammar — capability expressions extended with entity selectors (`model.mutate:Pset_FireSafety*@IfcWall&storey=EG`), with grant-coverage and op-level enforcement matching.
  - **mutations**: `changeSetToOps` expressId→GlobalId bridge with blake3 content-derived identity fallback recorded for the manifest `identity_map`.
  - **collab**: `extractMinimalLayer` now expresses deletions (entity tombstones plus `null` removals), closing the documented additive-only deferral; new `publishLayer` freezes a draft into an immutable, content-addressed, provenance-stamped layer.
  - **merge** (new package): three-way merge engine over (entity, componentKey) states with explicit conflict records, resolution application, merge-layer emission with `manifest.merge`, revert (inverse-op layers), and rebase.

## 1.18.1

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

- Updated dependencies [[`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a)]:
  - @ifc-lite/data@2.5.2

## 1.18.0

### Minor Changes

- [#1580](https://github.com/LTplus-AG/ifc-lite/pull/1580) [`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47) Thanks [@louistrue](https://github.com/louistrue)! - Plumb the IFC measure type through the property pipeline so consumers can show units (issue [#1573](https://github.com/LTplus-AG/ifc-lite/issues/1573)):

  - `@ifc-lite/data`: `Property` gains an optional `dataType?: string` carrying the raw IFC measure value type (e.g. `"IFCVOLUMETRICFLOWRATEMEASURE"`) of a typed nominal value. Additive and optional; existing consumers are unaffected.
  - `@ifc-lite/mutations`: the `PropertyExtractor` function type now carries the same optional `dataType?` per property, and `MutablePropertyView.getForEntity` preserves it through the base and mutation-merge paths, so a property's measure type survives the merge for unit display.
  - `@ifc-lite/mcp`: `geometry_volume` / `geometry_area` now resolve the volume/area symbol from the file's declared `IfcUnitAssignment` (via `@ifc-lite/parser`'s `extractProjectUnits`) instead of hardcoding `m³` / `m²`, and report the resolved symbol in a new `unit` response field. Falls back to the SI default when the store has no source buffer or declares no such unit.

### Patch Changes

- Updated dependencies [[`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47)]:
  - @ifc-lite/data@2.4.0

## 1.17.1

### Patch Changes

- [#1509](https://github.com/LTplus-AG/ifc-lite/pull/1509) [`bf56aaa`](https://github.com/LTplus-AG/ifc-lite/commit/bf56aaabf862dd1ac95f71b3b8fa7fbb8175c097) Thanks [@louistrue](https://github.com/louistrue)! - Declare `CsvConnector.import` with a computed method name so Vite 8's dev-time import-analysis no longer rewrites the method head as a dynamic import (which broke the viewer dev server with a SyntaxError). No API change: the method is still called `import`.

## 1.17.0

### Minor Changes

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

## 1.16.0

### Minor Changes

- [#1234](https://github.com/LTplus-AG/ifc-lite/pull/1234) [`b6acbc4`](https://github.com/LTplus-AG/ifc-lite/commit/b6acbc4b84bcdb4a2d774515200d27edd7e831cb) Thanks [@louistrue](https://github.com/louistrue)! - Add entity retype (reassign class) to the mutation overlay.

  `EntityTable` gains an additive `setTypeOverride(expressId, typeName | null)` so
  a host (the viewer) can reflect a pending retype live in `getTypeName` /
  `getTypeEnum` without rebuilding the table; the original columnar type is left
  intact.

  `StoreEditor.setEntityType(expressId, newType, { predefinedType? })` and
  `MutablePropertyView.setEntityType(...)` change an entity's IFC class in place,
  and a new `BulkAction { type: 'SET_ENTITY_TYPE', entityType, predefinedType? }`
  applies it to a selection. `StepExporter` materializes the retype on export.

  The entity keeps its expressId, so geometry, placement, representation and every
  `IfcRel*` reference (all keyed by `#id`) carry over unchanged. Attributes are
  re-laid-out by name against the target class's declared layout — dropping
  attributes the target lacks (e.g. IFC2X3 `CompositionType`) and validating
  `PredefinedType` against the target enum (an unknown override falls back to
  `USERDEFINED` + `ObjectType`). This mirrors IfcOpenShell's
  `ifcopenshell.util.schema.reassign_class`. Intended for compatible
  reassignments such as the building-element subtypes that share the IfcElement
  layout (`IfcBuildingElementProxy` ↔ `IfcColumn`/`IfcBeam`/`IfcMember`/
  `IfcPlate`/`IfcWall`).

### Patch Changes

- Updated dependencies [[`b6acbc4`](https://github.com/LTplus-AG/ifc-lite/commit/b6acbc4b84bcdb4a2d774515200d27edd7e831cb)]:
  - @ifc-lite/data@2.2.0

## 1.15.5

### Patch Changes

- [#1149](https://github.com/LTplus-AG/ifc-lite/pull/1149) [`61bad47`](https://github.com/LTplus-AG/ifc-lite/commit/61bad47257196b766fb0b8a17c56e53b763ca34a) Thanks [@louistrue](https://github.com/louistrue)! - Treat a null/unset property value as present, not absent. A property may legitimately exist with no value (e.g. an IFC boolean added from bSDD, which now starts unset rather than defaulting to `false`), so `MutablePropertyView` no longer reads `value === null` as "property does not exist":

  - `deleteProperty` keys absence off existence (in-session pset membership), so an unset property is still deletable instead of the trash button being a silent no-op.
  - `setProperty` classifies a write as `UPDATE_PROPERTY` vs `CREATE_PROPERTY` by whether the property already existed (not by null value), so undoing an edit to an unset property restores its prior unset state instead of deleting the whole property.

- Updated dependencies [[`bfd9004`](https://github.com/LTplus-AG/ifc-lite/commit/bfd9004daa17f481a7b33b5c3c11f620e6cd894d), [`248f2c0`](https://github.com/LTplus-AG/ifc-lite/commit/248f2c09a4d61fa27dfeaba5511a2a641d4cd278), [`ddae2b0`](https://github.com/LTplus-AG/ifc-lite/commit/ddae2b0024f071d00f9e6e4b77e0be3965412ec3)]:
  - @ifc-lite/data@2.1.0

## 1.15.4

### Patch Changes

- [#1116](https://github.com/LTplus-AG/ifc-lite/pull/1116) [`49778b1`](https://github.com/LTplus-AG/ifc-lite/commit/49778b179826d46e1c96361fe7b557e42db4ecfe) Thanks [@louistrue](https://github.com/louistrue)! - Seed the overlay express-id watermark above deferred property atoms, not just `entityIndex.byId`.

  On huge files the parser defers high-cardinality property atoms out of `byId` into `deferredEntityIndex` (`deferPropertyAtomIndex`). `StoreEditor.computeMaxExistingId()` scanned only `byId`, so a deferred atom sitting above the primary-index maximum could have its express id reused for a newly created overlay entity. With the export fix now emitting deferred atoms, that collision would surface as two `#ID=` definitions in the STEP output. The watermark (and the post-construction "store grew" guard) now span `deferredEntityIndex` too. Surfaced in review of the [#1110](https://github.com/LTplus-AG/ifc-lite/issues/1110) export fix.

## 1.15.3

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc)]:
  - @ifc-lite/data@2.0.2

## 1.15.2

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

- Updated dependencies [[`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0)]:
  - @ifc-lite/data@2.0.1

## 1.15.1

### Patch Changes

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/data@2.0.0

## 1.15.0

### Minor Changes

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

## 1.14.5

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

- Updated dependencies [[`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5)]:
  - @ifc-lite/data@1.15.1

## 1.14.4

### Patch Changes

- [#461](https://github.com/louistrue/ifc-lite/pull/461) [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7) Thanks [@louistrue](https://github.com/louistrue)! - Clean up package build health for georeferencing work by fixing parser generation issues, making export tests resolve workspace packages reliably, removing build scripts that masked TypeScript failures, tightening workspace test/build scripts, productizing CLI LOD generation, centralizing IFC GUID utilities in encoding, and adding mutation test coverage for property editing flows.

- Updated dependencies [[`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7), [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7)]:
  - @ifc-lite/data@1.15.0

## 1.14.3

### Patch Changes

- [#330](https://github.com/louistrue/ifc-lite/pull/330) [`07851b2`](https://github.com/louistrue/ifc-lite/commit/07851b2161b4cfcaa2dfc1b0f31a6fcc2db99e45) Thanks [@louistrue](https://github.com/louistrue)! - Remove the unused `@ifc-lite/parser` runtime dependency from `@ifc-lite/mutations`, switch `@ifc-lite/server-bin` postinstall to a safe ESM dynamic import, and refresh the published `@ifc-lite/wasm` bindings and binary so the npm package stays in sync with the current Rust sources.

- Updated dependencies []:
  - @ifc-lite/data@1.14.3

## 1.14.2

### Patch Changes

- Updated dependencies [[`740f7a7`](https://github.com/louistrue/ifc-lite/commit/740f7a7228413657d13014565d9e457f0e00e8a3)]:
  - @ifc-lite/parser@1.14.2
  - @ifc-lite/data@1.14.2

## 1.14.1

### Patch Changes

- Updated dependencies [[`071d251`](https://github.com/louistrue/ifc-lite/commit/071d251708388771afd288bc2ef01b4d1a074607)]:
  - @ifc-lite/parser@1.14.1
  - @ifc-lite/data@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.0
  - @ifc-lite/parser@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.13.0
  - @ifc-lite/parser@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.12.0
  - @ifc-lite/parser@1.12.0

## 1.11.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.3
  - @ifc-lite/parser@1.11.3

## 1.11.1

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.1
  - @ifc-lite/parser@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.0
  - @ifc-lite/parser@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [[`3823bd0`](https://github.com/louistrue/ifc-lite/commit/3823bd03bb0b5165d811cfd1ddfed671b8af97d8)]:
  - @ifc-lite/data@1.10.0
  - @ifc-lite/parser@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.9.0
  - @ifc-lite/parser@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.8.0
  - @ifc-lite/parser@1.8.0

## 1.7.0

### Patch Changes

- Updated dependencies [[`e0af898`](https://github.com/louistrue/ifc-lite/commit/e0af898608c2f706dc2d82154c612c64e2de010c), [`6c43c70`](https://github.com/louistrue/ifc-lite/commit/6c43c707ead13fc482ec367cb08d847b444a484a)]:
  - @ifc-lite/parser@1.7.0
  - @ifc-lite/data@1.7.0

## 1.4.0

### Minor Changes

- Initial release of drawing-2d and mutations packages

  - @ifc-lite/drawing-2d: 2D architectural drawing generation (section cuts, floor plans, elevations)
  - @ifc-lite/mutations: Mutation tracking and property editing for IFC models

### Patch Changes

- Updated dependencies [0191843]
  - @ifc-lite/parser@1.4.0
