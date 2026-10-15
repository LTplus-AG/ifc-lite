# Presentation layers — issue #7619

## Agreed specification

Add a dedicated sixth hierarchy tab labelled **Layers**, with **Presentation layers** as its tooltip and section title. This is IFC presentation organization, separate from the IFCX layer stack. No new load pipeline or public package API is needed.

List `IfcPresentationLayerAssignment` and `IfcPresentationLayerWithStyle` by their authored Name (fallback to class and express ID). Keep assignments distinct by model and assignment ID even when names match. Expand each assignment to its owning products, deduplicated within that assignment; a product can appear in multiple layers. Show an explicit empty state when no usable assignments exist.

Resolve ownership through explicit representation structure: product Representation, product-representation Representations, representation Items, and mapped-item MappingSource / representation-map MappedRepresentation. Handle nested items where geometry structure requires it. Do not follow unrelated shared placements, contexts, styles, or coordinates. Walk iteratively with visited sets so cycles and long chains terminate. Read each entity through existing effective accessors with build-local caching; honor current mutations, deletions, additions, and retypes. Avoid repeated source decoding and unrelated full-model work when the tab is inactive.

The tree groups **whole products** that reference assigned representations or items. Item-level overrides do not split product geometry into independently controllable fragments: a product may occur under several layers. Selecting a layer selects products, never representation helpers. Hide/show and isolate act on their drawable geometry through existing ID and assembly resolution. Do not automatically apply LayerOn, LayerFrozen, LayerBlocked, or LayerStyles.

Reuse hierarchy search, keyboard navigation, virtualization, outside-selection reveal, selection channels, and existing row actions. Do not offer an IfcGroup filter for presentation assignments. Preserve legacy/single-model and federated ID behavior, model visibility, and shared IFCX datastore ownership. Labels follow the existing localization machinery; verify six tabs in narrow and normal panels.

## Acceptance and evidence plan

- Resolver tests use parsed STEP inputs and effective mutations: representation and item assignments, both assignment classes, many-to-many/deduplication, mapped/shared/nested geometry, cycles, dangling references, unrelated resources, and source/current edits.
- Builder and mounted component tests verify assignment rows, product counts/selection, hide/show, isolation, search/reveal, empty state, and two models with colliding local IDs/names.
- Browser acceptance uses corpus fixture `tests/models/ara3d/AC20-FZK-Haus.ifc`, exported by Archicad, with ordinary loading. Save screenshots/recording and record exact visible outcomes and limitations. Inspect other local corpus fixtures if useful. Do not fabricate authoring-tool evidence.
- Run root turbo typecheck and targeted tests, applicable lint/module/localization gates, and production viewer build. Coordinate heavy commands on the shared host. No perf-sensitive Rust/geometry/wasm edits are planned; reassess perf requirements if scope changes.
- Independently review the final diff adversarially, repair findings and rerun affected checks. Inspect actual final-head review evidence and CI; green review-signal alone is insufficient.

## Delivery and merge policy

One issue, one reviewable PR closing #7619. Link the PR to this thread immediately. Include validation, browser evidence, limitations, and review results in its description. Shepherd CI and review findings until ready. Merge only after required ruleset contexts succeed, actionable review findings are resolved, the final diff is reviewed, and evidence supports the behavior. Admin merge is authorized only when truly ready; never bypass an unresolved correctness failure. A main merge deploys through the repository's nightly production workflow.

## Final validation

Reviewed implementation: `e9d5c0cf28483e59ae21bc47b4d040ac16065e30`. The final production viewer (`main-DcPDPeUv.js`) was verified on 2026-10-15 in the collaborative browser over a temporary private HTTPS proxy, with a secure context and WebGPU. The original corpus Archicad fixture is 2,526,511 bytes and was loaded through the ordinary file-input handler.

- Single model: 11 presentation layers and 82 rendered elements. `Außenwände` selects 21 products (8 walls,11 windows,2 doors), matching the inspector. [Selected layer](selected-layer.png).
- Hide reports 21 hidden and offers Show; Show restores them. Isolate leaves those exterior products visible with 61 others hidden. [Isolation](isolated-layer.png).
- Search finds `Wand-Ext-ERDG-1` under a collapsed layer and selection displays its IFC properties; clearing search restores collapse. Narrow icon-only and wider six-label tab layouts were verified, including keyboard resizing and Presentation layers tooltip/title.
- Federation: the same original bytes loaded again through `file-input-add` as `AC20-FZK-Haus-federated.ifc` produce22 layers/164 rendered elements. Selecting the second Außenwände selects21 from that model, while its first-model counterpart remains unselected. [Federation](federated-selection.png).
- Supplemental annotation regression: the original model has14 curve-only annotations without layer assignments. A derived variant adds only [one assignment record](annotation-layer-variant.txt) to their existing representations. Browser Hide removes the actual dimensions/text and Show restores them, with82 meshes unchanged. [Shown](annotation-layer-shown.png) / [Hidden](annotation-layer-hidden.png).
- Supplemental shape-aspect regression: a second variant adds only [three records](shape-aspect-variant.txt), reusing existing geometry. The browser layer expands/selects `Wand-Int-ERDG-4` and hides/restores exactly one product, with82 meshes unchanged. [Shape aspect](shape-aspect-selection.png). Both supplemental variants are explicitly derived regression fixtures, not authored Archicad assignments.

Checks on the frozen source:

- Root turbo focused run: **93/93 tests passed, none skipped**, covering parsed STEP ownership, current mutations, bounded cycles, real corpus data, canonical ID spaces, shared IFCX aliases, assembly/annotation IDs and mounted hierarchy behavior. Command: `TEST_PATTERN='presentation-layers|presentationLayerTree|rowSelection|HierarchyPanel.(search|reveal|i18n)|HierarchyNode|useEffectiveMaterialStores' pnpm test --filter=@ifc-lite/viewer --concurrency=2 --env-mode=loose`.
- Root `pnpm typecheck`:126 tasks passed; all4186 test files in66 packages are audited. Root `pnpm lint`:10763 files,136 rules, no errors; existing warnings remain outside touched files. Module-size gate:6147 files, no new oversized modules. Localization, accessibility and type-scale gates pass.
- Production build and static chunk-await guard pass. [Raw bundle measurements](bundle-after-lazy.json) pin the frozen source and pass the **unchanged** ratchet ceilings. Resolver code is loaded on demand; only code is cached, never model data.
- [Independent adversarial review](adversarial-review.md) pins the final source. Its finite native-geometry audit covers explicit generating geometry links while excluding shared frames/styles. Shared datastores deduplicate only within the same ID offset; actual-registry tests cover distinct spaces and shared IFCX zero-offset aliases.
- Mounted progressive-loading tests suppress premature empty/search states, preserve available rows, settle failed/geometry-only models, and explicitly start with both models pending. Unresolved selections retry when their own metadata arrives without waiting for siblings; resolved targets retire, preserving manual collapse and cancelling stale requests after a tree click/deselect. Pending classification already includes `pending` in `isModelStreaming`.

No Rust, parser, geometry, WASM or published-package sources changed; no changeset or perf-sensitive-path verdict is required. Local wasm-pack regeneration failed during existing wasm-bindgen setup, so browser/build validation used the fetched published `@ifc-lite/wasm@10.4.0` runtime. CI source-build gates remain required; this evidence makes no local Rust-runtime equivalence claim.

Symbolic annotation overlays retain their existing global isolation behavior. The new tab does not change overlay isolation semantics. The initial acceptance recording is retained locally and is not committed; a later recording could not be transferred after the preview client switched and is not cited. Committed screenshots, source tests and raw measurements are the portable evidence.
