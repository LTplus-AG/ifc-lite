# Sealed unary plane runtime checkpoint

Exact base: `c05004953082dad0fc3213940d44f9a4456d3f6c`.
Authority: `native/smlib-adapter/PLANE_CONTRACT.md`,
`include/ifclite_smlib.h`, and `src/protocol.cpp` under that adapter.
Native C++ and geometry/common/processing are outside this increment.

`SmlibWorker::clip_retained_plane` and the async browser equivalent take existing
sealed dependency selection, six original local-metre plane coefficients,
`PlaneSide`, `PlaneClipMode`, and existing tessellation transfer limits. The
selected proper-rigid evaluation-to-world frame remains outside the SDK and is
copied unchanged into the receipt. Source frame composition and PlacedResult
replacement semantics reuse existing dependency selection. Source/Result/Affine
and Clip can feed clipping; Clip can feed both dependency Boolean and affine
copy. History increments once and refuses beyond 128 operations. These values
carry operation-derived lineage only; they cannot mint an authored completion.

Request opcode20 is 92 bytes including the header. Success response is
324 + 136*cylinder_count bytes including the header (payload 312 + 136*count,
maximum 2488). The decoder accepts at most 16 cylinder records, rejects trailing
bytes, and validates original plane bits (including signed zero), side/mode,
input/output session/slot/generation, output independence, version and unchanged
frame marker, numerical basis residual, finite domain/cutter/clearance, counts,
proof mask/record consistency and cylinder conversion flags/finite coefficients.
These are structural checks on actual adapter evidence, not an independent
proof of SDK numerical correctness or preserved whole-product geometry.

Native publication owns an Arc ManagedObjectLease. Command object validation is
before and after draining cleanup; ordinary synchronized refusals preserve
inputs, status8/unknown status/transport/invalid certificate retires the captured process.
The output certificate's Empty classification must agree with existing opcode19
semantic emptiness and strict tessellation metadata. Zero triangles alone never
certify Empty. A post-publication native mesh-transfer refusal drops the output
lease for serial cleanup, without manufacturing a result.

Browser authority remains the private driver with its captured actual Worker,
private token map and exact incarnation. It queries capability64 plus version,
parses the actual response, freezes private JS result/certificate/input/mesh,
including pending-release generation alias rejection; Rust independently checks the bytes and seals owned immutable vectors and
lineage. No transport, response, positive certificate or qualification flag is an
input. Drop of an in-flight Rust future retires the owner; Drop of an accepted
Clip releases only that token. Post-publication browser errors retire rather
than silently discard uncertain allocations. Capability64 opens this explicit
candidate numerical seam, never qualification of a common source or final
product. Opcode21/capability128 and layer/opening controls are unchanged.

Validation: the small Node driver protocol/lifetime fixtures pass (17 tests).
They use fault peers and are NOT SDK or browser numerical evidence. New native
SDK candidates are gated by IFCLITE_SMLIB_WORKER. Browser candidates are compiled
only under wasm32 tests and require existing canonical staged /smlib assets.
Both actual sets and the new Rust fault fixtures are UNCOMPILED/UNEXECUTED here. Rustfmt parse-only with edition2021
passes; an initial invocation without edition rejected async syntax as Rust2015
and was corrected. No build, Cargo test/Clippy, WASM generation, actual SDK
runtime, actual browser, performance job, push or PR has been performed.

Both Pop and PC refuse admission (guard78); Mac is disabled. Preserve original
workspace61f8 and all foreign jobs. Parent-reported workspace61f8 execution failed
with four processing test compilation errors and two runtime Clippy findings;
it does not validate this increment. The parent's worker_dependencies Boolean
cleanup repair (execute Boolean and cleanup, then boolean?; cleanup?;) is outside
this patch and must survive assembly. Sourceoffpath stays unqualified until an
actual integrated root qualification, including known affine trim-loss/domain
refusals and adapter numerical qualification gaps, has been reconciled.
