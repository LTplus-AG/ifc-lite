# Unary plane source review round 1

Frozen source `a0fa95edd7ad15d2d5d05425808324a55c1cd7bc`, exact base `23d68a60f47a538dd1a369958cf1a47755adc5c5`. Twelve changed Git objects and actual SDK pin c9c5979f04cea8c38213004d4f04df0dcfb40d05 inspected. **Two P2 defects identified.** No builds/tests/jobs/source edits; no numerical qualification.

## P2: derived cutter resets shared source context metadata

plane.cpp::cutter_for constructs `new (*source->GetContext()) SmBrep()` without the raw context restoration used by checked_brep_copy. Pinned SmBrep.cpp493–525 calls SetThisModelSizeEstimate(DEFAULT) and SetThisLargeSmallSizeRatio(DEFAULT). SmBrep.h724–733 propagates those fields into the actual shared SmContext, including cached zone tolerance. Every successful nonempty clip can reset nondefault context metadata and alter original/sibling Breps inheriting DEFAULT. The copy helper's guard does not enclose cutter creation or later SDK work.

Repair: enclose the entire cutter/numerical operation and all exits in a shared nonallocating raw metadata restoration guard. Preserve exact raw DEFAULT sentinels, not chased SmTol getter values. Add actual SDK source/sibling regression using nondefault context fields and inherited source fields; compare raw fields before/after and later source/sibling tolerance behavior. No SDK edit or private-object cast.

## P2: evaluating validator precedes raw materialization refusal

plane_domain.cpp::certify_plane_domain calls validate_topology(source) before its face/edge materialization checks. That invokes SmBrep::ValidatePointers(level2). Pinned SmBrep.cpp31566–31590 unconditionally evaluates every present UV trim at endpoints/midpoint; CheckFace earlier at31255 is another evaluating call. This is not a pointer-only preflight.

SmBSplineCurve.cpp3274–3302 EvaluatePoint calls GetOrCreateGwNurbPointer then dereferences pCurve->knt. SmBSplineCurve.h549–552 calls MakeNurb when missing but ignores its status; generic MakeNurb5674 returns failure when no NURB exists. A present generic trim without backing coefficients can therefore hit null dereference before the promised unsupported refusal. Derived trim evaluators can also lazily materialize source representation before eligibility checks.

Repair: establish a proven non-evaluating source pointer/topology check plus raw class/materialization/domain checks before any evaluating SDK validator. Run broad evaluating validation on an independently owned admitted copy/output, or prove a truly non-evaluating source validation path. Merely changing the report/test level does not remove the unconditional EvaluatePoint calls. Add an actual present-unmaterialized UV trim witness requiring status7 and unchanged source backing pointer, plus derived lazy trim coverage where applicable. No crash or fitted source data may replace refusal.

## Proof checks and limits

Generic rational patch admission excludes power-basis form/extrapolation and requires existing coefficients, positive finite weights, finite clamped knots, degree+1 endpoint multiplicity, correct knot/control dimensions and actual face/trim UV containment. Under those conditions the Cartesian control hull bounds face interiors through nonnegative partition of unity. Primary GetControlPointsPointer implementations return homogeneous XYZW; dividing once by positive W and treating NL_NOW as nonrational matches those implementations. The source-side validation ordering above still needs repair before this admission is trustworthy.

The bounded cylinder enclosure matches pinned primary code: SmCone::ConvertUVFromNURBSToSTEP handles swapped/inside-out conversion; EvaluatePoint calls EvaluateSTEP, whose clamp is active with extrapolation disabled. SmCone.h395 gives baseRadius+tan(angle)*V, so angle exactly0 gives the recorded constant radius. O+[-R,R]X+[-R,R]Y+[Vmin,Vmax]Z bounds all points using raw basis coefficients, not sampled extrema. IsBounded follows the actual generator in SmSurfOfRevolution.cpp4569. This separate analytic proof does not qualify converted cylinders missing UV trims. Generic SmBSplineSurfaceNLib point clamping is indeed disabled under #if0.

Plane mapping matches SmPlane::EvaluatePoint's O+u*UScale*X+v*VScale*Y. That evaluator can additionally clamp to its analytic domain. For a fully formal plane admission proof, reconcile trim/face UV ranges with that actual clamp domain (or enclose its clamp image) and establish bounded UV outer-loop semantics; do not assume arbitrary inconsistent topology is valid geometry. This is proof hardening, not an independently demonstrated failing valid-source case here.

Interval projection uses an interval inverse of stored basis. Outward nextafter, finite/rounding/underflow checks and source-specific no-fast-math/no-contraction settings support the declared arithmetic model. Sidewall/back checks evaluate whole conservative input bounds against actual post-stitch planes with strict source/cutter tolerance clearance;16x initial expansion alone is not treated as proof. Cut point is never shifted. Basis residual is a numerical policy, not a certified geometric approximation bound. Cross-toolchain execution remains required.

## Protocol, ownership and tests

Request size is92 bytes including header. Success is324+136*cylinder_count, at most2500 bytes for16 records. Explicit LE serialization avoids C struct padding. Publication binds original input/output handles, plane/side/mode, local frame, bounds and cylinder records. Capabilities retain17/18/19 and add64 to59=123; no21/128 exposed. Fifth poison CTest remains isolated.

Checked copy/cutter/destructive failures abandon uncertain SDK allocations and taint the domain with8; no partial handle/certificate publishes. Success requires result==copied host after consuming cutter. Nonempty output validation checks ValidatePointers status AND zero report entries, manifold, void infinite region and positive finite volume. Status-only validation would be insufficient because the SDK can report failures while returning success.

