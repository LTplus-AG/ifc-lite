# Saved comparison chart source — #6549

## Current-main qualification

The later capture uses frozen `f626e81d690eb242229e8ca4fb360e0fa19f4678`, based on
main `e57ed503a`; the earlier files below remain attributed to their original source.
[Current observations](./current-main/observations.json) retain actual saved report
rows, persisted chart/document state, source/input hashes, and export notifications.
The saved A→B chart stays at three rows after the live B→C run, reloads with zero
models, and exports with `Document exported: 1 page` ([screenshot](./current-main/current-document-export-success.png)).
Deleting its history entry prints one complete notice and reports one chart not printed.
The actual [dashboard](./current-main/current-dashboard.pdf), [document](./current-main/current-document.pdf)
and [missing-source](./current-main/current-missing-source.pdf) downloads were independently
inspected/rendered with PyMuPDF at `(1.5, 1.5)`; all ten new screenshots/renders were viewed.
[Current qualification](./current-main/qualification.json) and [source hashes](./current-main/source-hashes.json)
record plain root typecheck 109 tasks/all 3,236 test files, full build 61, lint 8,111
files/zero errors, 265 selected passes/one existing optional skip, docs 428, API 9,165,
and the final-source oracle: 12 passes become 2 passes/10 assertion failures with restoration verified.
The 70 charts/186 consumer results belong to production-identical `89c0fbef2`; the
typed test correction, final nine mounted cases, gates and native proof belong to `f626`.
UI screenshots retain graphics-device-loss and federation-alignment toasts, despite
zero captured console/pageerror entries. This proves data/document output only.

## Earlier qualified capture

Actual Chrome exports captured from source `af39763b647e01e244a216892432a0a54eb94ac0`,
a clean integration with main `4fbff072ec1ac901591bb9b10f0431bd562b2836`.
The evidence commit adds files only; [source hashes](./source-hashes.json) identify
all changed production, test, guide and changeset bytes that were qualified.

The actual chart editor binds a completed saved comparison. A later comparison
cannot replace it. The chart retains its local history ID; dashboard/document
JSON does not embed the history dependency. Missing/deleted history is explicit.
Recorded rows do not identify entities in another loaded model: selection,
framing, cross-slices and snapshots are suppressed. Legacy unbound charts still
use the current comparison.

## Actual input and output

Public committed SketchUp exports are `apps/viewer/public/samples/building-architecture.ifc`
(444 entities) and `building-architecture-rev-b.ifc` (474 entities). Revision C is
explicitly derived from B through `MutablePropertyView` / `StoreEditor` / `StepExporter`:
wall GlobalId `1AQAupaRP1txwK1AGiN61V`, attribute `Name`, becomes
`Explicit browser chart revision C wall`. The exported C bytes are loaded through
the canonical add-model event. Its recipe and all input SHA-256 values are in
[observations](./observations.json); C is not represented as an independently
supplied authoring-tool fixture or committed as a new model.

| Actual state | Evidence |
| --- | --- |
| Saved A→B selected in editor: 3 recorded rows | [source picker](./source-picker.png) |
| Later B→C: 1 modified, 21 unchanged in current run | [later run](./live-comparison.png), [canonical history](./saved-comparisons.json) |
| Dashboard still uses A→B: added/deleted/modified, one each | [dashboard](./recorded-dashboard.png), [actual PDF](./dashboard.pdf) |
| Same source in Documentation, snapshot control disabled | [preview](./document-preview.png), [actual PDF](./document.pdf) |
| Reload clears models to 0 and preserves the binding and bars | [reload](./reloaded-no-models.png), [document JSON](./document.ifclite-document.json) |
| Deleting A→B gives one notice and no substituted chart | [preview](./missing-source.png), [actual PDF](./missing-source.pdf) |

PDFs were downloaded by actual mounted export controls using native ECharts SVG,
jsPDF, svg2pdf and autoTable. No PDF/SVG/browser exporter was replaced.
[Independent PyMuPDF text/font/hash inspection](./pdf-inspection.json) confirms
one page per file and one missing-source sentence. Page PNGs are actual PDF renders
at matrix `(1.5, 1.5)`. All preview screenshots and all three PDF renders were viewed.
[Capture script](./browser-capture.cjs) now reproduces the current capture: start root
`pnpm dev --host 127.0.0.1 --port 52658`, then run `node browser-capture.cjs WT OUTPUT_PREFIX 52658`.
It uses a new profile derived from the prefix and closes its own context. The original
earlier capture script remains in commit `e216d3d30bffb028e68b4006483142fb676da9fb`.

An earlier native capture at `aed543e56f1b9020663b91bc0261e6e2bc66d65a` found
the full missing notice twice (subtitle and empty body). The original
[PDF](./before-missing-source.pdf), [render](./before-missing-source-page-1.png) and
[attribution](./before-observations.json) remain. The narrow correction was proved
by actual mounted/PDF assertions: 6 pass + 2 assertion failures before, 8 pass after.

## Qualification and limits

[Qualification](./qualification.json) records commands and SHA-256 values for
actual logs: normal root build 61 tasks; plain root typecheck 109 tasks/all 3,188
test files; root lint 7,977 files/zero errors; 69 charts tests, 8 new mounted tests,
and 158 related viewer tests passed. One existing Archicad material-volume case
skipped because its optional AC20 fixture was absent. This is selected coverage,
not a full repository-suite claim. Docs compiled 425 snippets; API refresh checked
51 packages/82 surfaces/9,149 exports, with no name/kind snapshot delta for the
optional field. Full production-revert oracle: 17 files reverted, 10 green tests
became 1 pass + 9 assertion failures; byte-clean restoration was verified.

Mounted PDF tests require a test-only XML environment conversion because installed
HappyDOM rejects renderer CDATA. The [unmodified SVG](./original-echarts-cdata.svg),
[strict external XML acceptance](./strict-xml-proof.json) and [actual failure excerpt](./happydom-xml-failure-excerpt.txt)
are retained. At the test DOMParser boundary only, CDATA text is XML-escaped while
asserting identical decoded CSS; styles/elements/geometry and exporters remain real.
The native Chrome proof above uses the untouched browser parser and renderer.

Own Linux Chrome/software WebGPU reported device loss; screenshots also retain
EPSG federation-alignment errors. This proves data/UI/document output only, with
no 3D, geospatial-alignment or performance claim. The owned dev server was stopped
after capture (intentional exit 130); no shared browser profile was used.
