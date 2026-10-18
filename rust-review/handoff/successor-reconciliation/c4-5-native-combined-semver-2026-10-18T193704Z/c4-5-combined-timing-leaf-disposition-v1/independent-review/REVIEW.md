# Independent review: exact saved timing-leaf disposition

**APPROVE the precise two proposed entries for the listed saved witness only. No blocking findings within this narrow review.** This is independent disposition under the existing `EXACT_TIMING_LEAF_NONDETERMINISM` template, not application of the proposal or acceptance of broader qualification.

Reviewed proposal SHA256: `b6c3bdd6aa0a99a9695ad252f1adfd834bacf2a036d0ddcbac26af4ecda2e0d4`.
Reviewed `BINDINGS.json` SHA256: `ed4bd1a8bca588614520652949cebbb8840ae2b3ba8cc49c6d09ead56f422847`.

## Exact approved bindings

Both entries bind source commit `fc3635ae78665e95ea72328b88fc7b28ead148d2`, tree `4b3c4fd5a98faec9f74c70a2b2d9e2f4d03f0fe5`, fixture SHA256 `65b04e28e8f2d06ac8bcf3bf0d57264f168456d09865c3353fb802a5e66ee0c0` (64,373 bytes), and arm `observation-noninterference-wasm`. Both receipts use the direct combined `once` route with the same recorded default settings.

- `FC_Q0_REViT_ONCE_GEOMETRYMS_41_TO_43`: only `/diagnostics/0/phaseMs/geometryMs`, actual plain value **41**, actual observed value **43**.
- `FC_Q0_REViT_ONCE_TOTALMS_41_TO_43`: only `/diagnostics/0/phaseMs/totalMs`, actual plain value **41**, actual observed value **43**.

For each entry, SHA256 of the left scalar's comparator representation is `3d914f9348c9cc0ff8a79716700b9fcd4d2f3e711608004eb8f138bcba7f14d9`; the right scalar's SHA256 is `44cb730c420480a0477b505ae68af508fb90f96cf0ec54c6ad16949dd427f13a`. These are hashes of `41` and `43` under the actual schema hash function, not receipt hashes.

The only approved receipt pair, in plain-to-observed order, is:

- `../../c4-5-native-combined-runtime-v1/pc-results/combined-plain-revit-wall.json`: SHA256 `097f9c2fb717a6dfb306f664f8ec87da853df88c5abe13d41e2e85205080dc54`, 937,258 bytes.
- `../../c4-5-combined-observed-runtime-v1/pc-results/observed-revit-wall.json`: SHA256 `918b7a760c5e520e0b70a2337e8712730c92fee7a996b1d233c40bde3229c1a4`, 950,879 bytes.

The full plain/observed provenance objects in the reviewed `BINDINGS.json` exactly equal those in these receipts. All ten listed bound files match their size and SHA256. The runtime, helper, case-plan, instrumentation and settings identities in those provenance objects remain part of this approval.

## Authority and evidence

I read the original full `EXPECTED_DIFF.json`, including its binding policy and timing template. Its SHA256 remains `7bbbb5045ff3c62b8af6e233d56e19b045ce5eaf53bd0e501a8ca029fcfbb448`; its entries remain empty. The actual copied policy is byte-identical. The proposed separate leaf paths, exact values, source/fixture/arm bindings, named producer authority, condition and removal trigger satisfy that template without relaxing it.

The owned ordinary source `rust/wasm-bindings/src/api/gpu_meshes/batch.rs` starts the timer with `js_sys::Date::now()` at line 118 and computes `(Date::now() - batch_started_ms).max(0.0) as u64` at line 642. It passes that elapsed value to `record_pipeline_batch` at line 647. `api/pipeline_diagnostics.rs:46–73` forwards it as `geometry_ms` to the shared accumulator. `rust/processing/src/pipeline_diagnostics.rs:174–175` adds the same value to both `phase_ms.geometry_ms` and `phase_ms.total_ms`; camelCase serialization produces the two named public leaves. This is one elapsed-clock measurement represented in two fields. These definitions support exact timing-leaf disposition and provide no causal explanation for the observed difference.

