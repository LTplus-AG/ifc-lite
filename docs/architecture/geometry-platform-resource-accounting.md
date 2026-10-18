<!-- SPDX-License-Identifier: MPL-2.0 -->
# Implemented resource admission and its boundary

This is an incremental prerequisite for IFClite's Rust-owned execution platform,
not a complete platform cutover or an end-to-end memory bound. The exact Rust
kernel remains the permanent default. No loader, numerical kernel, source policy,
quality budget or browser ABI is replaced.

## Explicit policies and owners

`ifc_lite_geometry::resource::ExecutionPolicy::Compatibility` is the default and
installs no account, counter allocation or new limit. `Bounded(ResourceLimits)`
opts into independent cumulative work, copy bytes, output bytes, occurrences and
live requested-storage allowances. `None` is explicitly unlimited; `Some(0)` is
zero. The account checks every addition before committing counters. Releasing
live storage never refunds cumulative work or copied/output bytes.

`Strict(ResourceLimits)` refuses with typed `Coverage/UnsupportedCoverage` before
invoking a producer, because complete allocation coverage is not implemented.
Accounted execution returns `is_resource_qualified() == false`. Neither policy
turns requested Vec backing bytes into an allocator, process RSS or GPU bound.

`ModelResourcePool::admit` reserves a finite deterministic request live allowance
up front. It returns `WaitingForCapacity` without blocking for transient model
pressure, and a typed refusal when a request cannot fit at all. Hosts retry after
an owner drops; no cache lock is held while waiting. The request's work/copy/output
quotas do not depend on another product's scheduling. Account clones share quotas;
lexical nested calls inherit the current account. Joined workers entering a canonical
producer with the actual mutable source borrow recover that account from the
validated source capability. Canonical entry checks that capability even when a
worker-local account is already active: the actual source owner's bounded account
takes precedence for that child, and the previous worker-local scope is restored
on return or unwind. Compatibility source owners still transport terminal stops
while allowing explicit worker-local bounds. Independently created host models still
require host-level aggregate admission.

`Reservation` is unique and releases live bytes on drop. `retain()` explicitly
transfers residency to an account-owning payload/cache owner. Retention is
conservative: earlier replaced backing allowances remain charged until that owner
drops. Cached geometry can retain its publishing request's entire pooled allowance.
This can reject work that would fit with precise reconciliation; it cannot be
reported as measured allocator high-water accounting.

`AccountedMappedItemCache` keeps reached, completed cache effects alive across a
later branch's stop and across router/request destruction. It does not expose
naked mesh Arcs. Local caches keep their accounts with the router. Moving a producer mesh into
the local hash cache admits its actual vector capacities, including spare backing;
copy and output allowances still charge initialized logical payloads. Shared legacy
mapped caches and shared structural item-dedup caches have no owned bounded
handoff and refuse unsupported bounded publication/dispatch. Existing borrowed
cache APIs remain unchanged. Preexisting compatibility cache storage is outside a
new request's residency envelope.

## Real canonical integration

Both accumulating mapping consumers use the existing continuations, transforms,
frame selection and `Mesh::merge` numerical algorithm. Work/occurrences are charged
on repeated DAG paths, including cache hits and metadata-only placeholders; path
membership remains path-scoped. Mesh clone, merge and Vec-header growth preflight
portable wasm32/isize lengths and u32 offsets before reserve, narrowing or copy.
Moved old backing is included in cumulative copy cost. Failure cannot publish
partially merged geometry; multi-buffer reserve failures leave original arrays
intact. Source list decoding and numerical producers remain opaque exclusions.

A provisional batch-local template owns a rollback token. Failure/unwind removes
its incomplete materialized mark. Completed prior source-cache publications stay
at their original reached point and retain residency; a later branch is not a
transaction that retracts those independent effects.

The native Rust adapter
`produce_element_meshes_owned_accounted` drives the actual canonical owned
request/execute/accept/finish implementation. It returns
`AccountedElementMeshes`, which retains the effective request account and output
reservations while callers borrow the result. Copying borrowed output requires
caller admission. Raw mesh/UV/output-header admission occurs before presentation
acceptance; this does not bound all presentation scratch or expansions.

