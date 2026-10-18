# Provisional resource implementation review

Read only; no builds, tests, probes or repository edits. Inspected child worktree
`/home/louistrue/.t3/worktrees/ifc-lite/t3-fe080b7e` against parent checkpoint
`772522f9df`. Exact currently inspected file hashes are recorded in
`/tmp/ifclite-resource-provisional-inspection.json`; this is an active implementation,
not a qualified source freeze. The following are source-grounded paths and proposed
actual-behavior invariants, not claims of executed reproduction.

## 1. Same-thread nested admission can lose a terminal failure

`resource/mod.rs:75–77` returns `account.prepare(cost)` directly. The failure path
in `resource/account.rs:82–86` writes only the inner account's terminal state.
`ExecutionAccount::scope` at lines58–65 restores CURRENT without promoting a
pending account fault into the enclosing TERMINAL context.

Concrete path: an outer `produce_element_meshes_owned_accounted` uses Compatibility
(account without CURRENT, but with shared TERMINAL scope). A real registered
processor enters a fresh bounded child account with `work: Some(0)`, calls
`resource::charge(Cost {work:1,..})`, swallows its Err, leaves child.scope and
delegates to the actual extrusion processor. The failed account is no longer
CURRENT; outer TERMINAL remains unset. The outer adapter's checks therefore allow
success. This violates the stated nested first-terminal/sticky behavior; it is
independent of opaque producer allocation coverage.

Later meaningful test: use the existing actual wall/extrusion callback harness,
perform that nested failed admission, then delegate real geometry. Require the
outer accounted result to be typed ResourceRefused, with no accepted current-product
meshes and no fallback callback. Check unrelated enclosing reports restore normally.
Promoting charge failures through `stop` before an account scope can disappear is
a narrow candidate fix; also audit direct public prepare failures and scope exit.

## 2. Existing scoped-worker canonical children do not inherit resources

CURRENT and TERMINAL are thread-local (`resource/mod.rs:56–58`), and scope installs
only caller TLS (`account.rs:58–65`). Existing `session_threaded_tests` already
exercises real canonical production through an exclusively borrowed decoder on
another scoped thread and a fresh compatible router. Source-borrow/owner plumbing
in session_owner/core decoder has no matching resource propagation.

In that supported callback composition the worker's charge can return an empty
permit and its `resource::stop(Cancelled)` can have no sticky destination. The
worker can delegate real geometry, return it, and the accounted parent can finish
successfully. This is a concrete missing inheritance/terminal edge, not evidence
that opaque worker allocations are covered. If the new adapter deliberately
excludes this composition, it must enforce/refuse it and narrow its inheritance
contract; silently unmetered child admission contradicts the broad current wording.

Later meaningful test: reuse ThreadedExtrusion, drive the parent through the new
accounted adapter, and in WorkerExtrusion invoke charge/stop before delegating
real extrusion. Require parent quota/terminal ownership to survive that edge (or
an explicit unsupported-coverage refusal before child work), while keeping the
existing actual decoder/router child lease contract. No extra arbitrary worker
owner, public ticket or blanket bypass is needed to describe this requirement.

## 3. Local hash-cache move charges lengths but retains capacities

`router/processing_items.rs:250–255` charges MeshLengths::of(mesh).bytes before
get_or_cache_by_hash moves the original mesh into Arc/hash-cache storage.
MeshLengths::of (`resource/mesh.rs:27–32`) uses vector lengths. Cached original
positions/normals/indices/plane-tags retain capacities, which can exceed lengths.
This does not affect clone_reserved, whose new copied vectors use exact requested
lengths. It affects the original moved cache entry's known retained backing.

Later meaningful test: a registered processor delegates actual extrusion, then
reserves a large spare positions capacity without changing positions. Process a
local hash-cache miss under an explicit bounded live allowance and compare the
admitted retained storage to the cache vectors' capacities. Either charge known
backing capacity before its ownership transfer or state precisely that this
retained backing is also excluded. Opaque scratch/allocator rounding are already
explicit exclusions, but known retained Vec spare capacity is a separate quantity.
This is not a claim that the adapter promises a complete heap bound.

## Reviewed preservation that is present

- AccountedMappedItemCache owns account clones separately from cache payloads;
  completed entries can retain the full pooled allowance after later branch failure.
  Existing local/shared cache ownership is not a naked unretained Arc gap.
- Output wrapper owns output before reservation/account fields drop; caller copies
  are explicitly outside its guarantee. Coarse account retention can conservatively
  outlive individual freed buffers and is not exact cache reconciliation.
- Provisional template marker RAII rolls back incomplete/empty sources and retains
  completed markers at their reached effect point. Independently completed cache
  publications remain visible if a later branch stops.
- Mesh replacement preflights sizes and offset/index arithmetic, admits old/new
  coexistence and copied old contents before fallible reserves, then commits all
  replacement buffers before the same canonical merge. Later reserve failure
  leaves the original target's geometry/capacity unchanged.
- Existing packet identity/emitter checks and duplicate execution gates remain
  before actual callback/assembly effects. The new public accounted driver owns
  its replies internally; no new externally forgeable ticket API is exposed.
- Opaque decoder/profile/numerical/raster/assembly allocations and downstream
  copies remain declared unqualified. Strict mode refuses unsupported coverage.
  Those declarations are not themselves correctness defects or completion proof.

Additional coverage note: accounted_session's reservations Vec pushes permits
without reserve_headers and payload_bytes uses logical lengths, not final
assembly capacities. These are boundaries for the next accounted-control/output
coverage inventory; they should not be presented as a full memory guarantee.
