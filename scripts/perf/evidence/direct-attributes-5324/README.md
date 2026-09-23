# Direct attribute construction: rejected (#5324)

**Not shipped.** The candidate uses a single canonical STEP grammar with token
and decoded-attribute construction targets. It removes intermediate nested token
vectors for full decode, while preserving the existing narrow string projection.
The final candidate also compacts directly constructed lists: nominal parser
vector growth must not silently become retained entity capacity.

Measured base: `52d30de0ae3fc8ef6322191bd1831483b93d485f`.
Measured candidate: `dafe2d7e36e0be259df0c74ac9fff238b8ec6861`.
`rejected-candidate.patch` preserves the complete candidate and its tests against
that public base. This evidence PR changes no parser or decoder behavior.

`runs.jsonl` contains every sample from five alternating fresh-process pairs on
seven fixtures. `summary.json` records parse/geometry/total/full-load and RSS
values, model medians and paired ratios; `provenance.json` records artifact and
fixture hashes. The driver includes file reading through the complete processing
return in `fullLoadWallMs`, with `--cold --iters 1 --json --fingerprint`.
No owned build or test ran concurrently. The host was shared and the OS file
cache was not purged. RSS is the whole-process high-water mark, including untimed
fingerprinting and teardown; it is not steady-state retained memory.

All paired ordered mesh fingerprints, mesh/vertex/triangle counts, CSG-failure
counts and dropped-degenerate counts match exactly. That fingerprint does not
cover metadata strings, textures or instance records. The candidate's differential
parser tests separately compare attribute variants and floating-point bits with
the public token parser, malformed/depth-bound behavior, and every record in
three real models. Core tests passed after compaction. The strict clippy run
predated the final compaction adjustment; it is not reported as final-head
workspace qualification.

The full-load changes were mixed. The school model improved in most pairs, but
that did not establish a broad win; several controls had slower medians, and
Holter was variable. These results neither qualify the candidate nor isolate a
causal Holter regression. The common `decode_by_id` / `decode_at_with_id` cache
hits already return before parsing, so merely restoring a cache-hit fast path is
not an evidence-backed explanation for these measurements.

Per the issue's stopping rule, the experiment ends here. No candidate WASM
worker-pool performance cohort or complete final-head workspace qualification
was run. No browser benefit, universal regression absence, or memory reduction
is claimed. The earlier one-pair development screens overlapped builds/tests;
their timings were not used to qualify this change.

## Reproduce

Use separate clean checkouts at the base above. Apply `rejected-candidate.patch`
to one checkout. With the pinned toolchain, build each artifact independently:

```sh
cargo build --profile profiling -p ifc-lite-processing --example perf_probe
```

Copy each executable to a distinct immutable path, install the fixtures with
`pnpm fixtures`, and adjust the root/output/binary paths in `runner.py`. Run the
driver on an otherwise-idle machine. It refuses an existing output directory,
retains every sample, fails on an unsuccessful invocation or output mismatch,
and never replaces the original cohort with retries.
