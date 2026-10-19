<!-- SPDX-License-Identifier: MPL-2.0 -->
# Normal-core actual-account gate test support

This checkpoint implements the reviewed fixed-fixture test seam after frozen
a29301deb12411fa7753c2569df090caa0db8c74. All compilation, tests, Clippy, wasm,
package/feature validation and performance qualification for this change are
UNRUN. Parent owns admission and source assembly. No parser/cache/ProductOwner,
region, native/runtime, numerical policy or public tracked decoder activation is
introduced. Frozen R2/R3/R4/P2/8af/a293 artifacts remain unchanged.

## Feature boundary and shared implementation

The explicit core and geometry `source-resource-gate-test-support` features require
`source-resource-tracking`. Core retains geometry only as its existing versioned
dev-dependency. The reciprocal feature edges are test wiring, not a normal core
geometry dependency. Their package/unified-feature behavior still needs compilation.

The SAME private gate, authority, allocator and container modules compile under
`all(source-resource-tracking, any(test, source-resource-gate-test-support))`.
Default and ordinary tracking NORMAL library builds compile neither private gate
nor runner. Ordinary opted-in unit tests retain the prior private implementation.
The explicit feature also enables the normal library's pinned nightly Vec/reserve
APIs. There is no copied gate or account proxy across crate type identities.

Historical Budget/Resources, four-gate fixture quota, fixture constructors and
control-size reporting are split behind cfg(test). The sixteen-frame/ancestor
feasibility bounds exist only inside unit/test-support code. None is production
account workload authority, and none affects default acceptance. No dead-code or
guard allowances are added.

The public test-only module exports one runner, a fixed-case enum, scalar stage
enum and plain Copy report. It exposes no decoder, gate, allocator, work callback,
cache, source receipt or retained execution capability. This is additive Rust test
surface behind an explicit feature, not a shipping loader or owner migration API.

## Callback and source contract

`run_gate_witness` takes one original paired SourceResourceContext, a fixed case,
a once-only observer factory and a stage callback. The context is never replaced.
It creates one fixed small SourceBundle fixture, selects its actual decoder and
lease/work, publishes that context, verifies healthy source/account channels and
invokes the factory exactly once. Geometry constructs a funded actual
OwnedResourceContext using the supplied actual SourceStopHandle and returns its
observer projection. The SAME decoder/work then enters the existing private gate.
The gate revalidates the paired account, current source, owner and generation.

Stage callbacks receive only identifiers and run outside channel/binding locks.
They are TRUSTED test instrumentation. Arbitrary Rust closures are not mechanically
bounded: they must not recurse into the runner, select accounts, replace resource
projections or perform decoder work. Only the prescribed post-capture stage may
inject the case's account/observer fault. No production operation callback is
accepted. The source-stop factory argument is a resource channel, not a decoder
capability. A malicious callback can violate this testing contract; this interface
is not a security boundary for arbitrary extension code.

Geometry's witness implementation owns the real private-Inner account and pool,
plus a separate generous ambient account that must remain unused. Core unit tests
call only these geometry witnesses, returning unit/scalar outcomes across the
test-crate boundary. All typed context/observer/gate operations occur in the SAME
normal core library used by geometry. There is no synthetic Budget authority in
these combined witnesses.

## Fixed operations and retained backing

Each case uses a two-element real Vec, a two-element Box slice, a three-key map
with duplicate import and occupied replacement, and a standard Arc/Weak owner.
The same private container adapters perform every operation. The transient map
and Box are destroyed before growth measurements. Successful growth reserves 256
additional u64 elements; refusal requests 8192. Geometry supplies one 32768-byte
allowance; the refused requested Layout exceeds it before Global is reached.
There is no arbitrary model/workload input or unbounded per-allocation table.

Stage assertions distinguish funded observer metadata, separately funded gate
metadata and container Layout bytes in the SAME account total. Sharing must not
change Usage. Growth must retain full old/new overlap and charge the old backing
copy, including a refused live admission. Refusal preserves pointer, contents and
capacity. The original generous ambient account remains uncharged.
An additional healthy-account case ends authenticated work before attempting a
spare-capacity push. It requires Coverage refusal, unchanged backing/contents and
unchanged Usage without relying on an allocator callback.

After work ends, cleanup-only take/replacement destroys the strong payload and
nested Vec backing. The Weak cannot upgrade but retains its actual Arc allocation,
gate and observer backing. Every local context, source/decoder/lease and observer
is destroyed; then the runner drops its context argument. ReleaseExternalOwners
requires the stage callback to drop ALL external original account/context/observer
clones, including callback captures. Only the Weak retains that request at the
next stage. Final Weak destruction must release the existing pool permit; both
the final callback and geometry caller require zero resident bytes. The callback
retains only the pool and unrelated account, not the original request account.

