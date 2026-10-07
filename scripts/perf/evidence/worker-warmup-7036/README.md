# Worker warm-up candidate (#7036)

This preserves the original session's completed immediate and settled cold-load
captures. The candidate starts engine initialization and creates fresh geometry
workers while the file is read. Used workers are still terminated after each
load; persistent reuse was rejected by the original session for retained memory.

**Verdict: held for further measurement.** Worker initialization moves earlier,
but first-visible and total-load results are mixed. Earlier worker readiness
alone does not establish a user-visible speedup. Issue #7036 remains open.

[`summary.json`](summary.json) records paired medians, unchanged mesh counts,
capture hashes, identical IFC WASM binary hashes and the evidence limitations.
Raw records are [`f-immediate.jsonl`](f-immediate.jsonl) and
[`f-settled.jsonl`](f-settled.jsonl). Counts are not a geometry byte-identity
witness. The inherited captures have no retained JavaScript build manifest,
device-health witness or proof that the machine was otherwise idle.

The original batch continues under `flock /tmp/ifclite-perf.lock` from
`/tmp/7036-rig/run-all.sh`, using frozen bundles in `/tmp/7036-dist-base` and
`/tmp/7036-dist-branch`. Its repeat/federated stage overlapped local validation
builds during takeover, so those rows must be retained as contaminated evidence
and repeated on an idle machine. The large-file and cache-hit stages have not
completed at this checkpoint.

Before accepting the candidate:

- Rebuild both sides from recorded commits and preserve bundle manifests.
- Repeat cold, replacement, federated, large-file and cache-hit scenarios on an
  otherwise idle machine, with the real-GPU rig and paired ordering.
- Collect ordered geometry hashes and mesh/triangle counts, device-health
  evidence, and idle/peak memory as well as first-visible and total-load time.
- Verify fresh-worker disposal, cancellation, failure recovery and bounded idle
  memory through the existing behavior tests.
- Resolve the issue's persistent-reuse requirement explicitly: this candidate
  only overlaps fresh worker creation and does not eliminate repeat-load spawn.
- Complete the campaign's review and rollout requirements before enabling or
  merging a user-visible optimization.

The next independent T1 lever in the charter is #7035: migrate drawing markup
keys to the load's placement identity, preserving legacy markup while removing
the second full-source hash on loads without legacy data.
