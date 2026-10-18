# Retained evaluator: SDK and browser static review

Snapshot: child `80f0a6a5e55024cad3311b6a6bada9098d6f43b0` on `fb913d3a5cd3801bafad14ff29c4066074182c86`; actual SDK checkout `/tmp/ifclite-smlib-eval-upstream` at `c9c5979f04cea8c38213004d4f04df0dcfb40d05`. Every delivered changed-file hash and listed SDK-input hash matches the actual file. This is read-only static review: no build, syntax check, SDK run, browser run, test or heavy submission was performed. The delivery reports five protocol fault tests, not SDK geometry qualification.

## Concrete browser defects

### 1. Commit rejection before transfer strands a live upload

`native/smlib-adapter/browser/sweep.mjs` wraps only the chunk loop in cleanup. `await call(15, finish)` is outside that try/catch. Actual `SmlibWorkerTransport.batch` rejects pending-capacity overload before transferring the frame and leaves the worker alive. If other requests fill the pending capacity just before this commit submission, no C++ commit occurs, so its consume-on-commit rule cannot help. uploadSweep rejects and loses the token while the session still owns an active upload; later begin calls fail with upload-already-active.

Cover commit transport failure in the ownership cleanup domain without retrying commit. For a known unsubmitted request, abort the retained token if feasible; for uncertain delivery, retire the captured worker incarnation so an undisclosed successful solid cannot leak. Distinguish reported domain commit failure (transaction consumed) from transport rejection before submission. Add a fault test rejecting commit before dispatch and proving no active transaction remains.

### 2. Old upload cleanup can destroy a newly restarted worker

The same helper calls `transport.dispose()` unconditionally from malformed-response handling and from failed abort cleanup. If `restart()` occurs while a chunk is pending, the old pending promise rejects, abort with the old incarnation rejects, then its catch disposes the new worker. Similarly, final stale-handle detection calls malformed and disposes whichever incarnation is current.

Retire only the operation's captured incarnation. A stale old operation must reject without touching a replacement incarnation. An incarnation-scoped retire API is stronger than an unqualified dispose; a current-token check before synchronous dispose can also avoid this concrete race. Add restart-during-upload coverage that runs real work successfully on the replacement after the old upload rejects. The five current protocol tests do not exercise either defect.

## SDK calls and ownership verified against actual headers/source

- `SmApiCreateLineSegment` takes two SmPoint3d arguments and `SmLine*&`, returning an analytic SmLine. Both `SmApiCreateCircle(center,radius,SmBSplineCurve*&)` and `SmApiCreateLinearSweep(const SmTArray<SmCurve*>&, vector, distance, capFlag, SmBrep*&)` exist in the pinned SDK with the signatures used. No imagined producer API was found.
- The public linear-sweep wrapper explicitly copies caller curves because the inner kernel consumes them. `SmTArray` is non-owning with respect to its pointer members, and Add returns the inserted index or an allocation sentinel. Adapter unique_ptr<SmCurve> ownership, Add-index validation and final unique_ptr<SmBrep> cleanup fit those contracts; curves survive through the sweep and are destroyed once after the non-owning array goes away. SmCurve has a virtual destructor. Failure status checks occur after acquiring raw outputs into RAII.
- The producer passes TRUE for caps and requires nonempty faces, actual SmApiBrepIsManifoldSolid success and positive finite integrated volume within relative1e-5 of its independent area-times-projected-depth formula. For a unit sweep vector, that formula is area*depth*abs(dz), including oblique sweeps. It does not prove bounds, section shape, analytic surface kinds or source face correspondence. No current native/WASM geometry run qualified these checks.
- Current consumed source admission is rectangle-only. Low-level full-circle construction exists but is unqualified. It validates normal/x-axis/start/sweep fields yet calls the canonical center/radius circle API, ignoring retained circle parameter frame and start angle. The complete untrimmed circle's point set is unchanged under those restricted XY frames, but the comment claiming retained authored frame/trim must not be promoted into parameterization/provenance qualification. Partial/mixed circles and source circle admission should remain refused.
- SDK internals, including allocation failure while copying/consuming curves, were not proved exception-safe or heap-bounded by this adapter review. Adapter RAII is not evidence of a bounded SDK process heap.

## C ABI and framing findings

The extension is additive to unchanged ABI/protocol version1: capability query12 and begin/chunk/commit/abort13..16 leave old opcode layouts intact. Native and browser use the same C++ dispatch/parser. JS uploads numerical coefficients only; no extra IFC decoder or geometry implementation was introduced.

Declaration arithmetic is bounded before evaluation: loops must equal1 and segment count is1..8192 before `48+8*loops+104*segments`; maximum accepted length fits both u32 and1MiB. Reader bounds, sequential chunk offsets, remaining-byte subtraction and <=3840-byte chunks prevent the reviewed integer overflow/range holes. The adapter reserves declared input, owns one upload/session, discards invalid chunks of the matching transaction, consumes matching commits before completion/kernel validation, and session destruction owns incomplete upload cleanup. Counter exhaustion guards avoid ID wrap. The raw-pointer C ABI still requires valid caller memory as documented.

A minor contract mismatch remains: `sweep_commit` calls output(out) before moving the upload. A null output pointer therefore returns failure without consuming the active matching transaction, despite the blanket every-commit-consumes wording. Either narrow that statement to matched, valid-output commits or define/reorder null-output cleanup. Protocol callers always supply a valid local output, so this does not cause the browser defect above.

No definite new C++ signature/include/linkage compile error was identified statically. This is not a compiler result. CMake wires sweep.cpp and native/browser witnesses, but those targets have not been built or run for this delivery.

## Browser/module qualification and ownership limits

The helper copies recipe coefficients before its first await, uses BigInt for uint64 identities, enforces bounded counts/size, validates version/request ID and response shape, and tags accepted handles with its explicit worker incarnation. Existing worker batching serializes all commands per module; copied output allocations are freed by dispatchOwned finally. Actual client pending/timeouts/poison/restart rules remain the foundation for the extension.

The nominal sweep contract frees handles/session on success only. Assertion or transport failure can leave them alive until the outer actual browser runner disposes all workers; the Node bare-module contract has no such retirement wrapper and supplies neither a real incarnation nor dispose method to uploadSweep. Tighten that test transport and finally-cleanup before using it as ownership/error evidence. This is separate from the already disclosed absence of current SDK/WASM geometry qualification.

Document/native-controller identity and undelivered-result races are assigned to the other reviewers. This review does not qualify caller-supplied liveness, packet authenticity, retained appearance/face provenance, browser app integration or SDK resources. The default exact production path remains outside this opt-in slice; no fallback or cutover claim follows.
