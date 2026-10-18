<!-- SPDX-License-Identifier: MPL-2.0 -->
# Geometry platform: next implementation steps

The [foundation](geometry-platform-foundation.md) is implemented. Continue the
[whole-platform design](../../tools/smlib-evaluation/implementation-design.md)
through the following dependency order. Exact arithmetic, supported formats,
existing behavior and cross-target contracts remain hard preservation constraints.

## Implemented execution layer

1. **Authored planning.** Reuse the existing bounded analytic source walk to
   preserve raw source definitions, mapping identity, units, transforms, source
   status and product outcomes in a Rust-owned plan. Identify enclosing booleans,
   host openings and incomplete representation coverage explicitly. An authored
   operand is never presented as the final evaluated product.
2. **Common command protocol.** Expose transport-neutral bounded request encoding
   and response validation so Rust can plan operations for native and browser
   execution. Preserve worker affinity at the execution boundary; serialized
   handles are scoped to one module/process epoch.
3. **Browser execution.** Extract one shared C++ operation decoder for native
   and WASM, then implement independent module workers with owned request/result
   buffers, BigInt-safe handles, deterministic disposal and explicit restart.
   Test the real module in browser workers; Node alone is insufficient evidence.
4. **Native supervision.** Add bounded scheduling, request deadlines, cancellation
   and process cleanup beyond the current blocking client. Prove that a timed-out
   or cancelled kernel process is reaped and cannot keep publishing stale work.
   Transfer limits must not be described as process memory limits.
5. **Integrated qualification.** Exercise the authored plan through a real
   consumer, run the same boundary operations and mesh invariants through native
   and browser transports, retain fault/recovery evidence, and run repository
   checks appropriate to the actual delta. Record source/artifact versions and
   keep the original foundation receipts identifiable.

Independent implementation tracks delivered authored planning, browser/shared C++
transport and native supervision. Integration adds the Rust-neutral protocol,
consumer examples, cross-target checks and documentation. See the separate
[execution receipts](evidence/geometry-platform-execution/) for verified scope. These are reviewable
layers of one platform, not separate production IFC-family backends.

## Canonical production migration in progress

`produce_element_meshes` now drives one private owned `ProductExecution` session
through reached strategy stages and shared presentation assembly. The superseded
execution orchestrator is deleted; native and browser callers keep this one
producer. Construction performs reached strategy planning synchronously. The
session owns job entity/metadata, map iteration, attempts, geometry/instances,
hasher and exact-budget/degenerate state. Short-lived thread-bound guards install
its counters on each advance and restore the caller; triangle-order state uses
RAII. Typed outcomes retain annotation refusal, instance-only success and a host
consumed by openings. Hashing and final closure retraction retain their existing
assembly boundaries.

CSG failures retain the original retry and final drain points; there are no
per-poll drains. Final drain sees restored caller triangle-order mode; reached
slices preserve the product's callback-mutated mode between polls. Typed internal
request/execute/accept work now separates reached
router work from presentation. Planning briefly reserves the decoder/router;
first execution or finish binds enforced exclusive reservations through
publication. Stable identities are inline and shared reservation state is lazy.
Trusted synchronous `ExecutionWork` commits reached callback mutations using the
same owners' fresh identities. External changes while replies wait still reject;
reply acceptance cannot refresh generations, and replaced/dropped owners always
reject. Canonical lexical children search every live ancestor for matching owner
halves and strictly reserve independent halves. Ordinary router capabilities
remain thread-bound; an explicit decoder-only source scope also preserves a
mutable decoder borrowed into a scoped worker with its own compatible router,
joined before parent resume. Source authority expires with ancestor work and is
absent while replies wait; independent resumable siblings remain excluded. No
budget, pending-diagnostic or census TLS propagation is implied beyond existing
worker-local behavior. Acceptance rejects
mismatched owner/configuration, session/sequence/stage, payload, contextual emitter
and captured registry identities before assembly, returning rejected packets
unconsumed. Pending TLS is scoped by owner;
full router diagnostics and cache effects remain leased rather than owned reply
data. Sparse registry traces do not cover every direct/contextual path. Context
remains borrowed and fixed by the private canonical driver. There is no public
async/reply/cancel API or executing-router migration contract.
[Work-boundary qualification](evidence/geometry-platform-work/) records the corrected
source and scoped passing checks; full presentation and platform closure remain open.
See the [current product-session contract](geometry-platform-product-session.md).
[Product receipts](evidence/geometry-platform-products/) qualify the initial
synchronous control layer within their stated scope. Dormant owned state transfer
before numerical work does not establish executing router migration.

