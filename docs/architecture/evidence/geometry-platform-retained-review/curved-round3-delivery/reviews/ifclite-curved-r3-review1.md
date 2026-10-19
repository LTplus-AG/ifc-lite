# Independent curved round-3 source review

Verdict: two concrete blockers in committed `ffbf40aa869e3d6b50218609bb7b2e53e3a67300`: a native Rust compile error and a contradictory unconditional circle test. No additional definite geometry/authority defect was established by this inspection. This is source review, not execution qualification.

Reviewed the round-3 delta after `bf94476593`, with parent base `390c218c6f` and inherited integration `ccea8d2365`, prior reports/responses under `/tmp/ifclite-retained-authored-preservation-round2/reviews`, and the actual SDK at `c9c5979f04cea8c38213004d4f04df0dcfb40d05`. Companion hashes distinguish committed repository bytes, observed working bytes, prior evidence and SDK files.

No edits to repository/SDK source, builds, tests, compiler probes, heavy jobs, checkouts, publication, delegation or job retries were performed. Only the two requested `/tmp` artifacts were written. Fleet status reported Pop/PC reachable, Mac disabled, and current Pop admission allowed; this does not qualify execution or supersede the supplied history of guard78/PC capacity failures. Native SDK, actual module/browser, workspace, Clippy and performance remain UNRUN/UNQUALIFIED here. Numerical witness source and historical protocol-only checks are not geometry execution evidence.

## P1: untyped integer record prevents native runtime compilation

`rust/geometry-runtime/src/worker_disk_qualification.rs:48`:

```rust
for v in [4,0,if curved {2} else {1},if curved {3} else {2},2,0] {
    b.extend(v.to_le_bytes());
}
```

This array has no concrete integer type. The byte-vector result cannot infer an integer width from `to_le_bytes()`: u32/i32/u64 etc. all produce bytes accepted by `Vec<u8>::extend`. The receiver is therefore an ambiguous integer, the E0689 case. The typed u32 array at line46 is a different local `v` binding and supplies no constraint. This module is included unconditionally on native builds through `worker.rs`, so the error is not confined to an optional SDK-gated test or a qualification method that happens not to be called.

Narrow repair: start this array with `4u32` (or declare `[u32; 6]`), preserving the six LE-u32 wire fields. No protocol change is needed. Confirm with admitted assembled compilation after the source correction; no compiler was run by this review.

## P2: unconditional circle test still asserts the removed source-admission gate

`rust/processing/tests/retained_authored_evaluator.rs:258-264` builds `model(true)` and requires `AuthoredRetainedDocument::admit_source(..., 1, 1)` to return `InvalidSource`. The same file's revised test at lines46-61 explicitly includes `circle=true` and unwraps source admission/preparation/lowering for the same generated model. Both cannot pass.

The implementation agrees with the new successful-admission invariant: `retained.rs:267-309` accepts complete captured circle boundaries, `retained_region.rs` marks them `OrderedRegion`, and `worker_sweep.rs` checks `regions_qualified` immediately before SDK upload. Source epoch/revision values1/1 versus5/7 do not select a different geometry gate. The stale test is unconditional and will fail after compilation is fixed, even without an SDK executable.

Narrow repair: replace the stale source-refusal assertion with the new separation contract: source admission/lowering succeeds and requires `OrderedRegion`; an actual fresh worker refuses execution before qualification and remains usable; same-incarnation qualification then permits execution, while a replacement must qualify independently. Keep actual SDK assertions environment gated and report their execution honestly. Do not restore the old admission refusal just to satisfy this test.

## Source, coefficients and frames

The retained construction enum is consumed by the existing document/request boundary and runtime evaluator. Extrusions lower through the ordered-region path; swept disks lower through format2. These are owned numerical recipes from the existing analytic walk and bound plan, not an additional IFC loader or a sampled fit. Exact/default routing is unchanged in this delta; retained remains explicit, with no automatic replay or fallback.

Region lowering retains original records separately from derived traversal. It checks ordered outer/inner roles, complete capture, bounded curve counts, XY basis, connectivity and signed area. Derived boundary reversal changes only evaluation curves. Circular radians reach the existing numerical adapter; the source selectors, basis, traversal metadata and plane-angle scale remain separately owned. Rectangle qualification is determined from both profile identity and actual rectangle geometry. Other supported regions require the private runtime qualification state.