I inspected the actual staged observation patch, adapted input patch and original V5 patch. The adapted input differs from the original only in the scan hunk's current source line/context after `append_orphan_jobs`. The actual staged patch binds index tree `5157e4080c774195bfc08d359ad49b8d32500721` and SHA256 `0d4b47ed71d19230bfa75921c41c5868de0f0a4b48e4e59ba5c9d8a2e3a0bae4`; the adapted patch SHA256 is separately `ca697f59286651e6dddd257723ed016d92485159a759fc2d62e63f6f45716b94`. The batch observer hunk records `batch-input` after the timer start, with job/element observations inside the measured production boundary. It does not change the timer producer or the two accumulator assignments. This boundary observation does **not** establish that observer overhead caused the 2 ms difference.

I read the base comparator, effective V5 comparator/schema, actual copied comparator/schema and capture producer. The copied comparator is byte-identical to effective V5 (SHA256 `5e660df5173fc211ee3b9ed677a29299f9902fbacdd49e3562ebb3164ab81f65`). The actual copied schema retains V5 checks and adds explicit combined-return field availability and actual once-observation job-wire/order checks. Plain and observed use identical copied capture/schema bytes. Comparison retains the complete raw payload; no timer, diagnostic, cache counter, geometry field or order is removed.

I replayed only the existing pure comparator with the original empty policy on the saved receipts. It returned exit 1, `INCOMPLETE_UNKNOWN_DIFF`, exactly the two 41-to-43 leaves above, no expected entries and no stale entries. All other raw leaves compare exactly. I did **not** run the comparator with the proposal.

The receipts retain 17 jobs, 40 meshes and 1,771 triangles, mandatory wall 928204, successful before/after input guards and empty error/refusal/cleanup-error arrays. Observed prepass observations are exactly empty; geometry has 69 events: one batch-input, 17 batch-job, 17 element_job, 17 element-result, 15 effective-element-color and two representation-gate. I checked the saved producer reports, worker/original-session terminals, final guards, proof-file hashes and input-copy manifests. They support the recorded clean unchanged production source, unchanged inputs/tools/ordinary runtime, separate unchanged instrumented source and successful cleanup. This review made no new host, queue or process inspection.

The original observed worker `0b8d0c8b-d6bd-4065-90bf-3e941963d378`, session 63233, remains **failed, exit 1**; its observed build and capture exited 0 and its only recorded primary failure is the strict comparison. Its saved raw failure is unchanged. The native56 saved output is byte-identical to its saved baseline61 output under that existing corpus contract/normalization; this is separate context and supplies no performance or native/public parity clearance.

## Conditions and limits of approval

Approval is only for a separately bound pure re-comparison of the exact saved receipt bytes above, using the reviewed proposal and bindings. The comparator enforces fixture/source/arm/path/value hashes; it does not itself enforce capture-file hashes or interpret the prose condition/removal text. The parent's bound invocation must therefore retain and verify this exact-pair restriction. A comparator match alone cannot authorize another pair.

Retire both entries if either capture, fixture, source, runtime, instrumentation, settings or binding changes, or this witness comparison is retired. No future-run reuse, automatic exception generation, retry, blanket timer rule, whole diagnostics exclusion or policy relaxation is approved. Preserve the frozen original policy and original failed worker/comparison.

No claim is made that this difference is observer overhead, regression, noise, speed, or equal output performance. Broader C4-0, same-source native/public, serial/columns/once route coverage, baseline/current corpus coverage, performance, current-main integration, publication and closure clearance remain unapproved. Other outstanding requirements and earlier failures remain binding.

Only this review file was written. No source, proposal, capture, original policy, worker evidence or global state was edited; no production import/execution, build, WASM/browser workload, new test or further review task was run.
