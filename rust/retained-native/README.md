<!-- SPDX-License-Identifier: MPL-2.0 -->
# Retained native driver (M1, experimental)

This unpublished crate binds the shared processing controller to an isolated
SMLib worker. Enable `retained-runtime` explicitly. Default builds keep the exact
pipeline and introduce no SMLib dependency into published processing.

`run_model_native(source, worker_path, options, sink)` emits one atomic outcome
per canonical product job. It never retries a failed product or falls back to
exact geometry. A replacement worker qualifies its own numerical families.
`max_restarts` caps fault recovery at three replacements per model, including
failed qualification attempts. Settled source/product refusals retain the
healthy worker and release their receipts, including buffer-budget refusals
after a complete reply. Cancellation with work still in flight retires its
captured worker. The first sixteen controller-owned replacements per model are
uncharged; further replacements spend the fault recovery budget. No cancellation
refunds earlier faults. `ModelSummary.restarts` reports charged recovery attempts.
An invocation fault takes precedence over an elapsed product deadline, and a
domain retired by the executor always requires charged recovery.

Published parts contain f64 object-local metres and column-major placement
matrices into absolute IFC Z-up world metres. Every product carries
`PresentationObligationsUnmet`. Completed opening cuts and plan-proven unvoided
products discharge `OpeningClosure`; material, appearance, and persistent-face
obligations remain. Final affine-only values remain
`incomplete` in M1. `require_final_product` still refuses.

Build the real worker using `native/smlib-adapter/README.md`, then run from the
repository root:

```sh
IFCLITE_SMLIB_WORKER=/path/to/ifclite_smlib_worker \
  cargo test -p ifc-lite-retained-native --features retained-runtime
cargo run --release -p ifc-lite-retained-native --features retained-runtime \
  --example retained_compare -- --worker /path/to/ifclite_smlib_worker \
  --out /path/to/results --committed --gate
```

Machine admission policy also applies to these commands. The comparison writes
`summary.json` and `products.tsv`. It merges the frozen `tests/fixtures/cli-retained/tolerances.json` base with
all `tolerances.d/*.json` files in that directory, rejecting duplicate top-level
keys with both filenames. New slices add `tolerances.d/<slice>.json` in their
own first commit; never edit existing keys, widen values, or move keys out of
the base. Each fragment is a JSON object of new preregistrations;
there is no command-line tolerance override. `--manifest tests/models/manifest.json`
selects downloaded fixtures. Engine startup/qualification must succeed before any
coverage is reported. Orphan type products are retained candidates since M9; an
exact type mesh missing from the candidates is listed separately as an
“unexpected exact-only type product” and is a universe mismatch.
Missing files are reported explicitly and fail a
gated run. `--bless` updates the committed coverage manifest only after a clean
committed-fixture comparison and is forbidden whenever `CI` is set.

Memory values are Linux `getrusage` lifetime high-water marks, not isolated
per-phase allocations. Timings include worker startup and qualification. These
ordinary qualification runs are not an exclusive-host performance verdict.

Without `IFCLITE_SMLIB_WORKER`, native geometry witnesses print a skip message.
Setting `IFCLITE_REQUIRE_SMLIB` makes that absence a test failure; the
geometry-platform native lane sets it.
The inert transport, restart budget, async cancellation, admission, and oracle
witnesses require no SDK. Inert peers cannot construct geometry receipts.

The comparison keeps one qualified worker across the corpus. Initial qualification
and later acquisitions are reported separately from product milliseconds; use
`--release` for reported timings. Exact comparison rounds retained world points
in exact's own storage frame (RTC, rotation and per-mesh origin) to f32 before
measuring. Source volume and bbox checks still measure full-f64 retained geometry
at the unchanged preregistered tolerances. Refusal rows retain kernel status,
origin site/entity/cause, and the original error message.

Committed expectations: `issue_1985_scaled_kinds` #74 is `incomplete`; #81, #88,
#109 are `operation_unsupported`; #99 publishes. For `issue_098_wall_W`, only wall
#928204 is `opening_unsupported`; its seven windows publish and its seven opening
elements are `operation_unsupported`.

M3-0 adds source-only opening oracles under `oracle::openings`: exact line/arc
Green integrals, height bands and inclusion–exclusion for up to eight convex
cutter values with parallel world extrusion axes; nominal volume bounds and
linear-host bbox containment. Unsupported prism families return no prism
expectation. The oracle never changes a product outcome. The opened-product
exact comparison is report-only; f64 source measurements are the gate.

The comparison TSV adds `cuts`, `cutMs`, `consumedParts`, `src_cut_vol_rel`.
M3-A records each admitted Difference separately, with elapsed cut times in
`summary.json`; published rows report their cut count and total cut time.
Certified consumption refuses the whole product with `empty_result` and an
`opening_cut` origin. Material layers refuse before host or opening work. The cut
volume field is empty when no published cut can be compared. `summary.json`
lists supported extrusion openings and every opening without analytic
quantities. The committed universe adds issue_2019 and issue_3641; the latter
observes current codes only. `f-d-openings.ifc` is unreviewed and does not count.

The **2026-10-27 CUT-0 Round 3 orchestrator message** revises the M1 exact-linear
comparison rule: the independent source-derived volume oracle is authoritative.
When retained passes its preregistered source-volume limit and exact exceeds
the exact-volume limit against that same source value, the product's exact
comparison is `exact_defect`, report-only. `summary.json` lists these products,
the source/retained/exact volumes, retained-vs-source and exact-vs-source relative
deviations, and retained-vs-exact volume/area/bbox deviations. Without a source
oracle, or when retained fails it, the exact gate applies unchanged. Source
volume, source bbox, closure and nonfinite checks still fail independently.
This documented deviation changes no tolerance and adds no per-product allowlist.