Owned production lowering now covers nineteen constructor families. Existing processor
entry points use the same lower/evaluate seams:

| Family | Owned construction and preserved boundary |
| --- | --- |
| Extrusion and tapered extrusion | Admitted sampled regions, holes/disjoint areas, raw direction/depth/Position and existing end-profile correspondence/substitution policy. |
| Revolution | Admitted sampled regions, axis, Position and quality; source plane-angle units resolve to radians. |
| Swept disk and swept area | Sampled directrices, admitted radii/regions, source frames and production sweep policy. |
| Block and sphere | Raw f64 dimensions/radius and primitive Position; sphere retains resolved quality counts. |
| Triangulated face set and irregular-network alias | Source coordinate/index arrays, optional `PnIndex`, closed-shell policy and RTC state; winding, flat normals and textured UV expansion remain evaluation steps. |
| Polygonal face set | Admitted source positions and polygon loops, including holes, before production triangulation/orientation. |
| Faceted BRep and its with-voids alias | Owned f64 face loops before triangulation; standalone/base construction retains the historical Outer-shell policy. |
| Advanced BRep, B-spline surfaces and structural faces | Owned f64 face/surface inputs before triangulation; preserve current trims, refusal and approximation policies. |
| Face/shell surface models | Ordered simple/advanced faces, source failures and RTC inputs before mesh assembly. |
| Structural edges | Sampled f64 edge points before the existing narrow ribbon builder; current precision boundary is retained. |
| Sectioned solids, alignment and linear extrusion surfaces | Owned sampled sections/frames, ribbon samples or curve/extrusion/placement inputs; same production builders. |

The registry declares aliases, typed `ConstructionFamily` identity and processor
creation together. Explicit registration origin distinguishes default/configured
built-ins from caller overrides without constructing a processor for metadata.
Root and boolean-operand dispatch retain their separate policies.

`GeometryRouter::plan_construction_items` now compiles a flat, typed operation DAG
for explicit raw item roots. The iterative compiler retains ordered boolean
operands and CSG dependencies, reports cycles and shares definitions within a
dispatch role. Repeated requested roots retain every ordered occurrence. Evaluation
moves intermediate mesh ownership at the last consumer and clones only when another
consumer still needs it. No recursive operation ownership or source callback is
needed after compilation.

The production solid/solid boolean path and this DAG use the same
`SolidBooleanPlan` numerical step, including exact-kernel admission/rejection and
small-cut policy. This shared numerical seam does not establish equivalence of the
whole operation walk: graph compilation eagerly admits all source dependencies,
uses independent fixed limits of 16,384 nodes and 131,072 compiler work steps, and
does not reproduce legacy conditional source recovery or contextual operand
budgets. The root-count limit separately bounds scheduling. None of these is a
source-payload, kernel-effort or process-memory limit.
Numerical scheduling is demand-driven and retains ordered operands. An empty first
operand skips the numerical second branch of difference/intersection. Unused edges
release ownership iteratively while preserving later shared roots. Source admission
remains eager in this optional `ConstructionBatch` contract. Canonical execution
uses the conditional continuation path described below; delaying graph numerics
does not make eager graph admission equivalent to it.
Router length-unit refusal is retained. A separate monotonic diagnostic-work
budget charges new records and copies before shared-DAG fan-out can expand them;
exhaustion refuses explicitly while bounded results retain loss multiplicity.

