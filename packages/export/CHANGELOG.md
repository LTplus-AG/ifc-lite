# @ifc-lite/export

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
