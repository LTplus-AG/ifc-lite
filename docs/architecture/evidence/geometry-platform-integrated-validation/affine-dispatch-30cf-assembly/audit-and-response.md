# R2 analytic dispatch correction

Frozen separate commit `30cf377a579e95fef8315d4e9c8fbff95bf18109`, parent `8cdb8c12d7bf9a2c17eac8b7172eb28bea217ab3`. f39 and8cdb are preserved; only three owned paths change in this incremental patch. Cumulative after83d15 remains the same five owned paths. The producer-only three-line hunk is unchanged from f39; no older full-file overlays are supplied for integration.

Pinned SDK c9c5979f04cea8c38213004d4f04df0dcfb40d05; primary-source hashes verified against its Git blobs are in source-and-sdk-hashes.json. Syntax-only compilation of affine.cpp and both native test TUs passed. No builds, linking, actual tests or jobs submitted; working tree clean after freeze. Qualification.json records each held actual witness separately.

### R2 correction: bounded analytic evaluation and derivatives (UNRUN)

Independent R2 review supplies a second valid counterexample: natural[0,0.5],
STEP[0,2^1023], origin0, axis+X, scale2^-1023, and unit controls[0,1]. Spans,
position intermediates and exact dyadic corners pass, but `SmLine::Evaluate`
forms Jacobian2^1023/0.5=infinity before multiplying axis*scale*Jacobian. The
actual first derivative is (infinity,NaN,NaN), whereas the rational derivative
is (2,0,0). The finite-position guard alone was insufficient.

The pre-detach line proof now checks that actual Jacobian is finite and positive
and that both the unreversed STEP first derivative and the directed NURBS
first-derivative multiplication stages are finite. A collapsed nonzero-axis
first derivative also refuses. Exact corner predicates remain mandatory.
The bounded analytic-dispatch audit includes the following primary-source paths:

| Pinned SDK path | Checked arithmetic and derivative coverage |
| --- | --- |
| SmLine.cpp404–487, both parameter converters | Both bounded orientation branches; finite positive spans, non-nearzero NURBS span, endpoint extrema of every subtract/divide/multiply/add stage, normalized ratios in[0,1]. Unbounded/near-zero fallback branches remain excluded. |
| SmLine.cpp1035–1147 Evaluate, EvaluateSTEP, EvaluatePoint | Both position multiplication orders, covering mapped NURBS and full STEP intervals; actual Jacobian; unreversed and reversed first derivative stages. Every requested derivative order>=2 is assigned literal zero. Side and nonzero-tangent flags do not alter this implementation. |
| SmCurve.cpp3554–3564 EvaluateSTEPPoint | Delegates to EvaluateSTEP with order0; no independent arithmetic. The STEP endpoint construction used by SmLine::MakeNurb therefore shares the checked position path. |
| SmLine.cpp780–790 EvaluateCurvature | Literal zero, no parameter arithmetic. |
| SmPlane.cpp1458–1585,4371–4381 | EvaluatePoint and Evaluate/EvaluatePointFast use different multiplication grouping; both groupings and both successive additions are checked at full actual analytic-domain corners. All first U/V partial components and the returned stored normal are finite. Higher/mixed partials are literal zeros. |
| SmPlane.h189–200 EvaluateSimple; SmSurface.cpp10950–10999 EvaluateSTEP/STEPPoint | Delegate to the above plane evaluators, with no additional coordinate/Jacobian arithmetic. |
| SmSurface.cpp12242–12289 inherited plane UV converters | Identity copies; no span division or hidden Jacobian. SmPlane declares no override of these converters. |

Finiteness at the complete interval/rectangle extrema bounds each monotone
scalar stage over that domain, using the admitted signed independent coordinate
axes. No SDK evaluation, samples, fitted data or epsilon proves these bounds.
For2D analytic lines the canonical third component must be zero and its
arithmetic is checked too; raw NL_NOZ storage remains non-geometric and is
preserved in the seal. The plane guard checks finite actual canonical domain
ends explicitly; no hypothetical generic evaluator clamp is used.

This coverage concerns valid SDK derivative requests and correctly sized output
storage. In particular plane upper-half requests require U-order<=V-order; the
SDK's unsigned initialization loop is unsafe for the opposite invalid request.
Source geometry cannot authorize malformed request counts/arrays. This patch
does not modify upstream code or claim safety for arbitrary external SDK calls.
Nor does it certify all arithmetic in solvers, projections, normalizing helpers,
quadrature or the generic NURBS evaluator. Finite direct analytic evaluation is
an additional necessary eligibility condition; exact dyadic map identification
is still separate, and no bitwise equality of all floating evaluator outputs
or arbitrary algorithmic success is asserted.

The concrete producer call is still `copy_affine_rational` on the unpublished
checked copy: preparation/proof -> unchanged TurnToNURBS -> both unchanged
transforms -> exact seal -> original UV restoration -> real method2 admission.
TurnToNURBS calls ReplaceSurface with UV recreation enabled; ReplaceSurface
resets the face domain and calls CreateUVTrimCurves, whose paths may evaluate
still-analytic3D lines before the later edge conversion. Restored original2D
SmLines may also be evaluated later. The new guards apply to both dimensions
and all direct derivative orders, without needing an assumed derivative-order
census. Static source inspection establishes these possible routes, not an
actual execution trace or successful seal/restoration reachability.

A new SDK negative constructs the R2 forward source and a real reverse SmLine
using the same reversed materialized basis. It requires the exact corners to
pass, actual analytic order3 calls to expose the nonfinite first derivative
while higher derivatives are zero, a real generic copy to have derivative
(2,0,0), and the STEP call to retain its finite first derivative. The production
preparation must then refuse specifically at its Jacobian guard before any
UV detach; coefficient/knot/interval/pointer/metadata snapshots and actual UV
owners must remain unchanged. All these numerical assertions are UNRUN.

Frozen f39 and8cdb remain unchanged. Method2 positive, separate genuine six-record
method8/v2 positive, original Rust plane_clip.rs48 chain, exact-seal/restoration
reachability and status8 cleanup qualification remain held for parent actual
execution. The first producer of the observed2^-51 endpoint gap remains unproven.
No original oracle, tolerance, source predicate, public protocol, opcode, SDK,
copy/context implementation, CMake or runtime source is changed by R2.
