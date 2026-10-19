<!-- SPDX-License-Identifier: MPL-2.0 -->
# Simulated boundary-error prerequisite — frozen additive checkpoint

Base: 42c4a874d5e8ab0bfc7dbb97853245d8cb221e4c. Source: f1689d65064ce333e4277bc6a6adc866221644b2. All compilation, tests, jobs and performance UNRUN.
No parent checkout/index, active jobs or immutable receipts were modified.

Approved contract implemented: per-instance fixed atomics live inline in the
same funded GateInner. Only explicit gate-test-support compiles the injector.
Allocator clones share the gate; runner instances share no injection state.
The resource context/account/observer pairing and actual work gate are unchanged.
The private injector grants no source authority and stores no account projection.
After debit, it skips Global once, feeds AllocError into the existing result match
and failed_global, and preserves cumulative work/copy and peak history. No new
block ever exists on an injected attempt; no candidate deallocation is claimed.
Unarmed Global calls, pointer/Layout delegation, error handling and real old-block
cleanup remain the common existing paths. Zeroed/shrink simulated entrypoints are
residual coverage, not covered by a generic Global failure claim.

Four added actual-account fixed cases and the independent real-storage unit case
are mapped in qualification.json, all UNRUN. Combined actual-account witnesses
use the original paired private Inner and captured funded OwnedState in normal
core's type universe; fixture Budget is confined to independent storage ordering.
Weak-only pool retention and ambient-account invariants remain asserted in every
combined case. All four new cases test refused fresh-epoch reentry; the arm remains
unconsumed after pre-operation source refusal. Source F after debit takes reporting
precedence over the later simulated allocation stop.

The two parent-approved cfg(test) same_storage_domain methods compare exactly
std::ptr::eq(&*self.0, &*other.0) in Gate, forwarded by ResourceAllocator. They do
not check/stop/admit/refund or confer live work. Unit coverage distinguishes shared
clones from separate gates of the same source/account after work/source teardown.
Historical standard-owner contract exists at .source-cache-owner-r3/CONTRACT.md,
SHA256 34ee5695c015c302ae250f13a6fcabb0b67ecd87021bf863de0f38768d75e25c;
R4 corrections and the currently approved owner plan/Unit2 contract govern scope.

Canonical 85a44 correction is exactly five sequential drops, byte-identical to
the parent file. incremental-42c4.patch includes it; use the additive patch WITHOUT
that correction on parent 85a44. Patch application was checked using a disposable
index at 85a44f0ca78b5e5cffecbe4d80437e9fc17a7b35, preserving all foreign parent changes and the be54 gate quota hunk.
This metadata check neither overlays root files nor compiles assembled source.
No execution_owner/live-cache authority hunks or owner modules are included.
Do not replace the whole gate file during integration.

Frozen 42c4/a293/R2/R3/R4/P2 evidence remains unchanged. This checkpoint makes no
production activation, default output, performance, OOM or whole migration claim.
