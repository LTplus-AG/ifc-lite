# Independent adversarial review — #7619

Reviewed implementation commit `0562613208d6cb13afb6df69a81c7a71753fbc79`
against base `f1d7254b73` on 2026-10-15. This report is a subsequent
documentation-only artifact; its own commit is outside the implementation
revision named above.

Verdict: no unresolved correctness blocker found in the reviewed implementation.
This verdict does not replace required CI or the maintainer's merge decision.

## Scope and method

An independent reviewer read the agreed specification, the complete production
diff, all three new test files, existing hierarchy selection/reveal/action
helpers, effective entity enumeration and metadata accessors, and the committed
browser evidence. The reviewer did not author production changes. Findings were
sent directly to the implementation agents and their final repairs were reread
at the exact commit above. `git diff --check f1d7254b73 0562613208` passed.

The review examined duplicate names and local IDs, many-to-many membership,
shared mapped representations, cyclic geometry, nested structural ownership,
unrelated shared placements/contexts, invalid assignment references, current
mutations and retypes, legacy and federated IDs, shared IFCX stores, assembly
geometry, default-hidden spatial products, search/reveal, empty states,
localization and six-tab layout.

## Findings repaired before this revision

- Layer rows now participate in aggregate hidden-state computation. The final
  `HierarchyNode` change makes the eye icon, accessible action label and tooltip
  read the same computed `nodeHidden` value instead of the structural
  `node.isVisible` flag. The mounted test verifies Hide followed by Show.
- Isolating a layer containing a default-hidden space enables the corresponding
  spatial type visibility. Product types are resolved through existing entity
  ownership and mutation accessors; a mounted regression covers this case.
- Shared IFCX stores are projected once, retain all owner IDs without a false
  single-model badge, and consider geometry readiness across their owners.
  A builder regression exercises a metadata-only first owner.
- Assignment ownership covers representation subclasses, mapped and boolean
  geometry, and explicit nested set/curve/shell/face structure. It does not walk
  arbitrary context, placement or styling references. Traversal and reference
  flattening are iterative with visited sets.
- Assigned seeds must exist and have an effective representation/item class.
  Tests exercise a dangling ID also referenced by a shape and an assigned solid
  retyped to a property set; neither manufactures product membership.
- Effective metadata reads use the existing canonical mutation accessor and a
  build-local record cache. Tests cover names, named and positional clearing,
  positional precedence, created/deleted assignments and deleted products.

Whole-product selection remains distinct from visibility geometry: layer
selection uses member IDs, while visibility/isolation substitute drawable
assembly parts through the existing assembly resolver. Builder tests explicitly
assert that distinction and repeated-product row identity.

## Evidence assessed and limits

The reviewer opened all three committed screenshots. [Selected layer](selected-layer.png)
shows 21 selected products with the inspector reporting 11 windows, 8 walls and
2 doors. [Isolated layer](isolated-layer.png) shows the exterior wall/window/door
geometry, 21 isolated elements, 61 hidden elements and all six labelled tabs.
[Federated selection](federated-selection.png) shows 164 loaded elements, 22
assignment rows, distinct repeated layer rows and 21 selected products attributed
to the second model. The narrow screenshot shows all six icon tabs. These are
consistent with the real Archicad acceptance outcomes documented in [README](README.md).
The reviewer inspected screenshots rather than independently driving the browser.

The lead agent reported 47 focused tests passing without skips, all 126 root
typecheck tasks passing, and the static gate results recorded in the README.
The reviewer inspected the assertions but did not rerun heavy validation in
parallel. Full lint and required remote CI remained the delivery agent's
responsibility at the time of this review. Browser use of the fetched published
WASM runtime, and the local wasm-pack regeneration limitation, are explicitly
disclosed in the README; this review makes no additional runtime-equivalence
claim.

Any subsequent production-code change requires review of its delta before this
verdict can be applied to a newer head.

## Follow-up review: curve-only annotation visibility

Reviewed exact delta `626f4d2571..f40b50263a6dc3bab8ef8a6324acfaac07e3eef9`
on 2026-10-15. The intervening `0562613208..626f4d2571` delta was separately
verified to contain only this review report and evidence README updates.
The original implementation review therefore remains applicable, with the
following additional review covering the only subsequent production change.

