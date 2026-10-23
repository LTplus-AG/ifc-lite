# Native HiDPI navigation qualification (#6709)

Status: preparation passed; native model correctness and timing remain pending.
This capsule does not yet establish issue completion or a performance verdict.

The viewer policy and capture gateway shipped in #6711. This follow-up qualifies
that implementation on a physical NVIDIA Linux desktop, using a capped build
of main `be5c740cb9f1c57e4d1531ed574e2708839996be` and the cap-only control
described in `source-pair.json`. The control changes one expression in
`viewport-render-options.ts`; all camera, capture, scene and Rust inputs are
shared. It is a qualification control, not another viewer implementation.

## Protocol

- Use the catalogued public `ara3d/AC20-FZK-Haus.ifc` fixture, SHA256
  `d42ab0dee01173106c16cd823b4614efe188fa15dd65195d95b9879bec59acc5`.
  The similarly named committed viewer demo asset has different bytes and is
  deliberately refused by the fixture guard.
- Reconcile the successful root Turbo build/test receipts in
  `preparation-jobs.json`. Freeze every served asset and the package WASM/JS/type
  files; verify source cleanliness, WASM freshness and identical runtime bytes
  across the arms. Revalidate after measurement.
- Run one DPR2 smoke, then five counterbalanced A/B pairs at each of DPR1 and
  DPR2. Every sample owns a fresh native browser at a 1440 by 900 CSS viewport.
  The complete smoke and cohort share exclusive registered worker admission.
- Require the active, unlocked local desktop, connected displays, AC power,
  visible/focused page, a non-fallback NVIDIA device request, and retained host
  CPU/memory observations. These sampled observations do not prove absence of
  every unknown source of interference.
- Drive the existing orbit gesture. Record actual camera movement and texture
  dimensions through navigation and settling. Require CSS resolution during
  capped DPR2 navigation, full DPR2 resolution in the control, and restored
  configured resolution on the final settled frame.
- Request the real Screenshot command during a held drag. Retain the generated
  PNG at the canonical download boundary, require full-quality dimensions, and
  verify resumed interactive resolution followed by another sharp settle.
- Compare every published flat mesh field and typed array, coordinate data, and
  canonical placed triangle corners for every semantic owner, including
  instances. Compare before/after navigation and across samples. This witnesses
  the stated CPU domain, not GPU buffer or raw IFNS byte identity.
- Click a CSS-space point independently qualified by the canonical scene
  raycast and verify the actual UI selection. Reject page/WebGPU errors, device
  loss, interrupted focus/session, or missing/nonfinite measurements.
- Stop on the first failure and preserve it. Never replace a failed timing
  sample. A corrected preparation or diagnostic gets a separate attempt and
  does not retroactively qualify the refused run.

Metrics are rAF cadence, rAF JavaScript duration and GPU queue completion
latency. Queue completion is not GPU timestamp execution time. The retained
frame rig also reports its fixed frame-budget counter; interpret it alongside
the observed display cadence. Lower pixel counts alone establish no frame-rate
improvement. Inspect the actual exported raster and paired measurements before
publishing the verdict. This does not resolve #6516's loading regression.

## Retained harness

`qualification.mts` uses the repository's frame probe, orbit inputs, static
server, readiness checks and paired reporter. `native-platform.mts` is the
physical Linux platform adapter; its browser flags follow the canvas-specific
hardware qualification recorded for #7633. It adds no viewer loader, decoder,
kernel, capture pipeline or production debug API.

`geometry-witness-controls.mts` executes perturbation controls against the
actual fingerprint algorithm, including its serialized page expression under
tsx. Its successful result in `geometry-witness-controls.json` is an evidence
algorithm diagnostic, not native viewer correctness coverage.

The Python controller and preparation receipt IDs describe this particular
admitted run. To reproduce on the provisioned worker, prepare both source arms
with root pnpm/Turbo, fetch the canonical fixture with `pnpm fixtures`, and use
the new successful original receipt IDs in `preparation-jobs.json`. Run the
controller only through registered exclusive benchmark admission. Do not reuse
an uncertain request, bypass a live reservation, or infer acceptance from an
old receipt or script exit alone.
