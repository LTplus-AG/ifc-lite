<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# C4 default browser worker-pool timing and peak memory (#8341)

Measurement debt from #8341 ("Measurement debt"): end-to-end browser worker-pool
timing and peak memory for C4-10a/10b/11a/11b, plus the native A/B that C4-10b lacked.
No product code changes. Regressions are named below, not fixed.

## What was compared

- Base `a7164756b7`: main immediately before C4-10a (#8316's parent).
- Head `2f028bb080`: C4-11b #8329, the last C4 lane merge.
- The window is cumulative. Besides the six C4 commits (#8316, #8317, #8318, #8320,
  #8328, #8329) it contains retained M4/M6 (#8324, #8327; #8324 edits shared
  `material_layer_index.rs`, `router/layers/stages.rs` and `program/transactions`),
  diff A1/A2 (#8266, #8271), BIMcollab sources (#8321), IDS (#8315), CI and docs.
  A neutral window means no net regression; it cannot exclude offsetting changes, and it
  does not attribute anything to a single lane.

## Browser cohort (qualified on the host gates)

Driver `browser-cohort.mts` at `f1f661a4`. It reuses the repository cold-load sample
(`browser-cold-ab.mts` sequence: fresh Chrome per sample, empty caches, 4 pinned
geometry workers, cross-origin isolation check, GPU-health refusal, span readiness).
It adds balanced, seeded, randomized within-pair order (`ab-order.mjs`, seed 8341),
kernel peak RSS (`VmHWM`) for every Chrome process before teardown, and an
order-independent SHA-256 root over the retained CPU payload (per mesh: expressId,
colour, positions, normals, indices; plus instanced-only geometry hashes).

Pop, RTX 4000 Ada (Vulkan ANGLE, headed, adapter `fallback=false`), Chrome 156.0.8078.4.
CPU policy fixed (`no_turbo`, max 50%). Exclusive benchmark admission with idle-host
readiness sampled every 5 s throughout: no external builders, no thermal or throttle
events, no policy change, no input drift. Each side has a fresh source WASM build
(Turbo `0 cached`), and the served viewer WASM equals that side's build. Same toolchain
on both sides. 30/30 samples completed: five pairs on each of FZK-Haus, duplex and ISSUE_129.

| Fixture | Observed readiness, Δ (base spread) | Largest Chrome process peak RSS, Δ (base spread) | Browser-tree peak RSS sum, Δ (base spread) | CPU payload root |
| --- | --- | --- | --- | --- |
| AC20-FZK-Haus | −4.1% (±12.3%) | +0.79% (±3.2%) | +0.27% (±1.2%) | identical |
| duplex | −0.5% (±4.5%) | +0.48% (±3.6%) | +0.03% (±1.3%) | identical |
| ISSUE_129 | +0.2% (±3.8%) | −2.0% (±7.4%) | −0.5% (±2.6%) | identical |

Absolute medians and all secondary metrics are in `browser-r2/summary.txt` and
`browser-r2/report.txt`. Raw rows are in `browser-r2/runs.jsonl`.

Against the #8341 targets:

- **Median ≤ +1%:** met on all three fixtures. Every delta is inside the base side's own
  spread. Five pairs cannot resolve a 1% bound when the spread is 4–12%.
- **Peak memory ≤ base:** met on ISSUE_129. Not met strictly on FZK-Haus or duplex: head
  medians are 0.03–0.79% above base, inside the base spread. No memory increase is
  resolvable at this sample size.
- **Output identity:** CPU payload roots are identical on every sample and both sides
  per fixture. Diagnostic console-line digests are identical too, with millisecond
  values normalised and lines matching `refus|diagnos|fallback|failed` (3, 3 and 13 lines).

Reporter flags on ISSUE_129 (named, not investigated or fixed here):

- `spatial-ready` is slower: +11.2%, 1139 → 1267 ms, above its ±11% floor.
- `first-visible` is faster: −12.7%, 1423 → 1242 ms, above its ±2% floor.
- `metadata-complete` +11.1% stays within its ±17% floor.

Stream-complete and observed readiness are unchanged. Geometry becomes visible earlier
and the spatial tree arrives later, which looks like a main-thread ordering shift inside
the window. No commit is attributed.

Scope of the host gates: admission required a ready, idle host. Mid-run sampling recorded external builds, unreadable processes, CPU policy, temperature and throttling, and all stayed clean. It did not record CPU pressure, so a later `cpu_pressure` readiness failure would not appear here. The native resumes below overlapped this cohort, so browser timings may carry that load too. `cohort.py` is kept as the script that ran; its smoke check requires a renderer peak this host never labelled, so that stage would abort on a rerun (the smoke did not run here).

## Native C4-10b A/B (`ifc-benchmark`, reviewed ab.sh protocol)

- **Layer 1, #8317** (`70da3ece1b` → `5287a9a5bb`): complete five randomized pairs.
  Mesh, vertex and triangle counts are identical on all fixtures. TOTAL: FZK-Haus 0.0%
  (±5.2%), duplex +1.0% (±4.0%), ISSUE_129 −0.2% (±4.4%). No phase moves beyond noise.
  The adapter marks it `qualified: false` only because the reporter's `inconclusive` flag
  fires: ISSUE_129's `lookup/styles` and `preprocess` phases are 0 ms on both sides,
  below timer resolution. That flag is structural for this fixture under this reporter;
  rerunning cannot clear it. Receipts: `native-c4-10b-l1/`.
- **Layer 2, #8318** (`c0acc2d4ab` → `79cda2ec79`): complete five randomized pairs
  (`-r3`). Counts are identical. TOTAL: FZK-Haus 0.0% (±10.3%), duplex 0.0% (±1.0%),
  ISSUE_129 +0.15% (±3.6%). No phase moves beyond noise. Same structural `inconclusive`
  flag as layer 1, so `qualified: false`. Receipts: `native-c4-10b-l2/`. The earlier
  `-r2` measurement was refused by the adapter's single-shot readiness check
  (`cpu_pressure`, avg10 36%, no registered builders) before any round ran.

Host overlap: both native resumes started while the browser cohort was running, because Pop was never idle otherwise, so their readiness checks overlapped the browser run lightly. Treat both the native and the browser timing deltas as weaker evidence than an idle-host run. Mesh, vertex and triangle counts are unaffected.

## Not measured, and why

- Per-lane browser attribution for C4-10a/10b/11a/11b. One cumulative pair was measured
  to stay within hours.
- Renderer and GPU-process peaks as separate classified rows. Chrome rewrites its process
  titles into one space-joined string, so the driver's NUL-split `--type=` lookup labelled
  every process `browser`. The largest-process row is a re-scoring of the recorded
  per-process kernel peaks (`summarize.mjs`), not a classified renderer measurement.
- GPU buffer or pixel identity. The payload root covers the retained CPU payload only.
  Structured `PipelineDiagnostics` were not compared, only the console lines above.
- The default pool size on other hardware (the benchmark pins 4 workers), OS file cache
  state, search, properties and picking.
- The ordinary-admission headless smoke never ran: it timed out after 3600 s queued
  behind another session's job on a shared cache lane. The exclusive measurement was
  submitted with the identical committed request instead (`submit-measure.py` on Pop).

## Attempts and receipts

`receipts.json` lists every request, job, exit code, error and receipt SHA-256.
Superseded or failed attempts are kept, not replaced:

- Browser measure attempt 1 (`e09e214a`): every sample recorded `ok=false` at the
  payload step, `ReferenceError: __name is not defined`. tsx keeps function names by
  wrapping named closures, and that helper does not exist in the page. Fixed in
  `f1f661a4` by passing in-page code as source text.
- Three native preparations were refused before start by Pop's disk guard
  (626.9 GiB free < 634–684 GiB required with four storage slots reserved).
- Native layer 1 `-r3` and layer 2 `-r2` first deferred with `host not ready`; both
  were resumed under their original IDs. Layer 2 `-r2` then failed its single-shot
  readiness, and `-r3` completed.

Commands (on Pop, outside any reservation):

```sh
# browser builds, smoke and first measure (driver f1401184), then the corrected measure
python3 tests/evidence/c4-browser-8341/cohort.py setup f1401184ea05a8cdd8fc301a04c68e9a5ba7b0a9
python3 cohort-r2.py remeasure f1f661a4349b9d2b7db5a490e6d829294ef36cc7 r2
# native C4-10b, fixtures copied and hash-checked against tests/models/manifest.json
~/build-workers/ifc-benchmark run --cwd SRC@5287a9a5bb --base 70da3ece1be6a9b19730cb894d033ee30167650d \
  --id c4-10b-l1-native-8341-r3 --iters 5 --fixture AC20-FZK-Haus.ifc --fixture duplex.ifc \
  --fixture ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc
~/build-workers/ifc-benchmark run --cwd SRC@79cda2ec79 --base c0acc2d4ab9f5d6944183fc45fbc6d9154f448c1 \
  --id c4-10b-l2-native-8341-r3 --iters 5 --fixture … (same three)
# re-score the recorded rows
node tests/evidence/c4-browser-8341/summarize.mjs tests/evidence/c4-browser-8341/browser-r2/runs.jsonl
```
