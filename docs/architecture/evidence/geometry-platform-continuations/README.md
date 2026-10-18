<!-- SPDX-License-Identifier: MPL-2.0 -->
# Canonical boolean and CSG continuations

This stage covers the source scope recorded in
[source-manifest.json](source-manifest.json). [Validation](validation.json)
records completed native workspace tests, Clippy, fresh WASM checks with fixture
skips, raw real-file replay, the consumer example and repository guards.
Historical receipt directories retain their original source scope and results.

The canonical recursive boolean/CSG operand traversal has been deleted and
replaced by an iterative continuation driver. Explicit owned frames retain the
current source cursor, remaining FirstOperand spine, suspended host, operand
result and provisional batch state. Source admission remains interleaved with
execution at the reached continuation. This is not a claim that a complete
boolean operation has been decoded into a source-independent document before
execution begins.

The driver consumes the shared owned leaf constructors, plane and bounded-prism
plans, void-shell handling and solid boolean numerical policy. Polygonal batch
preparation and grouped-cut evaluation retain their separate admission and
numerical stages. The pure Rust exact kernel remains the CSG kernel across
all targets; this stage adds no kernel selection or replacement arithmetic.

The behavioral contract includes FirstOperand source order, delayed operator
and SecondOperand admission, empty-host short circuits, operation-specific
unreadable-cutter recovery, and one-record-per-loss propagation. Batch attempts
retain their innermost-first cutters, conditional preparation, acceptance gates,
solo-step distinction and sequential recovery. Failed provisional attempts may
rewind their own diagnostic range while their work and source reads remain
spent. Unit discovery stays conditional on the numerical path that needs it.

Nested CSG now shares its enclosing boolean recorder. Depth-first execution
preserves the previous transient-recorder append order, while mark-relative
rewinds preserve the enclosing log prefix. Top-level CSG still hands its
transient recorder's evidence to its public processor on success or error.
Suspended frames own their hosts, and result slots are consumed before reuse.
Error cleanup removes only the active path admissions made by this driver,
leaving a caller's ancestor membership and consumed visit budget intact. Normal
path exit pops active state outside debug assertions, so release execution
performs the same cleanup.

Qualification must exercise conditional source reads, recoverable and fatal
admission errors, nested CSG diagnostic order and draining, empty-loss flags,
provisional batch deferrals, and source/host ownership. Contextual nesting,
path membership, cycle detection and monotonic visit accounting retain their
existing distinct roles. CSG hops reset boolean nesting depth without resetting
the shared path or visit counter. Exact-kernel operation and element budgets
remain separate from source traversal accounting.

The reference-walk scanner cannot prove termination across transitions in an
explicit frame queue. Absence of recursion is insufficient: the driver still
needs dynamic cycle/path/work guards, and behavioral tests must show both
termination and refusal evidence. Scanner success alone does not qualify this
state machine's bounds.

The separate opt-in `ConstructionBatch` remains an eager source-admission graph.
Its source scheduling and graph/report-work bounds do not reproduce the
canonical continuation's complete conditional or contextual contract. Shared
constructor and numerical seams do not make those two execution contracts
interchangeable, nor do mutable execution budgets permit unrestricted numerical
result memoization.

The [whole-worker-pool comparisons](default-path-perf.json) retain matching mesh
counts and ordered geometry fingerprints on six models. Fingerprints omit UV,
texture, instance and text metadata; shared-host timing remains unqualified.
[Native process high-water samples](default-path-memory.json) cover three models
and do not establish browser/retained-plan memory or process limits.

Complete performance and memory qualification remains pending. Heap-owned frames avoid
recursive traversal stack growth, but can retain source snapshots, suspended
hosts and intermediate meshes concurrently. Path and visit bounds do not bound
payload bytes, peak process memory or worker residency. Whole-worker-pool
base/candidate measurements on an exclusive runner and broader identity evidence
remain required for a performance verdict. Isolated numerical timings cannot
establish one.

Product and mapping plans, opening orchestration, presentation, retained
representations, packaging and the coordinated cutover of every consumer remain
open platform work. This receipt covers canonical boolean/CSG control and its
shared seams, not complete platform migration. The
[capability ledger](../../geometry-platform-capabilities.md) tracks the remaining
coverage; later receipts must qualify further changes against their own source
scope.
