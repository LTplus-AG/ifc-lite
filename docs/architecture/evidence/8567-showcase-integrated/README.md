# Showcase recording: integrated viewer, internal demo (#8567)

**Internal demo, not production qualified.** This is the real ifc-lite viewer:
a production bundle built with `VITE_GAUSSIAN_SPLATS=internal-unqualified`,
rendering through the native WebGPU Gaussian adapter. The capture enters the
viewer's own file picker and takes the canonical `useIfcLoader.loadFile` path.
The take stays outside Git, a 55.6-second MP4/WebM; its hashes are in
[`evidence.json`](evidence.json). The disclosures shown on screen throughout:

- Internal unqualified preview
- Presenter-supplied demo placement (rx180), not alignment
- Uncalibrated: no units or measurement
- Centre clipping: whole Gaussians culled by centre, no caps
- Approximate composition over IFC glass and X-ray
- Not pickable

| Load through the picker | Section tool, centre clipping |
| --- | --- |
| ![Viewer load dialog: decoding the Gaussian PLY capture](01-load-progress.jpg) | ![Section plane removing whole Gaussians by centre](05-centre-clip-a.jpg) |
| **Inspect the capture** | **Remove the capture** |
| ![Capture details: Gaussian capture (internal preview), uncalibrated, explicit placement](07-inspect-capture-details.jpg) | ![Empty viewer after Remove capture](09-removed-empty-viewer.jpg) |

Capture: **Seem Kirke, Danmark**, Peter Rødsgaard Rasmussen (roedsgaard),
[superspl.at/scene/e832997f](https://superspl.at/scene/e832997f),
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The published
quantized SOG was converted to PLY (`gaussian/seem-kirke-v1.ply`); the
viewpoint is changed.

## Source and digest binding

- **Production source:** `16897873e6`.
  - The final head `cfabfaa4e7` adds tests/e2e only.
  - The later `d8fe061309` changes one `import type` line, one type annotation
    and a doc comment in `CaptureModelPanel.tsx`, all erased from emitted JS,
    plus a manual witness. The recorded bundle is runtime-equivalent to it.
  - The loader's GPU witnesses (runs 6 and 7) passed on this source.
- **Bundle:** dist digest `449e4aab…8a07` over 1,017 files.
  - It equals the loader's witnessed bundle once content hashes are
    normalised, except for the embedded build timestamp.
  - WASM `ae7ee826…` comes from rust tree `332f265ad1`, byte-identical across
    two independent builds.
- **Recorder:** `record-integrated.mjs` and `integrated-journey.mjs` at
  `d9bab8bcfd`, finisher at `ff219fbd0c`, all with a clean tree.
- **Environment:** Windows Chrome 156.0.8078.74 (headless) on the PC's NVIDIA
  Blackwell adapter (`isFallbackAdapter: false`), via `ifc-gpu-check`.

## What the take shows

All input is real and on wall-clock time; the CDP page screencast records the
UI and WebGPU canvas together. The journey:

1. Picker load, with the viewer's own "Decoding Gaussian PLY capture" progress.
2. Auto-frame on splat centres.
3. Wheel zoom, then orbit.
4. Section tool "Side (X)", stepped through the nave: whole Gaussians are culled
   by centre, with no caps.
5. Cut off, which restores the full capture.
6. "Show capture details": the capture's own panel. It shows 960,991 splats,
   SH degree 3, "Explicitly supplied placement", "Uncalibrated: no units,
   alignment or measurement" and its limitations, and no IFC claim.
7. Hide, show and fit from the capture's model-list row.
8. "Remove capture", which returns the viewer to its empty state.

The take made no skips and logged no page errors. 1,597 screencast frames span
55.5 s at p50 33.3 ms. The 17 gaps over 50 ms sit in the load, the wheel zoom
(with its settling into the orbit's first 0.6 s) and the removal.

Two diagnostics from the same session, not performance claims:

- With the right sidebar expanded, the same orbit ran at p90 66.7 ms; with it
  collapsed, at 33.4 ms. The take therefore opens the sidebar only to inspect.
- Wheel zoom steps run at roughly 100–133 ms.

Not qualified here:

- Production readiness or public enablement
- Hardware budgets
- Metric scale or alignment (there is no IFC model in the scene)
- Exact transparency composition and clipping caps
- Picking

The research preview, rendered by the PlayCanvas spike, is in
[`../8567-showcase-research-preview`](../8567-showcase-research-preview/README.md).
