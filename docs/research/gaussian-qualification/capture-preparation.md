# Architectural capture preparation (#8567)

This adds corpus coverage, not release approval. Integrated viewer rendering,
metric IFC/scan/splat alignment, hardware budgets, resilience and rollout remain
unqualified. Neither capture has a surveyed IFC counterpart or verified scale.
No first-party SOG loader is added.

## Licensed fixtures

- **Seem Kirke, Danmark**, Peter Rødsgaard Rasmussen (`roedsgaard`),
  [author's scene](https://superspl.at/scene/e832997f), CC BY 4.0.
  DJI drone photographs were aligned in RealityScan and trained in LichtFeld
  Studio. The publicly served v1 SOG was expanded to PLY with the existing pinned
  `@playcanvas/splat-transform` 3.10.3 (`4f90012`). This is a derivative of
  quantized/compressed published data, **not the author's lossless original PLY**.
  The website's direct download requires login; the public viewer assets are
  independently accessible. No authentication was bypassed. The source inventory,
  hashes and publisher camera are in `seem-source.json` and the fixture manifest.
  The PLY contains 960,991 Gaussians and 45 higher-order channels, but every
  published higher-order coefficient is zero. It is a visual demo candidate,
  **not captured higher-SH appearance evidence**.
- **Delft Aula & Library**, Yingwen Yu (2025),
  [dataset DOI](https://doi.org/10.17605/OSF.IO/P3CW7), CC BY 4.0.
  The publisher's [README](https://osf.io/download/kjtfb/?version=1) expressly
  licenses the dataset; the [paper](https://doi.org/10.5194/agile-giss-6-51-2025)
  describes UAV and ground photography and Postshot reconstruction.
  Unmodified file version 1 contains 1,991,216 Gaussians, SH3 and 493,823,100 bytes.
  The full download matches OSF's SHA-256
  `c56b1a07559312fcf1c9ef150802995005b6e3b4f8cf0c501fb96cec5d5ca45a`.
  The corpus test requires finite channels and nonzero values in every higher-SH
  channel; the header alone is insufficient.

Both files use `tests/models/manifest.json` and the existing content-addressed
`fixtures-v1` release. No model bytes belong in Git. Retrieve and verify with:

```sh
pnpm fixtures gaussian/seem-kirke-v1.ply gaussian/delft-aula-library-v1.ply
pnpm fixtures:check gaussian/seem-kirke-v1.ply gaussian/delft-aula-library-v1.ply
pnpm build --filter=@ifc-lite/load-trace --concurrency=2
pnpm test --filter=ifc-lite-gaussian-splat-spike --concurrency=2
```

Run the test command through fleet admission in pool `gaussian-production-8562`.
A missing fixture is a reported skip, never release acceptance. The Delft size
sits close to the proposed 2M-row/512MiB intake limits. These are fixture facts,
not permission to increase device or scene budgets. Peak memory includes input,
canonical channels, worker transfer and GPU allocations, not only file size.

## Reproduce the church derivative

Fetch the eight SOG files in `seem-source.json` into one directory, preserving
basenames. Check each byte length and SHA-256 before conversion. `settings.json`
is camera evidence, not decoder input. No coordinate, color, crop or scale flags
were passed:

```sh
node examples/gaussian-splat-spike/node_modules/@playcanvas/splat-transform/bin/cli.mjs \
  /path/to/seem-kirke-v1/meta.json /path/to/seem-kirke-v1.ply
```

Use the lockfile's 3.10.3 converter under fleet admission. Expected output:
226,795,353 bytes, SHA-256
`9178c73620ac6dd1e18f4b91870d71b7e06ded83d4beb0344ba8aa90630ab228`.
The original SOG has already discarded higher-SH information; conversion cannot
recover it. Tests enforce the published zero values instead of inventing them.

## Reproducible recording journey

Wait for the integrated viewer to be available. Load the PLY through the normal
file picker / `useIfcLoader.loadFile`, select it in the model panel and fit it.
Verify the church is upright, fully visible and has the expected brick façade
before recording. Retain the original file placement; do not introduce a metres
conversion. The publisher's initial camera is recorded in its own viewer frame;
do not reuse it as IFC coordinates without verifying the frame conversion.

`examples/gaussian-splat-spike/demo-camera.mjs` provides a deterministic 30-second
journey in the **integrated viewer's Y-up frame**. Capture the settled visible
bounds' center and framing radius and an aesthetically chosen initial azimuth
in the recording evidence. Sampling `demoCameraAt(elapsedSeconds, framing)`
produces position, target and a 55-degree vertical FOV:

1. 0–3 s: hold the wide establishing shot.
2. 3–15 s: ease through a 110-degree orbit, keeping the church in frame.
3. 15–22 s: approach to 1.65 framing radii for façade and roof detail.
4. 22–27 s: pull back and rise; finish at 155 degrees.
5. 27–30 s: hold the final composition.

Drive the existing viewer camera and render loop; do not render replacement
frames. Use wall-clock elapsed time during a real screen recording, retain
resolution/browser/device/source SHA, actual framing values and video SHA-256.
If a close approach intersects the actual capture, revise and record the
framing inputs before the take. Record load and failure behavior separately;
a polished orbit is not load/performance evidence.

Start with T3 `preview_status` / `preview_open`. The publisher-page inspection
on 2026-11-02 reported `No available adapters` / `Unable to retrieve a WebGPU
adapter` and used WebGL2. It is not hardware evidence. For the repository's
hardware-browser workflow, `~/build-workers/ifc-gpu-check` documents Windows
Chrome on the PC GPU with `IFC_GPU_CDP_URL` and Pop native Chrome flags.
Run that path through fleet admission, serialized with the parent/renderer,
and record a nonfallback adapter before making hardware claims. Timed results
additionally require the approved idle-window A/B protocol. No GPU qualification
or final integrated video has been produced by this corpus preparation.

Suggested video credit (also place it in the delivery description):
“Seem Kirke, Danmark — Peter Rødsgaard Rasmussen (roedsgaard), CC BY 4.0,
https://superspl.at/scene/e832997f. Published quantized SOG converted to PLY;
viewpoint changed. https://creativecommons.org/licenses/by/4.0/.”
