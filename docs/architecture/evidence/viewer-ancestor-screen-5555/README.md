<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Issue #5555 bounded browser screen

Base: d05f5423a7caf761f0a2e12d064d85e84355d031. Two alternating AB/BA pairs per variant, each Holter first load in a fresh Chromium process. This is a preliminary JS screen: the identical frozen WASM runtime is not rebuilt from this base, so these results do not qualify a shipping performance claim. All eight timed runs fall within the recorded single CPU competing WSL affinity window; Windows server, launcher and Chromium processes were pinned to mask 0xFFF000 before file input.

React subscription spike: base 7035/6263 ms; React 6116/6402 ms. Pair 1 improves 919 ms, pair 2 regresses 139 ms. Fails clear repeatability gate.

Renderer transient-upload ablation: base 6179/6293 ms; ablation 5869/5727 ms. Pair gains 310/566 ms; fails >=500 ms in both pairs investment gate. Ablation deliberately reduces progressive display and must never ship.

All eight runs passed strict full model/canvas/final scene/placed spatial index readiness, with identical 56,697 meshes, 755,426 triangles, closed #148571, UI count and GPU pick, and no page errors. Profiling summary is from an earlier post-#5477 frozen candidate and is diagnostic, not an A/B run.

`results.json` contains each attempt and SHA256 references to retained raw method, preload and screenshot artifacts. `variant-manifests.json` records source and served bundle hashes. Patch files and protocol are included. No IFC bytes, screenshots, properties text, command lines or private filesystem paths are in this bundle. Raw evidence remains in the task-owned Windows CI directory.

## Decision

Both patches are archived experiments and are **not applied** to production.
The screen does not establish that narrower subscriptions are universally useless,
or that a permanent-page renderer could not win on other models. It does not
justify either change as the requested larger Holter lever. Revisit with a new
measured workload or mechanism, not a framework replacement inferred from CPU samples.

The Windows checkout was restored to its original revision; its owned server and
browser processes stopped. The WSL resource window restored its saved affinities;
`restoration.json` records the live-thread audit.

For reproduction use the source base and archived patch with the production
build and strict browser witness described in the previous qualification under `scripts/perf/evidence/physical-summary-5477/README.md`. Keep the two variants separate and retain
the instrumentation and WASM provenance caveat above.
