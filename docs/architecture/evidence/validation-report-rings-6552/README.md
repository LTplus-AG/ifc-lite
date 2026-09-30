# IDS and information report rings (#6552)

The actual viewer and downloaded PDF show outcome rings over `apps/viewer/public/samples/building-architecture.ifc`, whose STEP header identifies SketchUp 2024 (24.0.594) and IFC-manager 5.3.3. Chrome loaded this real external model through the normal IFC file input and canonical load pipeline: 444 entities, four walls, fingerprint `building-architecture.ifc:f778982157aa24e`. The file's SHA-256 is recorded in `runtime-sources.json`.

Both production validation engines evaluated these actual entities. The authored definitions in `source-inputs.json` are demonstration inputs, not independently supplied compliance findings. The IDS checks require every wall's Name to exist and to equal `plumbing wall`: eight checks, five passes, three failures, engine verdict 62%. The information rules require Description to exist, Name to equal `plumbing wall`, and Description to contain `plumbing` as a warning: twelve checks, six passes, three warnings, three other failures, engine verdict 50%. Warnings retain their own bucket. The ring represents checked outcomes; the displayed percentage remains the engine's bounded verdict, including cardinality failures and empty runs.

## Actual proof

- `document.pdf`: actual 14,558-byte, two-page download from the mounted **Export PDF** control using real jsPDF, svg2pdf and autotable. SHA-256 `d8da79f8517ee1c0953126ad68093ceecd6eaea5f30e179b5769fee27b9f5afb`. No PDF/SVG mock or download suppression was used.
- `pdf-page-1.png` and `pdf-page-2.png`: inspected PyMuPDF renders of those exact bytes at `Matrix(1.5, 1.5)`. Both IDS and information blocks print in compact and long variants.
- `preview-ids.png`, `preview-information.png`, `live-information.png`: inspected actual Chrome screenshots of the mounted preview/results and benchmark controls. `native-ids-ring.png` and `native-information-ring.png` are actual clipped screenshots of the rendered SVG images, with the engine's visible percentage overlay.
- `document.ifclite-document.json`: actual persisted document after all four **Show benchmark scores** controls and independent titles were edited through their mounted inputs. Reload retained the same serialized document.
- `browser-observations.json`: actual engine summaries, canonical model identity, SVG images/accessible labels, verified serialized-document equality after reload and download identity. The first whole-window IDS frame was a blank Chrome compositor frame and is not presented as live-panel proof; its separately captured native ring, later IDS document preview and mounted tests supply that evidence.
- `pdf-native-ring-measurements.json`: 3,600 centerline color samples per actual PDF ring, rendered at `Matrix(4, 4)`. All four measured status shares fall within 3.5 percentage points of actual engine counts; the difference includes deliberate inter-segment gaps and antialias pixels. Independent bucket-midpoint pixels agree in the actual native SVG image and PDF, in clockwise pass → warning → fail order.

The capture source is `c5475182441bba8f1e7e8fb8b9305a376a720e80`, integrated with main `cfd1f5a221e7e08c6cba18ad156bfbb6b08c23ed`. Source hashes distinguish it from earlier rejected exports. The own-profile Google Chrome session used software WebGPU; device loss affected the 3D viewport. This is document DOM/PDF evidence and makes no 3D-rendering or performance claim. All owned browser sessions and dev servers were closed after capture.

## Why the shared SVG changed

The original actual export at `a205f5f87f284991ec1e497a7f8cdeb19d309214` printed all four mixed-result rings solid red in MuPDF. `before.pdf` and `before-page-1.png` retain that real failure; its pixel oracle measured zero green/amber and 98.53% red. The real jsPDF/svg2pdf regression also failed on negative PDF dash phases. PDF 1.x left negative dash-phase behavior unspecified; this is a portability problem, not a claim that every such file violates a normative rule. See the [PDF Association's specification explanation](https://pdfa.org/pdf-differences-github-repository-is-now-public/).

A wrapped nonnegative phase at `e2ab011fc42cb8af52ef0e14ccf203348d00d5f8` restored the proportions but reversed the clockwise order in the printed circle. `phase-only.pdf`, `phase-only-page-1.png` and its measured order failure retain why that correction was insufficient. The final shared `ringSvg` renders explicit clockwise SVG arcs from the existing `ringSegments`; preview and PDF use the same source, colors and counts, retaining the existing per-size gap, radius and stroke calculations. Empty and single-bucket rings retain the bare track and full-circle behavior. The obsolete dashed-segment path was removed.

## Qualification

Plain root `pnpm typecheck` passed 109 Turbo tasks and included all 3,184 test files at the final source. The new real-IFC mounted cases check both engines, controls/persistence/import/reload, old optional-field defaults, warning partition, empty/cardinality/partial evidence, locale switching, narrow page bounds, actual PDF operators and title/hidden-ring preservation through refresh and source selection. Removing title preservation or benchmark preservation individually produced five passes and one failure; restoring them passed. Actual PDF/color/order failures above were retained before the canonical correction.

Final focused regression and repository gate results are recorded in `qualification.json`. These checks do not claim a full local repository-suite pass; fresh exact-head CI is required before merge.

## Reproduce

Start the viewer through the normal root build/dev workflow and load the committed sample through **Open model file**. Evaluate the recorded IDS and information definitions through the production engines, or run the real-fixture mounted regression through root Turbo. New report blocks include a ring; imported old blocks without `benchmarks` keep their prior output. In Documentation, use **Show benchmark scores**, select compact/long presentation, author a block title, reload and export PDF. Inspect both percentages and clockwise status order; changing presentation must not change the embedded evidence or save a live run.
