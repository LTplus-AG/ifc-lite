# R1 finite STEP-dispatch correction

Frozen separate commit `8cdb8c12d7bf9a2c17eac8b7172eb28bea217ab3`, parent `f39ca76a5bde30c47d0dd9ef374f37f930bb9186` preserved unchanged.

The R1 counterexample is valid. In pinned SmLine.cpp459–487 the bounded conversion forms `(t-natural_min)/natural_length * (STEP_max-STEP_min) + STEP_min` (with the specified reverse branch). Finite STEP endpoints alone allow the span to overflow. Matching exact dyadic rational corners cannot authorize an SDK dispatch that produces NaN.

Before any UV detach, line-map preparation now requires finite positive STEP and natural spans (retaining the natural non-nearzero branch restriction), then checks finite subtraction/division/multiplication/addition intermediates and normalized ratios at the complete natural-domain extrema for both orientation branches. These operations are monotone over the interval with finite fixed positive spans; the endpoint extrema bound all interior operations. Signed-axis position-operation extrema are also checked for finiteness. Exact dyadic equality remains a separate unchanged requirement; unknown maps still refuse.

New actual SDK negative constructs the review's real SmLine state on a private actual box fixture with natural[0,1], STEP[-DBL_MAX,DBL_MAX], origin0,+X,scale0.5 and materialized controls±DBL_MAX/2. It requires finite exact matching corner equations and an actual successful SDK conversion returning NaN, then the specific unsupported `identity UV nonfinite STEP conversion span` refusal before detachment and a byte/pointer/metadata source-immutability comparison. This witness is UNRUN, not a reported pass.

Only three owned paths changed from f39: plane_identity_uv.hpp, plane_source_domain_tests.cpp, PLANE_CONTRACT.md. The producer-only patch is unchanged from f39; supplied separately for parent hunk integration. Cumulative delta from83d15 stays within the original five owned paths. No full-file overlays, SDK/runtime/common/opcode/CMake/mesh/copy/context edits, tolerance changes, jobs or source snapping.

Syntax-only compilation of affine.cpp and both native test TUs passed. Exact seal/restoration reachability remains UNRUN because TurnToNURBS surface replacement may recreate UV data/reset domains. The original log proves the represented endpoint discrepancy, not its first producer or analytic/rational equivalence. Required method2 positive, separate genuine method8/v2 positive, Rust plane_clip.rs48 chain and unchanged status8 cleanup remain held pending parent's actual execution. No whole-product qualification is claimed.
