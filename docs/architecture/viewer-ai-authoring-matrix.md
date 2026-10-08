# Viewer AI authoring operation matrix (P15A)

Reviewed native authoring lets the assistant propose creation, deletion, placement and relationship edits. The viewer's own builders and modelling commands carry them out after review. This page records what is supported, how each operation is previewed, committed, undone and proven, and what is refused. It belongs to [P15A](viewer-ai-plan.md#native-model-authoring-and-geometry-edits) in the [implementation ledger](viewer-ai-implementation.md); the user-facing description is in the [assistant guide](../guide/viewer-assistant.md#reviewed-model-authoring).

## Contract

`model.authoring` (version 1, `apps/viewer/src/lib/actions/model-authoring.ts`) is a sibling of P04's `model.changes`, not a new version of it. Data corrections compare one scalar with an expected scalar and are keyed per value. Authoring creates identities, takes lengths in a declared unit and frame, and refers to elements created earlier in the same batch. Folding it into the `model.changes` union would have changed `changeKey`, `changeField`, the scalar value reader and the receipt row semantics for every existing producer. As a sibling, `model.changes` v1 stays byte-for-byte compatible. Both kinds share:

- GlobalId resolution (`resolve-global-id.ts`, now also finding elements created this session);
- the staleness rule (batch digest plus `mutationVersion`);
- one `runTransaction` per model, all-or-nothing across models;
- the receipt type, library and Changes-panel list;
- `undoModelChanges` through `revertChangeOperation`.

A `ModelChangeReceipt` carries `kind: 'model.authoring'` for authoring; old receipts (no `kind`) decode unchanged.

Each batch declares `"units": "m" | "mm"` and `"frame": "storey-local"`. Coordinates are storey-local `[x, y, z]`, Z up, which is the frame the in-store builders take. Angles are degrees, counter-clockwise from above. A missing unit or any other frame is refused. Every length must fall in a builder-plausible metre range, so `200` declared as metres for a wall thickness is refused as a probable unit mistake. Existing elements are addressed as `{globalId, ifcClass, name}` and must still have that class (or a subtype) and name. Elements created earlier in the batch are addressed by `{ref}`; a ref must name an earlier creating operation. A batch holds at most 200 operations.

## Matrix

Preview always starts with resolution, the expected-state checks and the native edit gate (`mutationDenial`). Then a **dry run** executes the ready rows of each model, in batch order, against a draft of the model's overlay (`MutablePropertyView.prepareAtomic`). The draft is never published, so the builders' own validation decides, with earlier operations of the batch in place. A row whose builder refuses is **Refused by the model**, with the builder's message. A row that uses a refused or excluded creation is **Needs another row**. The 3D ghosts are drawn on the `proposal` overlay channel and cleared on apply, hide and unmount.