The presentation-layer dispatch now passes the existing `classTreeIds` union
of mesh IDs and annotation owner IDs into the builder. Previously, a completed
model's curve-only `IfcAnnotation` was marked geometry-less and omitted from
layer visibility targets despite rendering in the symbolic overlay. The
reviewer inspected `collectAnnotationEntityIds` and
`useSymbolicAnnotations`'s hidden-owner predicate: the overlay subscribes to
`hiddenEntities` and resolves the owner's model offset, so using these owner
IDs restores the established hide/show channel.

The added regression parses an `IfcAnnotation` with a representation containing
an `IfcPolyline`, supplies zero mesh IDs, and exercises the actual annotation
inventory and grouping dispatch. It asserts usable owner IDs on the layer and
product row after geometry readiness. This is behavior coverage of the dispatch
gap rather than a mocked resolver or source-text assertion.

No renderer behavior, resolver ownership traversal, effective-record decoding
or build-local record cache changed. Existing symbolic overlays intentionally
ignore isolation filters; this fix restores hide/show and does not establish
annotation-only isolation semantics. The original Archicad screenshots remain
evidence for the unchanged mesh-product behavior. The lead agent was rerunning
the focused tests and typecheck and planning final annotation browser acceptance
when this section was written; this reviewer does not claim those pending runs
or browser interactions as independently completed.

Verdict for `f40b50263a6dc3bab8ef8a6324acfaac07e3eef9`: no unresolved
correctness blocker found. `git diff --check 626f4d2571 f40b50263a` passed.

## Follow-up review: load presentation ownership code on demand

Reviewed exact source delta
`7bba4d1bea..6b087615b63b949761ed849cdd65ec12415fe2be` on 2026-10-15.
The intervening annotation-evidence delta `f40b50263a..7bba4d1bea` was verified
to contain documentation and screenshots only. Both annotation screenshots
were opened: hiding the explicitly documented derived 14-owner assignment
removes the dimension lines/text while preserving the model geometry.

CI's initial-entry bundle budget rejected the eager implementation. This delta
moves the existing presentation builder/resolver behind a dynamic import when
the Layers tab is active; it does not raise the budget or change ownership
resolution. The reviewer read all eight changed files at the exact source
revision above, including the new loader hook and mounted regression.

The shared cache contains code and its import promise, never a model snapshot.
Current model, annotation, geometry and mutation inputs are passed to the
builder after readiness. Effect cleanup prevents stale asynchronous callbacks
from publishing state after tab changes or unmounting. Failed imports clear the
shared pending promise; the localized error and Retry action provide an
explicit recovery path. Loading displays an accessible busy tree and suppresses
premature no-layers and no-search-results states.

Review identified that the original reveal effect would miss a held selection
when the newly asynchronous tree became ready. The final delta adds readiness
to that effect's dependencies without depending on expansion-changing
callbacks. The mounted regression verifies initial loading, absence of a false
empty state, leaving and reentering the pending tab, and automatic expansion
and selection after readiness. Existing layer actions, empty-state and
federation tests now await the actual tree. The annotation dispatch regression
supplies the builder explicitly and retains the annotation-ID union.

The lead agent reported 53 focused tests passing without skips, all 126 root
typecheck tasks passing with the 4,186-test-file audit, a successful production
build, and measured initial-entry/eager sizes inside the unchanged CI ceilings.
The reviewer did not independently rerun those heavy checks. Full lint and
remote CI were still being shepherded when this section was written.

The reviewer also opened the lead agent's production-browser screenshot
`browser-screenshot-louistrue-pc-tail476f78-ts-net-mv9bh5uv-7325e5c7.png`:
it shows 11 original Archicad layers, 21 selected/isolated exterior products,
the expected window/wall/door inspector breakdown, and 61 hidden elements.
The lead agent reported rechecking Hide/Show on this production build. Earlier
membership, federation and annotation semantics remain unchanged; symbolic
overlay isolation retains the limitation documented above.

Verdict for `6b087615b63b949761ed849cdd65ec12415fe2be`: no unresolved
correctness blocker found. The exact source delta passes `git diff --check`.

## Follow-up review: shape-aspect ownership

Reviewed exact delta
`90a5f72f9f..1816e878b544f08172325aa120efb542eb54b472` on 2026-10-15.
It changes only the resolver and its parsed-STEP regression tests. This closes
a valid missing ownership route identified by the subsequent automated review.

