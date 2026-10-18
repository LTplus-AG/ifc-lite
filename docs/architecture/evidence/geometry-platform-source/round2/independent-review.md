# Source preservation round 2 final review

Read-only inspection of child `b676f94f4a67ca99d29efd43ca691eb746046c37`, delivery `/tmp/ifclite-source-owner-preservation-round2`, and current parent `971a6f9acf` plus resource working-tree changes. All 53 combined delivery paths match combined-source-manifest.json. No repository edits, builds, tests, jobs or retry submissions were performed. Child logs/receipts were read as prior-run evidence; they do not qualify the assembled parent.

## Preservation conclusion

The original duplicate-layer objection is resolved on both scan collection and subsequent shared-prepass paths. No additional concrete defect was found in the delivered correction itself.

`processor/scan.rs::stash_span` restores `decoder.decode_at(start,end)` for PresentationLayerAssignment. A successfully parsed first record remains cached, so a later same-ID layer record reuses it. `ProcessingIndex::Owned.install` calls `SourceBundle::install_compatibility_index` instead of bind_decoder. That method installs the existing index into the SAME decoder; it does not replace the decoder, clear decoded/point/placement caches, discard its strict mode/refused-record set, or grant private factory provenance.

The index setter clears source_bundle, so even a previously authenticated decoder loses authority through this explicit compatibility installation. A populated prepass cannot later acquire pristine bind authority. SourceIndex Hash/Dense/Columnar installation preserves existing decoded cache and refusal state; cache/domain installation is distinct from owning-source authentication.

Fresh worker decoders still use source.decoder() over the canonical last-occurrence index. They do not receive the scan decoder's first-success semantic cache. This matches the intended separation between historical shared prepass behavior and independent fresh-worker ID lookup.

The same-class test checks first layer attribution and later decode_by_id. The cross-class test uses a later same-ID IfcRelVoidsElement and actual resolve_prepass: the retained layer cache yields no void edge, while a fresh factory decoder resolves the last relationship and yields host10 -> opening20. This is stronger than a scan-only memo test. Both also preserve a prior strict UnrepresentableReal refusal across installation.

## Cache authority and policy

- Raw decoded/point/placement/grid imports retain their compatibility effects but revoke coherent authority, including empty imports. Independent index setters remove private source provenance. No later raw import matches an earlier TrustedDecoderInputs revision.
- Opaque SourceCache entries cannot be supplied separately from their producing source/revision. Same-bundle same-revision transfer is admitted; foreign transfers return before changing destination or owner generation. Borrowed None/None remains an explicit unauthenticated caller precondition.
- The added overflow test reads an unrepresentable point losslessly, transfers the valid cached wall, then requires a strict factory decoder to refuse the point and count it. It depends on the existing rule that unrepresentable records are not cached, rather than laundering them through the typed cache.
- The rejection test populates destination decoded, point and placement caches, rejects foreign transfers, then reads the original values. It covers destination preservation rather than only checking a bool return.
- SourceBundle::scan_with still builds the native index in the classification scan, copies borrowed native bytes once at load, and hands workers Arc-backed factory decoders. The correction adds no second source scan/hash, map reconstruction or per-job bytes copy. Delivered browser indexes still undergo once-per-worker span/completeness validation, with the stated performance hold.

Placement memo writers still owe the existing canonical-transform contract; typed provenance does not verify arbitrary extension-authored matrices. The public raw cache APIs and from_trusted_inputs remain explicit trusted-input choices, not source authentication.

## Required parent integration work

These are merge obligations against the inspected parent/resource tree, not failures of the child standalone delivery:

