# Unary unknown-status closure source review

Frozen repair `f95d10b96b9e5096bd232dda205ae2eac2c69eb7` against `a1bc0a61c783215624d09f090b4198958ae5fe5a`; delivery `77d7ef591b41aef59d7c8c53c87f6c1fcae5f7b8`. Read-only Git-object inspection. No source edits, builds, tests, executable probes or jobs.

## Production finding closed in source

The unknown post-clip status finding in `/tmp/ifclite-unary-a1bc-native-review.md` is closed by `worker.rs296–308`. The shared call boundary now retires IO/protocol errors and every Kernel status outside the synchronized1..7 range. This includes8,9 and negative/other unknown statuses, covering capability, opcode19 semantic query, opcode9 tessellation, opcode10 mesh metadata and opcode11 streams. The exact original `result` is returned after retirement; termination errors are logged by retire rather than replacing the primary Kernel error. Known1..7 classification is unchanged.

The existing tessellation cleanup code preserves a read error when mesh release also fails. After unknown status retires the domain, release checks/flush refuse without dispatch, and the managed unpublished clip lease cannot revive that domain. Unchanged source selection/lease cleanup remains independent of the error policy. No additional production blocker was identified in this repair.

## New witness semantics

The fault peer activates status9 only after seeing opcode20 and only at the selected later opcode9,19 or11. It preserves original response version/request identity, so the expected error reaches the Kernel status branch instead of merely failing protocol parsing. The new Rust test independently checks exact primary status/message, captured owner retirement, source invalidation, continued foreign-owner liveness, observation of the later opcode after20, and that the failed opcode is the final submitted command. Its explicit subsequent flush must fail. This distinguishes the old live-domain behavior from the repaired shared boundary.

The synchronized post-publication status7 fixture remains: it requires source liveness and actual queued release commands for source display mesh2 and unpublished clip3, without releasing source1. These are rejection/cleanup fixtures only; they do not qualify SDK geometry. Opcode10 shares the repaired predicate but has no dedicated new fault case. All actual execution remains unqualified by this source review.

## P2 test isolation blocker inherited from a1bc

`tests/plane_faults.rs13–14` uses only process PID plus case string as the temporary directory, followed by create_dir().unwrap(). Two tests in this same binary select case `status7`: `native_plane_fault_packets_retire_only_captured_owner` at42 and `native_plane_synchronized_refusal_and_taint_have_distinct_lifetimes` at51–52. With the ordinary parallel Rust harness these fixtures can overlap under the same PID, causing AlreadyExists and aborting one test before exercising the intended invariant. One fixture's Drop can also race another fixture's files if isolation is weakened to create_dir_all. This defect predates f95; it was found while reviewing the witness repair, not introduced by the shared call predicate.

Minimal repair: give each Fixture::new invocation a process-wide monotonically unique suffix (e.g. AtomicU64 fetch_add), retaining the descriptive case, PID, exclusive create_dir and existing per-instance cleanup. Do not serialize the entire test binary or reuse a shared directory. This is a test setup blocker, not a reason to reopen the production unknown-status finding.

## Composition and hashes

The repair changes only worker.rs, the Python fault peer and its Rust tests, apart from delivery evidence. worker_dependencies.rs is byte-identical to a1bc; the parent's separate6fb Boolean/temporary cleanup hunk must survive incremental assembly and is not supplied by this child full file. worker_mesh.rs, worker_clip.rs and worker_objects.rs are unchanged as well.

Exact seven-file Git/SHA256 pins: `/tmp/ifclite-unary-f95-native-closure-review-hashes.json`. Native SDK/browser numerical qualification, Rust compilation and actual fault-fixture execution remain parent-owned and unproven here.
