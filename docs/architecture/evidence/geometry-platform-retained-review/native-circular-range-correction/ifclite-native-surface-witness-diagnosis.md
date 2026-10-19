# Native surface witness diagnosis and separate interval correction

Inspected the archived actual native qualification failure at source `331ab9d92ab588063b61400ca0bef1cfd424438a`, pinned SDK `c9c5979f04cea8c38213004d4f04df0dcfb40d05`, and the later root diagnostic source. Exact immutable inspected/final edited file hashes and compressed/raw run-log hashes are in `/tmp/ifclite-native-surface-witness-diagnosis-hashes.json`.

## Actual failed assertion: unresolved

The archived fbacabd8 run compiled and linked the C++ adapter/test executable. Upload transport and worker framing passed; owned boundary aborted with `region witness failed: actual planar/curved surface counts`. The output contains no fixture name, observed count, or flushed preceding region PASS records. An abort can discard stdout buffers. It therefore does not establish that the first rectangle, circle, oblique rectangle, or another particular witness failed. No source inspection justifies inventing those missing observations.

The test counts actual `GetFaces()` faces rather than faceuses. `surface->IsPlanar(1e-8)` is a genuine virtual Boolean geometry query, not a status API accidentally tested as truth. `SmPlane::IsPlanar` explicitly returns TRUE; there is no demonstrated Boolean/status inversion in the test.

A concrete SDK-query limitation deserves checking once counts are available: base `SmSurface::IsPlanar` calls `CalculateBoundingBox(natural_domain,nullptr,&pseudo_box,nullptr)` without overriding the default expansion flag. The Bezier-patch branch of that method expands the pseudo-box by one twentieth of a radius before `SmPseudoBox::IsPlanar` tests its minimum thickness. Thus the base query can reject planar geometry represented by a general surface rather than SmPlane. The linear sweep creates SmPlane only for orthogonal generating-line/sweep directions; otherwise it creates SmSurfOfExtrusion. Oblique rectangle sides may reach this general representation. This is a source-grounded candidate, **not proof that it caused the archived failure**.

The public sweep also defaults to continuity subdivision before analytic construction, so an assumed one-face-per-input-curve topology needs actual surface/count observations. The continuity enum includes geometric continuity levels, so simple knot multiplicity alone does not establish that a particular circle was split. No deterministic subdivision count is asserted here.

No planar/curved/cylinder assertion was removed, relaxed or reclassified. The later stderr fixture/count diagnostic must run on an admitted final-source SDK target before choosing a surface correction. If it establishes planar general extrusion misclassification, a correction must independently certify the represented plane (for example unexpanded bounded geometric data plus actual surface evaluation/linear-generator identity), not merely relabel unexpected counts or allow any topology.

## Separate definite adapter bug: circular endpoint range

This finding does not explain the unknown surface-count failure. The original adapter normalized start radians with remainder but passed `start+sweep` directly as an SDK degree endpoint. A full circle starting at 0.37 radians therefore sent an endpoint near 381.2 degrees. The actual called chain is `SmApiCreateArc -> SmBSplineCurve::CreateCircleSegment -> N_CreateCircArc -> N_CreateCircArcTol -> N_CreateQuadraticArcTol`. `CreateCircleSegment` unconditionally checks both endpoint degrees in [-360,360] using RANGE_ER; the range check is not disabled by NDEBUG. The lower constructor uses start and angular difference to create the rational quadratic segments. ReverseParameterization reverses the resulting curve after construction, preserving the existing negative-sweep policy.

The parent separately authorized an adapter-only correction and real SDK witnesses. Changed files:

- `native/smlib-adapter/src/sweep.cpp`: normalize the interval midpoint after reducing authored start, then derive both endpoints from that common midpoint and the unchanged signed sweep. This shifts the entire interval by a common multiple of 2pi rather than wrapping endpoints separately. It preserves long trims, full-circle extent, orientation and the circular frame/normal.
- `native/smlib-adapter/tests/sweep_region_tests.cpp`: six additional actual SDK witnesses: positive and negative full circles with nonzero starts, negative-normal full circle, wrapped 270-degree major arc, reversed major arc, and negative-normal major arc. Existing witness machinery checks analytic volume, bounds, planar/curved/cylinder counts, independent section length/boundary points and actual ABI upload. Major-segment area is `3*pi+2` and perimeter `3*pi+2*sqrt(2)` for radius2; these distinguish the major trim from the complementary small segment. All preexisting surface-count assertions remain intact.

## Validation boundary

The authorized two changed C++ files passed lightweight syntax-only compilation against the actual pinned headers:

`c++ -std=c++17 -fsyntax-only -DSM_NO_DEBUG_CODE -DSM_NO_GFX_OUTPUT_CODE -DNDEBUG -I native/smlib-adapter/src -I native/smlib-adapter/include -I /tmp/ifclite-smlib-eval-upstream/source/SMLib/inc -I /tmp/ifclite-smlib-eval-upstream/source/SM_API/inc native/smlib-adapter/src/sweep.cpp native/smlib-adapter/tests/sweep_region_tests.cpp`

Exit0, log `/tmp/ifclite-native-circular-interval-syntax.log` (empty); whitespace check passed. No SDK source was edited, no heavy build/link/runtime/test job was submitted, and no cleanup/retry occurred. The new positive SDK assertions remain UNRUN. The original surface-count failure remains an unresolved qualification blocker; syntax success or the independently correct angle normalization cannot turn it into a pass.
