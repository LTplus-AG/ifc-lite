<!-- SPDX-License-Identifier: MPL-2.0 -->
# Actual-account resource boundary checkpoint

This extends source 7628bf9acf82d8169084df40edcaaae07247877e. It connects the
resource interfaces to geometry's actual ExecutionAccount and OwnedResourceContext.
It does not activate parser, cache, ProductOwner or region tracking. The older
SOURCE_RESOURCE_PROTOTYPE.md describes the frozen R4 checkpoint, not the current
resource boundary. Frozen R2/R3/R4/P2 delivery artifacts remain unchanged.

All compilation, tests, Clippy, default/exact comparison and performance checks
for this checkpoint are UNRUN. Parent-reported native 31-test and wasm32 test
compilation passes belong to assembled source 26354b06cc798a36cd363b1ec9610334f03a7e33,
not this change. Parent owns fleet admission; no job is submitted by this work.

## Paired context and direct ledger

`SourceResourceContext::new` and `downcast` preserve their existing behavior.
`new_accounted<T: Any + Send + Sync + AllocationAccount>(Arc<T>)` derives both
the Any payload and the account trait object from its single argument. Private
fields prevent attachment/replacement with another account. Cloning/coercing the
existing Arc allocates no adapter record. `is_accounted` reports a projection,
not source authenticity. Projection extraction remains private to core.

Geometry publishes these paired views of the SAME private `Inner` allocation.
Existing `account_from_source_context` and joined-worker transport still recover
that Inner. There is no new account or allowance, and no lookup of ambient TLS
from allocator callbacks. The default account has no Inner and remains unaccounted.

`AllocationAccount` is a dependency-visible resource interface, not a sealed
source authority. Geometry's private Inner implements it directly. Under its one
State mutex, admission checks cancellation/first fault, admits cumulative work
and copy, and checks total live bytes plus the selected tracked category before
committing live counters. Container and metadata categories are subsets of the
existing `Usage.live_bytes` allowance. `allocation_usage()` reports their live
counts without adding limits. Failure of live admission keeps admitted work/copy
costs; Global failure rolls back only live bytes. Existing `prepare_inner`, public
prepare routing, Reservation and reserve_headers semantics are unchanged.

Refund checks category and total before subtracting, never allocates or panics,
and requires no active execution. Invalid refund records a fixed Coverage stop
without consuming another category or Reservation bytes. Storage observation is
optional instrumentation, not a pointer/permit table or resource authority.

## New backing ownership

The feature-visible `AccountedArc<T>`/`AccountedWeak<T>` own standard Arc/Weak
backing through a private explicit MetadataAllocator. It admits the actual
requested Layout before Global allocation, observes successful storage, delegates
Global deallocation, then refunds. The final Weak controls final backing release.
Construction failures unwind provisional live debits; admitted work remains.
Clone, downgrade, upgrade and observer projection share existing storage only.
No raw Arc extraction, public allocator extraction or custom reference count is
provided. This resource-only metadata API grants no decoder rights.

New opted-in gate backing and opted-in OwnedState observer backing use this
mechanism. The account owns neither, avoiding a strong self-cycle. Gates weakly
reference SourceBundle. Observer state and allocator clones retain the original
account; a pooled account consequently retains its existing PoolPermit through
externally surviving backing/Weak ownership. There is no per-block permit record.

The pre-existing account/Pool and actual execution owner/epoch allocations are
explicit baseline prerequisites created before tracked gate enrollment. This
checkpoint neither retrospectively accounts them nor introduces new owner/epoch
backing. Retained original stop handles can extend those baseline epoch lifetimes;
they never reactivate work. Baseline ownership itself still needs qualification
when subsequent production enrollment is designed. No unfunded envelope is used
for NEW gate or opted-in observer backing.

Binding restore frames and Authority snapshots are inline/stack records; they
allocate no new history backing. New metadata record counts are bounded by the
same account's live/work limits when finite; unlimited dimensions retain their
existing explicit meaning. No new production workload cap is imposed. The old
four-gate fixture quota and sixteen-frame/ancestor feasibility limits remain
confined to the private feature+unit-test prototype. They are not production
admission policy and cannot be promoted during later activation.