Geometry's fixed snapshot array and single observer slot are bounded test
instrumentation, outside source resource accounting. Existing source/owner/epoch/
account/Pool allocations remain baseline prerequisites; this does not fund or
regularize that baseline. Newly introduced gate and owned observer backing still
use actual admitted metadata Layouts through the existing standard allocator.

Actual account Usage/pool snapshots alone do not establish Global-free-before-
refund ordering. Existing unit storage-event instrumentation is retained for
that separate invariant; its fixture is not substituted for the actual account.

## First faults are irreversible

The factory captures a healthy real owned observer BEFORE fault injection. F is
a Work refusal, D a distinct CopyBytes refusal, and O an OutputBytes refusal.

| Case | Original source | Account | Observer/return | Fresh epoch |
| --- | --- | --- | --- | --- |
| Fresh work, healthy account | F | F | F | F |
| Fresh work, independent cancellation | F | Cancelled | F | F |
| Fresh epoch already stopped with D | F | Cancelled | F | D |
| Observer stopped with O before attempted F | O | O | O | O |

All reentry operations must remain unentered. Actual OwnedState recording O also
propagates O to its captured source/account; this witness does NOT fabricate an
observer-local fault inconsistent with those channels. A later attempted F cannot
rewrite O. Likewise a fresh epoch already stopped with D cannot be rewritten to F.
These cases assert precise outcomes, not universal channel agreement.

## Qualification still required

The parent's canonical E0432 correction is included verbatim: the earlier
boundary_witnesses_tests.rs import uses crate::resource instead of super. It
changes no resource, account or numerical behavior. The running parent jobs and
their original source pins/outputs are untouched; this source has no test pass.

Parent must compile default, ordinary-tracking and explicit-test-support normal
libraries; run both core wrappers and geometry witnesses; compile opted-in wasm
tests; validate normalized package feature edges; and run workspace strict Clippy
on its actual assembled source. A command matrix accompanies the delivery. No
build/test/check/lint/package/job is executed by this child.

`node scripts/verify-source-resource-feature-boundary.mjs` builds each normal
library and compiles the same external Rust import against it. Default and
ordinary tracking must reject the absent test-support module with E0432; explicit
test support must accept it. CI invokes this compiler probe. Like other Cargo
graphs, run it inside the admitted build environment. A successful library build
alone does not establish API absence, and this probe does not execute the gate.

This supplies a combined source path and behavioral assertions, not executed
evidence or production activation. Default/exact preservation, Global OOM,
performance, baseline backing, complete cache authority and generation/revision
proofs, Raw/cache/COW/escape migration and the major Rust owner migration remain
open. No generated binding files or package versions are changed.

## Additive simulated delegation-error prerequisite after 42c4

Explicit test support now includes four fixed cases: SimulatedFresh,
SimulatedGrow, SimulatedSourceGrow and SimulatedPreStopped. A fixed atomic record
is inline in each funded GateInner. It has no independent backing, account,
permit table or authority. Allocator clones share that gate; separate fixtures
share no injection state. Only the private fixture runner can arm it. No new
feature, dependency or production factory is introduced.

After successful same-account debit, the allocate/resize adapters consume the
one-shot arm immediately before their unchanged Global delegation. Armed calls
produce a simulated AllocError instead of calling Global, then use the existing
result match and failed_global path. This is neither process OOM nor a failed or
successful actual Global call. No new block exists: there is no candidate free
to claim. Successful/unarmed calls retain their original delegation and cleanup.
Zeroed allocation, grow_zeroed and shrink share these adapters, but simulated
failure through those specific entrypoints is NOT exercised or qualified here.

The combined actual-Inner witnesses assert retained attempted work/copy and peak
history, provisional live/category rollback, unchanged original Vec backing,
empty fresh Vec backing, source/account/observer agreement, fresh-work refusal,
Weak-only retention, final pool release and an untouched ambient account. Source
F introduced after debit wins over the later Allocation failure; a source stopped
before operation prevents debit and leaves the arm unconsumed, including reentry.
The actual-account counters are not physical-storage instrumentation. A separate
real-Global old-block unit witness retains storage-event checks: simulated grow
creates/frees no new block, and the real original block is later deallocated
before refund. Its fixture Budget is not authority in the combined account test.

The parent's 85a44 sequential-drop correction is included verbatim. No be54 cache
or authority files are copied into this branch. Apply the incremental patch by
hunks to the assembled parent; preserve its live-cache and test-quota changes.
Two cfg(test) storage-domain methods compare exact live GateInner identity via
std::ptr::eq over immutable references. They confer no admission or source rights;
separate gates remain foreign even with the same source/account. A unit witness
checks sharing and foreign domains after source/work teardown, without charges.

All new compilation, behavioral execution, feature/package checks, strict Clippy,
wasm and performance qualification remain UNRUN. The earlier source-qualified
parent results and failed original receipts are unchanged. This supplies bounded
simulated-error assertions, not general Global-failure or production readiness.
