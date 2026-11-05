# German browser workflow evidence

All ten browser checks pass against the final built preview on Pop (`pop-os`).
The coordinator repeated the full run after round 5; exit 0, no page errors,
including explicit accessible-control assertions for all four repaired library labels. The
committed building sample rendered on a hardware Intel Gen-12LP WebGPU adapter
(`isFallbackAdapter: false`), using the real fetched `@ifc-lite/wasm@12.2.0`
runtime. No Rust build, mocked WASM, performance claim, or native-speaker approval.

Reproduce from the checkout root after a current viewer build and an admitted
preview service on port 5188:

```sh
VK_DRIVER_FILES=/usr/share/vulkan/icd.d/intel_icd.json \
IFC_GPU_CHROME_PATH=/home/louistrue/.t3/tools/chrome-headless-shell/linux64/154.0.8037.92/chrome-headless-shell \
~/build-workers/ifc-gpu-check --limit 6 -- node tools/localization-german/workflow.mjs
```

The harness starts neither builds nor servers. It uses `IFC_GPU_CHROME_ARGS`
from the helper, or `IFC_GPU_CDP_URL` when supplied. `GERMAN_WORKFLOW_URL` can
select another already admitted service. Screenshot/JSON/accessible snapshot
artifacts remain local and ignored in `evidence/`; `workflow.json` contains exact
host, time, source, fixture/build/runtime SHA256 hashes, adapter and results.

The tested source was the shared worktree at
`aea79e9a1ca63c8e3aed03fa2a57ea2dde7bbed8`; the final runtime build contains the
round-5 catalogue corrections. Evidence files are ignored, and the compact final
report is maintained separately.
Parent built the final translations through its original root Turbo test graph.
Preview service receipt:
`/home/louistrue/build-workers/worker-state/jobs/abfe3e32-65ea-4bd3-84e0-57b2294d5099/receipt.json`.
Initial root test job: `4baa7dcf-150d-42dd-85b3-d336a4ab5e21` (parent owns and
reports root typecheck/test/gate coverage). Browser helper execution exited 0.
The built and installed WASM both hash to
`99d9681387e12ac8a04731eefbd03bc0599e23236803d447d22c8b5604c255b4`;
`/tmp/german-build2.log` records the npm 12.2.0 fetch. Generated `pkg/package.json`
contains older Rust package metadata and is not used as runtime provenance.

| Check | Concrete evidence |
| --- | --- |
| Render | `wide-loaded.png`: actual house geometry, 14 meshes / 12 geometry elements; WASM asset fetched HTTP 200 |
| Hierarchy and properties | Expanded building and `00 groundfloor`; real row selected express ID 262; properties display exact GlobalId `1AQAupaRP1txwK1AGiN61V` (`hierarchy-properties.png`) |
| Measurement | German Messen tool, actual canvas drag produces one measurement with visible readout (`measurement.png`) |
| Section | German Schnitt → Unten (Z); enabled cutting plane, rendered section (`section.png`) |
| IDS | Selected IDS validation UI, file input loads committed `building-architecture.ids`, clicked run; German Bestanden/Nicht bestanden summary (`ids-findings.png`) |
| Export | Actual browser download `ids-report-2026-11-05.json`; parsed IDS report asserts 3 specifications, 1 passed / 2 failed, 11 entity results, 8 passed / 3 failed |
| Narrow layout | 390×844, document width 390; actual rendered model with selection/measurement/section (`narrow.png`); wide viewport 1600×1000 |
| URL locale | `?model=/samples/building-architecture.ifc&lang=de`, HTML language and stored preference `de` |
| Persistence / English | Remove language query, reload preserves German; `?lang=en` switches HTML, stored preference and visible Home tab |
| Negotiation | Fresh isolated context with browser `de-CH`, no stored choice, selects German and renders Start tab |

German accessible names were exercised through role locators (Start, Messen,
Schnitt, Hierarchie durchsuchen, Datenvalidierung); accessible snapshots accompany
screenshots. IFC names and author-supplied sample text remain unchanged.

Limitations and reported defects: narrow layout has no document overflow, but
this is a sampled workflow, not an exhaustive overlap/a11y audit. The privacy
notice occupies much of the narrow lower viewport. The theme switch retains
legacy English `Toggle dark mode`; ViewCube face captions retain FRONT/BACK/etc.
The initial run exposed four grammar defects in validation-library actions.
Round 5 corrected them to “Keine Prüfung ausgewählt”, “Weitere Prüfung
importieren”, “Neue Prüfung aus dieser erstellen” and “Prüfung löschen”.
The final run asserts the actual accessible controls before recording
`ids-findings.png`; no known catalogue meaning defect remains from this workflow.

Preserved setup failures: the original prematurely started service returned 404
before `dist/index.html` existed and was stopped by its owner. T3 preview later
reported `No compatible GPU adapter found`; its separate tester tab was closed.
Unrestricted Vulkan enumeration with both provisioned Chrome versions lost the
Intel graphics device; forcing NVIDIA selected SwiftShader and was rejected.
Explicit Intel ICD with Chrome 154 rendered correctly and completed acceptance.
Earlier harness locator errors were fixed (tree expander, measurement toolbar,
empty-state IDS source button versus tab); failed attempts remain local JSON/logs.
No earlier failed/blank screenshot is treated as rendering acceptance. No old
campaign files, production files, or tests were edited by the tester. No commit.

Final root test/build receipt: eeead94c-ca5a-4f4f-beac-73e2097a6385 (62 tests pass).
Final admitted preview receipt: 9ea3dab9-d815-44b4-8550-9d703f263596.
Final browser log: /tmp/german-final-workflow.log; full results and hashes in evidence/workflow.json.
