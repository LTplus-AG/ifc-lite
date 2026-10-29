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
`checks/mod.rs`. Each check receives `SourceContext { product_id, analytic,
clips }`. The model-scoped `ClipOracle` borrows the shared `Arc<SourceBundle>`
and analytic sources; it resolves opening relationships once per model. A `Deref` compatibility
bridge lets the untouched M4/M6 stubs accept their existing analytic-only
argument until each slice adopts `&SourceContext`. Their dispatcher call need
not change again.

`OracleResult::authority` optionally supplies an independently established
volume, bounds, and curved/linear classification. The report feeds that into
its existing source comparison and `exact_defect` decision; multiple
inconsistent authorities fail. No output column or existing tolerance changes.
The `src_oracle` column also records per-part source curvature and executed
clip status; these diagnostic fields do not alter the geometry API. Empty
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

## Shared section integrator amendment, 2026-10-28

The orchestrator's Round 3 implementation task explicitly authorizes repairing
generic near-coincident breakpoint handling in CUT-0's `oracle/sections.rs`,
provided the tolerance and work cap remain unchanged, the exact FZK input has
a failing-before regression, and CUT-0 oracle outputs and coverage are rerun
with unchanged expectations. This supersedes the frozen shared-file restriction
only for that numerical robustness repair.

FZK wall #67536 produces adjacent events `0.6732050807569754` and
`0.6732050807569755`. The integrator previously rejected their first bisection
before testing convergence. It now evaluates that final representable level
against the same `1e-13` relative criterion, then refuses precision exhaustion
if it has not converged. The 2,000,000 work cap, area checks, topology events,
and acceptance tolerances are unchanged. Previously converged levels follow
the same arithmetic. The regression reconstructs the exact trapezoid and
plane, verifies the adjacent events, and compares with its hand integral.

## CI scope of the real-corpus witness

CI runs the synthetic three-chain witness (`m5_three_chain`), the committed
FZK/issue_5314 corpus products and the lineage boundary. The BURKWIL beam
#4548 witness needs a model that is not in the repository and CI does not
download it. It runs locally with `IFCLITE_BURKWIL=<ifc>`; set
`IFCLITE_REQUIRE_BURKWIL=1` to make an absent model fail instead of skip. It is
therefore not in `tests/evidence/m5/witnesses.txt`.

The native lane writes the M5 browser parity references to
`$RUNNER_TEMP/native-references/` (`IFCLITE_M5_REFERENCE`,
`IFCLITE_M5_LINEAGE_REFERENCE`). The workflow copies every `*.json` found there
beside `/smlib`, the same copy-if-exists rule as the M3 reference, so later
slices add a reference by naming a file, not by editing the staging step.

## Oracle scope and parity qualification, 2026-10-29

The outside-in source walk preserves planes collected before reaching an inner
Union or Intersection: those outer clips execute last. For an unknown subtree,
kept-side and closure remain gated; unavailable volume/section predictions are
explicit report-only records, never a silent omission of the product.

Clip section and bounds thresholds are chosen per part. The curved threshold
requires both independently decoded curved source and a plain-plane Difference
in that part's sealed host receipt lineage. Skips and clipped opening cutters do
not qualify a host. A skipped clip retains kept-side, closure and volume bounds;
its nominal tessellation uses the ordinary source oracle. Product-level parity
uses 1e-7 only when every part qualifies and the source gates pass; otherwise it
uses 1e-9. No tolerance value changed in this round.

Exact defaults a missing or unreadable `AgreementFlag` to true. Retained keeps
that behavior for exact parity; the independent oracle reports invalid mandatory
source instead of adopting the default.

## M11-F face-source composition

A sealed `PrismRole::HalfSpace` contributes exactly the authored plane at cutter
z=0, with role `halfspace` and item equal to the `IfcHalfSpaceSolid` id. Its
outward normal is -Z before Difference reverses the cutter orientation. The
lineage's existing sealed transforms place that source face in each result.
Finite cutter sides and its far cap are construction aids, never source faces.

Plane support coincidence uses non-collinear plane probes with the existing
incidence threshold. The existing bounded-extent and left-operand tie-breaks
remain in force. The stepped M11-F fixture checks separate hand-derived areas
for the cut face and the disjoint flush host step; native/browser parity also
checks their keys and per-key areas. No M11-F refusal or tolerance is waived.
