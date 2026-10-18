# Retained evaluator native runtime review

Read-only inspection of clean child `80f0a6a5e55024cad3311b6a6bada9098d6f43b0` at `/home/louistrue/.t3/worktrees/ifc-lite/t3-530d53b8`. Every delivered source-file hash matches the manifest. Existing root controller was also inspected; exact hashes are in `/tmp/ifclite-retained-runtime-review-hashes.json`. No edits, builds, runtime tests, new agents, fleet jobs or network access. The five reported browser protocol-only tests do not qualify SDK geometry or this Rust runtime path.

## 1. Undelivered newly-created handles have two leak windows

`supervision/controller.rs::perform` puts the worker back in available after its final interruption check. `respond` drops admission and ignores `response.send(result)`. Solid and Retained results own only Copy BrepHandle identity; dropping a result does not release its worker object.

Two distinct cases matter:

1. Receiver disappears after final interruption check but before send. SendError returns the still-owned result; ignoring it strands the new solid in the cached session.
2. Send succeeds while the receiver exists, then PendingCommand is dropped before wait consumes the queued response. The channel drops WorkerResult containing the new handle, leaving the session object. A fix that only handles SendError misses this second case.

Cancellation can likewise race between final check and response claim. The current wait blindly receives a success, and its eventual Drop sets cancelled even after successful consumption. There is no explicit claim state or publication linearization beyond send.

### Concrete coherent fix

Use an internal response envelope, not a public arbitrary callback or changed geometry payload. For successful resource-creating results (CreateBox, CreateCylinder, Boolean, RetainedExtrusion), attach a unique armed undelivered-resource guard. It holds only the actual ProcessControl/shared worker-lifecycle authority. PendingCommand::wait disarms it only when it claims the result. A failed send drops the envelope; dropping an unread queued response also drops it. Both retire and reap the actual owned process, invalidating that incarnation and all its handles. Killing by numeric PID is not acceptable. Releasing through a new unbounded SDK callback in Drop is also unsuitable; retirement reuses the existing process interruption mechanism.

Use a shared atomic claim/cancel state if cancellation must win when it precedes consumption: Pending -> Claimed versus Pending -> Cancelled/Abandoned defines the linearization. Wait returns Cancelled/Deadline only after undelivered cleanup completes. Pending's destructor must not mark a successfully claimed result abandoned. Keep queue admission release before waking a legitimate consumer so immediate resubmission still works; controller serial execution prevents the next queued operation from overtaking controller cleanup.

The process authority must outlive the envelope even after supervisor retirement; ProcessControl already owns Arc<Mutex<Child>>, preventing PID reuse races. An old envelope must retire only its own process if a replacement session is already running. Shared per-process lifecycle state must be invalidated by guard retirement; the cached SmlibWorker cannot remain apparently healthy. Do not clear a new process's diagnostic PID using an old numeric PID comparison as generation authority.

After a result is actually claimed, the current explicit caller-owned/release contract can remain unchanged. This fix addresses undelivered results, not automatic release of every publicly delivered Copy handle.

## 2. A worker retired during cleanup can still be cached

The controller only removes a worker for returned Io or Protocol errors. `worker_sweep.rs::evaluate_retained_extrusion` can fail tessellation with ResourceLimit, fail to release the unpublished solid, call retire(), and then return the original ResourceLimit. Controller consequently caches a dead/poisoned worker with its old diagnostic PID. The next CreateBox then fails with worker-requires-restart instead of immediately using a fresh session; an Incarnation command can even return successful zero because initialize skips work when session is already nonzero.

Check actual lifecycle before caching and before reuse, independently of the returned error class. Keep the original useful execution error, but never cache a client already retired by cleanup. The next legitimate request should lazily spawn a new incarnation without requiring an extra failing request. The same shared lifecycle observation is needed for response-envelope retirement in finding1.

## 3. Tessellation can hide mesh-release failure and strand a mesh handle

In `worker_mesh.rs::tessellate`, `(Err(error), _)` returns the original read_mesh error and ignores release(mesh)'s failure. A concrete protocol sequence is successful Tessellate, oversized MeshInfo causing ResourceLimit, then mesh Release returning a Kernel error. The worker remains healthy because a domain Kernel error does not poison call(). The retained wrapper subsequently releases its solid successfully and returns the original ResourceLimit; the unpublished mesh handle remains in the reusable session.

On any mesh-release failure retire the process, even when preserving an earlier read error as the public result. On read success plus cleanup failure, return cleanup error and retire. This helper predates the new retained path but is now part of its claimed transaction. Fixing only the retained solid-release branch does not cover the intermediate mesh. Fault injection is appropriate for cleanup ownership; geometry assertions still need the actual SDK.

## 4. Incarnation is not yet a live owner binding

Native incarnation() checks only the client's healthy flag. Spontaneous process exit while idle leaves a nonzero identity until later IO discovers it. The controller's process_id atomic is diagnostic metadata, not health authority. GeometryDocument validates a caller-supplied live numeric incarnation; it cannot itself observe worker death or prevent a caller supplying the old number.

