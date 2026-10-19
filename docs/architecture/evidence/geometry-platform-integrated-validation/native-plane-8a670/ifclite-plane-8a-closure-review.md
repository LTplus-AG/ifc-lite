# Unary plane closure source review

Frozen root `8a670c900e69b5e5a70f3c1ac2587fbd6e089999`. Prior report `/tmp/ifclite-plane-a0fa-review.md` remains scoped to `a0fa95edd7ad15d2d5d05425808324a55c1cd7bc`. Actual SDK pin c9c5979f04cea8c38213004d4f04df0dcfb40d05 inspected. **Both prior production findings are closed in source; one new test-setup defect remains.** No source edits, builds, tests, jobs or qualification claims.

## Prior context metadata finding: closed in source

context_metadata.hpp factors the existing legal protected-member-pointer access into a private helper. construct_brep restores all three shared raw context fields immediately after the default constructor, before returning or running MergeBrep/face work; its guard also restores on throw. checked_brep_copy uses it, preserving raw source metadata and flags. cutter_for now uses the same helper. clip_finite_plane additionally owns an outer Restore spanning preflight, copy, cutter, Boolean and return/error paths. Nonallocating raw assignments preserve DEFAULT bits rather than chasing/recomputing values. No SDK edit or base-to-derived object cast was introduced.

The new ObservingTrim calls the real SmBSplineCurve::Copy inside actual MergeBrep while checking source/sibling/shared metadata, so it can catch a temporary constructor reset that final-state-only tests miss. Existing original plane/orientation/volume/topology oracles remain unchanged.

## Prior evaluating source validation finding: closed in source

certify_plane_domain no longer calls ValidatePointers or IsClosed3d on the source. preflight_existing_data first checks actual face/edge classes, present materialized surface/curve/generator data, and every present UV trim's class/backing. GetUVTrimCurve is read-only at pinned SmEdgeuse.cpp6420–6441: it returns this/mate's existing pointer and does not evaluate or create one. GetGwNurbPointer is the raw getter, distinct from GetOrCreate.

The source uses pointer-loop closure and the pinned topology-only IsManifoldSolid/SmEdge::IsManifold checks. Full evaluating SDK ValidatePointers (status plus zero report entries), geometric IsClosed3d and volume now run on the independently owned copy/cutter/output. Missing generic UV containment still refuses in source bounds admission. Thus a present empty generic trim is refused before the former EvaluatePoint -> GetOrCreate -> failed MakeNurb/null-dereference path.

The new actual source tests insert generic and derived missing-NURB trim objects, demand status7/no taint/certificate, check unchanged source geometry/metadata/pointers and require derived MakeNurb call count0. They provide meaningful regression source coverage but remain UNRUN. Source pointers are trusted SDK-constructed handle topology; this is not a claim that arbitrary corrupt raw pointers supplied outside the C ABI can be inspected safely.

## P2: cached zone tolerance is treated as a DEFAULT-inheriting field in the witness

context_metadata_tests.cpp:73/78/80 assign SM_USE_DEFAULT to context/source/sibling cached zone tolerance for selected scenarios, then lines94–102 require successful clipping of a2-unit box with expected volume6 and expected Empty at x3.

Pinned SmMath.h50 defines SM_USE_DEFAULT as9876543.21. In the pinned old-tolerance configuration (SmConfig.h226–233), SmBrep.h699 GetTolerance returns m_sThisZoneTol3d directly; this cached zone field is not a DEFAULT-inheriting size/ratio property. SmContext.h describes the zone as cached/recomputed tolerance. Consequently those cases install an approximately9.8-million-unit actual source/cutter modeling tolerance, with the domain/enclosure expanding accordingly. They do not exercise an ordinary inherited tolerance setup and their geometric success oracle is unsupported by the source semantics.

Repair: retain DEFAULT sentinel coverage for model size and size ratio, but use valid finite cached zone tolerances for successful actual geometry cases (including matching old-tolerance semantics). If exact preservation of arbitrary zone bits is desired, test that as a separate raw copy/restore invariant without demanding a geometrically meaningful cut under that enormous tolerance. Keep the intermediate real MergeBrep observer, both explicit/default size/ratio cases, source/sibling comparisons and unchanged analytic clip oracles. This is a source-established fixture-policy defect, not an observed failed SDK run.

## Preservation and remaining evidence

Original no-plane-motion, outward interval projection, whole-domain sidewall enclosure, generic positive rational hull/cylinder proof branches, exact wire format, capabilities123 and existing17/18/19 remain. Native fifth poison CTest is still isolated; new context/preflight tests are added to the ordinary owned boundary and invoked from run_plane_tests. No cap/tolerance/volume oracle was relaxed in this closure delta.