1. Preserve `OwnedMeshProductionContext::presentation_palettes()` and `presentation_rotation()` while adding source/trusted fields and validation. Numerical packets must keep only those derived Arcs, not regain a full context/source owner.
2. Preserve `state.presentation_context = Some(Arc::clone(context))` in OwnedProductExecution::bind while adding validate_decoder before planning/execute/accept/finish and after final callbacks.
3. Keep the resource integration's `pub(super) fn canonical` visibility: the accounted sibling module calls it. The source delivery's older private `fn canonical` cannot overwrite this visibility.
4. Keep `session_canonical::with_source_resources` around the public owned producer. The source delivery predates that wrapper; losing it would remove joined-worker resource/terminal inheritance.
5. Add WorkError::MismatchedSource alongside, not instead of, the resource WorkPayload::Stopped variant and payload matching. Preserve actual source validation before owner/geometry/accept effects.
6. **Handle source mismatch in accounted_session::context_error.** Current parent maps only StaleSource and panics on every other error. After adding coherent-source validation, MismatchedSource is an expected typed error and must become AccountedProductionError::Context(ProductionContextError::MismatchedSource). A source-bound accounted call with a foreign decoder is the minimal distinguishing invariant: typed error before geometry, without panic or lease side effects.
7. Merge all source/presentation/resource test-module declarations in element.rs, plus parent docs and ledgers. Do not overwrite current program/boolean/layers work or revive historical traversal files.

Re-run real scoped-worker and nested canonical callbacks on the assembled source, including raw-import invalidation versus explicit trusted revision, wrong-source reply returned intact, and resource stops. Child earlier-run evidence cannot establish those combined contracts.

## Actual qualification lineage

Delivery verification identifies executed source `307c7c60ee5a9674d25dd5a485b9c31e3f7a505b`: focused processing preservation 3 passed; focused core source-cache tests 8 passed; Clippy all targets passed. Full workspace returned exit101, reporting 5773 passed, 1 failed, 47 ignored across 377 result groups. The failing appearance fixture conversion called the unbound test helper and panicked at `appearance/source.rs` with `appearance owns its base source`.

Final `b676f94f4a` differs from that tested source only in the appearance test setup migration and the generated declaration. The fixture test now uses the actual bundle factory, retains original geometry assertions and adds authority/trusted-revision assertions. That correction is plausible on static inspection, but has NOT been rerun. The final verification receipt records capacity-guard refusal before execution. Earlier Clippy success must not be described as a successful final-source rerun or erase the failed workspace result.

The canonical WASM build ran and regenerated the declaration. The subsequent contract command failed before tests because renderer/dist/scene.js was absent. The prepared dependency-correct root graph was not admitted. There is no final assembled-source browser, Python, complete-scene, allocation/RSS or worker-pool performance qualification from this delivery.

## Inspected hashes

Correction patch: `12a7b9e3e80d1e2134577ab78e4a4f896430ced83db78bf7573235858ba51afe`.
Combined source patch: `58608fbabe290e751185a2be246fcc24a8e2152dbbc86d825a8721c7dececbfc`.

Child delivery paths (all manifest matched):