Accounting covers requested Layout bytes and existing audited reservations,
not allocator internals or RSS. Account bookkeeping does not recursively allocate
permit/account objects for each debit. This checkpoint migrates no existing
Reservation::retain/reserve_headers container, so it charges none twice. A later
owner migration must remove or explicitly partition each old backing charge in
the same change that gives that backing an allocator owner.

## Observer and source gate

`OwnedResourceContext::try_capture_accounted(context, source_stop)` captures the
actual private geometry account and explicit source stop, without TLS lookup.
It funds an OwnedState containing its terminal mutex and captured channels.
`allocation_observer()` shares that allocation with no adapter allocation. The
existing `capture_current` retains its original raw terminal Arc allocation and
lexical behavior. It does not silently opt in. Missing projections refuse tracked
construction, rather than selecting ambient accounting.

Owned terminal handling snapshots its mutex, releases it, consults/updates source
and account, then commits its terminal. No cross-channel call occurs under the
terminal lock. Source-scope and private binding restoration move displaced owners
out of their locks before dropping them, including unwind.

The private gate extracts the allocation projection from the actual published
context, not a Resources downcast. Historical Budget/Resources are test fixtures
only; actual-account witnesses use the actual geometry implementation. Gate
construction, entry, operation checks, admission errors, overflow and Global
errors forward fixed ProgramStop channels. Original source stops take precedence;
the account preserves its own first fault, and the captured observer retains the
selected source fault. Early account.check failures also reach the observer.
Cleanup deallocation bypasses all work admission.

The actual mutable decoder, its actual ExecutionWork, live published epoch,
owner/generation and source identity remain independently validated. The captured
cache revision is still coupled to generation, not independently observed cache
authority. A context, observer, matching account or retained allocator is never
source authority. Original ProductOwner context validation/capture remains a
separate mandatory integration stage. No public tracked decoder/entity/cache
constructor is introduced here.

## API and witness qualification

The stable resource trait, costs/classes/events and paired context constructor
are additive Rust surface. Accounted metadata owners, observer handle and explicit
owned capture are opt-in `source-resource-tracking` surface. Both crates propagate
that feature; core's opted-in unit target also enables geometry's existing
test-support feature. Only opted-in core builds require the pinned nightly
allocator API. The old raw public operations and default parser/exact policy
remain. No Python/wasm/server/CLI binding surface is changed or regenerated here.
Core's existing geometry dev-dependency now inherits the workspace version/path
so packaging does not strip the path-only dependency targeted by the feature
edge. Packaging, the cyclic dev-dependency feature graph and unified downstream
compilation remain UNRUN and need coordinated Rust release qualification.

Core unit tests invoke real-account witnesses compiled in geometry's existing
test-support module. This avoids treating the unit-test core crate's types as
the normal core library types used by its geometry dev-dependency. Those witnesses
exercise actual accounted standard Arc/Weak backing, pool lifetime, explicit
OwnedResourceContext faults, joined decoder resource transport, and zero-budget
refusal. They do not expose the private gate or fabricate an adapter account.
The real account and the private gate are covered on their respective sides of
the dependency-visible interface; these witnesses are not ProductOwner activation
or an end-to-end real-account tracked decoder/cache allocation test.

Existing 31 prototype cases remain. Their fixture observes container and metadata
separately against one total live limit, preserving container-specific assertions.
run() funds its gate first and sets that total limit to retained metadata plus
the requested container allowance. Additional tests cover early gate fault
forwarding and source-context destruction outside its lock. Geometry unit tests
cover paired payload identity, rejected unprojected contexts, atomic category
refund, attempted costs versus unchanged legacy prepare policy, cancellation with
foreign TLS, and concurrent metadata destruction. Global OOM is not forced.

No performance or complete default-output compatibility claim is made without
execution. The remaining owner-wide Rust API replacement is a major migration,
with explicit release/guide updates and downstream Python/wasm/server/CLI/FFI
qualification. Cache exports/imports, COW, nested attributes, lazy storage, Raw
region capture and generation-coupled authority residuals remain mandatory work.