`ProgramStop` is typed and sticky. Audited callbacks normalize the typed geometry
error and check the account immediately on return. A processor that catches a
resource error and returns geometry cannot make the accounted producer succeed.
Stopped work bypasses plain, primary, void and type retry presentation, and the
owned driver checks before publication and after final diagnostic callbacks.
A fixed terminal record also follows that source capability, including under
Compatibility without an account. Scoped worker canonical entries install only
resource state; kernel budgets, diagnostics and census TLS do not migrate.
Arbitrary extension code before canonical entry must explicitly carry resource
state. Reached source evidence is retained. Ordinary source errors, even those with
terminal-looking text, keep historical recovery. Cancellation is cooperative;
callback side effects cannot be rolled back. Existing model-stream cancellation
still returns already delivered independent batches; this adapter does not
retract streaming output.

## Explicit exclusions and remaining qualification

Unaccounted families include decoder/index/source-list internals and decoded
entity cloning, reference-set bookkeeping, profile/curve sampling, numerical
constructor and exact-kernel scratch (including rational arithmetic), hygiene,
welding/dedup workspaces, layer/opening/boolean intermediate allocations not
passing audited merge helpers, diagnostics/evidence backing, attachment strings,
raster decode and assembly metadata/palette/split expansion. Custom processors
can allocate or mutate external state before returning. Native result collection,
stream sinks, browser partition/template expansion, JS getters, GPU upload and
later consumer copies require their own ownership coverage. Allocator metadata,
rounding and fragmentation are excluded everywhere.

No bounded policy is exposed through the five existing synchronous JavaScript
batch signatures; raw initialization and decoder ABI are unchanged. WASM runtime
qualification and browser output lifetime admission are outstanding. This Rust
change does not require handwritten generated bindings or a WASM API snapshot.

The focused tests exercise real inline IFC mapping diamonds, local/shared cache
hits and misses, ordered geometry/frame/instance equivalence, zero-geometry and
placeholder occurrences, early work/copy/output refusal at reservation probes,
template rollback, prior cache survival, typed callback stops, cancellation,
panic restoration, nested quotas and actual owned output/model residency handoff.
Pure length tests cover impossible sizes without giant allocations. Passing these
invariants does not establish complete IFC, texture/raster, source-free numerical,
full-model memory or platform fidelity coverage.

Integration overlaps include mapping/mesh ownership helpers, router item callback
normalization, owned product work/accept adapters, and the core source-owner
capability attachment for resource-only worker transport. Core decoder/index
loading, model load factories, constructor-plan APIs and source-policy walks
remain owned by their separate implementations. The item methods are extracted
without changing their ordinary dispatch/cache/diagnostic order, so the new
production modules stay within the size ratchet; existing budgets only decrease.

## Integration and terminal admission (round 2)

The incremental resource layer is ported onto the owned ProductProgram pipeline.
Mapping continues under `program/mapping`; item dispatch preserves the selected
`lower_owned` constructor, RTC fallback, and custom processor aliases. Owned
production retains its bound presentation context and shared derived handles.
No second loader or geometry engine is introduced.

Source stop observation walks the actual work-epoch ancestry iteratively. The
oldest ancestor with a recorded fault wins, including when a fresh worker child
has no bounded account. A different attempted descendant fault cannot replace
that record. Canonical borrowed and owned entries check before planning; their
existing infallible output ABI returns no child geometry while the outer
accounted adapter retains the typed terminal outcome. A retained stop handle
carries resource data only: source lease validation still controls live work.

The regression fixture stops a Compatibility wall callback before lending its
actual decoder to a scoped worker with a fresh router and a real mapped slab.
It requires zero child numerical calls and no new cache publication, preserves
an independently completed wall-map payload and earlier source-fault reports,
and covers both cancellation and a prior resource refusal. Separate tests cover
oldest-ancestor fault identity, expired source authority, ordinary unbounded
workers, and bounded source accounts versus foreign worker CURRENT state.
These are authored invariants, not executed qualification results.

This integration remains uncompiled and resource-unqualified: fleet storage
admission is refused. Focused tests, workspace tests, all-target Clippy, canonical
WASM contracts and the excluded PyO3 consumer remain unverified for this source.
No end-to-end performance result or full heap/RAM bound is claimed.