The DAG remains **opt-in raw-item execution**, with incomplete product semantics.
Full product/mapping placement and external host openings remain outside the
batch. Its half-space/grouped-cut policies and source-error recovery have not been
qualified against canonical continuation timing and contextual budgets. All
unresolved roots refuse batch evaluation; successful partial geometry is not
published as a complete batch. Constructor Position is applied in file length
units, while router scale/RTC publication and appearance stay outside this API.
Sampled curves and f32 coordinate admission remain explicit precision boundaries.

Successful evaluation exposes semantic boolean losses per unique requested root
and fresh observed failures attributed to source instruction IDs. Structured errors
own prior observed failures, root/item context and captured reports. Face refusal
and curve-cap reports survive thread transfer; capture preserves caller TLS. Decoder
refusal IDs remain a cumulative snapshot rather than per-root attribution. Product
occurrence attribution and complete report compatibility still require qualification.

Next, finish representation and product lowering through these same production
decoders, including mapped occurrence policy and external host openings. Qualify
the canonical continuation separately from the optional eager batch. Complete
product coverage still needs durable occurrence/face/material lineage, compatible
reports and presentation/consumer integration; raw-item graph execution cannot
stand in for canonical element production.

### Cutter and source-control extraction in progress

Production now lowers owned f64 half-space planes and bounded-prism placement/
boundary inputs through the original decoders. Their numerical builders operate
without the source decoder; prism depth remains dependent on the current host.
Grouped-cut numerical execution is separated from source traversal, retaining
trial subtraction, union fallback, removal bounds, repair and acceptance checks.

Void-shell plans own ordered shell construction and deferred faults. Production
still admits and evaluates one shell at a time before reading the next shell or
length unit. The opt-in graph owns Outer and inner-shell plans eagerly, with
separate root/base/operation roles and the operation's diagnostic operator.
Its source-report and unit-admission timing is not yet the production contract.

The polygonal candidate collector now snapshots its source reads into an owned
spine and queries that snapshot without a decoder. This preserves the collector's
SecondOperand-before-FirstOperand read order and current-node stop policy.
The canonical boolean/CSG continuation evaluator is now implemented and consumes
this collector at the reached production transition. Separate
[cutter/control receipts](evidence/geometry-platform-cutters/) retain the prior
extraction's tested scope; historical constructor-family receipts are unchanged.
Separate [continuation receipts](evidence/geometry-platform-continuations/)
record the new canonical control path's tested scope; historical receipts are
not reused as its qualification.

Current stage receipts live under [production-phase evidence](evidence/geometry-platform-phases/).
Those receipts describe the prior phase extraction; they do not qualify the new
constructor batch. Separate [construction-layer receipts](evidence/geometry-platform-construction/)
retain the prior constructor-stage tests and model comparisons. They do not qualify
the extended constructor families or operation DAG. Separate
[operation-layer receipts](evidence/geometry-platform-operations/) cover the previous
operation layer's invariants, raw real-file replay and canonical model comparisons.
The [constructor-family layer](evidence/geometry-platform-families/) records the
expanded nineteen-family source scope and demand-driven diagnostic ownership. Complete
graph and cutover qualification remain pending.

## Implemented canonical boolean/CSG continuations

Canonical boolean and CSG entry points now execute one demand-driven owned
continuation machine in `rust/geometry/src/processors/boolean/continuation.rs`,
`continuation_state.rs` and `continuation_batch.rs`. `process_with_depth` and the
CSG entry point enter this driver. The superseded recursive boolean/CSG operand
walk is deleted; `operand.rs` handles non-recursive built-in leaves and refuses
recursive entities that bypass continuation dispatch.

