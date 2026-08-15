# @ifc-lite/export

## 2.9.1

### Patch Changes

- [#2612](https://github.com/LTplus-AG/ifc-lite/pull/2612) [`256e4cd`](https://github.com/LTplus-AG/ifc-lite/commit/256e4cd3cd6c318af6ed3746df2187ebf3c3ae5c) Thanks [@louistrue](https://github.com/louistrue)! - Stop the Parquet export wrapping large express ids to negative numbers.

  `columnsToParquet` inferred Int32 for any whole-number column, so an IFC express
  id at or above 2,147,483,648 came back NEGATIVE: an id-shaped number that joins
  to nothing, in a file that opens cleanly. An express id is a `u32` everywhere
  else in this codebase (`Uint32Array` in the parser's entity index and its
  transports, `u32` in the Rust crates), and STEP bounds an entity id only by the
  `u32` the readers use, so this was reachable input rather than a hypothetical.

  `columnsToParquet` takes an optional `uintColumns` set, and `ParquetExporter`
  declares its id and geometry-index columns (`ExpressId`, `EntityId`, `SourceId`,
  `TargetId`, `RelId`, `ElementId`, `StoreyId`, `BuildingId`, `SiteId`, `Index0-2`,
  `VertexStart`/`Count`, `IndexStart`/`Count`).

  `SpatialHierarchy.parquet`'s `BuildingId`, `SiteId` and `SpaceId` are
  deliberately NOT in that set: they carry **-1 as "none"**, and declaring them
  unsigned turns that sentinel into 4294967295 - an id-shaped number where an
  obviously-absent marker belongs, which is the same defect in the other
  direction. A building or site id at or above 2^31 therefore still wraps in those
  three columns; fixing that means writing NULL rather than -1 for "none", which
  changes what every consumer reads for an absent parent and is a separate
  decision.

  **Schema change for `.bos` consumers:** the declared columns are now `UINT32`
  rather than `INT32`. Readers that pinned the old signed type will need updating.
  The values are unchanged except for ids at or above 2^31, which were previously
  written as negative numbers.

## 2.9.0

### Minor Changes

- [#2602](https://github.com/LTplus-AG/ifc-lite/pull/2602) [`e51f5cb`](https://github.com/LTplus-AG/ifc-lite/commit/e51f5cb82d10b6c7d73186d8126f788b48c7f3a1) Thanks [@louistrue](https://github.com/louistrue)! - Export `columnsToParquet`, the Arrow-to-Parquet conversion `ParquetExporter`
  already used internally.

  A caller with a table that is not an `IfcDataStore` view - the viewer's
  per-element x per-zone quantity breakdown is the first - now writes Parquet
  through the same type inference and the same Arrow IPC fallback, rather than a
  second conversion beside it. `ParquetExporter` delegates to it, so there is one
  implementation of the schema inference rather than two that agree today.

  Also exports `isParquet`, and fixes the browser path: the package resolves to
  its wasm-bindgen ESM build there, which does nothing until its default export is
  awaited. Without that every browser call threw inside `Table.fromIPCStream` and
  fell through to the Arrow IPC fallback silently, so a caller naming a file
  `.parquet` wrote Arrow IPC into it. `isParquet` lets a caller name the file
  after what it actually got.

### Patch Changes

- [#2580](https://github.com/LTplus-AG/ifc-lite/pull/2580) [`9b4d791`](https://github.com/LTplus-AG/ifc-lite/commit/9b4d791990cf72786b04f5b02933395fed1fe085) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `StepExporter` no longer emits a relationship record that names an entity the export itself excluded. A hidden PRODUCT under `visibleOnly` keeps its own defining line out of the file, but `IFCREL*` records are unconditional roots and their bytes used to be copied to the output verbatim — so a relationship naming both a kept and a hidden product still named the hidden one, shipping a `#N` reference with no `#N=` defining line. Strict STEP readers reject that file; lenient ones silently mis-place the geometry it pointed at.

  A new `filterHiddenRefsFromRelationshipLine` (`reference-collector.ts`) runs on every relationship's line right before it is written, for both source-parsed and overlay-authored relationships: a hidden or deleted id is dropped from a nested list attribute (`RelatedObjects`, `RelatedElements`, …), and the relationship is withheld entirely when a hidden/deleted id sits in a bare scalar attribute (`RelatingSpace`, `RelatedOpeningElement`, …) or when dropping it from a list would leave that list empty.

  Two exclusion sources are covered, both previously unhandled:

  - **`visibleOnly` hidden products** — the case above.
  - **Deleted (tombstoned) entities, on any export, `visibleOnly` or not.** The existing deletion-path guard only withholds an `IfcRelDefinesByProperties` when _every_ related object was deleted, and only for that one relationship class — a spatial-containment relation (or any other `IFCREL*` type) still naming a partially-deleted related list shipped the same dangling reference on a plain full export.

  The relationship's excluded/effective type is resolved through `EffectiveEntityIndex.effectiveType`, not the record's authored (pre-retype) class: an entity retyped across the `IFCREL*` boundary — into or out of a relationship class — is now classified by what the export actually writes, not by the class it started as. Classifying by the authored class alone let a retyped relationship skip the filter (or apply it wrongly) depending on retype direction.

  This is a behaviour change to STEP export output, split out of [#2398](https://github.com/LTplus-AG/ifc-lite/issues/2398) to stand on its own: the surrounding source-guard refactor in that PR is a provable no-op and does not touch this code path.

- Updated dependencies [[`cd72412`](https://github.com/LTplus-AG/ifc-lite/commit/cd724127245fcb767894642cd0994baaba88ff7d), [`b85b2be`](https://github.com/LTplus-AG/ifc-lite/commit/b85b2be4dd79045f1dd02ed344d102f27ecc2594)]:
  - @ifc-lite/geometry@3.8.2
  - @ifc-lite/parser@4.0.3

## 2.8.6

### Patch Changes

- [#2579](https://github.com/LTplus-AG/ifc-lite/pull/2579) [`6d09c4a`](https://github.com/LTplus-AG/ifc-lite/commit/6d09c4a768a9caa1600fb6db38d0e80ec8051aee) Thanks [@louistrue](https://github.com/louistrue)! - `StepExporter` now honours a quantity set the session DELETED.

  It withholds a source `IfcElementQuantity` when it is writing a replacement for it, and a deletion has no replacement to be recognised by, so a deleted set stayed in the exported bytes while the panel showed it gone. [#2487](https://github.com/LTplus-AG/ifc-lite/issues/2487) wrote that rule when `MutablePropertyView` had no public quantity-set delete; `deleteQuantitySet` ([#2508](https://github.com/LTplus-AG/ifc-lite/issues/2508)) gives it one, so the exporter asks `isQuantitySetDeleted` as well.

  Behaviour is unchanged for every session that does not delete a quantity set, which is every session before this one could exist.

- Updated dependencies [[`02079a6`](https://github.com/LTplus-AG/ifc-lite/commit/02079a66042a6e446b9f83f656685f6056020718), [`6d09c4a`](https://github.com/LTplus-AG/ifc-lite/commit/6d09c4a768a9caa1600fb6db38d0e80ec8051aee)]:
  - @ifc-lite/data@3.3.0
  - @ifc-lite/mutations@1.26.0

## 2.8.5

### Patch Changes

- Updated dependencies [[`0ab480d`](https://github.com/LTplus-AG/ifc-lite/commit/0ab480dd78fbce9f8159b6248579356cfa25bfaa), [`7ee619f`](https://github.com/LTplus-AG/ifc-lite/commit/7ee619f8c6a7490982136d5677674f4f6355a568), [`b4b3e0c`](https://github.com/LTplus-AG/ifc-lite/commit/b4b3e0cfa8ffa9185e96dc266dd6fdc3fef34797), [`c532d6a`](https://github.com/LTplus-AG/ifc-lite/commit/c532d6a9cb9397a24e718bcfe09f1c515067852d), [`1de1696`](https://github.com/LTplus-AG/ifc-lite/commit/1de16969db1c56f4901e4af49da74085bae3b3fe)]:
  - @ifc-lite/geometry@3.8.1
  - @ifc-lite/parser@4.0.2
  - @ifc-lite/encoding@2.0.0
  - @ifc-lite/data@3.2.4

## 2.8.4

### Patch Changes

- [#2469](https://github.com/LTplus-AG/ifc-lite/pull/2469) [`7f7255a`](https://github.com/LTplus-AG/ifc-lite/commit/7f7255acb6ab5a6d34b2e0782215ab0dbb9462a9) Thanks [@louistrue](https://github.com/louistrue)! - Fix a `deltaOnly` STEP export claiming a modification count it cannot deliver ([#2462](https://github.com/LTplus-AG/ifc-lite/issues/2462)). A session whose only edit was `setAttribute(8, 'Name', 'X')` exported a header reading `"Re-exported by ifc-lite, 1 modification"` over a `DATA` section with zero entity lines.

  The count was incremented at the INTENT sites, which is sound only for a full export: there the source-iteration pass writes every modified host's own rewritten line, so intending to modify an emittable host and emitting the modification are the same event. `deltaOnly` skips that pass wholesale, and the only lines a source-backed host can then contribute are the ones the property-set generator, the quantity-set generator and the type-object `HasPropertySets` rewrite produce for it. Three kinds of edit produce none of those and still counted: an in-place attribute edit (applied by rewriting the entity's own line, inside the skipped pass); a georeferencing edit to an **existing** `IfcProjectedCRS` / `IfcMapConversion`, which is queued as exactly such attribute edits; and a property/quantity-set **deletion**, which produces no replacement content for a delta to carry. `exportPropertiesOnly()` sets `deltaOnly`, so it was affected on all three.

  The count is now nominated at the edit sites and settled at the end from what the emit passes actually wrote, so the header claim and the `DATA` section cannot disagree. Deltas that do carry their modification — a replacement property set or quantity set, a repointed type-object `HasPropertySets` line — count exactly as before, and a full export counts the same entities it always did, apart from the no-op edits described in the next paragraph (its ledger keys on the entity rather than counting nominations, which changes no count reachable today and stops a future second nomination of one host from inflating one). The `willBeEmitted` / `hasEmittableHostBytes` carve-out that lets a generated `IFCRELDEFINESBYPROPERTIES` name a source host under `deltaOnly` is untouched; whether a host's line exists in the file being patched and whether THIS file contains the change are different questions, and only the second one is the header's.

  A modification is also counted only when the export actually **changed the line**, which narrows what counts on both paths. `setEntityType(id, 'IfcWall')` on an entity that already is an `IfcWall`, and `setPositionalAttribute(id, slot, value)` writing the token the slot already holds, used to count as a modification and to reach the ledger as a landed edit — over a file the exporter left byte-identical; so did a retype the source line was too malformed to apply. Each of those now compares the line across its own operation, the way a named attribute edit already did. The same rule reaches the type-object `HasPropertySets` repoint: a repoint can resolve to the list the line already names — deleting a property set name the type object does not own leaves every original id in place and generates no replacement content — and such a line is no longer written into a delta, nor credited with delivering the edit that nominated the host (which is then reported as undelivered, because nothing in that file carries it). A **full** export still writes it, since `rewrittenEntityIds` made the source-iteration pass skip that entity and withholding the line would delete the record. In short: a session whose edits all resolve to the text already present now reports `0` modifications and a header with no claim, where it used to report one per edited host.

  `stats.warnings` also gains entries naming what a `deltaOnly` export could not carry. (They are not the only new warning — see the last paragraph for one that fires on a full export too.) The ledger is keyed on **(entity, edit kind)**, not on the entity: a pass records an emission for the kind its content genuinely delivers — generated property-set lines deliver the property-set edit and nothing else, a rewritten type-object line delivers the in-place edits it carries — so one warning is emitted per dropped **kind**, naming the hosts it was dropped for and why that kind cannot survive a delta. A wall renamed **and** given a property set in one session now exports the pset into `DATA`, still counts **1** modification (the delta really does contain a modification for that wall, and `modifiedEntityCount` counts entities, not edits), and warns that it carried no attribute edits for `[#8](https://github.com/LTplus-AG/ifc-lite/issues/8)`. Keyed per entity, that same session returned `warnings: []` — a caller could apply the delta believing the rename was in it, which is the silent misreport this whole change exists to remove.

  "Delivered" means the emitting pass reports having applied that kind, not merely that a line came out: a named attribute edit whose name resolves to no slot in the record's class is discarded by the rewrite, and it is now named as undelivered rather than covered by the line that dropped it. Warnings whose cause is not the delta format are not duplicated by the ledger either: when a type object's `HasPropertySets` could not be repointed (see the last paragraph), the specific warning about that line is the only one you get for that property-set edit — the format is not why it failed.

  One gap is left, and it is in **nomination**, not in the warning: retypes and positional edits are recognised only inside the source-iteration pass, which `deltaOnly` skips, so a delta that drops one still does not name it. They are not always dropped — a retype or positional edit to a type object whose `HasPropertySets` is repointed rides along on that rewritten line and is recorded as delivered — and the one place this is visible in the count is narrow: a type object whose repoint FAILED, whose only other edit is a retype or a positional edit, emits its fallback line while the header claims nothing for it. Every other delta drops those two kinds without emitting anything, so claiming nothing is right.

  Also fixes a type object whose type-owned `HasPropertySets` is repointed losing every other edit to the same entity, on both the full and the `deltaOnly` path. That line is written by the rewrite pass rather than the source-iteration pass (`rewrittenEntityIds` makes that pass skip it), and the rewrite replaced slot 5 and nothing else — so renaming a wall type and editing one of its type-owned property sets in one session wrote the new pset list and the OLD name, with no error and no warning; `setEntityType` and `setPositionalAttribute` were dropped on that same line in the same silence. The rewrite now runs the same mutation pipeline the source-iteration pass runs — retype, then named attribute edits, then positional edits — and resolves `HasPropertySets` last, on its output. Applying the property-set resolution first would let a positional edit to slot 5 overwrite it, orphaning the property set the export had just generated.

  And that rewrite no longer deletes the entity when it cannot repoint the slot. Because `rewrittenEntityIds` makes the source-iteration pass skip the type object, the rewrite pass owns its only defining line — and it emitted one only when the slot replacement succeeded. The schema cannot make that fail (every `IfcTypeObject` subtype declares `HasPropertySets` at slot 5), but the INPUT can: a truncated or otherwise unparseable source line has no sixth argument to write into. Both passes then wrote nothing and the whole record vanished from the exported file, silently — a full export of a file with one malformed type line came back without that type. The rewrite now falls back to the line the mutation pipeline produced, which is exactly what the source-iteration pass would have written, so the record survives with the session's retype, attribute and positional edits applied. Only the property-set change is lost, it now says so in `stats.warnings` naming the entity, and any replacement property set generated for that host is left unreferenced — the warning says that too. Under `deltaOnly` the fallback line is emitted only when the mutation pipeline actually changed it, since a delta carries changes and that pass never ran; a host whose sole failed edit was the property set counts as nothing delivered, as it should.

- [#2497](https://github.com/LTplus-AG/ifc-lite/pull/2497) [`7c686f9`](https://github.com/LTplus-AG/ifc-lite/commit/7c686f9ac39f78a707dc083c798b6ef3d255e171) Thanks [@louistrue](https://github.com/louistrue)! - Three fixes to what a STEP export claims and what it writes: an attribute edit is counted from effect rather than intent ([#2483](https://github.com/LTplus-AG/ifc-lite/issues/2483)), an `Enum` property value is qualified as `IFCLABEL` instead of written as a bare enumeration token ([#2488](https://github.com/LTplus-AG/ifc-lite/issues/2488)), and a source byte range the store cannot address is refused rather than emitted as a blank line ([#2491](https://github.com/LTplus-AG/ifc-lite/issues/2491)).

  **A no-op attribute edit no longer claims a modification.** `setAttribute` was the last nomination site in the family [#2462](https://github.com/LTplus-AG/ifc-lite/issues/2462) / [#2469](https://github.com/LTplus-AG/ifc-lite/issues/2469) / [#2474](https://github.com/LTplus-AG/ifc-lite/issues/2474) converted from intent to effect. Two edits reachable on the FULL export path write nothing and still counted: `setAttribute(id, 'Name', v)` where `v` is the value already in the slot, and `setAttribute(id, name, v)` naming an attribute the class declares no slot for, which `applyAttributeMutations` discards. Either one put `"1 modification"` in the header of a file byte-identical to its input. The signal already existed — the mutation pipeline reports `attributed` by comparing the line across the named-attribute write, which is an effect and not an intent — so what moved is the nomination, from the collection pass to the two passes that write a rewritten source line (the source-iteration pass, and the type-object `HasPropertySets` rewrite that replaces it for the hosts that pass skips; both, because a host whose line only ever comes out of the rewrite path would otherwise stop counting a rename that genuinely landed). The georeferencing site moved with it: its fields are queued into the same `modifiedAttributes` map and applied by the same call, and its own `changed` flag is likewise intent — a field was supplied, not a field that differs — so writing `name: 'EPSG:2056'` onto an `IfcProjectedCRS` already named that counted too. `deltaOnly` is unchanged and still nominates at INTENT, deliberately: its per-kind warning exists to NAME an edit the delta format could not carry, so an undeliverable edit is exactly the one that must still be nominated, and a full export has no such warning and nothing for the caller to do — the honest report there is the count alone. The behavioural difference a caller may notice: a session whose attribute or georeferencing edits ALL resolve to no change now reports `0` modifications and a header with no claim, where it used to report one per edited host. An edit that does change the line counts exactly as before, once per entity however many kinds landed.

  **An `Enum` property value is written as a member of the SELECT it goes into.** `serializePropertyValue` wrote `PropertyValueType.Enum` as a bare EXPRESS enumeration token (`.EXTERNAL.`) into `IfcPropertySingleValue.NominalValue`, which is declared `IfcValue`. That SELECT resolves to `IfcMeasureValue | IfcSimpleValue | IfcDerivedMeasureValue` in every schema this exporter targets (IFC2X3, IFC4, IFC4X3) and none of them has an ENUMERATION leaf, so there is no wrapper for an enumeration token and a bare one is not a member at all — this was the one branch writing an unqualified token where every other branch writes `IFCLABEL('…')` / `IFCBOOLEAN(.T.)` / `IFCLOGICAL(.U.)`. It is now `IFCLABEL('…')`, which is what `@ifc-lite/collab`'s `PROPERTY_TYPE_NAMES` has always called this member, and the value is escaped like any other string (a bare token never was, because an enumeration name cannot contain a quote). The `.toUpperCase()` goes with it: it existed to build an enumeration name, which is upper-case by construction, and folding the case meant an authored `'external'` read back as `'EXTERNAL'`. The blast radius is small and known: NO extraction path produces `Enum` — the property extractor collapses every string-valued token to `String`, and a source `IfcPropertyEnumeratedValue` is a different property class rather than a `NominalValue` token — and `StoreEditor.PropertyKind` cannot express it either, so the only way to reach this branch is `MutablePropertyView.setProperty(…, PropertyValueType.Enum)` with the type named explicitly. No source file's re-export moves; a session that authored an enum-typed property writes a conforming line where it used to write an invalid one.

  **A byte range the source cannot serve is refused instead of emitted empty.** The exporter's byte-range gates asked two weaker questions — is there a source at all, and does this ref claim a non-empty range — and relied on an unstated invariant to join them: an empty source implies zero-length entity refs. Every producer in the repo honours it (the one source-less store builder adds every ref as `(0, 0)`) and nothing states or enforces it. A store that violates it made the exporter write a corrupt file in silence: refs claiming real bytes over a source with none passed the presence gates, so the property-set generator wrote an `IfcRelDefinesByProperties` naming the wall, while the source-iteration pass emitted the wall's own line as the EMPTY STRING, because `IfcSourceBytes.decodeUtf8` clamps a range it cannot address. A relationship pointing at a record that is not in the file, with no error and no warning. One predicate now answers "can this line be read" at every gate — both emittability predicates, the source-iteration skip, the type-object rewrite's decode and the `OwnerHistory` lookup — so a violating store degrades to the shape the exporter already handles correctly (a record with no emittable bytes: nothing is generated FOR it and nothing that names it is written) rather than to a broken file. Testing the ref rather than asserting the invariant at construction is deliberate: stores are built by the parser, by the viewer's server data model, by test doubles and by any embedder of the published API, so an assertion would have to be added to each and the next producer — a partial or streaming source, or one that attaches bytes after building its index — would be free to skip it. Nothing on any reachable path changes: a store whose refs are in range behaves exactly as before, and a source-less store with `(0, 0)` refs behaves exactly as before.

  Released as a patch: no exported API changes. The emitted-content difference is confined to properties a session authored as `PropertyValueType.Enum`, which previously produced an invalid `NominalValue`; the count difference is confined to attribute and georeferencing edits that resolved to no change at all.

- [#2496](https://github.com/LTplus-AG/ifc-lite/pull/2496) [`97ed6ef`](https://github.com/LTplus-AG/ifc-lite/commit/97ed6ef3addb81de2bba175882be35760eb25bc9) Thanks [@louistrue](https://github.com/louistrue)! - Two ways a re-export wrote wrong data into the file a user keeps: a regenerated property set re-declared its neighbours' types ([#2482](https://github.com/LTplus-AG/ifc-lite/issues/2482)), and a source `IfcElementQuantity` was deleted with nothing written in its place ([#2487](https://github.com/LTplus-AG/ifc-lite/issues/2487)).

  **A regenerated property keeps the type its source line declared.** Editing one property regenerates the whole property set, so every other property in it is re-serialized too — and they were written from `PropertyValueType` alone, which is a shape and not a type. The extractor collapses `IFCLABEL` / `IFCTEXT` / `IFCIDENTIFIER` to `String` and every `…MEASURE` / `…RATIO` to `Real`, keeping the source token only in `Property.dataType`, which the generator never read. So one edit rewrote its untouched neighbours: `IFCTEXT('…')` and `IFCIDENTIFIER('A-01')` came back as `IFCLABEL`, and `IFCLENGTHMEASURE(2500.)` and `IFCAREAMEASURE(12.5)` came back as `IFCREAL` — on the numeric side the measure token IS the unit semantics, so the number stopped saying what it measures. A re-export that touches a property set now writes each property's own declared type back, under four gates: the token must name a member of the `IfcValue` SELECT (resolved from the schema registry, so all 106 IFC4 leaves qualify and a vendor token like `IFCACMEWIDGETCODE` does not — it falls back to `IFCLABEL`, lossy but valid, rather than putting a non-member in the slot); its EXPRESS base must agree with the effective value type (so a session that retyped the property with `setProperty(…, valueType)` wins, and a property nobody edited always agrees, since the extractor derived both from the same token); the value must be representable in that base (so an `IfcPropertyBoundedValue`'s measure `dataType` is not wrapped around the display string it is extracted as, and no `IFCLENGTHMEASURE(NaN)` is written where the old path wrote `$`); and the value must satisfy the declared type's own EXPRESS domain, since six `IfcValue` members are constrained defined types and `setProperty` performs no schema validation. Editing an `IFCPOSITIVELENGTHMEASURE(5.)` to `-1`, or an `IFCNORMALISEDRATIOMEASURE(0.5)` to `2`, therefore no longer re-declares the constrained type over a value that violates it; the property relaxes to the nearest unconstrained ancestor of the same measure family (`IFCLENGTHMEASURE(-1.)`, `IFCRATIOMEASURE(2.)`), which is schema-valid and still says what the number measures. Properties AUTHORED in the session are unaffected — they carry no `dataType` and are written from the type they were created with, exactly as before. `null` values are untouched too: a null is the extractor's reading of `IFCLOGICAL(.U.)` as much as of an absent value, and which it is belongs to the mapping table ([#2472](https://github.com/LTplus-AG/ifc-lite/issues/2472)), not here.

  **A quantity edit no longer deletes the source quantity set.** A full export withheld a source `IfcElementQuantity` — the container, its quantity atoms and the `IfcRelDefinesByProperties` attaching it — whenever the session's mutation history merely NAMED that set, and then regenerated it from `getQuantitiesForEntity`. Those two disagree whenever the overlay has no base under it, and it has none by default: properties fall back to the view's `baseTable` or its on-demand extractor, but base quantities have only `setQuantityExtractor`, which is opt-in with no diagnostic when it is missing. Two reachable shapes followed. Editing one quantity of a source set regenerated that set holding ONLY the edited quantity, and the siblings the file came with were withheld and never rewritten. Undoing a quantity creation (`setQuantity` then `removeQuantityMutation`, which is what Ctrl+Z runs) left the append-only `CREATE_QUANTITY` record still naming the set while the overlay had dropped it, so the source lines were withheld and nothing at all replaced them: the export of a file WITH the quantity set was byte-identical to an export of the file WITHOUT it, under `modifiedEntityCount: 1` and no warning. Fixed in two independent places. The exporter now supplies the missing base itself — it is handed the very store the view is an overlay on, so it installs a store-backed quantity extractor when, and only when, the view has none, which covers every caller including external embedders of the published API rather than the in-tree callers we happened to find. And the skip loop now withholds a source quantity set only when the generator actually wrote a replacement for that name, rather than on the strength of a name in the history; there is no quantity-set REMOVAL this could suppress, because `deletedQsets` has no public populator, so withholding without a replacement was always the bug. A view that resolves its own quantities (the viewer, MCP, the CLI headless backend) is untouched — its extractor is never overwritten, whether it was installed before the first export or after one, and both view methods are feature-probed so a partial or older view falls back instead of throwing mid-export.

  What a re-export now produces, precisely. A property set the session edited: every property that came from the file keeps its source `NominalValue` token instead of the shape-derived one, so the same file re-exported through an edited pset differs from before on those lines and only on those lines (a property with a vendor or unrecognized token, a bounded/enumerated/list/table property, and every authored property are byte-identical to before). A quantity set the session edited: the emitted `IfcElementQuantity` now carries the source set's other quantities alongside the edited one, where it used to carry the edited one alone; an edit that was undone leaves the quantity set in the file, either as the untouched source lines or as a regenerated set with the same values and fresh express ids and GlobalId, where the whole set used to disappear. Counts are unchanged in shape: an edit that regenerates a set still counts as one modification of its host.

  `MutablePropertyView` gains `hasQuantityBase()` (minor), which is how a consumer holding the base data tells "this entity has no quantities" apart from "this view cannot see them". `packages/cli`'s `mutate`, `gym` and `generate-spaces` now wire `setQuantityExtractor` alongside the property extractor they already wired, so their views report quantity sets whole and not only at export time.

- [#2481](https://github.com/LTplus-AG/ifc-lite/pull/2481) [`9311e3f`](https://github.com/LTplus-AG/ifc-lite/commit/9311e3f045754931035cbc8cdba50a1412163006) Thanks [@louistrue](https://github.com/louistrue)! - Three fixes to what a STEP export claims and what it writes: property/quantity-set modifications are counted from effect rather than intent ([#2474](https://github.com/LTplus-AG/ifc-lite/issues/2474)), a `Text` property is emitted as `IFCTEXT` and a `Logical` one as `IFCLOGICAL` ([#2472](https://github.com/LTplus-AG/ifc-lite/issues/2472)), and the STEP argument splitter behind the type-object `HasPropertySets` repoint rejects an argument list it could not scan instead of writing a slot into it ([#2470](https://github.com/LTplus-AG/ifc-lite/issues/2470)).

  **A re-export produces different bytes for two property kinds.** A property authored as `Text` was serialized as `IFCLABEL` — `IfcLabel` is a bounded, name-like string and `IfcText` is unbounded prose, so a consumer read a different declared type than the property was created with, and a long value exceeded what `IfcLabel` is specified to carry. Auditing the rest of the mapping found one more: `Logical` was written as `IFCBOOLEAN` for its two definite states, borrowing the two-valued primitive's name for the three-valued one, and a Logical whose value is the third state (`.U.`, which the property extractor reads back as `null`) was written as `$`, dropping the state entirely. Both now name the primitive the property was authored as. Nothing else in the table moved: `String` remains `IFCLABEL` (it is the extractor's catch-all for a string whose declared type it did not keep, so the bounded primitive is the conservative default), `Enum` remains a bare enumeration token (which is not a member of the `IfcValue` SELECT it is written into — a pre-existing conformance gap this pass deliberately leaves alone, tracked as [#2488](https://github.com/LTplus-AG/ifc-lite/issues/2488)), and `Reference` — which no extraction path produces — remains a label, since an entity reference is a different property class rather than a different `NominalValue` token. `@ifc-lite/collab`'s `PROPERTY_TYPE_NAMES`, the same table for a different transport, already named both correctly. No round-trip test could have caught either: the extractor collapses every string-valued token (`IFCLABEL`, `IFCTEXT`, `IFCIDENTIFIER`) to `PropertyValueType.String` and keeps the token name only in `dataType`, so a value survives export and re-import through the wrong wrapper unchanged and only its declared type is lost. That collapse is also why re-exporting a source `IfcText` property still writes `IFCLABEL` — the regenerated property is written from the extracted value type, not from `dataType` — which is a wider change (it would mean honouring `dataType` for every regenerated property, `IFCLENGTHMEASURE` included) and is tracked separately as [#2482](https://github.com/LTplus-AG/ifc-lite/issues/2482).

  **A no-op property-set edit no longer claims a modification.** [#2462](https://github.com/LTplus-AG/ifc-lite/issues/2462) converted the source-line pipeline to report effect; the property-set and quantity-set sites still counted intent. Both nominate from a set NAME the session's mutation history mentions, which says nothing about whether that name resolves to content: `deletePropertySet(id, 'AName')` on a host that owns no such set was still "affected", matched nothing, generated nothing — and a full export reported `modifiedEntityCount: 1` with a header claiming a modification over a file byte-identical to its input. The quantity side reaches the same state through an undone quantity-set creation whose name matches no source set, since its `CREATE_QUANTITY` record stays in the append-only mutation history after the overlay has dropped the set. The test applied is effect on the emitted FILE: this export either wrote a line for the host's set or left one out. Regenerating a set with identical property values still counts, because the replacement carries fresh express ids and genuinely is different bytes; deleting a set that exists counts through the lines the export withholds — which is how a full export applies a removal, and why the generator's emission record alone could not settle it (a type-owned set is recorded by the `HasPropertySets` repoint that drops it from the list instead); deleting a set that does not exist touches neither side. Both set kinds record that withheld half, quantities included: the SAME undone quantity-set creation against a name the source file already uses is not a no-op at all — it withholds the source `IfcElementQuantity`, its atoms and its relationship while regenerating nothing, so it must keep counting. (That drop is itself a bug, older than this change and not fixed here — the exporter withholds a source quantity set on the strength of a name in the mutation history, and a `MutablePropertyView` with no `setQuantityExtractor` has no base to regenerate it from. It is reproduced and tracked as [#2487](https://github.com/LTplus-AG/ifc-lite/issues/2487), with a test on this branch pinning the current behaviour.) `deltaOnly` is unchanged — its nominations are not withdrawn, so the warning naming a property-set change a delta could not carry still fires, and the empty-delta early return still keys on the same intent-populated set it always did. A full export stays silent about an edit that resolved to nothing: there is no other flag to re-export with, and the count already says it.

  **An argument list the splitter could not scan is rejected rather than split into plausible parts.** `splitTopLevelStepArguments` tracked quote state and paren depth to find the top-level commas and then ignored where that scan ended up, so text that never left a string or never closed a nested list still produced parts — parts whose boundaries are wherever the scanner stopped rather than the record's slots. `replaceStepArgument`'s regex pins only the two ends of the record (`#N=CLASS(` … `);`), so such a line reached the split, had a slot written by index, and came back non-null: a success it had not achieved, and a corrupted line where [#2469](https://github.com/LTplus-AG/ifc-lite/issues/2469) had a dropped one. An unterminated string, an unbalanced nested list and a depth that dips below zero and climbs back (balanced at the end, every comma in between read as nested) are all `null` now, which the type-object repoint already handles by keeping the line as it stands and warning. The unit-rescale pass, the splitter's other caller, already stops one step earlier — it locates the record's argument span with its own quote- and depth-aware scan, so a line that never closes its string or its list has no span and is returned untouched; the span it does produce is balanced by construction, which makes the splitter's refusal an invariant there rather than a reachable branch.

  An EMPTY top-level slot (`a,,b`, or a trailing comma) is deliberately NOT rejected, though it is invalid STEP. It shifts nothing — an empty argument is one part, exactly as the entity parser counts it, so every index still names the attribute it is meant to. Rejecting it as well was tried and measured to be worse: the parser resolves `HasPropertySets` on such a line, so a session deleting that type object's property set has already had the pset's lines withheld by the time the repoint runs, and refusing the repoint left the record naming a property set the export had just dropped. That is a dangling reference and an invalid file, where the accepted split produces a correct one.

  The other two places that write a type object's slot 5 were audited for the drop [#2469](https://github.com/LTplus-AG/ifc-lite/issues/2469) fixed and are not affected: `retypeStepLine` parses the line itself and returns its input unchanged when it cannot, so there is no null to misread, and the overlay new-entities pass writes the slot as a positional override that pads the record to the class's declared arity first — a short authored payload grows to reach the slot rather than falling off the end, and the line is written either way. Both are now pinned by tests on the truncated input that produced the original drop.

  Released as a patch: no exported API changes, and the emitted-content differences are corrections to a declared type that was wrong — `IfcText` and `IfcLogical` are `IfcValue` members any IFC consumer already reads. The behavioural difference a caller may notice is the count, and only for property- and quantity-set edits. A host counts when this export wrote a line for its set or left one out, and not otherwise: a session whose set edits ALL resolve to no line either way — the reported case is `deletePropertySet` naming a set the host does not own — now reports `0` modifications and a header with no claim, where it used to report one per edited host. A set edit that does change the file counts exactly as it did before, including the ones whose only effect is lines the export leaves OUT and does not replace. Nothing else moved: the other four modification kinds are settled by the pass that writes them, and `deltaOnly`'s count and warnings are untouched.

- [#2507](https://github.com/LTplus-AG/ifc-lite/pull/2507) [`1e3595e`](https://github.com/LTplus-AG/ifc-lite/commit/1e3595ec0b5599d892407065357b9f6284d62b17) Thanks [@louistrue](https://github.com/louistrue)! - Split `step-serialization.ts` (678 lines, past the ~400-line module guideline) into three modules along the seams the file already had. No behaviour change: every moved function is byte-identical to what it was, and no import path outside `packages/export/src` changes — none of the moved symbols is re-exported from the package entry point, so `@ifc-lite/export`'s published surface is unchanged.

  - `step-argument-parser.ts` (221) takes the STEP argument parser and rewriter: `splitTopLevelArgs`, `replaceStepArgument`, `splitTopLevelStepArguments`. These are the one text layer in the export path that runs the other way — they read a record's slots back OUT of a line and write one back by index, where everything left behind turns a value INTO a token. They share one set of rules (quote state, doubled-quote escapes, paren depth, what counts as a slot), and those rules are what someone has to be able to find when a rewritten line comes out wrong. Both hardened functions from the malformed-input work now sit next to each other rather than 100 lines apart with an unrelated splitter and the file assembler in between.
  - `step-file-assembly.ts` (111) takes `assembleStepBytes` / `assembleStepBlob`, which do not serialize anything: they join a finished header and finished entity lines into the delivered artifact, and their contract is that the two stay byte-identical to each other.
  - `step-serialization.ts` (389) keeps exactly what its own docblock claims — pure value-to-token serialization.

  The test file split the same way (`step-argument-parser.test.ts`, `step-file-assembly.test.ts`), each block moving with the code it pins. Test count is unchanged at 648 passing / 30 skipped; five guard mutations from the moved code (the negative-depth rejection, the unterminated-string rejection, the `replaceStepArgument` slot validation, the `splitTopLevelArgs` comma trim, and the `assembleStepBytes` newline accounting) each kill exactly the same set of tests before and after the move.

- Updated dependencies [[`a8da187`](https://github.com/LTplus-AG/ifc-lite/commit/a8da187054ffb2992974e8592bbdd13a559ff8cd), [`63496ec`](https://github.com/LTplus-AG/ifc-lite/commit/63496ec0ae63c54c3bcbc5ecaec537877dc48831), [`97ed6ef`](https://github.com/LTplus-AG/ifc-lite/commit/97ed6ef3addb81de2bba175882be35760eb25bc9), [`a8da187`](https://github.com/LTplus-AG/ifc-lite/commit/a8da187054ffb2992974e8592bbdd13a559ff8cd), [`8bddeca`](https://github.com/LTplus-AG/ifc-lite/commit/8bddeca78313c6a2575e46975471055982389f12), [`eb39b27`](https://github.com/LTplus-AG/ifc-lite/commit/eb39b27f5eba186b23b3a683c25fff2c60084d9c), [`086e5dd`](https://github.com/LTplus-AG/ifc-lite/commit/086e5ddab3e72428fd262f0033598df5b714e328), [`086e5dd`](https://github.com/LTplus-AG/ifc-lite/commit/086e5ddab3e72428fd262f0033598df5b714e328), [`086e5dd`](https://github.com/LTplus-AG/ifc-lite/commit/086e5ddab3e72428fd262f0033598df5b714e328), [`7c686f9`](https://github.com/LTplus-AG/ifc-lite/commit/7c686f9ac39f78a707dc083c798b6ef3d255e171)]:
  - @ifc-lite/geometry@3.8.0
  - @ifc-lite/mutations@1.25.0
  - @ifc-lite/encoding@1.16.0
  - @ifc-lite/data@3.2.3
  - @ifc-lite/parser@4.0.1

## 2.8.3

### Patch Changes

- [#2397](https://github.com/LTplus-AG/ifc-lite/pull/2397) [`55f7591`](https://github.com/LTplus-AG/ifc-lite/commit/55f759154421bd002d0bdc171e82aa93b574470d) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `EffectiveEntityIndex.effectiveAttributeRef` resolving an overlay-created entity's named attribute by its _authored_ type instead of its _effective_ (post-retype) type.

  `effectiveAttributeRef`'s positional fallback looked up an attribute's schema position via `getAllAttributesForEntity(entity.type)`, where `entity.type` is the type the record was created as — ignoring `this.retypes`, the same map `effectiveType` already consults. For an entity retyped after creation (e.g. `IfcRelAggregates` retyped to `IfcRelVoidsElement`), a lookup for an attribute name that exists only in the new type's schema (`RelatingBuildingElement`) found no match in the old schema and returned `undefined`. This broke `propagateOpeningExclusions`' opening-exclusion propagation for a `visibleOnly` export: an opening whose retyped `IfcRelVoidsElement` names a hidden host was not excluded, because the relation's host could not be resolved.

- [#2330](https://github.com/LTplus-AG/ifc-lite/pull/2330) [`51cd3ab`](https://github.com/LTplus-AG/ifc-lite/commit/51cd3ab46c7f9d40588e319e7b2c24ce66e99c29) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix the export package's own (parallel, `@ifc-lite/cache`-independent) GLB reader silently decoding an empty mesh instead of erroring when an accessor's `count` is present but non-numeric.

  `readAccessor` computed `count` as `Number(acc.count || 0)`: the `|| 0` only substitutes a default for a _missing_ count — a present-but-bogus value (a corrupted JSON chunk with `"count":"abc"`) survives it and becomes `NaN`. The bounds check right below it (`byteOffset + byteLen > bin.byteLength`) is a bare comparison, so `NaN > bin.byteLength` evaluated `false` and the guard was bypassed; `bin.subarray(offset, NaN)` then silently returned an empty view, and the accessor decoded as a mesh with zero vertices/indices rather than a diagnosable error. `count` is now validated as a non-negative integer before use; a valid `count` (including `0`) is unaffected.

- [#2397](https://github.com/LTplus-AG/ifc-lite/pull/2397) [`55f7591`](https://github.com/LTplus-AG/ifc-lite/commit/55f759154421bd002d0bdc171e82aa93b574470d) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `visibleOnly` export keeping an opening whose host wall was hidden, when the host wall's `IfcRelVoidsElement` was an overlay-created relation that got edited (e.g. `RelatingBuildingElement` repointed) after creation.

  `propagateOpeningExclusions` identified an `IfcRelVoidsElement`'s ends by taking the last two entries of `OverlayIndex.refsOf`, which is documented as the UNION of the creation payload and every queued mutation ref, not a positional readout — a mutation ref is appended after both creation-payload refs regardless of which attribute it overrides. Editing the relation after creation therefore shifted "last two" off `(RelatingBuildingElement, RelatedOpeningElement)`, so hiding the new host failed to hide the opening. Overlay-created relations now resolve each end by attribute name (`EffectiveEntityIndex.effectiveAttributeRef`) instead of by position; the byte-scanned (parsed-from-file) path is unchanged.

- [#2318](https://github.com/LTplus-AG/ifc-lite/pull/2318) [`f67c622`](https://github.com/LTplus-AG/ifc-lite/commit/f67c622147ea51f2b04b93a7b7a9b485160b3e9c) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `ParquetExporter.writeEntities()` writing an overlay-retyped entity's PRE-retype class into `Entities.parquet`'s `Type` column. `writeEntities` already consults the overlay (`MutablePropertyView`) to drop tombstoned rows, but read `Type` straight off the parsed `entities.typeEnum` array regardless, never asking the same `EffectiveEntityIndex` its `isDeleted` check already uses. `StepExporter`/`Ifc5Exporter` resolve `effective.typeOf(id)` before emitting an entity's class, so a `setEntityType` retype (e.g. reclassifying a wall as a column) changed what those two exporters wrote but silently left the `.bos` archive's `Entities.parquet` naming the entity's original class — disagreeing with every other export of the same overlay.

  Rows whose type resolution is unchanged keep their existing rendering: the overlay's class is only used where it actually disagrees with the parsed one. A row whose old rendering came from the enum round trip (rather than the source name) can legitimately change even without an overlay retype — that is this fix working, not a regression. That distinction matters because `typeOf` answers for every indexed entity (not just retyped ones) and answers uppercase, so sourcing the whole column from it would have re-rendered untouched rows through a name table that is missing four of the 125 enum types — turning `IfcProxy`, `IfcSolidStratum`, `IfcVoidStratum` and `IfcWaterStratum` rows uppercase.

- [#2285](https://github.com/LTplus-AG/ifc-lite/pull/2285) [`33f11a8`](https://github.com/LTplus-AG/ifc-lite/commit/33f11a82d34b622c9d6d2c417e9fb38a7ace816e) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `ParquetExporter` emitting geometry for an overlay-deleted entity into the `.bos` archive. When a `MutablePropertyView` is supplied, `Entities`, `Properties`, `Quantities`, `Relationships` and `SpatialHierarchy` already dropped a tombstoned entity's rows, but `VertexBuffer.parquet`, `IndexBuffer.parquet` and `Meshes.parquet` never checked the overlay at all — a deleted entity's mesh still exported, so `Meshes.ExpressId` (and the vertices/triangles it indexes) could name an entity `Entities.parquet` had no row for. The three geometry writers now apply the same `isDeleted` filter as the other tables.

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

- [#2291](https://github.com/LTplus-AG/ifc-lite/pull/2291) [`09d67c7`](https://github.com/LTplus-AG/ifc-lite/commit/09d67c780bf68f58dec3f77920927857c752f8da) Thanks [@louistrue](https://github.com/louistrue)! - Widen the byte-range readers so they accept either the raw source bytes or the `IfcSourceBytes` accessor ([#2183](https://github.com/LTplus-AG/ifc-lite/issues/2183)). Behaviour-neutral groundwork: every widened helper normalises through `asSourceBytes` and reads via `decodeUtf8`/`slice`, and no call site changes shape. (`IfcDataStore.source` still held a `Uint8Array` at this step; the type flip lands in the same release, below.)

  `@ifc-lite/parser` now exports `asSourceBytes` and the `IfcSourceBytes` type. They were internal in the previous step because nothing outside the package consumed them; the widened readers in `@ifc-lite/export`, `@ifc-lite/cli` and the viewer are that consumer, and `IfcDataStore.source` is on its way to the type regardless.

  Widened: `BufferEntitySource`, `extractLengthUnitScale`, `extractProjectUnits`, `SpatialHierarchyBuilder.build`, `buildEntityRefsFromIndex`, `collectReferencedEntityIds`, `collectStyleEntities`, `collectRefsInByteRange`, and the CLI's dangling-reference scan.

- [#2414](https://github.com/LTplus-AG/ifc-lite/pull/2414) [`72bf949`](https://github.com/LTplus-AG/ifc-lite/commit/72bf949bd3a58dfb460c2c445e546d930a248e02) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `StepExporter`'s header claiming a modification the exported `DATA` section does not contain, on a store with no source bytes carrying a pset/attribute/georef edit against one of its entities. This is reachable in production, not just constructible in a test: `createSyntheticDataStore` — the function `apps/viewer/src/hooks/ingest/pointCloudIngest.ts` and `viewerModelIngest.ts` use for LAS/LAZ scans and GLB meshes — builds exactly this shape, a real (non-overlay) entity row with a zero-length byte range. Editing a pset on such an ingested entity and exporting STEP produced a header saying `"Re-exported by ifc-lite, 1 modification"` over an otherwise-empty `DATA;ENDSEC;`.

  The entity's own line was never written by the source-iteration pass (it skips zero-byte-length records) and its pset generation was already correctly gated behind `willBeEmitted`'s byte-range check — only the modification COUNT disagreed with what those two passes actually emit. The fix counts a modification only when the host entity will actually get a defining line: overlay-created (counted separately as new) or backed by real source bytes AND, under `visibleOnly`, not excluded by the visibility closure — the same predicate `willBeEmitted` uses. A normal file-parsed store with real edits is unaffected — its entities have real byte ranges and were never miscounted. A `visibleOnly` export whose hidden host had real edits was also miscounted before this pass and is now fixed the same way.

  The same mismatch existed for `options.includeGeometry === false`: an attribute edit against a geometry-classified host (`IfcShapeRepresentation`, `IfcCartesianPoint`, etc.) still counted as a modification even though the source-iteration pass's own `includeGeometry` filter drops that entity's line from `DATA`. `hasEmittableHostBytes` and `willBeEmitted` now agree with that filter too — except under `deltaOnly` (and `exportPropertiesOnly()`, which sets both flags), where the source-iteration pass's geometry filter never runs in the first place because the whole pass is skipped, so a source geometry entity's line is correctly assumed to already exist in the file being patched.

- Updated dependencies [[`d75786f`](https://github.com/LTplus-AG/ifc-lite/commit/d75786f631047d234f204289426f708f0be8674b), [`273b068`](https://github.com/LTplus-AG/ifc-lite/commit/273b06827ef1469f63c396d204474a9f2400c642), [`58fbc63`](https://github.com/LTplus-AG/ifc-lite/commit/58fbc634994742c79375830c1983508752fd78e9), [`2e16736`](https://github.com/LTplus-AG/ifc-lite/commit/2e167367037fa3b5d1d2d5d26dd4fb7ac169e2f5), [`710fd83`](https://github.com/LTplus-AG/ifc-lite/commit/710fd83638b51b2e4744a1ac364827a27dc0fc73), [`d9490e6`](https://github.com/LTplus-AG/ifc-lite/commit/d9490e6e2ecacb65aea42fcaef73fd292a4c3095), [`d89960a`](https://github.com/LTplus-AG/ifc-lite/commit/d89960aaab08387fbd2307c0f238bd112c684933), [`8751ba4`](https://github.com/LTplus-AG/ifc-lite/commit/8751ba41dc4d1893530b0f1db6ad0f8fa0d5d3fd), [`deb54d3`](https://github.com/LTplus-AG/ifc-lite/commit/deb54d3ff75f35c3c9206c8ea9a1e875426352c6), [`35e37ac`](https://github.com/LTplus-AG/ifc-lite/commit/35e37ac99ab444773bfec669cfc5cf3937443942), [`958aef1`](https://github.com/LTplus-AG/ifc-lite/commit/958aef125743682da75c3da7b41991abd9d36d32), [`de7bd04`](https://github.com/LTplus-AG/ifc-lite/commit/de7bd04619a43a32900b188e0507b95e7542d8c8), [`09d67c7`](https://github.com/LTplus-AG/ifc-lite/commit/09d67c780bf68f58dec3f77920927857c752f8da)]:
  - @ifc-lite/data@3.2.2
  - @ifc-lite/encoding@1.15.1
  - @ifc-lite/parser@4.0.0
  - @ifc-lite/mutations@1.24.2
  - @ifc-lite/geometry@3.7.1

## 2.8.2

### Patch Changes

- [#2059](https://github.com/LTplus-AG/ifc-lite/pull/2059) [`bdeb80d`](https://github.com/LTplus-AG/ifc-lite/commit/bdeb80d79443d89027a4d96879116e99dcc989a4) Thanks [@BIMvoice](https://github.com/BIMvoice)! - STEP export: keep georeferencing edits when the session deleted the file's existing georeferencing.

  The exporter looked up `IfcProjectedCRS` / `IfcMapConversion` in the raw entity index, so a CRS the session had deleted still counted as "existing". The edit was queued against the deleted entity, the export skipped that entity, and the replacement georeferencing vanished from the output with no error. The lookup now goes through the effective (overlay-aware) index, so a deleted CRS or map conversion is recreated instead.

  The same index now backs the source-CRS context and length-unit lookups the georef path uses, so newly created georeferencing can no longer reference a deleted context or unit.

- [#2105](https://github.com/LTplus-AG/ifc-lite/pull/2105) [`b3742d9`](https://github.com/LTplus-AG/ifc-lite/commit/b3742d9d29c3adfcbf67f573c62194547d7d172d) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Report a requested `IfcMapConversion` that the STEP export could not write, instead of returning a file that looks like none was asked for ([#2067](https://github.com/LTplus-AG/ifc-lite/issues/2067)).

  `StepExporter.export()` writes a new `IfcMapConversion` only when it can resolve an `IfcGeometricRepresentationContext` to use as `SourceCRS`; with no candidate it skips the conversion and writes the requested `IfcProjectedCRS` alone. Skipping is the right call — an `IFCMAPCONVERSION` whose `SourceCRS` points at a `#id` the export never writes is an invalid file — but the resulting output is byte-identical to one where the caller requested a CRS and no map conversion at all, so nothing distinguished "you asked for nothing" from "we refused". The refusal was written to `console.warn` and nowhere the caller could read.

  `StepExportResult.stats` now carries `warnings: string[]`, the same shape `MergeExportResult.stats.warnings` already uses, and the refusal is pushed there as well as to the existing console line (both from one shared message string, so they cannot drift). It is populated on both return paths, including the delta-only early return, where a georeferencing-only export can refuse the conversion and then have nothing else to write. `warnings` is empty on every export that refuses nothing, so a caller can treat a non-empty array as "the file is not everything you asked for".

  Which sessions this affects: only those that request a map conversion against a model with no usable `IfcGeometricRepresentationContext` to reference as `SourceCRS`, or against a model with no `IfcProjectedCRS` to reference as `TargetCRS` (requested or existing) — a file that never had a context, or (once the georeferencing resolution moves to the effective index, [#2048](https://github.com/LTplus-AG/ifc-lite/issues/2048)) a session that deleted every one of them. Ordinary georeferencing edits against a model with both are unchanged and report nothing.

  Not changed here: an overlay-created replacement context is still not used as `SourceCRS`. That behaviour was verified rather than assumed — with the id allocator watermarked above the fixture's maximum `expressId`, a context created through `MutablePropertyView.createEntity()` is written to the output file but never selected as `SourceCRS`, both before and after [#2048](https://github.com/LTplus-AG/ifc-lite/issues/2048). Selecting one would need its own decision, because `createEntity` does not require the mandatory `WorldCoordinateSystem` placement, so an overlay-created context can be a schema-invalid target.

  A second refusal is reported with its own message: a map conversion requested with no `projectedCRS` in the same call, against a model carrying neither `IfcProjectedCRS` nor `IfcMapConversion`. Both CREATE branches skip — there is no `IfcProjectedCRS` to reference as `TargetCRS`, requested or existing — so nothing is written and, before this addition, nothing was refused either. This is a different condition from the context refusal above ("no context to reference" vs. "no CRS to attach it to") and gets its own `stats.warnings` message so it does not repeat the context-specific wording.

- [#2047](https://github.com/LTplus-AG/ifc-lite/pull/2047) [`803005f`](https://github.com/LTplus-AG/ifc-lite/commit/803005f1c8d976350111c2f52a6b41b584393ca6) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Stop `Ifc5Exporter` (IFC5/IFCX) from exporting entities deleted via `MutablePropertyView.deleteEntity()` ([#2046](https://github.com/LTplus-AG/ifc-lite/issues/2046)).

  `Ifc5Exporter` walked `dataStore.entities` directly and never consulted the overlay's tombstone state, so a deleted entity still came out in the IFCX output — both as its own node and, in some cases, as a child reference of a still-exported spatial container. `StepExporter` already resolved this via `getEffectiveEntityIndex(...).isDeleted()` ([#2036](https://github.com/LTplus-AG/ifc-lite/issues/2036)); `Ifc5Exporter` now builds the same `EffectiveEntityIndex` once per export and gates the node-collection loop, the UUID-assignment pass, and the child-name/grouping passes on it, so a deleted entity is absent from the output entirely rather than surviving as a dangling child path.

  `ParquetExporter` has the same gap plus a wider one (no `MutablePropertyView` parameter at all) and is intentionally out of scope here — [#2046](https://github.com/LTplus-AG/ifc-lite/issues/2046) remains open for the Parquet half.

  Follow-up ([#2047](https://github.com/LTplus-AG/ifc-lite/issues/2047)): deleting a still-non-empty spatial container (e.g. a storey) left its surviving contents (e.g. a wall) present in `file.data` but unreachable from the document root — the deleted container was skipped when the exporter asked "what are this node's children", so nothing ever listed the wall as a child. `Ifc5Exporter` now re-parents a surviving child to its nearest surviving ancestor when its direct parent is deleted, walking up the hierarchy, and this re-parented map is now the single source the exporter consults for the emitted `children` tree. When no ancestor survives at all — the whole chain above the element is deleted, or the only route up runs through a cycle in the source hierarchy — the survivor is listed directly under the document-root node, which is emitted for that purpose even when the project itself was deleted. Either way, deleting a container never drops an undeleted element out of the exported hierarchy. The ancestor walk is bounded against cycles.

  The same inconsistency existed for the other two things that keep an entity out of an IFC5 export — the visibility filter (`visibleOnly` with `hiddenEntityIds`/`isolatedEntityIds`) and the spatial-tree filter (`onlyTreeEntities`) — because only the deletion check reached the map-building pass. Hiding an element left its uuid dangling in its still-visible parent's `children` dict; hiding a container, or isolating an element whose container is not itself isolated, left the element in `file.data` with nothing listing it as a child. All three filters now feed one `isOmitted` predicate that drives both node emission and the uuid/children/re-parenting construction, so an entity that is not emitted cannot be referenced as a child, and one that is emitted is always reachable from the document root — including via the root node itself, which is now emitted whenever filtering severed an element from every ancestor. Which entities each filter excludes is unchanged: visibility filtering remains a UI-level show/hide mechanism, separate from overlay deletion, and only the consistency of the tree it leaves behind is affected.

- [#2111](https://github.com/LTplus-AG/ifc-lite/pull/2111) [`6722e08`](https://github.com/LTplus-AG/ifc-lite/commit/6722e08b76c4cd89d8e7e1bbd06c768a36ae93ac) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Stop `ParquetExporter` from exporting entities deleted via `MutablePropertyView.deleteEntity()` ([#2046](https://github.com/LTplus-AG/ifc-lite/issues/2046)).

  `ParquetExporter`'s table writers clone whole typed-array columns straight out of `IfcDataStore` — `Entities`, `Properties`, `Quantities`, `Relationships`, and the derived `SpatialHierarchy` — with no per-entity loop and, until now, no `MutablePropertyView` parameter to consult at all. An entity deleted via the overlay was exported anyway, and so were its properties, quantities, and relationship edges. `StepExporter`/`Ifc5Exporter` already resolved the same class of bug via `getEffectiveEntityIndex(...).isDeleted()` ([#2036](https://github.com/LTplus-AG/ifc-lite/issues/2036), [#2047](https://github.com/LTplus-AG/ifc-lite/issues/2047)).

  `ParquetExporter` now takes an optional `mutationView` as its third constructor argument — existing `new ParquetExporter(store)` callers (the README example, `tests/integration.test.ts`) are unaffected. When supplied, a deleted entity's own row is dropped from `Entities`, and every `Properties`/`Quantities`/`SpatialHierarchy` row keyed by that entity and every `Relationships` edge touching it are dropped too. This is deletion-only, and only for the entity actually deleted: unlike `StepExporter`/`Ifc5Exporter`, the column-copy shape here has no per-entity emission pass to also apply the overlay's pset/quantity/attribute _edits_, so those still export the source values verbatim; and `SpatialHierarchy` is a source-parse snapshot with no overlay-aware re-parenting, so a deleted storey/building/site can still surface as a surviving element's `StoreyId`/`BuildingId`/`SiteId` (the class of problem `Ifc5Exporter`'s re-parenting pass solved in [#2047](https://github.com/LTplus-AG/ifc-lite/issues/2047), not addressed here). Call out to `StepExporter`/`Ifc5Exporter` for full overlay-aware export in the meantime.

  **The exported Parquet is deliberately NOT referentially closed.** A deletion drops the rows that are _identified by_ or _keyed to_ the deleted entity, but surviving rows may still carry ids that no longer resolve — most visibly a surviving element's `StoreyId`/`BuildingId`/`SiteId` pointing at a deleted storey. This matches how a relational export normally behaves: the tables are a queryable projection, not a self-contained graph, and a consumer joining them must tolerate unresolved ids exactly as it must for any partial export (`exportTable('entities')` alone has never been closed either). Cascading deletions instead would silently remove elements the caller never deleted, which is a worse answer for an export format. Callers needing a closed graph should use `StepExporter`/`Ifc5Exporter`.

  No shipped surface (viewer, CLI, MCP) constructs `ParquetExporter` today, so this closes the exporter-side gap without a call-site change; a future consumer can now pass its `MutablePropertyView` and get correct output from the start.

- Updated dependencies [[`2c47277`](https://github.com/LTplus-AG/ifc-lite/commit/2c47277ee6dfbd9779eb4948d1f2e7b0ea61d00e), [`5371d7d`](https://github.com/LTplus-AG/ifc-lite/commit/5371d7def2671f6568c838879b8be058bb6247c9), [`4c739be`](https://github.com/LTplus-AG/ifc-lite/commit/4c739be2aba74ad6868b6dca51dad441c6fa9903), [`f493930`](https://github.com/LTplus-AG/ifc-lite/commit/f4939309aed136979bd5cc1f95a25c2a0ebe779f), [`befc108`](https://github.com/LTplus-AG/ifc-lite/commit/befc1083e377315231006352cb3fe95949e92b47), [`0ceb99a`](https://github.com/LTplus-AG/ifc-lite/commit/0ceb99a36125a2dfc8775e762d9f4f9ddb69d733), [`3c2ffa6`](https://github.com/LTplus-AG/ifc-lite/commit/3c2ffa6a1bd0a04d3d73e2ea7c0fb1a2233599a9), [`d44b6c1`](https://github.com/LTplus-AG/ifc-lite/commit/d44b6c1710ee86596e96e0204785d2bf7c0940a9)]:
  - @ifc-lite/geometry@3.7.0
  - @ifc-lite/mutations@1.24.1
  - @ifc-lite/data@3.2.1
  - @ifc-lite/parser@3.15.1

## 2.8.1

### Patch Changes

- [#2039](https://github.com/LTplus-AG/ifc-lite/pull/2039) [`818990b`](https://github.com/LTplus-AG/ifc-lite/commit/818990b772e3cda41a0aa5feda1263c5fe6d518c) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Stop silently dropping IFC4X3-only element types from de-meshed and LOD0 exports ([#2032](https://github.com/LTplus-AG/ifc-lite/issues/2032)).

  Both `demesh-writer.ts` and `lod0-generator.ts` carried a private `findAttrIndex` that resolved positional attribute slots through the parser's IFC4-pinned registry. For a class that exists only in IFC4X3 — `IfcSignal`, `IfcPavement`, `IfcCourse` and the rest of the infrastructure additions — that registry returns nothing, so every attribute index came back null.

  In the de-mesh writer that meant `Representation` could not be located and the element was skipped with reason `no-representation-attribute`. In the LOD0 generator it meant `ObjectPlacement` could not be located and the element was dropped from the walk entirely, with no skip reason recorded anywhere — so an infrastructure model could lose elements from its LOD0 export with nothing in the output to say so.

  Both now resolve slots through the cross-schema union already used by `attribute-real-slots.ts` and `attribute-slot-types.ts`.

- Updated dependencies [[`c65bdbe`](https://github.com/LTplus-AG/ifc-lite/commit/c65bdbe033494e71e35e0222895fa1d017f0fd76), [`d9abe5b`](https://github.com/LTplus-AG/ifc-lite/commit/d9abe5b48eee9066ff1b21d7408350f152c9f4f1)]:
  - @ifc-lite/parser@3.14.0
  - @ifc-lite/mutations@1.23.1

## 2.8.0

### Minor Changes

- [#2036](https://github.com/LTplus-AG/ifc-lite/pull/2036) [`a8e58a2`](https://github.com/LTplus-AG/ifc-lite/commit/a8e58a2b5e75db8388835c77b2688240667f68ab) Thanks [@louistrue](https://github.com/louistrue)! - Answer exists / class / deleted from the mutation overlay first, so the saved file agrees with what the session did ([#2012](https://github.com/LTplus-AG/ifc-lite/issues/2012)).

  `StepExporter` repeatedly asked the parsed `IfcDataStore` questions the `MutablePropertyView` overlay is the authority on. The buffer answers for the file as parsed; the overlay knows what the session has since created, edited, retyped and deleted. Every pass that reached for the store produced output that disagreed with the user:

  - `visibleOnly: true` computed its reference closure from the source index alone. An overlay-created entity is not in that index and nothing in the source references it, so it could never become a root and could never be walked into: a created wall was absent from the export, with no error and no warning. This is reachable from the viewer's "export visible only" and from `export_ifc`'s `global_ids` allowlist.
  - `isTypeEntity()` read the source record's class, so a property set added to an overlay-created `IfcWallType` was emitted as an occurrence `IFCRELDEFINESBYPROPERTIES` while the type's `HasPropertySets` stayed `$`. Its already-authored `HasPropertySets` list was dropped from the rewrite for the same reason.
  - A generated property set on an overlay-created host took the file's first `IfcOwnerHistory` rather than the one the caller authored, and kept referencing one the session had cleared or deleted. Owner-history resolution now goes through the same `willBeEmitted` predicate the emit guards use, because a reference is a reference.
  - `IfcDoorStyle` and `IfcWindowStyle` were classified as occurrences. Type-object-ness is now decided from the cross-schema inheritance chain rather than a `TYPE` suffix, the same way [#2033](https://github.com/LTplus-AG/ifc-lite/issues/2033) decides it: those two are IFC2X3 `IfcTypeProduct` subtypes carrying `HasPropertySets` at slot 5 whose names do not end in `Type`, and the committed Duplex fixture has six of each. The suffix test was wrong in both directions — `IfcRelDefinesByType` ends in `TYPE` and is a relationship.
  - An explicitly cleared positional override was read as an absence. `setPositionalAttribute(id, slot, null)` is the overlay saying "nothing here", and `??` discarded that answer in favour of the creation payload, so a cleared OwnerHistory came back as the authored reference and a cleared `HasPropertySets` resurrected the list the user had removed. Both sites now ask `Map.has`.
  - A deleted entity could still make the exporter **remove** something. An edited property set is replaced wholesale, so its original id is skipped — but IFC exporters share one `IfcPropertySet` between entities, and once the host is deleted there is no replacement to take its place, leaving a surviving entity's relation pointing at a container nobody wrote. Verified against `e6516991`; the quantity path had the same hole on its own bookkeeping. `retainSharedAtoms` rescues a shared _atom_ one level down; nothing rescued the shared container.
  - A source `IfcRelDefinesByProperties` whose every related object the session deleted is now dropped, which also covers a plain delete with no property edit.

  The questions now have one place to be asked: `getEffectiveEntityIndex` folds the overlay into the complete source index and answers `get` / `has` / `typeOf` / `effectiveType` / `isDeleted` / `isOverlayCreated` / `refsOf` / `byType`. `getVisibleEntityIds` takes it as an optional fourth argument, and `collectReferencedEntityIds` / `collectStyleEntities` follow an overlay record's authored `'[#42](https://github.com/LTplus-AG/ifc-lite/issues/42)'` references where a source record would be byte-scanned. A store with no overlay, or an overlay that has queued nothing structural, takes the previous code path with no wrapper allocated.

  **Builds on [#2030](https://github.com/LTplus-AG/ifc-lite/issues/2030) rather than replacing it.** That PR's `willBeEmitted` predicate — will this id have a defining STEP line at all — is the right question for the emit sites and is kept, including its deliberate carve-out for source records under `deltaOnly` / `exportPropertiesOnly`. It is now answered by the effective index in one lookup instead of four, and its documented workaround falls away: the `getNewEntity` fallback existed because `deleteEntity` forgot an overlay-created entity instead of tombstoning it, so `isDeleted` could not answer for one. The overlay branch itself stays and is load-bearing — a _live_ overlay-created entity has no source bytes and would fail the byte-range test a source record passes.

  Every case is covered by a test that re-parses the exported STEP rather than matching the emitted string.

### Patch Changes

- [#2030](https://github.com/LTplus-AG/ifc-lite/pull/2030) [`e651699`](https://github.com/LTplus-AG/ifc-lite/commit/e651699180b791b95cbd721ad66d5f38e03eca2b) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `StepExporter` emitting a dangling `IFCRELDEFINESBYPROPERTIES` (or a type entity's rewritten `HasPropertySets`) that references an entity with no defining line in the output.

  Editing a property or quantity on an entity, then making that entity disappear from the export by any of three routes, used to leave the reference behind:

  - **Deleting the entity.** The entity-emission loop already skipped a deleted entity's own line, but the pset/qset generation loops didn't consult tombstones, so they still emitted a relation pointing at nothing.
  - **Creating an entity in the overlay, then deleting it.** `deleteEntity` forgets a newly-created entity instead of tombstoning it, so a tombstone check alone can't catch this case — the entity was never tombstoned, it just no longer exists.
  - **Hiding the entity under a `visibleOnly` export.** The visibility filter drops the entity's own line, but the pset/qset generation loops ignored the visible-entity closure entirely.

  All four places that generate a property or quantity set entity, or rewrite a type entity's `HasPropertySets` attribute, now share one check — "will this entity id have a defining line in the output at all" — instead of three separate special cases that each covered only one route.

  This makes the export internally consistent: it no longer writes a relation with a dangling reference. It does not make a hidden or deleted entity's edits survive export, and an entity created in the overlay and then hidden under `visibleOnly` is still dropped from the output (a separate, pre-existing gap).

- [#2024](https://github.com/LTplus-AG/ifc-lite/pull/2024) [`63905dc`](https://github.com/LTplus-AG/ifc-lite/commit/63905dc3993ad227500a0f68c406276c909eb6f5) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fixed the remaining `GeometryProcessor` WASM handle leaks tracked in issue [#1959](https://github.com/LTplus-AG/ifc-lite/issues/1959), beyond the viewer P0 sites fixed separately. Each site now frees its handle in a `try/finally` covering every early-return and throw path, not just the happy path:

  - `@ifc-lite/mcp`: `clash_check` / `clash_matrix`'s model meshing (long-lived MCP server process, one handle per never-before-clashed model).
  - `@ifc-lite/export`: `generateLod1`'s primary and fallback processors, including the forced-meshing-failure fallback path.
  - `@ifc-lite/cli`: `diagnose-geometry`, `extract-entities --detect`, and `gym`'s lazily-created clash-channel processor — all reachable more than once per process from a long-lived host (a test harness, a REPL session) even though each is a one-shot CLI command in normal use.
  - `create-ifc-lite`: the generated React + WebGPU template's mount effect now disposes its `GeometryProcessor` on both the mid-init cancellation path and on unmount, so scaffolded projects don't inherit the leak.

  `apps/viewer/src/hooks/useIfcLoader.ts` is intentionally untouched: its processor's WASM handle is shared with `IfcParser.parseColumnar` via `getApi()`, and disposal there needs a design decision (owned-and-reused vs. freed-per-call) that has not been made yet.

- [#2011](https://github.com/LTplus-AG/ifc-lite/pull/2011) [`a5cc568`](https://github.com/LTplus-AG/ifc-lite/commit/a5cc568a642d7dd8d17f1ed7858844f9289bc841) Thanks [@louistrue](https://github.com/louistrue)! - Fix `StepExporter` silently dropping attribute edits made after an entity was created through the mutation overlay ([#2006](https://github.com/LTplus-AG/ifc-lite/issues/2006)).

  `getAttributeMutationsByEntity()` / `getPositionalMutationsForEntity()` were applied only inside the source-iteration loop, which walks the parsed buffer. An entity created via `entity_create` / `store.addEntity()` has no source record, so the new-entities pass wrote it from its authored creation payload alone: create a wall, set its `Name`, save, and the file said `'untitled'` with no error and no warning. The overlay-created line now takes the same named-attribute and positional overrides the source path applies, resolved against the effective class so a retype and an attribute edit compose.

  Overlay-created records PAD, which the source-buffer path deliberately does not: `entity_create` takes whatever positional list the caller passes, so a wall authored with three arguments still has a real `Tag` slot at index 7, and dropping that edit is the same data loss. Named and positional overrides share one padding rule and grow the record to the class's full declared arity, so an edited record is never emitted with fewer arguments than its class declares — a truncated record parses here but a schema-validating consumer rejects it. An index past the declared layout is not a slot and still cannot grow the record. On a source line a short argument list means a different schema rather than a partial authoring payload, so nothing there is padded.

  Two further fixes on the same call path, each of which applied to existing entities read from the source buffer as well as to created ones:

  - Named attributes now resolve through `getAttributeNamesAcrossSchemas` instead of the parser's IFC4-pinned registry. An IFC4X3-only class (`IfcCourse`, `IfcRoad`, `IfcBridge`, `IfcFacility`, …) resolved no slots under the pin, so every named edit on one was discarded. Measured identical — same names, same order — for all 755 pinned classes that declare attributes, so no IFC4 export changes behaviour.
  - A named edit is now serialized from the slot's DECLARED type rather than inferred from the token it replaces. Inference has nothing to read when the slot holds `$`, and it failed in both directions: an ENUMERATION came out quoted (`'USERDEFINED'`, not `.USERDEFINED.`), and a text value that merely looked like a token was emitted as one, so a `Tag` or `Name` of `[#12](https://github.com/LTplus-AG/ifc-lite/issues/12)` became an entity reference and `.FOO.` an enumeration. Both write a schema-invalid record rather than a wrong value, and a room or tag literally named `[#12](https://github.com/LTplus-AG/ifc-lite/issues/12)` is ordinary on a real project. On a class the IFC4 pin does not carry, declared types for inherited slots come from the nearest ancestor it does carry, matched by attribute NAME (`IfcRoad.CompositionType` → `IfcElementCompositionEnum`), and alias names are canonicalized so the stratum leaves resolve like `IfcGeotechnicalStratum`.
  - Enumeration tokens are checked for lexical validity before being written. A value carrying a comma, parenthesis, semicolon, space or quote is not a token at all: `.A,B.` re-parses as TWO arguments and shifts every following slot, and `.O'BRIEN.` opens a string literal that runs past the end of the record. Such a value falls back to a quoted string with a warning — the record keeps its arity and the user keeps their text — rather than being dropped or throwing. Domain validity (is `.FOO.` a legal member of this enum) is still deliberately not checked here.

  Also stops counting an overlay-created entity as both new and modified, which made the header provenance claim two affected entities for one created-then-renamed wall. All three counting sites an overlay-created id can reach are guarded — attributes, properties and quantities — not just the first.

- Updated dependencies [[`0adb741`](https://github.com/LTplus-AG/ifc-lite/commit/0adb7413b869c9d50bdcdae5c00a730d17c2823f), [`263c3ef`](https://github.com/LTplus-AG/ifc-lite/commit/263c3efba5baf503f192700ba7f70ce08a1dafc8), [`a2ca053`](https://github.com/LTplus-AG/ifc-lite/commit/a2ca0535c14cd1bf9d55713584766dff55430158), [`e4d2db5`](https://github.com/LTplus-AG/ifc-lite/commit/e4d2db5f11798e3ec78f45249139d69aa1e65275), [`a8e58a2`](https://github.com/LTplus-AG/ifc-lite/commit/a8e58a2b5e75db8388835c77b2688240667f68ab), [`a5cc568`](https://github.com/LTplus-AG/ifc-lite/commit/a5cc568a642d7dd8d17f1ed7858844f9289bc841)]:
  - @ifc-lite/geometry@3.6.0
  - @ifc-lite/parser@3.13.0
  - @ifc-lite/data@3.2.0
  - @ifc-lite/mutations@1.23.0

## 2.7.1

### Patch Changes

- [#1966](https://github.com/LTplus-AG/ifc-lite/pull/1966) [`80051a5`](https://github.com/LTplus-AG/ifc-lite/commit/80051a51868b7343c4c3e08e335c0d5bdf900424) Thanks [@louistrue](https://github.com/louistrue)! - Fix undone attribute edits being resurrected on STEP export ([#1957](https://github.com/LTplus-AG/ifc-lite/issues/1957)).

  `StepExporter` reconstructed attribute values by replaying `MutablePropertyView.getMutations()` — the append-only mutation history. Undo applies its reverse edit with `skipHistory: true`, so a superseded `UPDATE_ATTRIBUTE` record keeps its stale `newValue` forever and the exporter baked the pre-undo value into the output. The editor showed the reverted value; the file did not. Silent, with no error and nothing in the output signalling it, and directional: it restored data the user had explicitly reverted.

  The exporter now reads attribute values from the overlay via the new `MutablePropertyView.getAttributeMutationsByEntity()`, which returns the current state — an undone edit has had its overlay entry reset to the pre-edit value, or removed outright when the attribute was newly set. This makes attributes consistent with every other overlay-backed path in the exporter: property sets (`getForEntity`), quantities (`getQuantitiesForEntity`), positional attributes (`getPositionalMutationsForEntity`) and retypes (`getEntityTypeMutation`) already read current state, so attributes were the sole outlier rather than an instance of a general pattern.

  **Scope.** Only the attribute path was affected. Property and quantity edits take their _values_ from the overlay and use the history only to decide which pset names to re-emit, so an undone property edit was already re-emitted with its correct current value. Georeferencing edits reach the exporter through `ExportOptions.georefMutations`, not through the view, and are untouched.

  `getAttributeMutationsByEntity()` and the existing `getAttributeMutationsForEntity()` are both backed by a new entityId-keyed secondary index, mirroring the one already used for property and quantity mutations. That also removes a full-map `startsWith` scan from the per-entity accessor, which the properties panel calls on every selection.

  No migration: the overlay and the history are both in-process state, and any edit that was not undone exports exactly as before.

- Updated dependencies [[`80051a5`](https://github.com/LTplus-AG/ifc-lite/commit/80051a51868b7343c4c3e08e335c0d5bdf900424), [`0571583`](https://github.com/LTplus-AG/ifc-lite/commit/05715834ce94a1f8e5dc20d6a60b7468190c2e88)]:
  - @ifc-lite/mutations@1.22.0
  - @ifc-lite/parser@3.12.0

## 2.7.0

### Minor Changes

- [#1887](https://github.com/LTplus-AG/ifc-lite/pull/1887) [`87f3507`](https://github.com/LTplus-AG/ifc-lite/commit/87f3507f6fb67a3fd834a190737ea33d7e9ad661) Thanks [@louistrue](https://github.com/louistrue)! - `StepExportOptions.guidRandom` seeds the GlobalIds `StepExporter` synthesizes at export time - the `IfcPropertySet` / `IfcElementQuantity` roots it regenerates for mutated or overlay-created property and quantity sets, their `IfcRelDefinesByProperties` links, and any `IFCPROXY` placeholder minted by schema conversion (`convertStepLine` gained a matching optional `random` argument). Without it those four roots came from the platform CSPRNG, so a seeded in-store build that used `addPropertySet` / `addQuantitySet` still exported different bytes on every run. `StepExportOptions.timeStamp` additionally pins the STEP header `FILE_NAME` instant, so a fully seeded export is byte-identical run to run. Both are optional; omitting them keeps the previous random / wall-clock behaviour exactly.

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
- Updated dependencies [[`382fa7c`](https://github.com/LTplus-AG/ifc-lite/commit/382fa7cf97c04bad07963e25052cbaeb6c2ba7e3), [`6792dd1`](https://github.com/LTplus-AG/ifc-lite/commit/6792dd11ad7049acb7329221ea8809d6333aefb7), [`6842c56`](https://github.com/LTplus-AG/ifc-lite/commit/6842c56c72065fd9f43ac282cacb766b7808c282), [`6869d5c`](https://github.com/LTplus-AG/ifc-lite/commit/6869d5ced2d19ac4ab8b2591847f3ffd52236d14), [`8799484`](https://github.com/LTplus-AG/ifc-lite/commit/87994844a5edb66404fa12b0719c89f5ec026c4d), [`22bffac`](https://github.com/LTplus-AG/ifc-lite/commit/22bffac737efa9bdd6ca583518f637593cb4d4bc), [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f), [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f), [`428c5ae`](https://github.com/LTplus-AG/ifc-lite/commit/428c5ae54bac236a3950f451ee12a0dc23226336), [`3dc3eb5`](https://github.com/LTplus-AG/ifc-lite/commit/3dc3eb56bd372ddd0e317347db1cad888dffd609)]:
  - @ifc-lite/encoding@1.15.0
  - @ifc-lite/data@3.0.0
  - @ifc-lite/parser@3.11.0
  - @ifc-lite/mutations@1.21.1
  - @ifc-lite/geometry@3.5.0

## 2.6.0

### Minor Changes

- [#1769](https://github.com/LTplus-AG/ifc-lite/pull/1769) [`2a7c7ff`](https://github.com/LTplus-AG/ifc-lite/commit/2a7c7ffe0ac27a8cc315e5d4a633c56469646cf0) Thanks [@Blogbotana](https://github.com/Blogbotana)! - Demesher: selective per-element mesh simplification with lightweight IFC re-export ([#1767](https://github.com/LTplus-AG/ifc-lite/issues/1767)). `@ifc-lite/export` gains `DemeshSession` — pick elements (usually the heaviest, see `heaviest(n)`), escalate simplification one level per `simplify()` call (levels 1-4 = internal-cavity removal + vertex-clustering decimation at target ratios 0.5/0.25/0.10/0.03, level 5 = bounding-box collapse) with render-ready replacement meshes for live scene updates, then export a lighter IFC separately via `exportIfc()`, which authors `IfcTriangulatedFaceSet` geometry and prunes the replaced representation subgraphs (IFC2X3 input auto-upconverts to IFC4). Also exported: `applySimplifiedGeometry` and the supporting types.

  `@ifc-lite/geometry` gains `GeometryProcessor.simplifyMeshes()` backed by the new wasm `simplifyMeshes` API (`SimplifiedMeshes`). `@ifc-lite/cli` gains `ifc-lite simplify <file.ifc> --level 1..5 [--ids ...] --out light.ifc [--json]` for dev/testing. `@ifc-lite/data` / `@ifc-lite/mutations` widen `IfcAttributeValue` with a write-only `{ real: number }` marker (serialized by `stepReal()` in `@ifc-lite/export`) so tessellation coordinates always carry a decimal point.

### Patch Changes

- [#1791](https://github.com/LTplus-AG/ifc-lite/pull/1791) [`37224e8`](https://github.com/LTplus-AG/ifc-lite/commit/37224e8cd852d246cf463622cd612a38e0cf6e27) Thanks [@louistrue](https://github.com/louistrue)! - Demesher follow-ups: `applySimplifiedGeometry` now replaces a repeated express id once and skips duplicates with a `duplicate-id` reason (a second overlay chain would be orphaned bloat); the prune mark-and-sweep moved to its own module (`demesh-prune.ts`); documented the complete-`entityIndex.byId` requirement and the triangle-count-vs-bytes expectation for `ifc-lite simplify`.

- Updated dependencies [[`2a7c7ff`](https://github.com/LTplus-AG/ifc-lite/commit/2a7c7ffe0ac27a8cc315e5d4a633c56469646cf0), [`90522d2`](https://github.com/LTplus-AG/ifc-lite/commit/90522d218d5a9c4df0760349b5bfc60916a23f8f), [`502c61b`](https://github.com/LTplus-AG/ifc-lite/commit/502c61bc7c0ae1ac313ed93ab335fdd942471c72), [`05c8bdf`](https://github.com/LTplus-AG/ifc-lite/commit/05c8bdf348c5afae8978293cd324d45104e24940), [`7194c95`](https://github.com/LTplus-AG/ifc-lite/commit/7194c95002f2c84cd3c9444d710a50190a976a90), [`502bdbf`](https://github.com/LTplus-AG/ifc-lite/commit/502bdbf5c4c4c86999f4e662b71ee5b0b16307ae), [`6102a22`](https://github.com/LTplus-AG/ifc-lite/commit/6102a222a6a71afcdab89855f1dcfa9437d3994f)]:
  - @ifc-lite/geometry@3.3.0
  - @ifc-lite/data@2.7.0
  - @ifc-lite/mutations@1.21.0
  - @ifc-lite/parser@3.10.0

## 2.5.3

### Patch Changes

- [#1772](https://github.com/LTplus-AG/ifc-lite/pull/1772) [`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7) Thanks [@louistrue](https://github.com/louistrue)! - Fix STEP REAL serialization and string-attribute quoting.

  `toStepReal` / `serializePropertyValue` (export) and `serializeValue` (data) appended a bare `.` to JavaScript's exponent notation, emitting invalid ISO-10303-21 literals (`5e-8` -> `5e-8.`, `1e21` -> `1e+21.`) and leaving a nonconforming lowercase `e` (`1.5e-7`). A single shared `formatStepReal` helper now performs the mantissa/`E` rewrite (`5.E-8`, `1.E+21`, `1.5E-7`), and `toStepRealScaled` reuses it.

  `serializeAttributeValue` (export) now always emits a quoted+escaped STEP string when the edited attribute's source token is a quoted string, so user free-text like `[#12](https://github.com/LTplus-AG/ifc-lite/issues/12)`, `$`, `*`, or `.FOO.` can no longer be reinterpreted as an entity reference, null/derived marker, or enum.

- Updated dependencies [[`7ef3622`](https://github.com/LTplus-AG/ifc-lite/commit/7ef36225d863ec64dfb254cf0767d4ab9d034849), [`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7), [`0d400ed`](https://github.com/LTplus-AG/ifc-lite/commit/0d400edd61a71108c2affd0923fb561affbfe9fe), [`564a800`](https://github.com/LTplus-AG/ifc-lite/commit/564a800e997322d863aac84127497ef4f8310ac3), [`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7), [`a42b8a9`](https://github.com/LTplus-AG/ifc-lite/commit/a42b8a9cfc559781575dde893b2116a5dc493732)]:
  - @ifc-lite/parser@3.9.1
  - @ifc-lite/data@2.6.0
  - @ifc-lite/encoding@1.14.11
  - @ifc-lite/geometry@3.2.1

## 2.5.2

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

- Updated dependencies [[`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a), [`d0647c9`](https://github.com/LTplus-AG/ifc-lite/commit/d0647c9a1801fc03b7c5d32314e53ef922c56f2f), [`26de705`](https://github.com/LTplus-AG/ifc-lite/commit/26de705b8608b9cd75e90411288c7ada96b3352b), [`bc1531f`](https://github.com/LTplus-AG/ifc-lite/commit/bc1531f899e5f8d18d1a6ff1ef6d997236a01243)]:
  - @ifc-lite/data@2.5.2
  - @ifc-lite/encoding@1.14.10
  - @ifc-lite/geometry@3.1.4
  - @ifc-lite/mutations@1.18.1
  - @ifc-lite/parser@3.8.2

## 2.5.1

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

- Updated dependencies [[`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39)]:
  - @ifc-lite/data@2.5.1
  - @ifc-lite/encoding@1.14.9
  - @ifc-lite/parser@3.8.1

## 2.5.0

### Minor Changes

- [#1558](https://github.com/LTplus-AG/ifc-lite/pull/1558) [`47bde10`](https://github.com/LTplus-AG/ifc-lite/commit/47bde10dcacddf8f99e1e6b2bf036c78c192c5ff) Thanks [@louistrue](https://github.com/louistrue)! - Add `MergedExporter.exportBlobAsync` (and its `MergeBlobExportResult` type): assembles the merged STEP file as an off-heap multi-part `Blob` instead of one contiguous `Uint8Array`, so the largest STEP output ifc-lite produces (every federated model concatenated) never materialises as a single buffer on the JS heap. The viewer's merged-export download now uses it, handing the Blob straight to the download path with no copy. Byte content is identical to `exportAsync`. Also rewrites the internal `assembleStepBytes` (used by `StepExporter`/`MergedExporter`) as a two-pass single-allocation assembler (`TextEncoder.encodeInto`) instead of retaining a persistent `Uint8Array[]` of every encoded entity; output is byte-identical, verified against the previous implementation on a multi-byte UTF-8 corpus.

### Patch Changes

- [#1562](https://github.com/LTplus-AG/ifc-lite/pull/1562) [`52dd7a1`](https://github.com/LTplus-AG/ifc-lite/commit/52dd7a16788375a9507c40fbde106b78236801db) Thanks [@louistrue](https://github.com/louistrue)! - Weld per-face-duplicated faceted-brep vertices at the mesh SOURCE instead of per export. The faceted-brep mesher emits geometry per `IfcFace` with no cross-face vertex sharing, so a closed shell duplicates every shared corner once per incident face (~3-6x). That collapse now happens once, at the single per-element mesh funnel (`build_mesh_data` in `produce_element_meshes`), so every element -- render, GLB/OBJ export, and analysis -- arrives welded in its `MeshData`, and the previously separate per-export welds (from-bytes `to_yup` and the viewer's from-meshes GLB path) are removed as redundant. The weld keys on the exact position plus a quantized normal, so creases (a cube corner shared by three faces with distinct normals) stay split and flat/crease shading is preserved; world triangles, winding, and the world AABB are unchanged. It is deterministic and byte-identical cross-arch (native == wasm32, positions and topology identical, only the documented libm-trig normals differ), and closes the volume/watertightness gap for non-voided faceted breps on the render path (voided elements already welded via the coplanar-facet pass). The mesh-output determinism manifests are re-pinned for the one affected battery element (the round column [#500](https://github.com/LTplus-AG/ifc-lite/issues/500), an extruded circular profile: 216 -> 144 vertices, triangle count unchanged).

- Updated dependencies [[`0762522`](https://github.com/LTplus-AG/ifc-lite/commit/076252241ec4201462f7fcf0555c83606de5fecd), [`d7a3205`](https://github.com/LTplus-AG/ifc-lite/commit/d7a3205524e023f936b29ee1bc113d1d10e3b0b1), [`52dd7a1`](https://github.com/LTplus-AG/ifc-lite/commit/52dd7a16788375a9507c40fbde106b78236801db), [`b157b48`](https://github.com/LTplus-AG/ifc-lite/commit/b157b4841bfa795f8a937a9be20c21b645757fbe)]:
  - @ifc-lite/geometry@3.1.0
  - @ifc-lite/parser@3.6.0

## 2.4.1

### Patch Changes

- [#1553](https://github.com/LTplus-AG/ifc-lite/pull/1553) [`369ee9b`](https://github.com/LTplus-AG/ifc-lite/commit/369ee9b680309ca70c569b3f26bd07acfb83c19d) Thanks [@louistrue](https://github.com/louistrue)! - Shrink GLB exports by welding per-face-duplicated vertices. The faceted-brep mesher emits geometry per `IfcFace` with no cross-face vertex sharing, so a closed shell duplicated every shared corner once per incident face (~3-6x) -- the direct cause of the ~8x-larger GLBs seen on structural (faceted-brep-heavy) models versus reference extractors. Exports now collapse vertices that share an identical position and coinciding normal at the single glTF write funnel, then remap indices. World triangles, the world AABB, and flat/crease shading are preserved exactly (creases keep distinct normals and stay split); the weld is deterministic and cross-arch, applies to every GLB path (in-memory, streaming, bounded, and the viewer's from-meshes export), and leaves `process_geometry` output and the mesh-output determinism manifests untouched.

- Updated dependencies [[`369ee9b`](https://github.com/LTplus-AG/ifc-lite/commit/369ee9b680309ca70c569b3f26bd07acfb83c19d)]:
  - @ifc-lite/geometry@3.0.3

## 2.4.0

### Minor Changes

- [#1481](https://github.com/LTplus-AG/ifc-lite/pull/1481) [`204cab4`](https://github.com/LTplus-AG/ifc-lite/commit/204cab48f8e3b6326a8005628ed5b7174d9d694c) Thanks [@louistrue](https://github.com/louistrue)! - feat(export): add `unitReconciliation: 'normalize'` merge mode

  `MergedExporter` can now rescale a model whose length unit differs from the first
  model's into the primary unit, so a mixed-unit merge produces one ordinary
  single-unit `IfcProject` with one `IfcUnitAssignment` (opens correctly everywhere,
  BIM Vision included) instead of a multi-project federation.

  - Every length-valued datum is rescaled: all `IfcCartesianPoint` /
    `IfcCartesianPointList` coordinates, scalar lengths (extrusion depths, profile
    dimensions, radii, thicknesses, `IfcVector.Magnitude`, CSG primitive sizes,
    `IfcBuildingStorey.Elevation`, `IfcSite.RefElevation`), `IfcLengthMeasure`
    property values, and `IfcQuantityLength`. Which attributes are length-valued is
    derived from the IFC schema registry, not hand-rolled.
  - Areas and volumes are converted by their own declared `AREAUNIT`/`VOLUMEUNIT`
    ratio (not the length factor squared/cubed), so a model with millimetre lengths
    but square-/cubic-metre quantities (the common authoring-tool default) is not
    corrupted.
  - Angles, direction ratios, counts, unit definitions and georeferencing offsets
    are left untouched. `MergeExportResult.stats.normalizedModelCount` reports how
    many models were rescaled, and advisories are surfaced for schemas the length
    registry does not fully cover (IFC4X3) and for georeferenced models.

  The CLI `merge` command gains a `--unit-reconciliation <auto|normalize|assume-shared>`
  flag, and the viewer's merged export adds a "Mixed units" selector.

- [#1484](https://github.com/LTplus-AG/ifc-lite/pull/1484) [`a48abac`](https://github.com/LTplus-AG/ifc-lite/commit/a48abacfacdf226702f2454859afe9abe018e029) Thanks [@Blogbotana](https://github.com/Blogbotana)! - feat(export): configurable spatial merge matching in `MergedExporter`

  `MergedExporter` unifies `IfcSite`/`IfcBuilding`/`IfcBuildingStorey` across
  merged models with a single fixed heuristic today. It now accepts explicit
  matching strategies, mirroring IfcOpenShell/BlenderBIM's "Merge Projects"
  recipe:

  - `mergeSites?: 'single' | 'by-name'` — `'single'` ignores Name and unifies
    iff each model contributes exactly one `IfcSite`; `'by-name'` matches only
    same-name (case-insensitive) sites, with no single-instance fallback.
  - `mergeBuildings?: 'single' | 'by-name'` — same strategy, for `IfcBuilding`.
  - `mergeStoreys?: 'by-name' | 'by-elevation' | 'by-name-then-elevation'` —
    `'by-name'`/`'by-elevation'` match on exactly one criterion with no
    fallback; `'by-name-then-elevation'` is the pre-existing combined heuristic
    made explicit.

  All three options are optional and, when omitted, preserve today's exact
  default behavior (name match, else single-instance fallback for site/building;
  name-then-elevation for storeys) — purely additive, no default behavior change.

  One edge-case hardening applies in every mode, including the default: when two
  sites (or buildings) in the same secondary model would match the same
  first-model target (e.g. identical names), only the first claims it and the
  second is kept as its own root instead of being silently collapsed onto the
  same target. This brings site/building matching to parity with the
  pre-existing storey behavior.

  The CLI `merge` command gains matching `--merge-sites` / `--merge-buildings` /
  `--merge-storeys` flags.

### Patch Changes

- Updated dependencies [[`8e43ecf`](https://github.com/LTplus-AG/ifc-lite/commit/8e43ecf540b88b942a4ec2127dd9bcf24ec244fa), [`d1e16f9`](https://github.com/LTplus-AG/ifc-lite/commit/d1e16f944ea9f3a35a7153959f13db168a35c229), [`a46dcdf`](https://github.com/LTplus-AG/ifc-lite/commit/a46dcdf68d05e8cdec4199167647f2dfa3c62cb6), [`6d2cb21`](https://github.com/LTplus-AG/ifc-lite/commit/6d2cb21a170413c6c98aadf10d254667b2ed2b53), [`3d25765`](https://github.com/LTplus-AG/ifc-lite/commit/3d25765edc2cee40268a6d5a27d4055f88f76489), [`b66ff1d`](https://github.com/LTplus-AG/ifc-lite/commit/b66ff1dd915a0ff4f60198a511adb7ed7f714079)]:
  - @ifc-lite/geometry@3.0.0
  - @ifc-lite/data@2.3.0
  - @ifc-lite/encoding@1.14.8
  - @ifc-lite/parser@3.5.2

## 2.3.0

### Minor Changes

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

### Patch Changes

- 775e479: Fix IFC2X3 → IFC4/IFC4X3 schema conversion producing invalid entities. The converter trimmed
  trailing attributes when downgrading but never **padded** the new trailing attributes that
  newer schemas added (e.g. `PredefinedType` on `IfcWall` / `IfcBeam` / `IfcOpeningElement` /
  `IfcFastener` / …, the IfcDoor/IfcWindow additions, `IfcMaterial.Category`, etc.). Upgraded
  entities were left a positional attribute short and rejected by strict readers (e.g. BIM
  Vision). Padding is driven by the generated buildingSMART attribute tables (`@ifc-lite/data`),
  scoped to upconversion so the downconversion trim path is untouched.

  Padding is applied **only when the source attribute name-list is a strict prefix of the
  target's** (i.e. the newer schema merely appended attributes). Many entities insert/reorder
  attributes mid-list — e.g. `IfcMaterialProperties` (`[Material]` → `[Name, Description,
Properties, Material]`), `IfcApproval`, `IfcTask` — where blindly appending `$` would shift
  values into the wrong, type-invalid slots; those are left untouched. All headline targets
  (`IfcWall`/`Beam`/`Column`/`Member`/`Plate`/`OpeningElement`/`Door`/`Window`/`Fastener`/
  `MechanicalFastener`/`Grid`, `IfcMaterial`) are prefix-safe, so the intended fix is preserved.

  Also tolerate whitespace after `=` in `convertStepLine` (e.g. Tekla's `#34498= IFCWALL(...)`);
  such lines previously failed the entity-line regex and passed through **unconverted**, so
  neither type renames nor attribute adjustment applied. Validated end-to-end with ifcopenshell:
  a federated IFC2X3 + IFC4X3 → IFC4 export went from 2556 "Invalid attribute value" errors to 0
  (remaining issues are pre-existing source-data defects). ([#1416](https://github.com/LTplus-AG/ifc-lite/issues/1416))

- Updated dependencies [e6bd2dd]
- Updated dependencies [24e1648]
- Updated dependencies [f9f0784]
- Updated dependencies [7c45192]
- Updated dependencies [6eb46f1]
- Updated dependencies [4f76955]
- Updated dependencies [909c1b0]
- Updated dependencies [3f25a72]
  - @ifc-lite/geometry@2.13.0

## 2.2.0

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

### Patch Changes

- Updated dependencies [[`6af9dc2`](https://github.com/LTplus-AG/ifc-lite/commit/6af9dc26f97f87237c27ae502c127e6170a80d64)]:
  - @ifc-lite/mutations@1.17.0

## 2.1.1

### Patch Changes

- [#1415](https://github.com/LTplus-AG/ifc-lite/pull/1415) [`829b208`](https://github.com/LTplus-AG/ifc-lite/commit/829b208735ef05f36c0bd3fc9ba802cc12cfcabb) Thanks [@Blogbotana](https://github.com/Blogbotana)! - Stop dropping shared property atoms when a property is edited. Editing a property replaces its
  property set and skips that set's member atoms wholesale; because exporters deduplicate shared
  `Pset_*Common` atoms (e.g. one `IsExternal` `IfcPropertySingleValue` referenced by dozens of
  psets), this orphaned every other pset referencing the atom, leaving dangling `#id` references —
  an invalid IFC that strict readers (e.g. BIM Vision) refuse to open. `StepExporter` now retains
  any atom still referenced by a surviving property set / element quantity; the edited pset still
  emits its replacement with the new value while shared atoms stay for the psets that keep their
  original. Fixes both single-model and merged export (the merged exporter bakes through
  `StepExporter`). ([#1413](https://github.com/LTplus-AG/ifc-lite/issues/1413))

  Also stamp generated `IfcPropertySet` / `IfcRelDefinesByProperties` / `IfcElementQuantity`
  entities (emitted when a property/quantity is edited) with an existing `IfcOwnerHistory`
  instead of `$`. OwnerHistory is optional in IFC4 but **mandatory** in IFC2X3, so the previous
  `$` produced an invalid IFC2X3 file that strict readers (e.g. BIM Vision) reject. The exporter
  now reuses the model's owner history (falling back to `$` only when the file has none).

- Updated dependencies [[`8a4ce69`](https://github.com/LTplus-AG/ifc-lite/commit/8a4ce694ea1d8c1b0f25310f8a1addb3ff649f14)]:
  - @ifc-lite/parser@3.5.0

## 2.1.0

### Minor Changes

- [#1392](https://github.com/LTplus-AG/ifc-lite/pull/1392) [`d38ee2f`](https://github.com/LTplus-AG/ifc-lite/commit/d38ee2fb2e8003503600df261b0fd9aa1f279a4e) Thanks [@louistrue](https://github.com/louistrue)! - Make `MergedExporter` unit-aware so federating models with different length units no longer mis-scales geometry, and reconcile shared GlobalIds instead of emitting duplicates ([#1332](https://github.com/LTplus-AG/ifc-lite/issues/1332)).

  Previously the merge folded every model into the first model's `IfcProject` and deduplicated its `IfcUnitAssignment`, so a second model's raw coordinates were silently reinterpreted under the first model's unit (e.g. a metre model read as feet, ≈3.28x off). Models that reused the same `GlobalId` for `IfcSite`/`IfcBuilding`/`IfcBuildingStorey` or products also produced duplicate-entity errors in strict viewers.

  Now:

  - A model that shares the first model's length unit is unified as before (single project, spatial structure and infrastructure deduplicated).
  - A model with a different length unit is **federated**: it keeps its own `IfcProject`, `IfcUnitAssignment` and representation contexts, so its coordinates stay correctly scaled. The output then contains more than one `IfcProject` only when units actually differ — an intentional, flagged relaxation of the `IfcSingleProjectInstance` rule that is strictly better than the previous silent mis-scale.
  - GlobalIds are reconciled, not blindly duplicated: a non-relationship rooted entity repeating a GlobalId already emitted **in the same unit space** is unified to the one instance. Otherwise it is kept and re-stamped with a fresh deterministic GlobalId — this preserves objectified relationships (`IfcRel*`), whose membership can differ even when the GlobalId matches, and prevents a unit-compatible model from being unified onto a federated (different-unit) instance.
  - Resource entities whose Name is coincidentally a 22-character GlobalId-charset string (properties, quantities, materials, styles, …) are no longer mistaken for rooted entities, so their values and names are never dropped or overwritten.

  The model's unit scale is read from `dataStore.lengthUnitScale` automatically. New `MergeModelInput.lengthUnitScale` lets callers override it, and a new `MergeExportOptions.unitReconciliation: 'auto' | 'assume-shared'` option (default `'auto'`) can force the pre-1332 single-project behaviour when the caller has already normalised units. `MergeExportResult.stats` now also reports `federatedModelCount` and `warnings` (the latter flags the multi-`IfcProject` conformance trade-off); the CLI `merge` command prints these warnings.

## 2.0.0

### Major Changes

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

## 1.21.0

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

- Updated dependencies [[`b6acbc4`](https://github.com/LTplus-AG/ifc-lite/commit/b6acbc4b84bcdb4a2d774515200d27edd7e831cb), [`1693b95`](https://github.com/LTplus-AG/ifc-lite/commit/1693b9593a07791439a6577bed5046d22fd21384)]:
  - @ifc-lite/mutations@1.16.0
  - @ifc-lite/data@2.2.0
  - @ifc-lite/geometry@2.8.0

## 1.20.0

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

- Updated dependencies [[`61bad47`](https://github.com/LTplus-AG/ifc-lite/commit/61bad47257196b766fb0b8a17c56e53b763ca34a), [`bfd9004`](https://github.com/LTplus-AG/ifc-lite/commit/bfd9004daa17f481a7b33b5c3c11f620e6cd894d), [`69e5425`](https://github.com/LTplus-AG/ifc-lite/commit/69e5425e3d7586fcc2d44a33465806adc0ed53f8), [`bd585c7`](https://github.com/LTplus-AG/ifc-lite/commit/bd585c73de1f39db3c9aac168174012b98b79855), [`248f2c0`](https://github.com/LTplus-AG/ifc-lite/commit/248f2c09a4d61fa27dfeaba5511a2a641d4cd278), [`200681b`](https://github.com/LTplus-AG/ifc-lite/commit/200681ba17f162aaafaabf56c0723ddba693faf8), [`ddae2b0`](https://github.com/LTplus-AG/ifc-lite/commit/ddae2b0024f071d00f9e6e4b77e0be3965412ec3)]:
  - @ifc-lite/mutations@1.15.5
  - @ifc-lite/data@2.1.0
  - @ifc-lite/parser@3.3.0
  - @ifc-lite/geometry@2.7.3

## 1.19.8

### Patch Changes

- [#1116](https://github.com/LTplus-AG/ifc-lite/pull/1116) [`49778b1`](https://github.com/LTplus-AG/ifc-lite/commit/49778b179826d46e1c96361fe7b557e42db4ecfe) Thanks [@louistrue](https://github.com/louistrue)! - Fix STEP exporters dropping deferred property atoms, which produced hundreds of thousands of dangling `#`-references in merged (and single-model) IFC output.

  On large files the parser can move high-cardinality property atoms (`IfcPropertySingleValue`, `IfcQuantity*`, `IfcPropertyEnumeratedValue`, …) out of `entityIndex.byId` into a secondary `deferredEntityIndex` to cap memory (`deferPropertyAtomIndex`). Every other consumer (on-demand property/material extraction) reads through the `byId.get(id) ?? deferredEntityIndex.get(id)` fallback, but `MergedExporter` and `StepExporter` walked `byId` alone. They therefore emitted the `IfcPropertySet` / `IfcElementQuantity` _containers_ while silently dropping the atoms those containers reference — leaving the STEP output full of references to entities that are never defined. Strict viewers (e.g. BIM Vision) reject such files, and lenient ones fall geometry back to the origin when a placement / type / material chain resolves to a dropped entity.

  Both exporters now iterate the complete entity set via a shared `getCompleteEntityIndex` helper (primary index + deferred atoms), and the merge offset / new-id allocation now spans deferred ids too so remapped ids can't collide with a deferred atom sitting at a higher express id. When nothing was deferred the primary index is returned unchanged, so the common path keeps its existing behaviour and cost.

- Updated dependencies [[`49778b1`](https://github.com/LTplus-AG/ifc-lite/commit/49778b179826d46e1c96361fe7b557e42db4ecfe)]:
  - @ifc-lite/mutations@1.15.4

## 1.19.7

### Patch Changes

- [#1114](https://github.com/LTplus-AG/ifc-lite/pull/1114) [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb) Thanks [@louistrue](https://github.com/louistrue)! - Per-element local frame: eliminate f32 "fan" corruption on building-scale and georeferenced models.

  When a mesh is stored at f32 precision while its vertices sit at building-scale world coordinates (a model whose extent reaches ~200 m from the coordinate origin), the f32 mantissa only resolves ~15 µm there, so vertices closer than one ULP collapse to the same value and the triangles joining them fan out as long needles across the model. Lowering the global RTC threshold is the wrong lever (it is reserved for >10 km federation re-basing), and a single global recentre still leaves the model genuinely spanning ~200 m.

  Each element's vertices are now stored RELATIVE to a per-element `MeshData.origin` (the f64 AABB centre, snapped to the kernel reconcile grid `1/65536 m`), so the f32 coordinates stay element-small and collapse-free at any building or georef scale; the world position is `origin + position`. The renderer reconstructs world space with a per-batch model-matrix translate around a single shared scene origin (so abutting elements in different colour batches stay bit-coincident with no seam z-fighting), and the selection-highlight / GPU-picker buffers replicate the batch's exact f32 path so highlights are bit-coincident with no depth bias. The local frame is ON for the wasm (viewer) path and opt-in for native/server, so determinism snapshots and server output stay absolute-coordinate byte-identical.

  Every world-space consumer of element geometry now folds `origin` (`world = origin + position`): camera/scene bounds, the CPU raycast + BVH narrow phase, snap detection, the section cutters (CPU + GPU), the BIM↔scan deviation BVH, the spatial index, clash (world-frame triangles fed to both the TS and Rust kernels), the glTF / IFC5 / Parquet exporters, the Cesium GLB overlay, the construction-projection outline + storey-band derivation, and the federation alignment / mesh-duplicate paths. `MeshData.origin` is serialized in the geometry cache (format version 6, which auto-heals stale entries). Position differences (normals, edge vectors, areas) are origin-invariant and unchanged.

  This composes with the sub-grid sliver hygiene pass: the local frame removes the f32-storage fans, and `Mesh::clean_degenerate` removes the sub-grid slivers the finer-grained CSG host emits.

- Updated dependencies [[`d2086aa`](https://github.com/LTplus-AG/ifc-lite/commit/d2086aa0c5ab5e4d4f98cb25498f58a88c24443c), [`4af01aa`](https://github.com/LTplus-AG/ifc-lite/commit/4af01aabe1c669864c3c3d1757789d7de81beaec), [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb), [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8), [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb), [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8), [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8), [`977b41d`](https://github.com/LTplus-AG/ifc-lite/commit/977b41db04a83d912f85cc9167cd564ffcb0aafb), [`e42b703`](https://github.com/LTplus-AG/ifc-lite/commit/e42b70324a9d5caab23257d52e96df0198d8caa9), [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb)]:
  - @ifc-lite/geometry@2.7.0

## 1.19.6

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

- Updated dependencies [[`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`da1999f`](https://github.com/LTplus-AG/ifc-lite/commit/da1999fc6e482fa3d668b9aa98a840d2bb838112)]:
  - @ifc-lite/parser@3.2.0
  - @ifc-lite/geometry@2.6.1
  - @ifc-lite/data@2.0.3

## 1.19.5

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc)]:
  - @ifc-lite/data@2.0.2
  - @ifc-lite/encoding@1.14.7
  - @ifc-lite/geometry@2.4.1
  - @ifc-lite/mutations@1.15.3
  - @ifc-lite/parser@3.1.1

## 1.19.4

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
  - @ifc-lite/mutations@1.15.2
  - @ifc-lite/data@2.0.1

## 1.19.3

### Patch Changes

- [#874](https://github.com/LTplus-AG/ifc-lite/pull/874) [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85) Thanks [@louistrue](https://github.com/louistrue)! - Centralize IFC STEP entity scan selection behind a typed scanner helper, remove the unused duplicate `parseEntityOnDemand` implementation, keep the legacy `parse()` adapter on the shared scan path, route LOD exports through shared/adaptive ingestion paths, persist cache entity-index columns to avoid cache reload rescans, and update public docs away from legacy sync parse/geometry paths.

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85), [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/parser@3.0.0
  - @ifc-lite/geometry@2.0.0
  - @ifc-lite/data@2.0.0
  - @ifc-lite/mutations@1.15.1

## 1.19.2

### Patch Changes

- [#813](https://github.com/LTplus-AG/ifc-lite/pull/813) [`78f1d10`](https://github.com/LTplus-AG/ifc-lite/commit/78f1d10aab812da682962845638daa95b86ae178) Thanks [@louistrue](https://github.com/louistrue)! - fix(glb): preserve per-mesh colours when re-importing a `.glb`

  Both GLB importers (`parseGLBToMeshData` in `@ifc-lite/cache` and the
  secondary one in `@ifc-lite/export`) hardcoded
  `color: [0.8, 0.8, 0.8, 1.0]` on every mesh and never looked at
  `materials[*].pbrMetallicRoughness.baseColorFactor`. After the
  GLB-export-dialog work ([#688](https://github.com/LTplus-AG/ifc-lite/issues/688)) wired colour authoring through the
  exporter end-to-end, a round-trip
  (IFC → GLB → re-import as model) silently lost all colour and the
  viewport went grey.

  Fix: resolve each primitive's `material` index against the glTF
  `materials` array and copy `baseColorFactor` into `MeshData.color`,
  keeping the previous grey as the fallback when a primitive has no
  material (e.g. third-party glTFs). Regression tests added in both
  packages cover the round-trip and the no-material fallback.

- Updated dependencies [[`bdb9978`](https://github.com/LTplus-AG/ifc-lite/commit/bdb997842fe38627fefbcddf250fc0136289bc84)]:
  - @ifc-lite/parser@2.4.2

## 1.19.1

### Patch Changes

- [#810](https://github.com/LTplus-AG/ifc-lite/pull/810) [`e80e728`](https://github.com/LTplus-AG/ifc-lite/commit/e80e7281273a4a8352d9efae151f07c9f6be18f7) Thanks [@louistrue](https://github.com/louistrue)! - fix(glb): preserve per-mesh colours when re-importing a `.glb`

  Both GLB importers (`parseGLBToMeshData` in `@ifc-lite/cache` and the
  secondary one in `@ifc-lite/export`) hardcoded
  `color: [0.8, 0.8, 0.8, 1.0]` on every mesh and never looked at
  `materials[*].pbrMetallicRoughness.baseColorFactor`. After the
  GLB-export-dialog work ([#688](https://github.com/LTplus-AG/ifc-lite/issues/688)) wired colour authoring through the
  exporter end-to-end, a round-trip
  (IFC → GLB → re-import as model) silently lost all colour and the
  viewport went grey.

  Fix: resolve each primitive's `material` index against the glTF
  `materials` array and copy `baseColorFactor` into `MeshData.color`,
  keeping the previous grey as the fallback when a primitive has no
  material (e.g. third-party glTFs). Regression tests added in both
  packages cover the round-trip and the no-material fallback.

## 1.19.0

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

- Updated dependencies [[`d0ba541`](https://github.com/LTplus-AG/ifc-lite/commit/d0ba541dda3936b985c2189fbca4300cbb89df91)]:
  - @ifc-lite/geometry@1.19.0

## 1.18.1

### Patch Changes

- [#726](https://github.com/LTplus-AG/ifc-lite/pull/726) [`58e2e9e`](https://github.com/LTplus-AG/ifc-lite/commit/58e2e9ed3e3f17b6d2fc73ae320ec95be5b17e36) Thanks [@louistrue](https://github.com/louistrue)! - Fix STEP/IFC export failing with `TextDecoder.decode: ArrayBufferView ... can't
be a SharedArrayBuffer` when the data store's source buffer is SAB-backed.
  Both `StepExporter` and `MergedExporter` now route all source-byte decodes
  through `safeUtf8Decode` from `@ifc-lite/data`, which transparently copies
  into a scratch buffer on the (Firefox / Chrome-with-mitigation) runtimes
  that reject `TextDecoder.decode()` on `SharedArrayBuffer` views.

## 1.18.0

### Minor Changes

- [#598](https://github.com/louistrue/ifc-lite/pull/598) [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c) Thanks [@louistrue](https://github.com/louistrue)! - `StepExporter` improvements for the overlay-driven add/duplicate/edit flow.

  - Overlay-created entities (`view.createEntity()` / `store.addEntity()`)
    now respect `includeGeometry: false` and the `visibleOnly` /
    `allowedEntityIds` closure — same filters that already apply to
    source entities. Without this a freshly-added wall would smuggle
    its `IfcCartesianPoint`/`IfcExtrudedAreaSolid` helpers past
    `exportPropertiesOnly()`.
  - `deltaOnly` mode now keeps overlay-created entities even when no
    other modifications exist — the early-return predicate consults
    `mutationView.getNewEntities()` and `newGeorefLines` so a
    `createEntity()`-only edit isn't silently dropped from the
    delta. Regression test
    (`emits overlay-created entities under deltaOnly when no other
modifications exist`) locks this behaviour in.
  - `serializeStepArgs` / `serializeStepValue` are exported from
    `@ifc-lite/export/step-serialization` so the overlay-emit path
    and the rest of the codebase share one canonical STEP-formatting
    implementation.

### Patch Changes

- Updated dependencies [[`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742), [`16d7a63`](https://github.com/louistrue/ifc-lite/commit/16d7a6361a78bb39a2bd61bba6990db5d3df0c04)]:
  - @ifc-lite/mutations@1.15.0
  - @ifc-lite/parser@2.2.0
  - @ifc-lite/geometry@1.16.6

## 1.17.2

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

- Updated dependencies [[`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5)]:
  - @ifc-lite/data@1.15.1
  - @ifc-lite/encoding@1.14.6
  - @ifc-lite/geometry@1.16.2
  - @ifc-lite/mutations@1.14.5
  - @ifc-lite/parser@2.1.6

## 1.17.1

### Patch Changes

- [#461](https://github.com/louistrue/ifc-lite/pull/461) [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7) Thanks [@louistrue](https://github.com/louistrue)! - Clean up package build health for georeferencing work by fixing parser generation issues, making export tests resolve workspace packages reliably, removing build scripts that masked TypeScript failures, tightening workspace test/build scripts, productizing CLI LOD generation, centralizing IFC GUID utilities in encoding, and adding mutation test coverage for property editing flows.

- Updated dependencies [[`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7), [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7)]:
  - @ifc-lite/data@1.15.0
  - @ifc-lite/geometry@1.16.1
  - @ifc-lite/parser@2.1.5
  - @ifc-lite/encoding@1.14.5
  - @ifc-lite/mutations@1.14.4

## 1.17.0

### Minor Changes

- [#456](https://github.com/louistrue/ifc-lite/pull/456) [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0) Thanks [@louistrue](https://github.com/louistrue)! - Add LOD geometry generation, profile projection for 2D drawings, and streaming server integration

### Patch Changes

- Updated dependencies [[`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0)]:
  - @ifc-lite/geometry@1.16.0

## 1.16.0

### Minor Changes

- [#392](https://github.com/louistrue/ifc-lite/pull/392) [`6cbcf90`](https://github.com/louistrue/ifc-lite/commit/6cbcf904c99b17e4095424ba087c903fb4c82061) Thanks [@louistrue](https://github.com/louistrue)! - Fix "Invalid string length" error when exporting large merged IFC models by using chunked Uint8Array assembly instead of string concatenation. Add async export methods with progress callbacks to StepExporter and MergedExporter. ExportDialog now shows a progress bar with phase indicator and entity counts during export, matching the BulkPropertyEditor feedback pattern.

## 1.15.1

### Patch Changes

- [#368](https://github.com/louistrue/ifc-lite/pull/368) [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8) Thanks [@louistrue](https://github.com/louistrue)! - Refactor internals across parser, renderer, export, and viewer packages

- Updated dependencies [[`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8)]:
  - @ifc-lite/parser@2.1.1

## 1.15.0

### Minor Changes

- [#354](https://github.com/louistrue/ifc-lite/pull/354) [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f) Thanks [@louistrue](https://github.com/louistrue)! - Add dynamic IFCX schema import detection for IFC5 export

### Patch Changes

- Updated dependencies [[`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f), [`40bf3d0`](https://github.com/louistrue/ifc-lite/commit/40bf3d00cb5d5ef3512b96cd5e066442adcaab87), [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f)]:
  - @ifc-lite/parser@2.1.0
  - @ifc-lite/encoding@1.14.4

## 1.14.4

### Patch Changes

- Updated dependencies [[`ba9040c`](https://github.com/louistrue/ifc-lite/commit/ba9040c6ff3204f3a936dd2f481c4cd8a4e6f5b5)]:
  - @ifc-lite/parser@2.0.0

## 1.14.3

### Patch Changes

- [#309](https://github.com/louistrue/ifc-lite/pull/309) [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0) Thanks [@louistrue](https://github.com/louistrue)! - Expose uploaded chat attachments to sandbox scripts through `bim.files.*`, teach the LLM prompt to reuse those files instead of `fetch()`, and add first-class root attribute mutation support for script/export workflows.

- Updated dependencies [[`07851b2`](https://github.com/louistrue/ifc-lite/commit/07851b2161b4cfcaa2dfc1b0f31a6fcc2db99e45), [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0)]:
  - @ifc-lite/mutations@1.14.3
  - @ifc-lite/geometry@1.14.3
  - @ifc-lite/data@1.14.3
  - @ifc-lite/parser@1.14.3

## 1.14.2

### Patch Changes

- [#316](https://github.com/louistrue/ifc-lite/pull/316) [`740f7a7`](https://github.com/louistrue/ifc-lite/commit/740f7a7228413657d13014565d9e457f0e00e8a3) Thanks [@louistrue](https://github.com/louistrue)! - Preserve edits to type-owned `HasPropertySets` during STEP export instead of re-emitting them as duplicate `IfcRelDefinesByProperties` property sets.

- Updated dependencies [[`740f7a7`](https://github.com/louistrue/ifc-lite/commit/740f7a7228413657d13014565d9e457f0e00e8a3)]:
  - @ifc-lite/parser@1.14.2
  - @ifc-lite/data@1.14.2
  - @ifc-lite/geometry@1.14.2
  - @ifc-lite/mutations@1.14.2

## 1.14.1

### Patch Changes

- Updated dependencies [[`071d251`](https://github.com/louistrue/ifc-lite/commit/071d251708388771afd288bc2ef01b4d1a074607)]:
  - @ifc-lite/geometry@1.14.1
  - @ifc-lite/parser@1.14.1
  - @ifc-lite/data@1.14.1
  - @ifc-lite/mutations@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.0
  - @ifc-lite/geometry@1.14.0
  - @ifc-lite/mutations@1.14.0
  - @ifc-lite/parser@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.13.0
  - @ifc-lite/geometry@1.13.0
  - @ifc-lite/mutations@1.13.0
  - @ifc-lite/parser@1.13.0

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

- Updated dependencies []:
  - @ifc-lite/data@1.12.0
  - @ifc-lite/geometry@1.12.0
  - @ifc-lite/mutations@1.12.0
  - @ifc-lite/parser@1.12.0

## 1.11.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.3
  - @ifc-lite/geometry@1.11.3
  - @ifc-lite/mutations@1.11.3
  - @ifc-lite/parser@1.11.3

## 1.11.1

### Patch Changes

- Updated dependencies [[`02876ac`](https://github.com/louistrue/ifc-lite/commit/02876ac97748ca9aaabfc3e5882ef9d2a37ca437)]:
  - @ifc-lite/geometry@1.11.1
  - @ifc-lite/data@1.11.1
  - @ifc-lite/mutations@1.11.1
  - @ifc-lite/parser@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.0
  - @ifc-lite/geometry@1.11.0
  - @ifc-lite/mutations@1.11.0
  - @ifc-lite/parser@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [[`3823bd0`](https://github.com/louistrue/ifc-lite/commit/3823bd03bb0b5165d811cfd1ddfed671b8af97d8)]:
  - @ifc-lite/data@1.10.0
  - @ifc-lite/parser@1.10.0
  - @ifc-lite/geometry@1.10.0
  - @ifc-lite/mutations@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.9.0
  - @ifc-lite/geometry@1.9.0
  - @ifc-lite/mutations@1.9.0
  - @ifc-lite/parser@1.9.0

## 1.8.0

### Minor Changes

- [#211](https://github.com/louistrue/ifc-lite/pull/211) [`0b6880a`](https://github.com/louistrue/ifc-lite/commit/0b6880ac9bafee78e8b604e8df5a8e14dc74bc28) Thanks [@louistrue](https://github.com/louistrue)! - Improve IFC export with visible-only filtering, material preservation, and full schema coverage

  - **Visible-only export**: Single-model export now correctly filters hidden entities (fixes `__legacy__` model ID handling)
  - **Material preservation**: Multi-model merged export preserves colors and materials by collecting `IfcStyledItem` entities via reverse reference pass
  - **Full IFC schema coverage**: Expanded product type classification from ~30 hand-curated types to 202 schema-derived types (IFC4 + IFC4X3), covering all `IfcProduct` subtypes including infrastructure (bridges, roads, railways, marine facilities)
  - **Orphaned opening removal**: Hidden elements' openings are automatically excluded via `IfcRelVoidsElement` propagation
  - **Performance**: Replaced `TextDecoder` + regex with byte-level `#ID` scanning and `byType` index lookups for style/opening collection (~95% fewer iterations)

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.8.0
  - @ifc-lite/geometry@1.8.0
  - @ifc-lite/mutations@1.8.0
  - @ifc-lite/parser@1.8.0

## 1.7.0

### Patch Changes

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

- Updated dependencies [[`e0af898`](https://github.com/louistrue/ifc-lite/commit/e0af898608c2f706dc2d82154c612c64e2de010c), [`6c43c70`](https://github.com/louistrue/ifc-lite/commit/6c43c707ead13fc482ec367cb08d847b444a484a)]:
  - @ifc-lite/parser@1.7.0
  - @ifc-lite/data@1.7.0
  - @ifc-lite/geometry@1.7.0
  - @ifc-lite/mutations@1.7.0

## 1.3.0

### Patch Changes

- [#119](https://github.com/louistrue/ifc-lite/pull/119) [`fe4f7ac`](https://github.com/louistrue/ifc-lite/commit/fe4f7aca0e7927d12905d5d86ded7e06f41cb3b3) Thanks [@louistrue](https://github.com/louistrue)! - Fix WASM safety, improve DX, and add test infrastructure

  - Replace 60+ unsafe unwrap() calls with safe JS interop helpers in WASM bindings
  - Clean console output with single summary line per file load
  - Pure client-side by default (no CORS errors in production)
  - Add unit tests for StringTable, GLTFExporter, store slices
  - Add WASM contract tests and integration pipeline tests
  - Fix TypeScript any types and data corruption bugs

- Updated dependencies [[`0c1a262`](https://github.com/louistrue/ifc-lite/commit/0c1a262d971af4a1bc2c97d41258aa6745fef857), [`fe4f7ac`](https://github.com/louistrue/ifc-lite/commit/fe4f7aca0e7927d12905d5d86ded7e06f41cb3b3), [`4bf4931`](https://github.com/louistrue/ifc-lite/commit/4bf4931181d1c9867a5f0f4803972fa5a3178490), [`07558fc`](https://github.com/louistrue/ifc-lite/commit/07558fc4aa91245ef0f9c31681ec84444ec5d80e), [`cc4d3a9`](https://github.com/louistrue/ifc-lite/commit/cc4d3a922869be5d4f8cafd4ab1b84e6bd254302)]:
  - @ifc-lite/geometry@1.3.0
  - @ifc-lite/parser@1.3.0
  - @ifc-lite/data@1.3.0

## 1.2.1

### Patch Changes

- Version sync with @ifc-lite packages
