# Frozen final affine source review

Commit `3ada119540bf08f8fbc059d234d676f6e525a993`; base `e98406f5dffe4591e41b80d8fc841e29a1b056ab`; previous scoped review `994d4dd7a399136f153cf6c5e0ea549e592b9c25`. Manifest pins 34 exact Git-object paths plus relevant primary SDK source hashes at `c9c5979f04cea8c38213004d4f04df0dcfb40d05`. Prior reviews under `/tmp/ifclite-affine-review-51be` and `/tmp/ifclite-affine-review-994d` are preserved unchanged.

Verdict: **no new concrete source blocker identified in the reviewed changes**. This is source-only: SDK compilation/CTest, Cargo and browser execution remain UNRUN. It does not establish target qualification, feature preservation for excluded representations, common-product completion, or production readiness.

## New eligibility correction

Pinned SmBrep.cpp:10923–11016 shows GetSurfaces/GetCurves only enumerate geometry owned by their respective face/edge. New affine inspect() checks enumerated curve count against all edges and surface count against all faces before certifying classes. Each getter can append at most one entry per topology object, so equality rules out the skipped shared/foreign-owned references rather than merely matching a subset's class counts. These cases are explicitly refused, not copied under a false exact-conversion certificate. Zero counts on a genuinely empty BRep remain distinguishable from omitted referenced geometry by the same topology counts; empty-result publication still needs the parent's separate empty-result contract.

The affine 100000 class/topology budget stays in affine preflight. Removing it from shared checked_brep_copy prevents imposing a new affine-specific cardinality refusal on existing rigid17 and Boolean copy consumers. The shared helper continues to reject specialized/composite topology unsupported by the pinned MergeBrep implementation and checks the actual MergeBrep status and topology count.

## Tainted-domain unwind and cleanup

On actual copy failure, checked_brep_copy abandons unlinked/partial result allocations, marks terminal taint, restores raw context metadata, and propagates status8. The preceding review's allocation-safe status8 fallback remains present. New abandon_tainted_solids releases all session Solid unique_ptr ownership without invoking SDK destructors. It runs on taint entry, caught taint and fallback taint, preventing later session/static destruction from traversing potentially inconsistent SDK topology. CPU-only mesh/upload buffers do not own SDK solids.

The Boolean copy stage now holds a and b separately and releases both if copying either operand taints the domain, before stack unwind can invoke an SDK destructor for the earlier successful copy. Affine conversion's post-copy catch already relinquishes its result before rethrowing terminal taint. Preflight synchronized refusals occur before a partial copy exists and retain source ownership. No new output handle is published on these failure paths. Raw ABI users must discard the terminal module; runtime/native/browser retirement remains the actual reclamation boundary.

Pinned SmApiGeneral.cpp uses a raw global SmContext pointer, not a context-owning static RAII destructor; abandoning session/partial solid pointers therefore avoids the identified SDK destruction paths at normal adapter static destruction. This does not claim all arbitrary SDK failures are recoverable: the module intentionally cannot recover.

Raw tolerance fields and DEFAULT inheritance preservation are unchanged from the reviewed checked-copy repair: metadata is copied without chased defaults, source state is read only, and the exact shared context fields are restored with nonallocating assignments. No private cast or SDK edit was introduced.

## Isolated poison witness

The deliberate UV trim Copy failure moved into its own fifth CTest executable/module. Existing four test registrations remain separate from the poison witness. Its source-owned real box is explicitly relinquished after taint as well. The regular owned-boundary lane no longer executes a deliberate terminal failure before normal shutdown/other cases. New CMake wiring includes the extra native and Emscripten test executable and timeout; its execution remains unproven.

## Managed affine object lease and dispatch

The frozen source imports the parent's runtime-only independent-object lifetime dependency as an explicit separate commit. Final affine receipt now owns Arc<ManagedObjectLease>, acquired immediately after returned-handle decoding. The last owner invalidates only its exact generation and queues serial release; explicit raw release invalidates the same registered flag and stale Drop cannot release a replacement generation. The explicit consumed source raw escape disarms managed release; it does not recreate sealed receipt authority. Retained Boolean dependency results use the same managed lifetime instead of retiring sibling objects on Drop.

call() drains queued releases and then validates command object authority. CopyAffine is explicitly included in that validation, so a stale or concurrently invalidated input cannot be dispatched after cleanup. The registered liveness flag, exact worker/session/slot/generation and captured RuntimeOwner bind affine output acceptance. Queue overflow/poison or uncertain cleanup retires the captured domain rather than silently dropping cleanup authority. The existing bounded queue and bounded per-drain count prevent an unbounded synchronous drain.

The parent already owns dependency b20f191df7/0f3832cc03; integrate affine-owned commits without replaying 0b30dcd37e. In particular preserve the parent's IsEmpty command validation and empty outcome arms, absent from this standalone source branch. Their absence here is a known composition boundary, not an unnoticed final-product feature assertion.

## Retained invariants and limits

Effective SVD placement residual checking and signed-scale reflection topology repair remain intact. Source/Result/Affine inputs preserve immutable Definition/AffineCopy/Boolean lineage; explicit rigid world_from_affine becomes Placed lineage; the128-operation bound remains. Original caller matrices and raw authored requests stay in sealed ancestry. No source mesh replacement, silent exact-kernel substitution or second loader is introduced.

Offsets, nonmaterialized rational data, unsafe close knots, unsupported geometry ownership/classes and numerical envelope exclusions remain explicit gaps for the full preservation objective. Box/cylinder and chain witnesses cannot establish support for all mapped authored geometry. Target qualification, class expansion, parent composition, complete empty semantics, common product transactions and final validation remain necessary. Historical 4/4+21 evidence is not evidence for this frozen extension.

No source edits, builds, tests, fleet submissions or PR comments were made by this reviewer. Only this report and its hash manifest were written under /tmp.
