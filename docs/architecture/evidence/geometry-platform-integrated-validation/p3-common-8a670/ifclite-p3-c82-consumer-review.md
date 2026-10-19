# P3 canonical browser consumer review, round 1

Frozen source `c82a596f12a7272888fd0cf8ab42e48e1ac0be9a`. Independent read-only source review; no source edits, builds, WASM generation, actual SDK/browser execution, fleet jobs or PR actions. **Two concrete source defects identified. All execution remains unqualified.** Prior protocol fixture success is not qualification of this source.

## P2: retained consumer captures inverse material-layer policy

`rust/wasm-bindings/src/api/retained_product.rs:121` installs the material-layer index when `self.merge_layers()` is true. The canonical ordinary batch uses `if !self.merge_layers()` at gpu_meshes/batch.rs:225. That flag means merge/render walls as one solid; false enables material-layer slicing. The newly captured retained router therefore carries the opposite policy for either setting, contradicting the intended canonical snapshot/configuration seam. MaterialLayers is still unresolved, so this is not a report of current final geometry loss; it is a concrete incorrect consumer policy that must not be carried into completion.

Repair: factor/use the same material-layer router configuration helper/predicate in ordinary batch and retained admission, with behavioral witnesses for both settings. Do not merely assert on source strings. Ensure future workflow path gates cover the helper. Preserve the dedicated part-skip policy separately.

## P2: canonical actual-Worker witness requires an impossible requirement count

`retained_product_tests.rs:21` asserts remaining_requirements.len()>=5 for the nested mapped proxy. Frozen retained.rs:326–330 returns exactly four named remaining requirements (OpeningClosure, MaterialLayers, IfcAppearance, PersistentFaces); retained_entries finishes that placed product with this same list, and no production code appends a fifth requirement. The new test will fail after successful transaction execution. Increasing unresolved requirements to satisfy a stale count would be wrong.

Repair: assert those named unresolved obligations plus final_product_available=false, and separately assert the expected product-placement fact where useful. Keep actual numerical/occurrence and post-retirement witness rejection assertions intact. This source finding predicts a failed assertion; the browser test has not executed.

## Canonical source/ownership observations

- Admission clones the actual installed CoherentLoad under a short mutex borrow and drops that guard before any async work. It decodes the actual product, uses combined_pre_pass and the existing material/palette/texture caches, and snapshots the same ProductionModel. It takes no raw IFC bytes, source key, numeric Worker identity, transport or completion from the caller.
- Product/type-map job-kind selection is factored into product_job.rs and called by ordinary gpu_meshes/batch.rs. The extracted code preserves existing type-map list/filter/EmitTagged behavior. The material-layer inversion above is a separate configuration error, not a reason to fork job selection.
- Execute owns one local authenticated decoder and one retained router for the entire async transaction; no self-referential decoder field or refreshed decoder between awaits. ProductOwner reservation stays in the shared execution; source/router/resource lexical scopes remain synchronous issue/accept operations. The adapter owns numerical-only batches, with resources restored before awaited Worker calls. No RefCell or mutex guard was found crossing an await in the inspected consumer.
- On error the consumer invokes explicit synchronous cancellation cleanup while preserving the primary error. The router is consumed once; failed or completed transactions cannot silently restart against a new source/router. The shared context lifecycle and receipt liveness are revalidated by witness(). No source-only mesh is returned.
- The successful return is explicitly contract=common_product_transaction_only with final_product_available=false. It reports the actual common plan/ledger counts and unresolved requirements. This is an inspection artifact, not final-net publication; the absence of final product output is an acknowledged P2/P4 hold, not a hidden source-only success.
- Independent cancellation is captured before a wasm-bindgen mutable executor borrow. Captured runtime domain identity uses the private actual Owner Arc and private driver liveness; identity clones do not create object leases. Browser construction is explicit, and ordinary admission/loading does not instantiate an SDK Worker.
- Prior dispatch observation remains read-only and uses actual transferred/detached request frames. Private fixed /smlib driver construction, independent object release, angle<=180 validation before runtime InFlight guards and retired-domain invalidation are retained.

## Tests and workflow scope

The new processing browser tests call BrowserWorker::new_retained_execution(), actual qualify() and the real shared issue/execute_browser/accept loop. They do not accept supplied response/transport/qualification flags. Source covers nested/repeated Boolean/empty operations, mm/survey affine, private receipt rejection/swap/foreign cases, actual-dispatch15/5/18 cancellation, source/context/resource expiry and an unrelated resource callback while awaiting. Runtime browser tests additionally exercise real source/result/affine leases, actual dispatch cancellation/replacement and PlacedResult frame replacement. Their presence is not an execution pass.