- `.changeset/coherent-source-context.md`: `3375e70c99c2720a335d0f13353772a97b166be77024d7469a4a441b094969c3`
- `docs/api/rust.md`: `2819632826845d99a03c83385cba5d14990f55a46994ccd06a26bf93d5724f95`
- `docs/api/wasm.md`: `4d8543ef0e0daa1ce9cefd07a74b3a685800b895784b28dfc13c95b35118d501`
- `docs/architecture/coherent-source-ownership.md`: `1902d4f4b827bb9fb59f2cf3e61919dc71fa57abcd70e7fdb8fe55c6a5a3d6ab`
- `packages/geometry/src/geometry.worker.ts`: `719dc117dfc7c9a86bd8f64413fbca5d31aeb5870997bea3e2f27fa277222681`
- `packages/wasm/pkg/ifc-lite.d.ts`: `67c465620f0906c7ff33582e19f38cdd2fe835586b2fd08fba2495f1633a5ad8`
- `packages/wasm/test/model-context.test.mjs`: `a3cf85984391d01bc6be139c8f9b2385305e315db2213285722a9dccc22d6e55`
- `rust/core/src/columnar_index.rs`: `ac4f93c8c0d7cdb2e7aa38102cb80eec822eb64ff6c0693633fd88abf70e306d`
- `rust/core/src/decoder.rs`: `90e96ca30bd72f0daa86e7aa5eacb81aef84a0c47c3222fd14417417b0aa66ee`
- `rust/core/src/decoder/caches.rs`: `81ac177a8e0da46503399893f0872e7cec964ba028f6b86d7199f48d1e1144ed`
- `rust/core/src/decoder/schema_layout.rs`: `012d72845deec3479f0b6bdce2476393b7f38a900fbdfa0aeebb329bc74ba475`
- `rust/core/src/decoder/source_caches.rs`: `5690daa4d42cfe1199f958d58159d1d40eb1ff881992ed4a6e2c476488036c9e`
- `rust/core/src/decoder/source_caches_tests.rs`: `9559d83811ef8f517284b561f8fe872824e69d8831ac6e5108902e6e64f8e2c6`
- `rust/core/src/decoder/styled_items.rs`: `5aa00fa5e26ccf342de2881f86ccbcd9e9aa0e8c42ee0e71099996dabe8acf59`
- `rust/core/src/dense_index.rs`: `b4b3f62260e2c1bac1a9841c23e3871f651638e09822d9d35b1d4fabceca5829`
- `rust/core/src/lib.rs`: `d1a9666c1504a0207b6c88905d33682e0f6251f2afe6f6d1b241ac68444dc433`
- `rust/core/src/source_bundle.rs`: `ed174aa07af14f1647302f44095be34a2d3f6760e35d9a204e6a3524ca5518ad`
- `rust/core/src/source_bundle_tests.rs`: `6e4ed7d2c85a947a7aff31347ddf063055a2df9eef6207f2a00892477f10338c`
- `rust/core/src/source_index.rs`: `03a55b573067cb260dd8378bb72ac976e900c2ade1acb717ea3ee47ef5d34f6d`
- `rust/core/src/source_index_tests.rs`: `47848f460f63f583c81e5cff5f6332e67ce924dc16f2de3a2a69fc3e84b3d45c`
- `rust/processing/src/appearance/annotation.rs`: `25f3942bc524584dcb91430b0867c32045292efb894902735c7af44846898754`
- `rust/processing/src/appearance/atlas_plan.rs`: `808f01d193e6ae5068db2678e01b4b05d74a570570cb01326e8031c373ebbd3e`
- `rust/processing/src/appearance/authored.rs`: `10867be60267423356f54901d604a33297c1dcbc22e55bd17f64a96f41699c34`
- `rust/processing/src/appearance/canonical.rs`: `3466eba2878ae6939e30bde75b3f9051a3e263757d2638c3769603ea34324eda`
- `rust/processing/src/appearance/catalog.rs`: `091d00ee5bf4957f31cf33d83907456d912a1d417c85c25e6697abaa4b8d7ead`
- `rust/processing/src/appearance/context_tests.rs`: `67e4deadda5d8f6173bf39538ee8f7020e48e3e901dcfeb4f677a013b980356c`
- `rust/processing/src/appearance/evaluated.rs`: `218b3a3e8c1f58ca3b48e14127e77924b73358021b72e49459c73adfd083ca35`
- `rust/processing/src/appearance/evaluated_tests.rs`: `0d2a5804571685b07730fcd32bd08cf7f09f1a977d979659ce2bafb4207f2a46`
- `rust/processing/src/appearance/mod.rs`: `c6e7195af66782df6901794ebf2c67c7cc987271ef4fcbde1cef00622b5edc45`
- `rust/processing/src/appearance/owned_context.rs`: `bfaafb44a032f50a5d729284fdcfcae04fc86a755901616ac5741e5740c68ef7`
- `rust/processing/src/appearance/page_source.rs`: `e9e455714e607d2762f3e984053d7d451a24358634cd23e2af1e4791e076443f`
- `rust/processing/src/appearance/pdf_fill.rs`: `eeb42ff844628cee7ecfc2e6501e98a309c60874c3d3ace4e8dc091e810630a4`
- `rust/processing/src/appearance/source.rs`: `8eca9e5dc7982a7b43fecd73283c54ac8247cc934476f7ea4cd5e1be84008af0`
- `rust/processing/src/element.rs`: `4a2c4d27d084e300ae53381bdeeb2fdb76fcac67b154fe15189fbf7ed55cd95c`
- `rust/processing/src/element/model_context.rs`: `8abc4d929a594462285ed8a9f93e16e93efd797028fc5269d45bbf65d0a51058`
- `rust/processing/src/element/owned_callback_tests.rs`: `5448379c87daa864d2d3a71be4782b344178ea34d06f86310d1567229aaa8d68`
- `rust/processing/src/element/owned_session.rs`: `2225868f5d633102d794d25205edff4450e2c8006e8398bb67055a3830cb843f`
- `rust/processing/src/element/session_protocol.rs`: `594ab92eaef66d1e68780e48d6eb9af7e7f5694395581629eb464943ddf3bf7f`
- `rust/processing/src/element/source_context_tests.rs`: `14045654200568947945dd0f0362f8ebb84d231c2740b9fef5f3591ea8edd7de`
- `rust/processing/src/processor/entity_index.rs`: `77bbb3d48cb08d52b1bba89396b895b790eb7f96b82fa81d2b542e2d04131b41`
- `rust/processing/src/processor/jobs.rs`: `1427649fd50fe0ee62151bc72aac6fe521a970f531f215f275e2664f042a2131`
- `rust/processing/src/processor/mod.rs`: `74016db8f139bf653cc60f69b7007c4bd822e480675b965d4e01b9eec0682d4b`
- `rust/processing/src/processor/scan.rs`: `d0c00ce2eeed1bb673f16a9fc5ab58e8c3869c0f22606941e75f241067af88dd`
- `rust/processing/src/processor/scan_preservation_tests.rs`: `6688aa71b2740e81eb4774e524fbc279ff6afac04b21166fde2c47430b566a3b`
- `rust/wasm-bindings/src/api/coherent_source.rs`: `0f74ae57d511122d5e3ec05ba17c10c6355e88351da31e6e310c5b3d526d7833`
- `rust/wasm-bindings/src/api/entity_index.rs`: `2cb6cbb39a2a6bee92025bf8834e11b96ba87c8e6d7065f3297bb777a65f1fa1`
- `rust/wasm-bindings/src/api/gpu_meshes/batch.rs`: `c020e932e64510f8d2d46c57549591566119f653369a9c1a8c6fc8e5f3a067f2`
- `rust/wasm-bindings/src/api/gpu_meshes/batch_from_source.rs`: `2a33406e99defbe48383af3c20822c82a3939e7bd25ee47f872e98a6e842cc43`
- `rust/wasm-bindings/src/api/gpu_meshes/batch_partition.rs`: `98c219fe394bc166a5ff93408d0545767ea76546c682af91c089a2e415b2c4b7`
- `rust/wasm-bindings/src/api/gpu_meshes/mod.rs`: `e4ff470752e5b86a9e2f4f23363d1851aa6c9499274f0a2ce53b21697bc3c1db`
- `rust/wasm-bindings/src/api/gpu_meshes/prepass.rs`: `c7673adbe1063001a4c338bd5398582e883942469f29cc34531b019dde577674`
- `rust/wasm-bindings/src/api/mod.rs`: `e58bf18419d5b70d4ff7bbefbde3bb328d75067fbbccb5312f91e7bc0fd89470`
- `scripts/perf/README.md`: `f7118fd298da6a85fac8d1e883efada1c670551e90a401c6248b01876c419c12`

Parent integration files at inspection:

- `rust/processing/src/element/model_context.rs`: `5228555bf80a924d739246cc1c47610c63298a193bee35cb30d14e6e375b0cf5`
- `rust/processing/src/element/owned_session.rs`: `4c6dcfaa742fea5e812f41a51882e3e77b540fa3e02a83531613fa502a2b3f73`
- `rust/processing/src/element/accounted_session.rs`: `47183ec80b8a7970b215fbc89438380e469c740b142cb0426e015a5b1e9e86a2`
- `rust/processing/src/element/session_protocol.rs`: `6cde3eaa6b44878b95a16e9d48436298d226b55349160c1e1f753e93657cff4d`
- `rust/core/src/execution_owner.rs`: `e38ffab725f51a3b047cdd77ee6a00716d3aac3c2e7f2901588406e4b86b9aca`