Frames own the current host mesh, ordered FirstOperand spine, pending operands,
boolean depth, `solo_step`, empty-loss state and provisional failure marks. The
driver owns its admitted active path, while the caller's `OperandPath` carries
path membership and monotonic visits. Error unwinding removes only admissions
made by this driver; caller ancestors and consumed work survive. CSG wrappers
reset boolean depth while retaining the shared active path and visit count.

Source admission interleaves with numerical decisions through the canonical
`EntityDecoder`. `step.rs` separates reached step admission from
`finish_solid_step`; numerical plans own their admitted inputs and share the
existing constructor/cutter/`SolidBooleanPlan` execution seams and exact kernel.
This is an owned execution continuation, not a detached all-branches source plan.
The optional `ConstructionBatch` still compiles eagerly and has a different
admission, budget and recovery contract.

| Canonical transition | Implemented control and remaining preservation proof |
| --- | --- |
| FirstOperand spine | Frames retain the ordered spine and a spine-local seen set. Qualify cycle errors, base admission, output ordering and error attribution against the prior canonical path. |
| Empty host and unknown operator | Difference/intersection skip sequential SecondOperand work for an empty host; DIFFERENCE retains the provisional collector's earlier direct cutter reads. Empty-first union records its loss before admitting the second operand. Unknown operators preserve the host without reading the cutter. Prove dormant malformed operands and refusal state remain dormant. |
| Unreadable second versus admitted leaf failure | `second_operand_or_record` preserves the host for difference/union and empties intersection; reached constructor failures can propagate. Qualify exact loss multiplicity/order and prior losses on error. |
| Half-space / bounded cut | Reached step admission owns the decoded plane/cutter inputs; a kept-side decision precedes contour construction. Preserve bounded subtraction, single-cutter gate, conditional plane fallback, cap refusal and full-host-removal checks. |
| WithVoids operand role | Base/standalone leaves retain Outer-only behavior; operation leaves evaluate ordered inner shells conditionally through existing owned seams. Prove shell/unit discovery timing and failure/skip behavior. |
| Provisional polygonal group | Candidate collection precedes base evaluation as production policy requires. Frames retain its failure mark and pending cutters. Deferral resumes the FirstOperand spine; the existing provisional Boolean records rewind while source reports and consumed visits remain spent. Qualify trial/union/removal/repair acceptance and report channels together. |
| Source and numerical budgets | Boolean depth, active-path bound, monotonic visits and per-element exact-kernel effort remain distinct. No cached result or shared definition may erase occurrence work or failure multiplicity. Qualify cycles, deep acyclic chains, CSG resets, shared-DAG exhaustion and repeated deferrals dynamically. |

The [continuation receipts](evidence/geometry-platform-continuations/) record
native tests and Clippy for their pinned continuation-stage source, WASM checks with fixture skips,
real-file raw replay, the consumer example, six canonical geometry comparisons
and sampled native process high-water marks. These are scoped proofs, not full
product/presentation identity, exclusive-runner latency, browser/retained memory
or complete corpus qualification. Existing phase, constructor, operation, family
and cutter receipts retain their historical scope. These historical measurements do not
qualify the later work-boundary corrections. Their corrected-source qualification
is recorded separately in the [work receipts](evidence/geometry-platform-work/).

The recorded reference-walk check passes for its pinned extraction, but its recursive
call-graph analysis does not follow this explicit frame/work queue. That pass is
not proof of continuation guard safety. Review every frame transition and test
termination, accumulating DAG multiplicity, monotonic work charging, path cleanup
and reported refusal. Capturing reports after execution cannot undo speculative
source reads; preserve conditional decoder timing itself.

## Next integration and qualification work

