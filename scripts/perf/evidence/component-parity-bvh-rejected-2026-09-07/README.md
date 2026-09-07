# Rejected component parity BVH screen (#4054)

Do not land this candidate. Per-component BVH filtering of exact parity queries did not establish a substantial corpus cold-load gain. The experiment is stopped; this record adds no production implementation.

[screen.json](./screen.json) retains the exact source commits, changed-source digests, frozen candidate viewer manifest, baseline/candidate WASM digests, fixture digests, individual measurements and descriptive cohort summaries. Anonymous model identifiers replace private filenames; source contents, paths and application metadata are omitted. The measured baseline precedes the winding correction in #4058; the documentation parent is not the benchmark baseline.

The screen used one fresh-process Chrome pair per distinct fixture, with the historical eleven and expanded sixteen reported separately. It is not five-pair qualification. Aggregate ratios describe available timings only: they must not substitute for success across the full cohort. Nearby MEP variants do not establish independent lineage gains.

The candidate timed out after 240 seconds waiting for renderer finalization on one small fixture; its baseline passed. Both sides of the largest fixture also timed out closing Chrome after saving functional results. All failures remain recorded. Two completed pairs failed the original raw geometry-channel gate. Normalized entity hashes, bounds and volumes do not prove occurrence, style, normal, winding or closure equivalence. The failed small run has unavailable geometry output, not a demonstrated representation mismatch. No later fix or another candidate's canonical comparison retroactively qualifies this artifact.

The first five pairs used the original harness; the remaining twenty-two used a frozen fixture-aware harness with explicit empty-property handling. This is a screening cohort, not a uniform final acceptance cohort. Broader Firefox, repeated-pair, federation/cache and complete diagnostic/geometry parity qualification were not established. Existing functional checks cannot erase these limits.

Before the screen, the candidate passed geometry library tests, strict workspace Clippy, root Turbo typecheck and real WASM contracts with reported skips. A later test-only extension added exact-hit candidate-superset and distinct padded-endpoint coverage. These checks support the bounded mechanism review; they neither replace the failed end-to-end gates nor imply full issue acceptance.

The lesson is to reject this version rather than extrapolate a classification hotspot into a corpus win. BVH construction overhead is a possible tradeoff, not an attributed cause; no small-component threshold has been justified. Any reconsideration needs a new mechanism or stronger evidence. Independent constraint-recovery and type-reconstruction work retain their own issues and evidence.

The candidate source is retained as plain patches, so inspecting the rejected
mechanism does not depend on private branch refs surviving. These zero-context
patches use `git apply --unidiff-zero` (avoiding whitespace-only context lines). Apply
`measured-candidate.patch` to public commit `96ea5f08e4872cb50fe9eac7a9878ff607eb3f4a`;
its affected base files are byte-identical to measured source `7509432ca`.
This reproduces the two changed files at measured commit `67c3f6d31`.
`later-tests.patch` then reproduces the test-only extension at `bdc38d30c`;
those later tests were not part of the timed artifact. Neither patch is applied
to production by this documentation PR.

- `measured-candidate.patch`: SHA-256 `1ceda5c0b0b9bde477b0a7de487d962a75fadfbd1593a44a48f1186b02b9fb9b`.
- `later-tests.patch`: SHA-256 `abc9e24c8370e535c1a6da4c62c9d8aa2565e09d8665295321adb4fbe6353b5a`.
