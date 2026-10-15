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

## Results

Validated on 2026-10-15 using the production viewer build and the original corpus Archicad fixture (2,526,511 bytes), loaded through the normal file-input handler. The collaborative preview ran over a temporary private Tailscale HTTPS proxy, with a secure context and WebGPU enabled. The browser client switched from macOS to Windows during acceptance; the final screenshots below are from the Windows client and the final production behavior. The last source cleanup removed an erased unused type-only import.

- Single model: 82 rendered elements; 11 presentation layers. Expanded `Außenwände` lists 21 products (8 walls, 11 windows, 2 doors). Clicking selects those products; the properties panel agrees on 21 elements. [Selected layer](selected-layer.png).
- Hide reports 21 hidden and changes the control to `Show Außenwände`; Show restores them. Isolate shows the exterior walls/windows/doors with 61 other elements hidden. [Isolated layer](isolated-layer.png).
- Search for `Wand-Ext-ERDG-1` finds the product under its collapsed layer; selecting it shows its real IFC properties. Clearing search restores the previous collapse.
- Federation: load the same corpus bytes again with a distinct display filename through `file-input-add`. The viewer has 164 rendered elements and 22 assignment rows. Selecting the second `Außenwände` selects 21 products from `AC20-FZK-Haus-federated.ifc`, while its identically named first-model assignment stays unselected. [Federated selection](federated-selection.png).
- Supplemental annotation regression: the original Archicad model has 14 curve-only annotations without presentation assignments. A derived variant adds only [one assignment line](annotation-layer-variant.txt) before the DATA section terminator, referring to their existing representations; its geometry is unchanged. The production viewer shows a new 14-product layer. Hide removes the actual dimension lines/text and shows `Hidden elements · 14`; Show restores them. [Shown](annotation-layer-shown.png) / [Hidden](annotation-layer-hidden.png). This added assignment is a regression variant, not an authored Archicad layer.
- Checked icon-only tabs in a narrow sidebar and all six text labels in a sidebar wider than 480 CSS pixels. Keyboard resizing works. The tooltip and section title both read Presentation layers.

Validation:

- Root `pnpm typecheck`: all 126 turbo tasks succeeded; audit covers all 4,186 test files in 66 packages.
- Root `TEST_PATTERN='presentation-layers|presentationLayerTree|rowSelection|HierarchyPanel.(search|reveal|i18n)|HierarchyNode|useEffectiveMaterialStores' pnpm test --filter=@ifc-lite/viewer --concurrency=2 --env-mode=loose`: 56/56 tests passed, none skipped. The dependent production build and chunk-await guard passed.
- Module-size, localization literals, accessibility ratchet and type-scale gates passed. Root `pnpm lint` passed (10,761 files, 136 rules, no errors); existing warnings remain outside touched files.
- Independent adversarial review repaired stale visibility labels, spatial-product isolation, shared IFCX attribution/readiness, invalid assignment seeds, nested representation ownership, and mutation decoding. Exact implementation review is recorded in [adversarial-review.md](adversarial-review.md).

No Rust, geometry, parser, WASM or published-package sources changed; no perf-sensitive-path verdict or changeset is required. Browser validation used the published `@ifc-lite/wasm@10.4.0` runtime: local wasm-pack regeneration hit an existing wasm-bindgen installation/config error and the build explicitly fell back to the fetched runtime. CI remains responsible for its supported source-build/prebuilt eligibility gates; this evidence makes no local Rust-runtime equivalence claim.

The initial acceptance recording is retained locally and is not committed. A later recording could not be stopped/transferred after the preview client switched; it is not cited as evidence. The committed screenshots and automated checks are the portable evidence.

Curve-only annotation owners reuse the existing annotation ID collection for layer hide/show. During isolation, symbolic annotation overlays retain their existing global visibility behavior; the new tab does not change overlay isolation semantics.

The bundle ceiling caught eager resolver code on the first CI run. The Layers tab now imports its builder on demand, caches code only, and exposes loading/error/retry states. A mounted cold-load test switches away and back while loading and verifies that a held selection is revealed once ready. The rebuilt production browser again showed 11 authored layers, selected 21 Außenwände products, hid/restored 21, and isolated them with 61 hidden. [Final lazy-build isolation](lazy-build-isolation.png). The unchanged bundle ceilings pass locally; raw measurements are in [bundle-after-lazy.json](bundle-after-lazy.json).

Final review found a missing `IfcShapeAspect` ownership route. The resolver now links aspect shape models to a validated `PartOfProductDefinitionShape` owner (`IfcProductDefinitionShape` or `IfcRepresentationMap`), per the [IFC schema](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcShapeAspect.htm). Three parsed regressions verify product and shared-map owners, invalid references and current edits/deletions/retypes. A second derived Archicad variant adds only [these three records](shape-aspect-variant.txt), reusing existing wall geometry. The production viewer lists the new layer, expands/selects `Wand-Int-ERDG-4`, hides exactly one product and restores it; rendered element count stays 82. [Shape-aspect browser evidence](shape-aspect-selection.png). This is a regression variant, not an authored Archicad assignment. Final source `1816e878b5` passed the 56-test focused run and root typecheck; the rebuilt bundle still passes unchanged ceilings.