Positive C ABI primitive witnesses use constructors that already validate volume, and run_plane_tests queries source volume before protocol_witness. These can prewarm source UV caches and cannot prove raw retained-source admission. The direct raw SDK cylinder/control-net witnesses help but remain UNRUN. Add actual source-bound runtime construction-to-clip tests before any display/volume read, checking no source data mutation.

This checkpoint has no runtime sealing/acceptance/common source lifecycle route. Additional analytic classes, affine trim loss, polygonally bounded halfspaces, unbounded Union, paired atomic split/interface ancestry and final layer shell presentation remain open. Two unary clips cannot establish shared layer interfaces. Syntax checks, certificates, capability bits and historical native tests do not close these gates.

## Exact candidate Git-object SHA256 pins

| Path | SHA256 |
|---|---|
| `native/smlib-adapter/CMakeLists.txt` | `2fd4d4a4dd303601e594ea1bb528436d4fff83f5b39f4b31eb443239812bc50f` |
| `native/smlib-adapter/PLANE_CONTRACT.md` | `92eaab3693f200c3106235698537ffc44e2c479f9767e8edb8b0b5ebee78cd0c` |
| `native/smlib-adapter/include/ifclite_smlib.h` | `f67077face61a64176dbb0f155aa4d96a13124135728d7ff016f138cadaf6fa3` |
| `native/smlib-adapter/src/adapter.cpp` | `7f937d6b815d3248548929d299deb4d3909229d0810e8b2800e8b11e74aede08` |
| `native/smlib-adapter/src/plane.cpp` | `491c348edeee425a2c11156ec2b66990f07f940d73b17479448b226c71a4ac3f` |
| `native/smlib-adapter/src/plane.hpp` | `f3300a0c0ffd0e1876410011a6718d84f5c4625b526627e7e258875099c13f71` |
| `native/smlib-adapter/src/plane_domain.cpp` | `d7e4832c2692c490dc392d74e2f71f0da9ed14e047732774aae4f02a6e167e1e` |
| `native/smlib-adapter/src/plane_domain.hpp` | `5590c01616b27bccfec2edb23eba9b0759d766a882d6c7ef5c3023851e2aa245` |
| `native/smlib-adapter/src/plane_interval.hpp` | `12405e5045b61f73b797f618977b4123eb326171be42e9392a67a712b431c158` |
| `native/smlib-adapter/src/protocol.cpp` | `800e18af50520867897d70b25e814428e78cd279bcd643fc8d68e70abf520a8a` |
| `native/smlib-adapter/tests/adapter_tests.cpp` | `b5e339673bfeb57d77995c9bf2cc123abb07498b87615c9abf54f2cc527ef86c` |
| `native/smlib-adapter/tests/plane_tests.cpp` | `206c369c6a104456a66b188836710e58e4573407a708d3454378bcfb62f90847` |

## Primary SDK file SHA256 pins

| Path | SHA256 |
|---|---|
| `source/SMLib/src/SmBrep.cpp` | `5d44d6ac347fa42e4e83fead8bbde82ce46c5ff48e0a973b5c7cddc778a2fca1` |
| `source/SMLib/inc/SmBrep.h` | `7826cddbc8816cb51bba8349f5fedee42070ab63c0a33018c1875134c0d9ab73` |
| `source/SMLib/inc/SmContext.h` | `07cbae5016d3bee7df0afb12dbc957250dfc239a9300432f5e7e60b20e309134` |
| `source/SMLib/src/SmPlane.cpp` | `5e554da57cd7b642ceb46c0528d582a906993fcde94779ab8a7a2328ec6e48e5` |
| `source/SMLib/src/SmCone.cpp` | `74a065f859c430cfa2183798467a323f0692445831c94952f35b04cd5b6df8c2` |
| `source/SMLib/inc/SmCone.h` | `79d2d27689add5a69d3c932a3efa5a6026782e3f8fb6fac333e28abc1a62146e` |
| `source/SMLib/src/SmSurfOfRevolution.cpp` | `1366bc85dc515f2e95486878a6ba24ac9bcad73d04ee7b54a85be91496ea3cfe` |
| `source/SMLib/src/SmBSplineCurve.cpp` | `93c905a12c4124f6761f63ca9dbe2e2ffe400eb32b493c3d514be42de2c41138` |
| `source/SMLib/inc/SmBSplineCurve.h` | `0e12036dda5f5439d3cbc5a2daf4253779ed4dfa73167031587d9ff5eb12dfb2` |
| `source/SMLib/src/SmBSplineSurface.cpp` | `f99a3b406641889e17d117e7d76ef45e24a5ec3b291adbca963f9b773057598a` |
| `source/SMLib/src/SmBSplineSurfaceNLib.cpp` | `b971fc6c381f25805d6b5fec6463359bd20850f0e50fb0c75510c4e563061b1b` |
| `source/SMLib/src/SmExtent1d.cpp` | `3f3c6ac8133290ca089a2b2e04d69a16f31352457f026ba62692d93f73764324` |
| `source/SMLib/src/SmExtent2d.cpp` | `a8cfce8285b2a86b5e8d34c410533a623c3b8b6ebd075aed2e087b33128e001c` |
| `source/SM_API/src/SmApiQueries.cpp` | `d6d3c79094a0e14af95233a0af1e038559b6433864979b95b23f4a060db2305a` |
