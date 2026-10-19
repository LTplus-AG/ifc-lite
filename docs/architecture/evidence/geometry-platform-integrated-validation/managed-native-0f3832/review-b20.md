# Managed native object lifetime review

Reviewed immutable b20f191df7cfdecf783da506fd6b43c88b70d292 vs ecdfb58675, nine delta files, plus worker mesh transfer/runtime owner/process control. Worktree located at /home/louistrue/.t3/worktrees/ifc-lite/t3-8b51732f; inspection used git show of the pinned commit. No edits, builds, fixture tests, SDK execution or job submissions. Runtime assertions remain unqualified.

## Concrete authority blocker

`worker_objects.rs::release`, lines 148 onward: every `check(solid)` error triggers `flush_releases` before the original error is returned. This includes a handle belonging to another worker/session, not just a locally queued final-drop handle. Consequently a rejected foreign release can send cleanup commands into the receiver's independent worker. If its pending release fails, the receiver retires and the foreign-argument error is replaced by that cleanup error. Other public handle APIs first run `wire`/object_liveness and reject a foreign handle before `call` drains cleanup.

Minimal correction: reject mismatched worker/session before any drain; restrict the special stale-managed drain to a local handle still present in `objects` with invalidated liveness (the queued final-drop case). This preserves the existing explicit-release-of-queued-object cleanup-failure test. Avoid treating arbitrary removed/stale generations as authority to drain current resources.

Meaningful bounded protocol witness using the existing immutable object-release-peer: worker A owns a managed object dropped into its pending queue; separate worker B provides a foreign solid. `A.release(B_solid)` must return WrongWorker without consuming A's queue or retiring either worker. An explicit later A.flush_releases must expose the peer's real release failure and retire A only. This proves transport/lifetime behavior, not numerical SDK correctness.

## Preserved mechanisms in this checkpoint

- One private Arc lease is shared by managed registry Weak upgrades; final strong Drop invalidates the exact AtomicBool before enqueue. Full WireHandle keys retain session/object generation. Explicit release removes the registry record and invalidates the flag; stale lease Drop cannot enqueue the reused generation.
- No queue mutex is held over SDK IO or owner retirement. Poison and allocation/4096-bound enqueue failure retire captured Child authority; no numeric PID/replacement lookup. Drains bound each call by their initial queue length; concurrent later drops remain for a subsequent call.
- Command handles are revalidated after draining, preventing a queued-drop object from being used by a later command. Release uses exchange directly so drain does not recursively call itself.
- Consuming host-trusted escape disarms the lease; the returned raw handle requires explicit release, preserving the documented ownership transfer. Ordinary result/receipt final Drop releases its object instead of retiring all sibling objects. RuntimeOwner cancellation and actual worker Drop still retire the captured process.
- Tessellation and Boolean evaluation preserve the primary numerical/transfer failure when cleanup also fails, while retiring the domain. Post-create manage failures are possible only after liveness loss in these sequential methods; any created temporary lease then performs cleanup/retirement. Status8 remains a retiring call error.

## Integration requirements and qualification limits

This child predates parent's newer getters/outcome/mapped construction changes. Compose those fields and methods, do not replace the parent's whole native outcome type. Affine CopyTransform validation from the independent affine candidate is absent here and must be added to check_command_objects when that command variant is integrated. The historical process-cancellation domain policy is intentionally unchanged.

The added actual-SDK tests cover independent chained-result/source lifetimes, raw escape, stale explicit release and replacement survival but have not run. The queue fault-peer tests witness lifetime/cleanup only. No numerical, heap/RSS, deadline or broader platform-completion claim follows from this source review.
