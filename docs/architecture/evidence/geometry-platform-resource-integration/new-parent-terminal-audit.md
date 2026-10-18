# Read-only audit of newer parent fb913d3a5c

The delivery remains based on e26527d79c. The newer parent was inspected via
`git show` only; it was not checked out, rebased, copied, or edited. Its files and
hashes are in new-parent-readonly-hashes.json. No compiled claim is made.

There are no directly overlapping changed paths between this resource delivery
and e265..fb913, but there is a semantic terminal-admission integration boundary.
Do not restore the deleted processors/boolean continuation files when applying
this patch. Keep the new BooleanProgram, graph `&recorder.effects` caller, and
`Execute::execute(&NumericalEffects)` with the actual PendingEffects unwind sink.

Terminal-sensitive catches in the new parent:

- batch.rs::prepare_group: failed plane parsing, `_` in lower_bounded_prism, and
  `_` in built-prism handling rewind and return a recoverable fallback. A typed
  ProgramStopped error must bypass that rewind/fallback. Check the sticky source
  terminal before a retry and before each further source/numerical operation.
- step.rs::begin_boolean_step: `if let Ok(plan)` and `if let Ok(cutter)` lead to
  plane fallback on any other result. Preserve source-fault fallback but return
  ProgramStopped for a typed terminal and check sticky resource state before
  prism/single/plane work. Option-returning source adapters also need a sticky
  check after None so a recorded stop cannot masquerade as a source miss.
- operand.rs::without_voids: `_` in shell-result handling converts failure to a
  recoverable void-source refusal. Its infallible Value ABI needs a checked
  internal Result or an explicit terminal-safe adapter; do not silently return
  partial outer geometry as a successful accounted product. `evaluate` must
  propagate the typed terminal. Admit no next shell or subtraction after a stop.
- mod.rs::drive has no resource admission check at its loop boundary. Add a
  reached terminal barrier when porting resources into the new Boolean driver,
  including before final success. Keep the active-path cleanup in run on Result
  failure and the RestoringProgram unwind semantics.
- work.rs::Execute outputs differ (Result, pair with Result, bare enum/value).
  Do not add a blanket conversion that erases the actual unwind sink or turns
  source faults into terminals. Resource checks belong at reached admission and
  result classification boundaries; no numerical/kernel/diagnostic TLS transport
  should be added to SourceResourceContext.

These catches are audited integration hazards, not executed reproductions of a
new reachable bounded allocator failure. Boolean numerical/profile coverage is
still explicitly opaque in this resource delivery. The accounted outer adapter
will reject a sticky terminal at return, but that alone does not prevent extra
internal fallback work. Parent integration must reconcile these sites before
claiming terminal-safe Boolean internals. Preserve prior source reports,
independent completed caches, and the numerical-only unwind-forwarding guard.
