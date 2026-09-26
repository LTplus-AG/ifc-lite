<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Colour override browser run for PR #6148

Run on 2026-09-26 against base `8f83154af` and patched head `e0edbd9a2`, built with `pnpm build --filter=@ifc-lite/viewer`. The model was the repo's catalogued `tests/models/various/O-S1-BWK-BIM architectural - BIM bouwkundig.ifc` (326.8 MiB). Its IFC header identifies an IFC2X3 export from Graphisoft Archicad 21 on 2019-12-03. It was read from a local Windows Dropbox copy; the model bytes are not committed here. Both builds reported 55,577 geometry-streaming meshes and 16,395 scene IDs.

The browser was Windows Chrome 153.0.8010.50 in a fresh Playwright page for each run, on an AMD Ryzen 9 9900X3D and NVIDIA RTX 5070 Ti. Each build ran as a Vite production preview from WSL2. Runs were sequential in base → branch → base order; the table uses the second base pass, whose no-override draw count matches the branch's. Chrome's Linux SwiftShader device dropped during a preliminary attempt, so **all numbers below are from Windows Chrome**.

The temporary measurement hook in both builds made a `Map` entry for every `scene.getAllMeshDataExpressIds()` ID, with the same deterministic opaque RGBA palette in each build. It timed only `scene.setColorOverrides(map, device, pipeline)` via `performance.now()` and requested a render. The read-only viewport hook supplied frame stats and resident bytes. Windows `Win32_Process.PrivatePageCount` supplied GPU-process private memory immediately before and about three seconds after the override. An automated drag issued 80 pointer moves over the canvas; the observed frame rate counts distinct `getFrameStats().timestamp` values over that drag's elapsed time. These are render frame observations, **not a CPU-time profile of `render()`**.

| Metric | Base, second pass | PR #6148 |
|---|---:|---:|
| Draw calls, no overrides | 1,373 | 1,369 |
| Draw calls, all 16,395 IDs overridden | 8,891 | 1,369 |
| GPU-process private memory, before → after | 1,146,916 → 2,255,384 KiB | 1,142,444 → 1,148,500 KiB |
| GPU-process private memory added | 1,082 MiB | 5.9 MiB |
| One `setColorOverrides` call | 771.5 ms | 30.1 ms |
| Orbit, 80 pointer moves | 11.3 observed fps | 22.1 observed fps |
| Renderer-reported resident geometry | 36,311,204 B before and after | 36,245,920 B before and after |

The reported resident geometry counter excludes the colour table and old overlay allocations; process private memory is the relevant allocation observation. GPU-process private memory also includes unrelated browser allocations, so its delta is an approximate cost of this operation. The geometry-streaming mesh count matched, while final summary mesh counts varied slightly even between base runs; this run does not establish byte-identical complete output.

## Visual check

`renderer.captureColorFrame()` produced these 512 × 512 frames at the viewer's initial camera position:

| | No override | Deterministic opaque colours |
|---|---|---|
| Base | ![Base clear frame](base-clear.png) | ![Base coloured frame](base-color.png) |
| PR #6148 | ![Branch clear frame](branch-clear.png) | ![Branch coloured frame](branch-color.png) |

The clear and coloured pictures show the same building surfaces and colour placement by visual inspection. A raw pixel comparison found a mean absolute RGB difference of 0.12/255 per channel in the coloured images; 2,647 of 262,144 pixels differed by more than five levels in at least one channel. The clear images also differed at 2,930 pixels by that criterion, consistent with ordinary raster/load variation; this is visual parity rather than pixel identity.

## Remaining acceptance

This is **one real model**, not the original 55-model federation (82,478 elements, 147.8 M triangles). It does not exercise federation IDs past 2²⁴, transparent/glass or `IfcSpace` promotion, a fractional-alpha override, focused-clash emphasis, X-Ray/ghost, or a model streamed in after colours are applied. It also does not measure `render()` CPU time or per-model load time with the lens already active. Those claims need the 55-model run or separate targeted real-model evidence before they are treated as verified at federation scale.
