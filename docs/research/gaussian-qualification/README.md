# Gaussian qualification preparation (#8567)

**Partial preparation; rollout blocked.** No integrated viewer qualification,
metric alignment approval, hardware performance measurement or supported limit
is established here. M2/M3 and #8566 precede full #8567 acceptance. This slice
changes the fixture tools and offline research harness only.

## Reproduce the bounded corpus slice

From the repository root, through the registered fleet launcher (use pool
`gaussian-production-8562` and one unique storage task for related commands):

```sh
pnpm fixtures gaussian/plant.splat gaussian/textile_ball.splat
pnpm fixtures:check gaussian/plant.splat gaussian/textile_ball.splat
pnpm test --filter=ifc-lite-gaussian-splat-spike
```

The root Turbo command builds the research example before its tests. It uses
pinned `@playcanvas/splat-transform` 3.10.3 and `@luma.gl/splats` 9.4.2. This is an
offline decoder/sort oracle, not a second viewer loader or rasterizer. The public
feature remains disabled. Test timeouts and download byte bounds are safeguards,
not performance acceptance numbers. Missing captures produce named SKIPs; the
preceding `fixtures:check` is mandatory for an evidence run. Full root tests,
typecheck, real WASM, required CI and integrated hardware acceptance remain separate.

Only `tests/models/manifest.json` is committed for captured binaries; normal
fixture fetch/hash verification, `.manifest-ignore`, and `local/` privacy guards
apply. Gaussian metadata is mandatory even in the historical version-1 registry.
Regeneration refuses new/unreviewed or changed PLY/.splat bytes. Reviewed unmodified
bytes fetch from immutable upstream blobs and are excluded from fixture uploads.
Direct downloads stop at the declared byte budget before publishing a file.
The two captures total 15,943,584 bytes. Do not run unscoped corpus downloads for
this preparation. No private files or shared upstream checkout were modified.

## Corpus inventory and rights

| Fixture | Verified source metadata | Role and limitations |
| --- | --- | --- |
| `gaussian/plant.splat` | 113,648 Gaussians, SH0; 3,636,736 bytes | Real foliage capture; non-metric, source photographs not pinned |
| `gaussian/textile_ball.splat` | 384,589 Gaussians, SH0; 12,306,848 bytes | Larger of the two real objects; **not** the large-scene acceptance fixture |
| Generated `qualificationPly()` | 8,224 Gaussians, SH3, 32 contiguous input batches with overlapping depths; 2,041,136 bytes | Analytic PLY control; all 45 higher coefficients checked against independent exact fractions after real upstream decode; global far-to-near order must interleave the batches |

