<!-- SPDX-License-Identifier: MPL-2.0 -->
# R4 frozen contract: bounded standard-allocator prototype

Source base f57db33bc11e6d6aac559dd0f0268ea37ac746ef. R2/R3 remain immutable.
Parent reports ba3aa; no parent harness/production source is imported or qualified.
This R4 artifact is frozen before prototype edits. No broad owner/caller migration,
public owner replacement, canonical resource activation, parser change or new
loader is authorized here. Execution remains UNRUN until parent admits its jobs.

## Corrections to R3

1. A Box-slice adapter FIRST checks the existing original stop and validates work,
   then calls Layout::array::<T>(len). Overflow records fixed LiveBytes/Overflow
   without invoking Box or A. Only then call Box::try_new_uninit_slice_in. Plain
   AllocError must never be guessed to mean overflow. An initialization guard
   owns the allocator-bearing uninitialized box and a prefix count; unwind/error
   drops exactly initialized elements before Box deallocation/refund. No partial
   nested element is leaked or treated as initialized.
2. Cleanup-only moves/takes/empty-owner replacement do NOT acquire fresh work,
   debit resources, validate a current epoch or discard retained backing. They
   move the actual allocator-bearing container/gate/refund account, even after
   cancel/expiry/unwind. They grant no authority to allocate, mutate source data
   or accept checked provenance. Subsequent destination operations require a NEW
   validated actual-decoder work binding in the original compatible resource domain.

## Bounded implementation agreed for this phase

Private rust/core/src/source_resources prototype, compiled only in core's unit-test
TARGET when source-resource-tracking is enabled. Normal public/default/raw APIs
and parser paths remain byte-for-byte behaviorally untouched. This test-target-only
choice is explicit: it gives parent an executable feasibility checkpoint without
shipping a dormant private API or adding dead-code/guard allowances. A library
feature build alone does not execute or qualify this prototype.

Feature enables optional exact hashbrown 0.15.5, default-features=false, nightly;
no other new package/version. Nightly allocator_api/try_reserve_kind and
vec_push_within_capacity gates only for the opted unit-test target. Optional
dependency lock edge is updated explicitly; no cargo resolution/build is run here.

Authority seam lives in a feature+unit-test-gated child module of execution_owner,
which can inspect actual private State/WorkEpoch safely. Gate entry takes the
ACTUAL decoder and its ExecutionWork; verifies work lease identity/live atomic
state and the matching published source epoch/context; copies owned state/epoch
references and the current cache revision, never a raw decoder pointer or retained
&mut reference. Allocator calls validate the live shared generation/alive/reserved
state and ancestor epochs, plus same-thread current source-work binding. Revision
is bound to that generation: current raw cache revision-changing APIs also change
ExecutionOwner generation; tests exercise actual raw imports. No independent live
revision claim is made if an internal future writer bypasses generation updates.
This implication is an explicit audit obligation before production integration.

The existing resource-only SourceResourceContext on the actual source-work scope
must contain the prototype resource adapter. Gate construction/entry recovers it
from actual private execution state; a separately passed backend/account is NEVER
selected as canonical. A public context object alone grants no source authority.
Core ResourceBackend trait supports fixed-cost admission/refund/check/stop; no
geometry dependency or Reservation import. Geometry backend integration remains
parent-coordinated future work. Behavioral tests use a real counting/enforcing
backend attached to actual decoder source work, not mocked geometry outputs.

Gate scopes are lexical with inline previous binding and bounded nesting. No lock
is held during allocation, backend callbacks, Global, source work or destruction.
Ordering: snapshot gate binding under gate lock, release it, validate authority,
then backend admission; refund touches backend only. Entry on another thread while
bound refuses; a scoped source worker must create its own actual child work before
binding. Shared state is accessed through safe Arc/Mutex/atomics; no aliased mutable
decoder dereference, TLS authority or pointer registry. Cleanup transfers keep the
same backend and gate; a later decoder may rebind only under same actual adapter.

ResourceAllocator clones account/gate refs only. allocate/zeroed validate, debit
requested Layout before delegated Global, preserve original ProgramStop in the
fixed terminal, and roll back live bytes on Global error. Work/copy charges are
cumulative and never refunded on failed attempts. deallocate delegates first,
then refunds Layout bytes without work/epoch validation or allocating/panicking.
Grow/grow_zeroed/shrink admit full new Layout alongside old, delegate to Global,
refund old only after success, roll back only provisional live bytes on failure.
No custom refcount/table, global allocator hooks or canonical semantic activation.

Use actual std Arc/Weak, allocator-bearing Vec/Box, and hashbrown try_reserve plus
pre-reserved insertion. No infallible allocating clone/COW, shrink/conversion or
uninspected allocation API. Fixed terminal bridges AllocError/TryReserveError;
classify capacity overflow without formatting. Test original/ancestor stops first.
Hashbrown supports only internal nonpanicking values; arbitrary destructor-panic
bucket cleanup remains unsupported exactly as recorded in R3.

Control envelope: hard maximum 4 simultaneously retained gates per adapter,
16 lexical binding frames per gate, 16 visited ancestor epochs per authority.
One actual State plus up to 16 already-created WorkEpoch records per validated
chain are baseline prerequisites, not allocations claimed pre-admitted here.
Adapter/resources/gate/state/epoch record sizes are published as size_of/Layout
expressions and reported by the focused tests (numeric ABI results UNRUN).
Baseline accounts/epochs/backend have separately declared retention and size;
gates reserve a fixed metadata slot before fallible Global Arc construction and
release it on final gate destruction. No metadata per allocation/hit and no
recursive self-accounting. Standard Arc metadata overhead is explicitly included
in the control envelope declaration, not falsely called a physical heap quota.

Focused tests cover exact Layout debit/refund observation, weak-only control
retention, clones at zero remaining budget, actual generation/revision/epoch/wrong-
owner refusal, nested/reentered/joined work, fixed original stop forwarding,
grow overlap/rollback, cleanup handoff after stop/unwind, overflow-before-Box,
partial nested slice initialization cleanup, and hashbrown reserve/tombstone/
replacement/import rollback. No source-text tests. All compiler/test/Clippy checks
are UNRUN pending the parent's fleet admission; no heavy job is submitted here.

Private prototype is not production coverage. R2/R3 public API major-release,
caller migration, canonical grammar/sink/COW, warm original-source activation,
complete metadata qualification and downstream runtime/performance obligations
remain. Parent reviews this clean checkpoint and admits feasibility checks before
coherent consumer migration is authorized.