The [structured scene comparisons](evidence/geometry-platform-scene/) extend
historical ownership-layer proof beyond the geometry fingerprint: actual UV and
texture payloads, frames/instances, symbolic text, metadata and streaming events
match in their recorded corpus. Separate existing IFCX and USD consumers have
[their own receipts](../../tools/smlib-evaluation/scene-comparison/ifcx/).
Unwitnessed channels and later source revisions remain unqualified. Use the same
consumer harness against each newly frozen source layer; do not transfer old
passing counts to new implementation.

The [current context-layer snapshot](evidence/geometry-platform-context-final/)
has a passing full native workspace and all-target Clippy run, fresh consumer
checks, artifact continuity for structured scene comparisons and positive Rust
and WASM material-layer witnesses. Its actual interleaved worker-pool
measurements preserve geometry fingerprints on the measured corpus. Shared-host
timing is unqualified, and slower heavy-model execution with higher peak memory
requires controlled profiling. Keep that risk open through the next source
changes; neither passing correctness checks nor prior-layer measurements prove
performance preservation.

The [owned source/execution design](geometry-platform-source-execution.md) specifies
the remaining reached representation, mapping, texture, type and opening commands,
model-context revisions and cache-effect timing. Its implementation milestones
remain subordinate to the whole-platform preservation gate.

The [product-program contract](geometry-platform-product-program.md) sets the
next implementation boundary: reached source admission, decoder-free numerical
operations and explicit extension leases. The
[resource-admission design](geometry-platform-resource-admission.md) describes
terminal refusal and reservations before output growth. Both remain planned
contracts; owned snapshots and traversal frames alone do not establish them.
The [program preservation review](geometry-platform-program-review.md) records
the concrete admission differences that a shared implementation must test,
including opening probes and late type-map origin handling.

Continue from the scoped continuation evidence and extend the owned model
through representation and product traversal, mapped
occurrence policy, external host openings, presentation and consumers. Preserve
conditional admission while establishing durable source/face/material lineage;
retain the shared production entry point and all existing public coordinate/unit
contracts. Integrating retained SMLib execution still requires an explicit
representation/evaluation policy and durable replayable descriptions. Neither the
canonical exact continuation nor the eager raw-item batch completes that work.

The [owned product-session implementation](geometry-platform-product-session.md)
now owns attempts and scoped accounting with a typed synchronous work boundary.
Next extract finer mapped-source and opening-context commands while preserving
reached source work. Complete emitter-tagged diagnostic transactions before
changing retry/final drain behavior. Internal sequence/stage, owner/configuration
and emitter checks are implemented. Owned context snapshots now add checked
load/source-epoch/revision identity and typed source-expiry rejection.
Authenticated source/index bundles, frame acceptance and complete effect
envelopes remain prerequisites for external reply-driven execution. Retained-kernel integration and consumer migration remain open; moving
an already-executing router/cache owner is not qualified by the initial session.

The [interim source-adapter review](evidence/geometry-platform-context-final/coherent-source-review/review.json)
adds a concrete provenance obligation: an authenticated byte/index pair must
not authenticate unrelated decoded-entity or geometric memo caches imported
through public mutable APIs. The compiled probe demonstrates foreign same-ID
entities surviving both adoption and later cache injection. Revalidate the final
implementation against that case, preserve legitimate same-source prewarming,
and define the explicit compatibility contract for legacy cache transfers.

## Then

Complete typed lowering for the full capability inventory and execute those plans
through canonical per-element production. Add durable source/face/material lineage,
analytic normals and UV behavior, dependency-aware edits and cache invalidation.
Integrate sections, quantities, clash, existing exports and retained USD/BRep
interchange with a versioned IFCX contract. Qualify worker packaging and asset
closure in all supported consumers, process memory limits and model-scale memory,
full-corpus fidelity, cross-target determinism and end-to-end performance.

The [capability ledger](geometry-platform-capabilities.md) remains open until
those proofs exist. Retained-kernel production activation and removal of remaining
superseded orchestration follow coherent qualification, with the exact engine
retained permanently.