Captured data attribution: **Marcel Padilla, _splats: a small collection of Gaussian
splat objects_ (2026)**, [source repository](https://github.com/marcelpadilla/splats).
Both entries are CC-BY-4.0, unmodified. License, author, counts, hash, units and
axis are published in the pinned [plant metadata](https://github.com/marcelpadilla/splats/blob/c3e5ec0a8ddb3ab26f28a067a29d272fe1a23411/data/plant/meta.json)
and [textile ball metadata](https://github.com/marcelpadilla/splats/blob/c3e5ec0a8ddb3ab26f28a067a29d272fe1a23411/data/textile_ball/meta.json).
Their binary SHA-256s are in the registry, not inferred from a moving branch.
Higher SH was dropped by that source; these captures cannot validate SH3 shading.

The analytic PLY source is
`examples/gaussian-splat-spike/qualification-fixtures.mjs` (MPL-2.0). Its default
output SHA-256 is
`ad8fb87d654f180aebf4f5d7cb66028fecf38ae05281820ee00048dce0e5436b`.
Reproduce it in memory; do not commit its binary or mistake the generator's input
batches for demonstrated production streaming/scheduling. The depth test exercises
the upstream global sort, not composited pixels, reverse-Z, or batch upload.

## Missing corpus gates

- **Large real capture:** no admitted, licensed, hash-reviewed multi-million
  Gaussian scene in this slice. The Padilla repository's million-row mesh
  conversions are not captures. Duplicating a small object does not fill this
  gate. Select one bounded scene after size/device agreement, pin producer,
  license, bytes, SH degree, camera poses and held-out views before fetching.
- **Captured higher SH:** analytic SH3 checks channel preservation, not real
  appearance. Add an uncompressed Gaussian PLY with retained higher coefficients
  and licensed held-out images. A code repository's license alone is insufficient
  evidence for a third-party captured model.
- **Genuinely metric IFC/scan/splat triple:** not found/verified in this slice.
  [Existing CRAS evidence](../../architecture/evidence/scan-registration-cras/README.md)
  supplies a licensed IFC/metric scan pair with held-out registration landmarks,
  but no trained Gaussian scene or posed photography provenance. Its measured
  as-built residuals are not survey-control accuracy. Do not manufacture a splat
  triple by fitting the two non-metric objects to the building. Preserve the
  existing CRAS/private evidence; no multi-GB CRAS re-download is needed here.

For admission of a future triple require units/CRS and axis evidence for all three
assets, documented transform provenance, independent held-out control with
predeclared tolerances, camera/training provenance and redistribution rights.
An aesthetically aligned screenshot cannot substitute for these.

## Bounded source investigation

NVIDIA's [pinned dataset catalogue](https://github.com/nvpro-samples/vk_gaussian_splatting/blob/d2f603251b1b007c94ee07dd9c5579b7492af6fe/docs/datasets.md)
identifies Christian Rochner's `fountain_place.zip` and Jean-Eudes Marvie's
`flowers_1.zip` as CC-BY-SA-4.0. HTTPS HEAD on 2026-11-01 reported respectively
679,744,906 and 125,568,178 archive bytes on `developer.download.nvidia.com`.
Only headers were fetched. They are concrete candidates, **not admitted corpus**:
no binary hash, uncompressed size/count, SH inventory, camera provenance or
metric IFC counterpart has been verified. The current upstream ZIP fetch path
supports pinned GitHub IFC members only; admitting these requires reviewed
external archive provenance and bounded member extraction (or approved
content-addressed redistribution), not pointing the fetcher at a moving ZIP.
The multi-GB pretrained bundles were not downloaded. This investigation does
not claim that no suitable metric triple exists anywhere.

## Proposed device/scene budgets — not measured or agreed

These are explicit candidates for maintainer agreement **before** measurement,
not supported product limits. Every row is pending M2/M3. Test at 1920×1080,
DPR 1, fixed camera path and camera settings; record actual adapter, driver,
OS/browser/build/toolchain, viewport and source hashes. Software adapters provide
correctness only. No hardware result is present here.

| Candidate device class | Candidate total Gaussian cap / decoded data cap | First visible / complete load from local bytes | Moving frame p95 / interaction p95 | Process peak / retained after remove delta |
| --- | --- | --- | --- | --- |
| Integrated WebGPU, 16 GiB RAM (Intel/AMD) | 500k / 256 MiB | 2 s / 10 s | 33.3 ms / 100 ms | 1 GiB / 64 MiB |
| Discrete WebGPU, ≥8 GiB VRAM, 32 GiB RAM | 2M / 1 GiB | 2 s / 15 s | 16.7 ms / 75 ms | 3 GiB / 128 MiB |
| Apple Silicon WebGPU, ≥16 GiB unified memory | 1M / 512 MiB | 2 s / 12 s | 33.3 ms / 100 ms | 2 GiB / 64 MiB |

Propose mixed scenes with 1, 8 and 32 overlapping batches and one registry-pinned
IFC model; record its triangles and bytes separately. Add standalone IFC-only
base/branch controls. After 30 seconds settled, candidate CPU frame p95 ≤2 ms,
GPU frame p95 ≤4 ms when redraw is needed; no continuous redraw at rest. Record
first-visible, full-ready, cancellation, input-to-present, CPU and GPU work
separately. Memory means process baseline-adjusted resident/private memory plus
tracked CPU buffers and GPU allocation peaks; label unavailable GPU telemetry
unknown, never zero. Candidate IFC-only regression budget: ≤5% with paired spread
reported, not an isolated timing. All timings await admitted idle hardware runs
and agreed protocols. Mobile, WebGL, software rendering and >cap scenes have no
proposed support here.

## Resilience matrix

| Case | Executable preparation here | Integrated acceptance still required |
| --- | --- | --- |
| Truncated PLY record | Generated bounded mutation; real upstream rejection assertion | Loader diagnosis, no partial committed model |
| NaN position | Generated mutation; reports rejection or preserved nonfinite channel | M2 finite-channel policy and visible diagnosis; no poisoned bounds/GPU data |
| Oversized fetch response | Real local HTTP stream test, byte-budget refusal and old-file preservation | Production file/decoded/GPU allocation budget refusal |
| Huge declared vertex count / exhaustion | Do not feed an unbounded allocation to this oracle | Isolated worker with hard memory/time cap; bounded preflight, cleanup, recoverability |
| Repeated load/remove | Fixtures available, no browser result | 20 cycles; plateau and after-remove memory against agreed budget; no WASM/GPU handles left |
| Rapid replacement | Fixtures available, no browser result | 20 alternations during read/decode/upload; latest model wins, old callbacks cannot commit |
| Tab suspension | No browser result | Hide/resume during each load phase and settled view; bounded resumption, no stale sort |
| Device loss | No browser result | Trigger loss during upload/render; explicit recover/refuse, resources released, IFC state preserved |

Record all outcomes including skips. The malformed-file tests distinguish
upstream observations from production conformance; preserving a NaN is an
unresolved production gate, not a resilience pass. A release verdict remains
**BLOCKED** until the missing corpus, agreement, integrated outcomes and full
required checks are evidenced. Close the fleet storage task after publishing
compact receipts; do not retain build trees or benchmark targets.
