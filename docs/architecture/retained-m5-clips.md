# Retained plane clips (M5, #7955)

A Difference with an `IfcHalfSpaceSolid` uses CUT-0's finite prism in the
host evaluation frame and the ordinary retained Boolean executor. Union and
Intersection refuse. `AgreementFlag` uses the exact plane reader unchanged.
A bounds-proven kept-side clip emits no cutter or Boolean. Mapped operands
use the existing affine bake before clipping. A certified empty Difference
refuses the whole product; the original host is never published instead.

## Scope amendment, 2026-10-28

The orchestrator's Round 2 task message explicitly authorized a minimal shared
result/provenance hook in `program/boolean/retained.rs`, plus a trailing
`FailureSite::HalfSpaceClip` and the transaction error match. This amends the
M5 spec's frozen CUT-0 Boolean file restriction; no non-halfspace Boolean
behavior is intended to change.

The hook is `arm_step_result(site: FailureSite, entity: u32)`. It is armed only
when halfspace dispatch returns `Cutter`, not on `Skip`. `retained_solid`
attaches the Difference's logical result, whose numerical outcome is shared
with the executor. `check_step_result` runs at the next spine continuation,
before popping a node or decoding another operand, including after the final
clip. A certified empty outcome preserves the halfspace id and yields
`halfspace_clip` / `consumed` / `empty_result`. This same hook already covers
bounded/boxed cutters once M6's dispatch stubs return a cutter; M6 can choose a
different failure site at the arming point without changing the mechanism.
The hook does not create an empty certificate or interpret an unbound outcome
as empty; authentication remains the executor's responsibility.

The preregistered tolerance file is `tolerances.d/m5.json`, as requested in the
Round 2 task (the original spec called it `m5-clips.json`). No existing
threshold was changed. Test-generated minimal STEP fragments are synthetic
controller invariants; they are not authored-corpus or independently reviewed
fixture qualification.

## Shared source-oracle interface amendment, 2026-10-28

In the Round 2 follow-up answer, the user authorized a **generic, shared**
source-context extension in `retained_compare.rs`, `compare/report.rs`, and
`checks/mod.rs`. Each check now receives `SourceContext { model, product_id,
analytic }`; `model` borrows the shared `Arc<SourceBundle>` so each slice can
read its bytes or create an indexed decoder without another model buffer. A `Deref` compatibility
bridge lets the untouched M4/M6 stubs accept their existing analytic-only
argument until each slice adopts `&SourceContext`. Their dispatcher call need
not change again.

`OracleResult::authority` optionally supplies an independently established
volume, bounds, and curved/linear classification. The report feeds that into
its existing source comparison and `exact_defect` decision; multiple
inconsistent authorities fail. No output column or existing tolerance changes.
The existing six-field `src_oracle` serialization remains unchanged. Empty
per-slice results leave all existing check behavior unchanged.

## Non-schema case (e) amendment, 2026-10-28

The user's follow-up ruling says to put case (e) in a "SEPARATE clearly-named
adversarial/non-schema fixture" and keep it "OUT of the committed coverage
universe and published-count deltas". Accordingly,
`m5-adversarial-nonschema-mapped-operand.ifc` labels its IFC4 violation:
`IfcMappedItem` is not an `IfcBooleanOperand`. Tests pin the observed affine
bake before the clip, typed outcome and native/browser agreement only. It has
no analytic qualification expectation. Schema validation must reject it.

The schema-valid outer mapping bakes after clipping; its affine final output
is deferred to M10. All other candidate qualification cases stay in
`f-e-clips.ifc`, with hand expectations in `expected.d/m5.json` (the task's
slice-name convention also replaces the spec's `m5-clips.json` here).
The survey case places the rotation and offset on the extrusion itself, so
it exercises the plane-to-host transform. The generic chain and curved case
avoid the old fixture's collapsed edges; minimal controller fragments retain
separate deliberately degenerate regression coverage.

## Operation-limit correction, 2026-10-28

The user's boundary ruling keeps the shared 128-operation limit unchanged.
M5 §5's `1 + 2k` lineage formula counted constructions incorrectly: native and
browser count Boolean/Affine operations only. A plain k-clip chain consumes k
operations; cutter constructions consume zero. Tests cover 128 complete
controller admissions, real native/browser 70 and 128 publications, and the
129th operation's atomic `resource_exhausted`, followed by a successful product.
The existing runtime-origin diagnostic identifies the limit (`retained
dependency depth` native, `retained operation depth` browser); it is not a
source-entity refusal. No shared limit or failure taxonomy changes.

Per-step clip timings are observed by an M5 test executor that forwards actual
calls to the real SDK and associates a halfspace prism's sealed receipt with
its Difference. It writes a separate per-product `clips`/`clipMs` summary and
p50/p95, preserving the comparison harness's existing output columns. These
invocation timings are diagnostic, not an exclusive end-to-end perf verdict.

The mutation manifest uses the newly added M5 source-oracle module as its
slice discovery key, because CUT-0 already added `plane.rs` and discovery
requires an added production key. Its reverse-applied behavioral patch still
changes only `plane.rs` to ignore AgreementFlag, and the logical a/b witness
must fail. The key is registration, not the mutation target.

The optional h2 plane touches the actual host surface, but CUT-0's outward
rounded conservative box extends beyond it. It is therefore a contact case,
not a bounds-proven skip. Its volume remains 48. The `max h == 0` no-call
witness instead places the plane exactly on the conservative box boundary;
no padding or tolerance is removed. A separate no-call witness covers h.