The workflow builds actual native SDK and browser WASM adapters, stages the canonical bundle into each test crate and invokes wasm-pack headless Chrome for runtime, processing and retained-product tests. The stager checks pinned clean SDK inputs, matching configured modules and bundle/source hashes; it explicitly does not attest how supplied binary outputs were compiled. This workflow builds those supplied outputs in the preceding step, but actual serving-root/path/browser availability and test selection still require an executed run. The ordinary Node SDK boundary lane is not a substitute for these browser tests.

The inspected actual-browser Rust tests do not establish startup timeout/missing-asset behavior; those scenarios remain a P3 execution/coverage gate unless separately demonstrated by actual-browser witnesses. Existing Node/transport scenarios, a newly constructed replacement's numeric incarnation, or a runner timeout do not prove a replacement performs actual geometry. Several existing runtime cancellation witnesses do qualify/evaluate a real replacement; retain those stronger checks.

## Scope boundaries

Remaining halfspace/external opening/layer/final appearance/UV/texture/persistent-face assembly requirements belong to the broader production goal and are not completed by P3's inspection API. Target qualification, canonical generated bindings/API snapshot/changeset synchronization, real browser execution and all native/WASM/consumer/performance validation remain mandatory. This review does not re-review the complete P2 common acceptance engine or original SDK implementation.

## Exact Git-object SHA256 pins

| Path | SHA256 |
|---|---|
| `rust/wasm-bindings/src/api/retained_product.rs` | `a295d77a02be395a99016607a43952e42c723fefc6c717c727fbbb0a2e2ef5c1` |
| `rust/wasm-bindings/src/api/product_job.rs` | `40a5a753afae1525e2beb378af1a630f9852afa5c2e9e8f14c1e998aaba44828` |
| `rust/wasm-bindings/src/api/gpu_meshes/batch.rs` | `d374dff45aac3cdb630306b58a7d682196abe0935770db48011c9fbcb89b3d41` |
| `rust/wasm-bindings/src/api/mod.rs` | `7fcfd25dd08fa6ef151b1d2f64b44e727ecdcd9eaf577f5954a2fe01f879d8b9` |
| `rust/wasm-bindings/src/api/retained_product_tests.rs` | `9449bdb2cb800db77d0a943516db256e7491f18a5ab36a42bf9f62b9b8b93505` |
| `rust/wasm-bindings/src/api/coherent_source.rs` | `0f74ae57d511122d5e3ec05ba17c10c6355e88351da31e6e310c5b3d526d7833` |
| `rust/processing/src/element/session_retained/browser_tests.rs` | `8436ab7b22dc7069c89426e61d97939cd86e9509a1430c4e0874bdad09e41f3c` |
| `rust/processing/src/element/session_retained/browser.rs` | `fc0e505f0a61287af7f3ba1401ceb1aec97f12c730a26f0cefe32606c7e8f734` |
| `rust/processing/src/element/session_retained/target.rs` | `e10e98d77163f5397df9dbc03d50298e04ae538c66ad60a0747f0affb3a67da8` |
| `rust/geometry-runtime/src/browser_bridge_tests.rs` | `6b8fb225b62bb11cea5d39bcb92539d2d1ae46b51711c432cc9e98acf638d269` |
| `rust/geometry-runtime/src/browser.rs` | `2f48c2302b46ef318699f091c2921279525f2ff708fc5bb4f336223359e36619` |
| `rust/geometry-runtime/src/browser_bridge.rs` | `c0322dae94c81139b48e73c3d85718371c720a86b71c8b6e351884e6977ca10a` |
| `rust/geometry-runtime/js/retained-driver.mjs` | `92ce43a4f88e93c8ec9b4b466c67c570f9624cc0a0bb51b4fe47cf9cfad3ed04` |
| `rust/geometry/src/program/retained.rs` | `606563c92a299dda12c2d7aa5df1ed137b63d025e65b20c08c47c0ddabfc8fe6` |
| `rust/geometry/src/program/retained_entries.rs` | `d279170da62f818d44e9e76acb6773529dafb00b9dc9b0faabf66de0c6c44bdc` |
| `.github/workflows/geometry-platform.yml` | `9be4ea703c25ed370c1f52ca4c5bd7c722a74b3c8ee71ef0dfb72a40ecc109e0` |
| `scripts/stage-retained-browser-assets.mjs` | `67d48f0b465873ba5050241e10bf3c59a0f66f7267949b4b1bc048db6f6bccff` |
| `docs/guide/geometry.md` | `336f6e08e14b9f2d5ffe0c134894d2fd89ea20cc6aafc4a503cc01f39305aa82` |
