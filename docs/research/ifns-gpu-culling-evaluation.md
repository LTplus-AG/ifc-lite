<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

# IFNS GPU culling evaluation

Status: **dropped — the implementation was removed, this record is kept**

Decision date: 2026-09-14. Implementation removed the same day.

## Decision

The WebGPU compute-culling experiment is not approved for production, and the
code has been deleted rather than left dormant. This file is retained on its
own: the corpus run below cost 161 fixtures and 1.054 GB to produce, and it is
the reason not to attempt the same design again without first solving the
picker divergence.

The implementation landed in `04fbc7578` and was reverted. Recover it from that
commit if the acceptance gates below are ever worth completing; the revert is a
clean inverse, so `git revert` of the revert restores the whole experiment
including its corpus harness.

The original version of this note said the code "may remain temporarily for
reproducibility" and that it should be deleted if nobody intended to finish the
gates. Nobody did, and it went further than dormant: the experiment put main
red on four CI lanes, because it landed without the typecheck, lint and
Node-tests gates passing.

## Why it was dropped

The complete fixture corpus did not show enough broad benefit to justify the
current costs and correctness gap:

- 161 fixtures (1.054 GB) were loaded through the canonical viewer load path.
- 159 loaded standalone. Two IFCX overlay files produced their expected
  load-with-a-base-model message.
- Only 15 models (9.32%) produced IFNS geometry: 114,224 occurrences across
  4,315 templates in the final run.
- At a 0.75 pixel projected-diameter threshold, the tested views removed 13.43%
  of visible occurrences and 13.16% of submitted IFNS triangles.
- Enabling the path allocated 11.41 MiB of additional GPU buffers, 119.04% of
  the original IFNS instance-buffer size, plus 1.74 MiB of CPU bounding spheres.
- The picker still renders the original instance buffer. An occurrence removed
  by projected-size LOD can therefore remain clickable even though it is not
  visible. This is a release blocker.
- Atomic compaction does not preserve source order. Threshold-zero comparisons
  were pixel-identical in 28/30 poses; the other two differed by 22 pixels and
  were also unstable in their same-mode repeats.
- Transparent instanced geometry is kept on the direct path. The corpus run
  covered standalone loads; federated IFNS now uses model-scoped templates, so
  mixed-model correctness and performance still require dedicated validation.
- Repeated canonical loads changed IFNS counts for four large fixtures. The
  largest observed occurrence swing was 4.60%, so fine-grained benchmark
  comparisons require a load/IFNS repeatability investigation first.

No geometry warnings or uncaught page errors occurred during the final corpus
run.

## Performance evidence

The reliable GPU measurements are synthetic timestamp queries on one NVIDIA
Blackwell adapter, using 10,000 occurrences and 30 samples per mode:

| Triangles per occurrence | Visible | Direct median | Culled median | Change |
|---:|---:|---:|---:|---:|
| 1 | 100% | 0.004960 ms | 0.009984 ms | 101.3% slower |
| 1 | 10% | 0.004928 ms | 0.004320 ms | 12.3% faster |
| 1 | 1% | 0.004960 ms | 0.003648 ms | 26.5% faster |
| 100 | 100% | 0.136224 ms | 0.141088 ms | 3.6% slower |
| 100 | 10% | 0.097632 ms | 0.015808 ms | 83.8% faster |
| 100 | 1% | 0.093632 ms | 0.004736 ms | 94.9% faster |

This establishes the shape of the trade-off: compaction is overhead when most
geometry is visible and can win when expensive geometry is overwhelmingly
rejected. It does not establish a production win on real IFC scenes.

The corpus animation-frame proxy was 32.100 ms direct versus 32.095 ms culled.
It includes browser scheduling and two `requestAnimationFrame` waits, so it must
not be quoted as GPU performance evidence.

## Correctness coverage completed

- Real WebGPU shader compilation and direct-versus-threshold-zero pixels.
- Workgroup boundaries at 1, 63, 64, and 65 occurrences.
- All-rejected and mixed hidden/frustum cases.
- Per-frame indirect counter reset.
- Conservative perspective and orthographic projected-size boundaries.
- Isometric perspective and top orthographic corpus poses.
- Instance translation: matrix, AABB, materialized geometry, GPU sphere update,
  reversibility, and mixed flat/instanced bounds.
- Lazy allocation, device-limit fallback, and allocation-failure fallback.
- Viewer typecheck and production build.
- Renderer tests: 175 passing. WASM contract tests: 22 passing.

## Acceptance gates for reconsideration

All of these are required before production rollout is discussed:

1. Picking, selection, visibility, sectioning, and rendering consume one shared
   visibility result, including projected-size LOD.
2. Compaction ordering is deterministic, or a documented visual-error policy
   explicitly accepts depth-tie differences.
3. Actual viewer compute and render passes are measured with GPU timestamp
   queries on representative IFNS corpus models.
4. Testing covers at least an integrated/low-power GPU and a mid-tier discrete
   GPU in addition to the available NVIDIA Blackwell system.
5. A workload gate avoids allocating and dispatching culling for small or
   mostly-visible IFNS workloads. Its thresholds must come from measurements,
   not guesses.
6. The load/IFNS count variability is explained or removed so repeated results
   are comparable.
7. A product-owned visual-error budget is defined before enabling nonzero LOD.
8. Full-corpus parity, interaction tests, renderer tests, viewer typecheck,
   production build, and WASM contract tests all pass.

## Reproducing the evaluation

Historical: the corpus runner, its `test:instanced-culling:corpus` script and
the `CULL_CORPUS_*` variables were removed with the implementation (#4819),
so the commands below no longer run. They are kept as a record of how the
evaluation was produced. The original evaluation fetched fixtures and built
the viewer before running the corpus:

```bash
pnpm fixtures
pnpm --filter @ifc-lite/viewer build
pnpm test:instanced-culling:corpus
```

The runner supported `CULL_CORPUS_FILTER`, `CULL_CORPUS_OFFSET`,
`CULL_CORPUS_LIMIT`, and `CULL_CORPUS_OUTPUT`. Per-model JSON and mismatch PNGs
default to `.codex-artifacts/instanced-culling-corpus/`. The local decision
bundle also contains `instanced-culling-decision-data.json`, raw Blackwell
timestamp samples, and repeatability observations. `.codex-artifacts` is local
evidence storage and is not the durable decision record; this document is.

When revisiting, run the complete corpus rather than offering a user opt-in to
collect evidence in production.