Rational extraction retains Euclidean controls, weights, degree, unique knots and multiplicities, plus derived expanded knots and active interval. Forward parameter-master trims are admitted explicitly; unsupported trim conventions retain originals and refuse numerical ownership. Solid bounds restrict the original rational domain; bounds layered over an already trimmed rational directrix are refused. The legacy line/arc status remains Unsupported for rational geometry with empty legacy segments; the separate owned rational payload supplies retained planning admission. A finite occurrence frame is still required, and source-only coverage requirements remain present.

Format2 subtracts the first control as a local anchor, converts controls/radius to metres once, and retains inverse scale plus anchor outside the SDK. Original knots, weights and active parameter values are not normalized or fitted. The actual pinned `SmBSplineCurve::CreateCanonical` header takes Euclidean controls, matching multiplicities/knots, optional weights and trim interval; the used pipe producer exists. Its source creates a new BRep and uses the path for the sweep. This validates API correspondence by inspection, not successful SDK geometry.

The earlier review's nonunit line concern does not apply to these bytes: `curve_source.rs:87-102` normalizes DirectionRatios in `vector_from_ref` before `line_basis` multiplies Magnitude. It is not a blocker and needs no repair from this review.

Immutable Boolean dependencies compose occurrence and evaluation frames, validate positive rigid metre frames, and compute inverse-left times right with translation subtraction before rotation. The adapter copies before transforming; its Boolean path preserves operands. Temporary transformed solids are released after the operation, tessellation failure releases the new result, and cleanup failures retire the captured domain. Result lineage describes evaluated dependencies without asserting complete final-product coverage. No definite scale/frame defect was found in this inspection.

## Capture, object lifecycle and authority corrections

Capture failure now clears the provenance graph, disables further capture and latches `capture_status` independently of interpreted geometry. Its bounded record/value traversal can refuse capture without turning a valid legacy line/arc result into partial successful geometry or changing its Complete status. Rational ownership and retained source admission require complete capture. The new budget/malformed-edge tests assert behavior, not source text; they were not executed.

Raw release removes the object's tracked Arc and sets its AtomicBool false before the command. Both sealed source realizations and retained dependency results test that object flag together with actual process liveness. Slot/generation reuse obtains a fresh flag, so a released realization cannot regain validity merely because its process survives or another object is allocated. Release failure retires the process; intermediate tessellation meshes use the same tracked-handle path and release cleanup. The new release-before-accept source test exercises the relevant model-bound rejection, but remains UNRUN.

Existing bound admission continues to validate the actual decoder/source pairing, reuse its execution lease/cache, and retain only a small lifecycle capability in the numerical/document owner. Canonical execution/acceptance uses private pending tickets and the sealed immutable runtime packet. Acceptance authenticates the ticket before source-expiry retirement. Public standalone packets cannot manufacture that receipt. The new enum does not bypass these barriers or introduce a second authority source.

## Residual scope and next work

Rational planar regions are still unsupported; hollow, closed and multisegment disk routes remain refused. Reverse/Cartesian-master rational trims, periodic/unclamped splines, general unsupported curve families, scale/shear/reflection, robust self-intersection certification and complete presentation/UV/persistent-face behavior are not qualified here. General rational source admission is not a statement that every admitted SDK pipe succeeds.

Full final-net ProductProgram integration/accounting is owned by the sibling effort: this source/dependency slice does not prove complete representation coverage, all Boolean/opening dependencies, complete application/native-browser integration or final-product receipts. Retained USD and other unimplemented consumers remain incomplete. No performance or hard process-heap bound is established.

Next concrete work: fix the u32 annotation and replace the stale circle gate test; checkpoint the assembled source, then obtain admitted native build/CTest, workspace tests and verbatim workspace Clippy evidence, followed by actual module/browser qualification and the required base/branch performance evidence. Exercise the new source routes through bound authority and same-incarnation gates, including release/restart and rejected/abandoned cleanup. Keep the exact default permanent and all residual refusals intact.

During inspection the repository acquired an unstaged wording-only change to `rust/geometry-runtime/src/worker.rs` and untracked `rust/processing/tests/retained_curved_consumption.rs`. Neither is part of this committed verdict; both were preserved. The SDK had no tracked changes; its untracked build/tool directories were preserved. No foreign source, credentials, job, lock or immutable evidence was changed.