No additional concrete production correctness defect was identified within this scope. Source proof-hardening and broader coverage limits from the prior report remain separately stated. Compile/link/actual fiveCTest, native/runtime/browser numerical evidence, source-bound unprewarmed positive cases and cross-target qualification remain required. A source closure verdict is not numerical qualification.

## Exact source Git-object SHA256 pins

| Path | SHA256 |
|---|---|
| `native/smlib-adapter/CMakeLists.txt` | `2e20e2ab4fae5930a1f066fb61f1f1ce3a758ed87625c3c72338e4cafd551a7f` |
| `native/smlib-adapter/PLANE_CONTRACT.md` | `d4efcd4c2513e326e8e7ba46b10b10edff9c1123ba892054109a8a7c41ba58be` |
| `native/smlib-adapter/include/ifclite_smlib.h` | `f67077face61a64176dbb0f155aa4d96a13124135728d7ff016f138cadaf6fa3` |
| `native/smlib-adapter/src/adapter.cpp` | `7f937d6b815d3248548929d299deb4d3909229d0810e8b2800e8b11e74aede08` |
| `native/smlib-adapter/src/context_metadata.hpp` | `c105a819bb1aa5d7e678aadca403a4174a0312621eb26cbc2d850eb0f3d4b407` |
| `native/smlib-adapter/src/copy.cpp` | `df3f6993cbc6fea0dd488891dc08a9ff595630e30adc1e8f31d988898c7b3a1b` |
| `native/smlib-adapter/src/plane.cpp` | `95f9f995959d9b77d5dae2661683ed45c182885796e4aad8ef815884a73a068e` |
| `native/smlib-adapter/src/plane_domain.cpp` | `e1379fb7f6f1fd69eae686af66002a49067e28414f8a22dcca39d72357f89542` |
| `native/smlib-adapter/src/plane_interval.hpp` | `12405e5045b61f73b797f618977b4123eb326171be42e9392a67a712b431c158` |
| `native/smlib-adapter/src/protocol.cpp` | `800e18af50520867897d70b25e814428e78cd279bcd643fc8d68e70abf520a8a` |
| `native/smlib-adapter/tests/adapter_tests.cpp` | `b5e339673bfeb57d77995c9bf2cc123abb07498b87615c9abf54f2cc527ef86c` |
| `native/smlib-adapter/tests/context_metadata_tests.cpp` | `29045495a431f0e145b90e3877d8b5c3ee2313ec88b03560937acb16e3724241` |
| `native/smlib-adapter/tests/plane_preflight_tests.cpp` | `f38e2cb5bd891bdc8b3c9eae87e6788d039362b468b81bec33cdfa5e5ac713a8` |
| `native/smlib-adapter/tests/plane_tests.cpp` | `6c39c64804764d210af6657f2b0324eb13cc35a0e247a62c8380f9bc58fb7cb7` |

## Primary SDK SHA256 pins

| Path | SHA256 |
|---|---|
| `source/SMLib/inc/SmMath.h` | `b5e2a7999d0a836d557c0b420601b48d782a395d1f94f4d9a12b64a91a9787c4` |
| `source/SMLib/inc/SmConfig.h` | `5b46facc624c688e71d34715dd9054052c757f896b2b4e6132993cc5472f45f1` |
| `source/SMLib/inc/SmBrep.h` | `7826cddbc8816cb51bba8349f5fedee42070ab63c0a33018c1875134c0d9ab73` |
| `source/SMLib/inc/SmContext.h` | `07cbae5016d3bee7df0afb12dbc957250dfc239a9300432f5e7e60b20e309134` |
| `source/SMLib/src/SmBrep.cpp` | `5d44d6ac347fa42e4e83fead8bbde82ce46c5ff48e0a973b5c7cddc778a2fca1` |
| `source/SMLib/src/SmBSplineCurve.cpp` | `93c905a12c4124f6761f63ca9dbe2e2ffe400eb32b493c3d514be42de2c41138` |
| `source/SMLib/inc/SmBSplineCurve.h` | `0e12036dda5f5439d3cbc5a2daf4253779ed4dfa73167031587d9ff5eb12dfb2` |
| `source/SMLib/src/SmEdgeuse.cpp` | `d117c7b53f010a699a73384907d4c23fbc2bdb078f09a3e97dfaa5a8d685505e` |
| `source/SMLib/src/SmEdge.cpp` | `cb69520529d7e45c497478262cde2ed2fcbc2557f3a02bdf01a30017c8ead3a7` |