The reviewer independently checked the
[buildingSMART IfcShapeAspect definition](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcShapeAspect.htm):
`ShapeRepresentations` lists shape models, and `PartOfProductDefinitionShape`
identifies the owning product-definition shape or representation map. This
ownership runs from an assigned aspect representation back to the referenced
owner, despite the STEP reference itself pointing out from the aspect.

The final implementation adds a direct reverse ownership edge from each
validated aspect shape model to its validated owner. This is equivalent to
walking through an active aspect node; it avoids incorrectly treating the
owner as a child of the aspect. Owners must exist and have the effective class
`IfcProductDefinitionShape` or `IfcRepresentationMap`. Children must exist and
have an effective `IfcShapeModel` class. Current entity enumeration and the
existing build-local cached metadata accessor ensure deleted or retyped
aspects, owners and shape models do not contribute stale links. Optional,
dangling and unrelated owner references do not produce edges. The visited
ownership traversal, per-build decoding cache and lazy module boundary are
unchanged.

Three new parsed-STEP tests exercise an aspect representation absent from the
owner's main representation list, a shared mapped owner reaching two products,
invalid owners and shape-model references, named/positional ownership edits,
shape-list edits, deleted aspects/maps and retyped resources. The reviewer read
these assertions and the complete production delta; no heavy validation was
run in parallel. The lead agent was rerunning build, focused tests, typecheck,
lint and browser acceptance when this section was written, so their results
remain the delivery agent's responsibility.

Verdict for `1816e878b544f08172325aa120efb542eb54b472`: no unresolved
correctness blocker found. The exact delta passes `git diff --check`.

## Follow-up review: nested generating curves and mixed visibility

Reviewed exact delta
`7c4831be69..ac024da3df702ce6b0283a29c0148726dd3c82fd` on 2026-10-15.
It addresses the subsequent review findings concerning swept-solid directrices
and a mixed row advertising Hide while its existing action reveals members.

The geometry change adds explicit generating curve/profile ownership edges:
sweep directrices, swept/end profiles, sectioned-solid/spine curves and profiles,
swept surfaces, nested arbitrary/composite/derived profiles, offset basis curves,
surface Curve3D geometry and IFC4X3 curve-segment parent curves. It does not
follow placements, axes, contexts or styles. The same-class audit identified
that subtype ownership rows must merge inherited attributes; the final union
keeps both `SweptArea` and subtype `Directrix` edges. Shared generating geometry
therefore reaches all owning products without spreading through placement-only
references.

The reviewer checked the schema registries and IFC4 EXPRESS corrections:
IFC4/IFC2X3 offset curves can be direct children of `IfcCurve`, whereas IFC4X3
introduces the `IfcOffsetCurve` base. Explicit 2D/3D roots in the final patch
retain `BasisCurve` ownership in both layouts and harmlessly union duplicate
attributes where the abstract base exists. Parsed IFC4 tests exercise both
offset forms along with the other generating-geometry cases. A separate parsed
IFC4X3 test exercises `IfcCurveSegment.ParentCurve`. Shared curve/point fixtures
assert two product owners while excluding a third product sharing the point
only through placement; additional assertions cover inherited/subtype edges,
current directrix edits and deleted curves. Resolver traversal, effective reads
and per-build record caching retain their prior bounds and semantics.

The visibility change centralizes the action decision in
`hierarchyNodeVisibility`, using the exact `getNodeElements` IDs for both the
callback and the row's icon, accessible label and tooltip. Any hidden member
offers Show, matching the existing reveal-all behavior. Fully-hidden styling
remains separate and uses drawable assembly parts where applicable. Removing
the aggregate-type allowlist prevents row state and action membership from
drifting independently. A mounted regression starts with one of two layer
products hidden, verifies Show reveals both, then verifies Hide hides both.

The reviewer read the complete six-file delta and related schema/helper code.
The lead agent was rerunning build, tests, typecheck, lint, bundle measurement
and browser acceptance when this section was written; this reviewer does not
claim those pending runs as independently completed. Previous unchanged
ownership, federation, lazy loading and annotation behavior remain covered by
the earlier review sections.

Verdict for `ac024da3df702ce6b0283a29c0148726dd3c82fd`: no unresolved
correctness blocker found. The exact source delta passes `git diff --check`.
