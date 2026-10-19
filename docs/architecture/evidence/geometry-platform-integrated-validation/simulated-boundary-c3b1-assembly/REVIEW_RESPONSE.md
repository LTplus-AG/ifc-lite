<!-- SPDX-License-Identifier: MPL-2.0 -->
# f168 independent-review P2 witness corrections

Base f1689d65064ce333e4277bc6a6adc866221644b2; corrective source c3b1ae95fbf8939258e1038ee8a94d5f3739ba28. Five files, 66 insertions/23 deletions.
Frozen f168 and all prior artifacts remain unchanged. All compilation, behavioral
execution, Clippy, wasm, packaging, feature matrix and performance remain UNRUN.
No job/build/test was submitted; no root source or foreign task was modified.

## P2-1: independently assert the actual account's complete stop

Geometry Instrumentation captures actual account.check().err() at TerminalObserved
into scalar Captured.account_stop. That scalar survives after all original account,
context and observer clones are destroyed, without retaining authority/account
backing. For ordinary SimulatedFresh/Grow, run_case compares this independent
observation to the COMPLETE report.operation_stop. A healthy account produces None
and fails equality against the required Allocation stop; a mismatched dimension,
requested/remaining bytes or reason also fails. RefusedGrowth uses the same complete
comparison instead of its previous self-comparison. Source-F cases retain their
explicit expected-F assertions, and existing independent cancellation/first-fault
cases retain their specific irreversible outcomes. No universal rewrite is claimed.

## P2-2: exact peak from the actual requested Layout

The existing per-instance test-only injector records Layout::size() from allocate's
actual layout or resize's actual new Layout, after debit and before skipping Global.
It stores only a fixed AtomicUsize inline in the already funded GateInner. The
plain report carries requested_layout_bytes; no authority, account choice, registry,
permit or new callback is added. Unarmed calls do not record a simulated request.

Geometry retains scalar BeforeGrow/AfterGrow snapshots and checks:
  peak_after == max(peak_before, live_before + requested_layout_bytes)
for all three consumed-injection cases, using checked conversion/addition. No
capacity/request rounding guess or >=2048 threshold is used for these cases.
Pre-stopped work requires requested_layout_bytes == 0 and completely unchanged
Usage. Existing old pointer/value/capacity, metadata/category/live, work/copy,
source/observer/reentry, ambient, Weak and final-pool checks remain. Successful
uninjected growth keeps its separate existing overlap assertions.

The simulated boundary still makes NO Global call and allocates NO new candidate.
There is no candidate-free, successful/failed Global-call or process-OOM claim.
The existing failed_global and Global delegation statements are unchanged; only
fixture scalar instrumentation arguments are added to the allocator callsites.
The old real-block free-before-refund unit witness, cfg(test) storage-domain
methods, sequential teardown and published live-cache authority are untouched.

## Integration and qualification

incremental-f168.patch applies cleanly to parent 06209aac5de57c68704084c4bbd3c42d6c59e43f in a disposable index, and
changes only the five manifest paths. All other parent source/hunks are preserved.
No root overlay or execution occurred. source-manifest.json has exact before/after
SHA256 and Git blobs; SHA256SUMS freezes this response, patch and qualification.
Parent owns independent review and admitted source-qualified validation.
