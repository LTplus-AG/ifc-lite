<!-- SPDX-License-Identifier: MPL-2.0 -->
# R4 private standard-allocator feasibility checkpoint

This prototype is built ONLY in the core unit-test target when the opt-in
`source-resource-tracking` feature is enabled. There is no production activation,
new loader, public owner replacement or default/raw/parser policy change.
All compilation, tests and Clippy are **UNRUN**, pending parent-coordinated fleet
admission. The child submits no jobs. Enabling the feature alone does not execute
or qualify the private prototype. The selected optional dependency is exact
hashbrown 0.15.5, default-features disabled, nightly allocator feature enabled.

`source_resources/authority.rs` is a private feature/test-only child of
`execution_owner`. It captures safe owned execution-state/epoch references from
an actual coherent SourceBundle decoder, its actual ExecutionWork and its matching
published source scope. No retained decoder reference or raw decoder pointer is
used. ResourceAllocator callbacks check the active gate binding, alive/reserved
execution state, live generation, ancestor epochs, current source publication
and actual resource adapter. A captured cache revision is bound to generation:
every existing raw cache revision-changing API also changes that generation.
Future production integration must maintain/audit this implication; this prototype
does not claim an independently mirrored live cache-revision atomic.

Raw authored/borrowed decoders and trusted nonzero external-cache revisions are
not supported by this prototype. It does not replace the parent's private context
validation/ProductOwner source transaction. SourceBundle identity plus actual work
is a core feasibility prerequisite, not a claim that geometry production authority
has been integrated. An account, gate, allocator, retained handle or identical
input bytes alone grants no work authority.

`Backend` is the resource-only seam. A future geometry adapter must implement its
allocation-free/nonpanicking admission, fixed terminal, checked refund and storage
observation contract without importing geometry into core. Only the unit fixture
constructs the counting/enforcing backend. Gate creation recovers it from the
actual published SourceResourceContext; it never substitutes a fresh backend for
an existing production resource account. No production backend is adapted here.

Allocator success transfers a requested-Layout refund obligation to the standard
container holding that allocator; no per-block permit allocation or pointer
registry exists. Actual deallocation delegates to Global before refunding. Standard
Arc/Weak controls all shared lifetimes, including weak-only retention and implicit
Weak cleanup on payload unwind. Replacement admits full old+new overlap and keeps
cumulative work/copy cost on refusal. Destruction/cleanup-only take/replacement
never require an active epoch. Later destination growth needs actual validated
same-source, same-adapter work. No public generic owner is introduced; arbitrary
user destructors, Global allocator replacements and broad parser/COW coverage
remain unsupported.

Box slices precheck original terminal/work and Layout::array before calling the
plain-AllocError API. The prefix guard drops initialized nested elements on error
or unwind, then the allocator-bearing box frees/refunds its allocation. Terminal
forwarding uses fixed ProgramStop throughout; std TryReserveError::kind and
hashbrown's enum classify overflow without formatting. Canonical grammar, UTF-8/
escape/error sinks and consumer migration remain future work.

## Declared control metadata envelope

Requested source-container Layouts exclude the separately declared baseline
account/resources/execution/control storage and allocator-internal overhead/RSS.
The test enforcer observes actual delegated allocation/resize/free events and
rejects refunds preceding storage release. Its fixed counters are instrumentation
and resource enforcement, not mocked geometry results.

The compile-time size expressions are `size_of::<Resources>()`,
`size_of::<GateInner>()`, `size_of::<Authority>()`, `size_of::<Restore>()`,
`size_of::<State>()`, `size_of::<WorkEpoch>()`, `size_of::<ResourceAllocator>()`
`size_of::<SourceResourceContext>()`, and `size_of::<Budget>()` for the actual fixture backend. Numeric ABI values have
NOT been executed/measured. The focused metadata test prints these expressions'
actual values when run. Global Arc control/header alignment must be included in
the separate parent baseline envelope, using the inspected pinned std layout;
these payload sizes alone are not its total allocation size.

Hard limits per actual adapter are 4 retained gate records and 16 lexical binding
frames per gate, with at most 16 ancestor epochs accepted per authority. Thus at
most 64 binding records and at most 1024 referenced epoch positions can be retained
by those active prototype bindings (overlapping references need not be distinct).
The Restore frame is stack storage, not an allocated history. Slot reservation
precedes fallible gate Arc construction; GateInner destruction releases its slot.
Allocator-held gate/account references remain until their actual last container/
Weak handle drops. Gate metadata exposes no Weak handle of its own. Its model
identity is a standard Weak<SourceBundle>, avoiding a future source-index ->
allocator -> gate -> strong source cycle. Only active authority snapshots hold
the source strongly. The original model/control-block lifetime belongs to the
parent's baseline; it is not newly charged source identity or container bytes.

Creation/lifetime of existing ExecutionOwner state, epochs, account and backend
must be declared by the parent as baseline prerequisites. Their allocation is
not retrospectively called source-container pre-admission. This prototype has no
unbounded log/history/registry and no recursively self-accounting permit records.
Full initial-source baseline enforcement remains a production integration hold.

## Parent-run qualification, not executed here

Use the repository root and its registered environment/fleet routing. Suggested
focused command for the parent after admission is
`cargo test -p ifc-lite-core --features source-resource-tracking source_resources -- --nocapture`.
Then qualify the optional feature/unified consumers with the parent-approved
workspace test/strict-Clippy commands. This suggestion is not a submitted job.
Python, built-wasm boundary, server/CLI/FFI, exact output and performance remain
future migration gates; a private prototype pass would not establish them.

Tests use real std/hashbrown containers and an actual decoder source-work chain.
They cover Layout accounting/overlap, weak-only and nested destruction, source/
generation/revision/context refusal, ancestor expiry on a joined worker, reentry,
control caps, cleanup handoff after cancel/unwind, Box overflow/prefix cleanup,
fixed terminal forwarding, and hashbrown replacement/tombstones/batch rollback.
Underlying Global OOM/OS allocator failure is not forced by an enormous allocation;
that branch and full feature compilation remain explicit qualification holds.

The later owner-wide Rust API migration still needs a major release and complete
migration documentation across consumers. R2/R3 frozen contracts and independent
review remain the design history; they are not runtime evidence for this source.