| Operation | Native API (commit) | Preview validation | Ghost | Undo | Export/reparse proof | Limits |
|---|---|---|---|---|---|---|
| `element.create` IfcWall, IfcSlab, IfcRoof, IfcPlate, IfcColumn, IfcBeam, IfcMember, IfcSpace | Store `addWall` / `addSlab` / `addRoof` / `addPlate` / `addColumn` / `addBeam` / `addMember` / `addSpace` (`addOrdinaryElementInStore`), explicit generated GlobalId | Storey GlobalId resolves to an `IfcBuildingStorey`; dry run of `addOrdinaryElementInStore` with the same storey-placement preparation | Native footprint prism or parameterised section sweep in the shared native linear profile frame | One batch with the rest | Created wall found by GlobalId, contained in its storey, no dangling `#` reference | Rectangle or bounded polygon footprints; all nine native parameterised profile sections for beams/columns/members. Positive fillet radii are exported; each review row names the rounded details omitted by its sharp-corner preview. No topology/engineering validity certification; no type/layer defaults applied |
| `hosted.create` door, window, opening | Store `addHostedFill` (`addHostedElementInStore`) in the transaction's batch | Host is a wall (existing or created in the batch); dry run of the hosted builder (fit, overlap, schema) | Cut box along the host axis at offset/sill | Same | `IfcRelVoidsElement` voids the created wall; `IfcRelFillsElement` fills the opening | Wall hosts only; slab openings refused by the contract |
| `walls.join` | `bim.store.joinWalls` through `recordModellingEdit` | Both walls; dry run of `joinWallsInStore` | None (row text) | Same | `IfcRelConnectsPathElements` exported | IFC2X3/IFC4/IFC4X3 only (builder refusal) |
| `type.assign` | `bim.store.addElementType` (for a new type) and `assignType` through `recordModellingEdit` | Expected current type name; type GlobalId resolves to an `IfcTypeObject` with the stated name; `Already of this type` | None | Same | Reparsed `IfcRelDefinesByType` names the type | New types take only `ifcClass` and `Name` |
| `material.assign` | `bim.store.addMaterial` (when `create`) and `assignMaterial` through `recordModellingEdit` | Expected current material name; exactly one `IfcMaterial` of that name, or `create: true`; `Already this material` | None | Same | Reparsed `IfcRelAssociatesMaterial` names the material | Single `IfcMaterial` only; layer sets stay in the inspector |
| `element.move` | `commitElementTransform` (the Move tool's commit: hosted openings and fillings travel, joined walls follow) | Transform planner refusals; storey workplane; optional `from` origin within 1 mm | Element meshes moved | Same | Reparsed placement origin moved by the delta | Horizontal only; vertical moves and storey changes are refused |
| `element.rotate` | `commitElementTransform` rotation about the element's own placement origin | Upright placement with an explicit RefDirection; optional `fromDeg` within 0.1° | Element meshes turned | Same | Reparsed placement angle turned by the stated degrees | About Z only |
| `element.split` | Existing `splitElementsInStore` inside the shared reviewed transaction and `recordModellingCommit` | Full native shape/provenance/placement snapshot, exact model-local unique identity, pinned source/view revision; native dry-run and write recheck | Existing marker mesh primitives at the native cut; direct storey parent proof, explicit unavailable projection, no resulting-solid or engineering parity claim | Same canonical writer; explicit unique-target rows with no truncation | Independently reparsed piece shapes/frames, larger-piece identity, one derived identity, native metadata/opening policy; one grouped undo | Supported native wall/linear/plan slab-like targets only; native boundary refusals remain authoritative |
| `element.resize` | Full `commitElementSize`: canonical size editor through `recordModellingEdit`, plus occurrence-only material layer clone/rescale | Expected full native editable dimensions; shared geometry/layer write on an unpublished draft; native hosted-fit and shared-ownership refusal | Native post-edit push/pull prism or section sweep; bounded outline, direct storey-frame proof; each row discloses unavailable placement/geometry, sharp fillets and outer-body-only preview | Same, including geometry and layers | Stable identity, reparsed dimensions and layer totals; sibling/type unchanged | Wall height/thickness, flat slab/roof/plate thickness, straight beam/column/member length and rectangular cross section; fixed start/end rule. Existing GlobalId targets only |
| `element.profile` | Existing native `setElementProfile` section writer inside the reviewed transaction | Expected native section; shared centred-section reader/validator and emit core on an unpublished draft | Existing section sweep with current native axes; sharp-corner fillet disclosure or explicit preview unavailability | Same | Reparsed native profile class/dimensions; undo restores the original section | Nine existing native variants on centred straight beam/column/member extrusions; no arbitrary geometry inferred |
| `element.delete` | Store `removeEntity` | Expected class/name; allowed classes (walls, slabs, roofs, plates, columns, beams, members, spaces, doors, windows, coverings, furnishing, proxies); refused for assemblies and for hosts of openings; dry run of the removal | Element meshes in red | Same | Element absent after reparse, no dangling `#` reference | A deleted door or window leaves its opening; openings themselves are not deleted |

Commit re-runs the preview and refuses a stale one. It writes each model's approved rows inside one `runTransaction` with the store's gated actions, so the edit gate, collaboration role and workflow lock apply. The created, hosted, joined, retyped, re-materialled, moved and turned elements are re-meshed through the wasm re-mesh service (`created` cause when anything was created, else `hostsChanged` for moves). Undo and redo re-mesh the same batch.

## Explicit refusals

Not offered and refused by the contract with a reason: curtain walls, stairs and railings, grids, free-standing doors and windows, copy and array, split, trim and extend, vertical moves, storey or containment changes, group and zone membership, arbitrary layer-set authoring, classifications, and any operation on IFC5/IFCX models that the builders refuse. Each has a native tool in the Model workspace. Adding one here needs its own parameter validation, preview and export proof. Structural intent and missing dimensions are never invented: the guidance tells the provider to ask instead.

## Evidence

Tests run against the committed SketchUp-authored `building-architecture.ifc` (IFC4, millimetres), using `apps/viewer/src/test/authoring-sample-fixture.ts`:

- `lib/actions/model-authoring.test.ts` (8 tests) covers:
  - contract refusals: units, frame, unit mistakes, classes, refs, vertical moves;
  - preview resolution with no writes;
  - builder refusals and blocked dependents;
  - the edit gate;
  - one undo batch with re-mesh, export/reparse referential integrity (containment, type, material, void, fill, join), and undo;
  - move, rotate and delete with reparse proof, expected-origin conflict and single-use previews;
  - session-created GlobalIds and refusal to delete a host;
  - receipt decoding.
- `lib/actions/model-authoring-ghost.test.ts` checks that the wall and window ghosts match the committed builder geometry in the storey frame.
- `components/viewer/actions/ModelAuthoringReview.test.tsx` mounts the card and covers the Edit-mode gate, dependent exclusion, the ghost upload and clear, apply, the receipt and undo.
- `components/viewer/assistant/ModelChangeProposal.test.tsx` covers the authoring proposal card, the native review and a refused malformed answer.

No real provider answer, viewport screenshot or multi-model authoring run is recorded yet.
