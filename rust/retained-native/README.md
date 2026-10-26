<!-- SPDX-License-Identifier: MPL-2.0 -->
# Retained native driver (M1, experimental)

This unpublished crate binds the shared processing controller to an isolated
SMLib worker. Enable `retained-runtime` explicitly. Default builds keep the exact
pipeline and introduce no SMLib dependency into published processing.

`run_model_native(source, worker_path, options, sink)` emits one atomic outcome
per canonical product job. It never retries a failed product or falls back to
exact geometry. A replacement worker qualifies its own numerical families;
there are at most three replacements, even if a larger limit is requested.

Published parts contain f64 object-local metres and column-major placement
matrices into absolute IFC Z-up world metres. Every product carries
`PresentationObligationsUnmet`. Shape publication grants no opening, material,
appearance, or persistent-face authority. Final affine-only values remain
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
`summary.json` and `products.tsv`. It reads the preregistered tolerance file;
there is no command-line tolerance override. `--manifest tests/models/manifest.json`
selects downloaded fixtures. Engine startup/qualification must succeed before any
coverage is reported. Exact-only orphan type products are listed separately as
“out of M1 scope”; they never enter the coverage numerator or denominator.
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
#928204 is `opening_strategy`; its seven windows publish and its seven opening
elements are `operation_unsupported`.