Add a shared per-process owner/lifecycle capability or a nonblocking actual Child::try_wait-backed health query, used by client incarnation and supervisor reuse/delivery. try_wait must reap observed spontaneous exits. A dead owner must invalidate its handles immediately when observed; replacement identities remain unique checked host IDs. Check at command admission and before publishing retained results; detached completion acceptance must bind the actual owner capability, not merely an unchecked caller number. No query can guarantee a process remains alive forever after a check, so numerical operations must continue validating at their actual owner boundary.

Adjacent browser gap: SmlibWorkerTransport.#poison clears its worker but leaves #incarnation unchanged. batch correctly rejects an unavailable worker, yet the getter still advertises the old identity. Expose absence/retired state or invalidate the token on poison so display/result acceptance cannot mistake that token for observed liveness. Full browser host binding remains explicitly unqualified.

## Staged source transaction inspection

C ABI Session owns at most one unique Upload. Begin validates bounded lengths/segment counts before publishing ownership; allocation failure destroys the unpublished upload. Chunk validates offset/remaining size and resets the active transaction for malformed valid-token chunks. A native chunk failure attempts Abort and retires on uncertain cleanup. Browser chunk cleanup does the same, disposing if abort fails.

A valid-token Commit moves upload out of Session before completeness checks, recipe validation, SDK sweep construction and handle store. Those later failures therefore consume and destroy upload state; the constructed solid is unique_ptr-owned until successful store. Abort destroys the unique upload. Wrong-token commands refuse without destroying another legitimate transaction. The transaction arithmetic is bounded (one loop, <=8192 segments, <=1MiB declaration, <=3840-byte chunks). These source mechanisms appear coherent; they remain uncompiled/unrun. They do not impose process/kernel RAM limits.

Deadline/cancellation during staged upload or tessellation is already interruptible by the supervisor's independent actual Child control; process retirement releases the full session. The existing controller joins transport and reaps before reporting timeout/cancellation in its normal paths. The missing boundary is ownership after command completion but before result claim, plus cleanup-retired cache reuse. No exact/default routing or geometry loader change is needed to fix these.

## Meaningful regression plan

1. Actual SDK delivery tests in controller-private tests: perform a real box/retained creation, deterministically drop its receiver before response delivery, then assert owned PID gone/reaped and immediate next real box volume8 succeeds with a different incarnation. A second test sends successfully into a live unread receiver and drops it afterward; this catches the second window. Controller-private orchestration can control perform/respond boundaries without sleep polling or a mock geometry return. Repeat with actual retained rectangle volume24 once that SDK path qualifies.
2. A claim/cancel boundary test pauses after actual creation, cancels before result claim, then requires terminal cancellation plus process reaping. A normal claimed result must keep its process alive, accept real volume/manifold queries and release explicitly. Dropping an old unclaimed envelope after a fresh session starts must not kill the new process.
3. Immutable executable protocol fault peer for MeshInfo-over-limit plus failed mesh Release. Assert retirement/reap and next-session success; do not assert its invented mesh or solid data as geometry evidence. Also test successful read followed by failed Release.
4. Actual retained construction with MeshLimits0 should release its solid and leave the session usable when all cleanup succeeds. A cleanup-failure peer should force retirement while preserving the original resource error. The next command must succeed directly, not first fail on the dead client.
5. Controlled actual worker terminate and spontaneous-exit peer: old incarnation becomes absent/zero when observed, old handles reject, actual process is reaped, stale RetainedCompletion refuses document publication without changing document state. A restarted worker must require a new request bound to its new incarnation; never silently replay.
6. Add an actual Rust integration test from genuine authored IFC rectangle plan -> document RetainedRequest -> SmlibWorker/SupervisedWorker retained command -> independent volume/manifold/bounds and display-consumer result, explicit release. Existing new Rust coverage is protocol encoding; the SDK sweep assertions currently live in C++ and browser contract sources. Circle remains gated until its separate actual witness succeeds. Run preserved consumer and exact/default tests on the assembled source afterward.

Existing supervision fault-peer tests provide process-stage markers, immutable symlinked scripts, Linux /proc absence including zombies, and actual next-session SDK volume checks. Reuse those synchronization/ownership patterns. Do not revive dynamically written executable fixtures, elapsed-time-only race probes, proxy processes whose SDK descendants escape the owned Child, or mock geometry assertions.

## Qualification and remaining scope

The SDK is locally present with pinned source/license evidence; this review does not reinterpret absence of validation as missing SDK. The new C++ producer/volume/manifold checks and C++/browser sweep test sources are substantive, but no current native C++/Rust/WASM actual execution qualifies the delivered evaluator. Protocol-only success is not geometry evidence. No full authored family/Boolean/opening/appearance/UV/analytic-normal/persistent-face, retained USD, hard memory bound, end-to-end performance or production activation claim follows. Exact remains default/permanent and public USD/IFCX mesh consumers are not replaced.
