# Browser evidence for #6614 and #6615

See [the specification](../../section-6614-6615-spec.md) for scope and acceptance. This directory contains both the original hosted baseline and the local implementation run on 2026-10-01.

## Local implementation

The local production viewer was built from the working tree based on `ab97764f42222177ac3c64b98f6aa2262c15a98a` and served at `http://localhost:5291`. It used the fetched npm 10.2.0 WASM runtime; no Rust changes or new WASM API were required. Browser automation used T3's Chromium preview at 1,280 × 800 CSS pixels, DPR 2. These artifacts record the integration working tree before subsequent source refinements, rather than a browser run of the final submitted commit. Later refinements are covered by the automated checks listed below; a final-source browser rerun is not claimed.

- [Measured browser observations](local-implementation.json)
- [PDF reference visible](local-pdf-visible.png) and [hidden without refitting](local-pdf-hidden.png): native full-page browser screenshots
- [Downloaded SVG](local-export.svg.gz) and [DXF](local-export.dxf.gz)
- [Rendered final downloaded PDF](local-export-pdf.png)
- [Rendered downloaded A3 sheet PDF](local-sheet-pdf.png)

The downloaded SVG/DXF bytes are stored losslessly as gzip artifacts to keep generated export records out of the source diff. Decompress with `gzip -dc <file.gz>`.

The real IFC input was `tests/models/ara3d/AC20-FZK-Haus.ifc`, authored with Archicad. It loaded through the normal file input: 44,249 entities, 82 geometry elements. The Side section was at X = 6 m. At projection depths 0, 3 and 7 m, cut geometry stayed at 28 polygons and 103 lines; projection lines changed from 0 to 228 to 949, and hidden lines from 0 to 95 to 521. The mounted generation regression also checks exact window boundaries through actual mesh outlines rather than a mocked return value.

Wheel tests dispatched browser events to the actual drawing canvas: delta 1 produced a small change, delta 100 a larger change, zero and horizontal-only deltas did not zoom, and physical modifier key state reduced the zoom step. Automated events validate the listener and cursor anchoring; an OS-generated trackpad/device session remains a manual acceptance gap.

The Underlays workflow imported a metre-unit DXF line into the frozen Side engineering frame and enabled centering. The downloaded DXF was parsed: 1,076 entities, including its vector reference with endpoints `(-7.5, 1.158846)` and `(-2.5, 4.158846)`, preserving the known 5 × 3 m span. Layer visibility is honored before composition; exported mapped reference vectors use a per-reference export layer.

The PDF was the repository's two-page rotated control document, imported through **Underlays → Import PDF/image**, calibrated to 5 m, and committed into the existing reference library. Hiding it changed 273,863 canvas pixels. SVG and raw PDF downloads retained its raster and the DXF vector; DXF displayed an explicit raster omission confirmation. The final PDF was downloaded again after correcting a double Y inversion discovered during artifact inspection. Its final registration was restored and relinked to the exact original PNG digest after rebuilding. Poppler rendered an upright roof above the slab, with the reference beneath the vector geometry. The final PDF is 4,008,088 bytes, one page, 510.236 × 447.342 points; SHA-256 `aac8495433e4a233db1e598e7e6cbfc036b8a2ee4ab33ecf9ac91f1650dc112d`. The full PDF remains at `/tmp/section-qa/section-fixed.pdf`; its inspected rendering is committed here.

The browser also enabled the A3 Landscape sheet at 1:100 and downloaded its PDF. Poppler confirms one 1,190.55 × 841.89-point A3 page; the inspected rendering retains the upright model, PDF reference, DXF line, frame and title block. The existing sheet rasterization produces a 52,212,881-byte PDF for this case; compression/size optimization is not part of this change.

Automated tests cover sheet composition, Print/SVG mapping, export cancellation/continuation, asset leases, units, persistence/migration, frame compatibility, and mounted controls. Browser downloads exercise mixed-reference raw SVG/PDF/DXF and sheet PDF. An OS print-dialog run, an independent wall/window section oracle, a real CAD alignment oracle, architectural PDF calibration and physical input-device testing remain unclaimed.

## Validation results

- Integration-source root `pnpm typecheck`: 109 tasks green; all 3,203 test files covered by the typecheck audit.
- After restacking onto main, isolated final candidate `e27f90cf55106752fcd284f77e531285daf62e5b` passed root typecheck (109 tasks; 3,205 test files across 56 packages) and sequential root lint. This source-gate run used Node 26.7.0 and pnpm 10.8.1; pnpm warned that the supported engines are Node 22/24. It is not a supported-runtime browser or timing-test claim. CI builds the current WASM and runs the supported-runtime test lanes before each merge.
- Updated multiline-bounds candidate `ff910c8e925414cd0aa2bf5379cafb4aa43c08a7` passed isolated root typecheck (109 tasks; 3,205 test files) and sequential root lint on supported Node 22.14.0 / pnpm 10.8.1. The DXF layer independently passed the same gates on Node 22. Multiline bounds tests pass 3/3 and reference export tests 8/8; canvas, bounds, SVG, PDF and DXF share the line-spacing factor.
- Latest main integration candidate `adeec99ade4f69076eeadad3ef05482e77a10586` passed isolated Node 22.14.0 root typecheck (109 tasks; 3,211 test files across 56 packages) and sequential root lint after the native-check and map-unit changes landed on main. The custom-plane picker race is covered by a mounted regression with a visible toast; import tests pass 4/4.
- Root drawing-2d tests: 560 tests green, including clipped outlines through the actual WASM boundary.
- Focused root viewer tests: navigation, projection generation/settings, Underlays, plane placement/bounds, persistence, reference library, teardown, export composition/omissions and PDF layout all pass. Final PDF layout tests cover physical Z-up landmarks and SVG/PDF direction/scale parity; settings rerun is 6/6 green.
- Root viewer broad run: 13,522 tests, 13,498 passed, 22 skipped, two failures. The touched reference notice assertion was corrected and its suite reran 6/6 green. The other failure is untouched `authoredFallbackMesh.test.ts`, alignment fallback (#6232). An isolated clean checkout of the same base commit with the same Node 22.14 runtime and identical WASM digest reproduces exactly that failure (14/15 focused tests pass). It passes under Node 26, so the broad suite is not claimed entirely green here. Logs: `/tmp/ifc-section-tests.log`, `/tmp/ifc-lite-reference-library-test.log`, `/tmp/ifc-section-authored-baseline-node22.log`.
- Retained focused failure evidence: [unchanged baseline](baseline-authored-mesh.txt) and [local implementation](local-authored-mesh.txt).
- Documentation sample checks: 425 snippets in 100 documents; API surface, test wiring, source-text assertion and module-size gates green.
- Accessibility, translation-literal, type-scale and oxlint gates green. Unused-declaration allowances are tightened to the measured improved counts; no allowance is raised.
- Final root `pnpm lint` and repeated root `pnpm typecheck` both exited successfully after baseline tightening and the semantic accessibility correction.

## Hosted baseline

The historical observations below concern the hosted baseline, not the changed local viewer.

- [Raw browser observations](browser-observations.json)
- [Side section with registered PDF visible](pdf-side-visible.png)
- [Same canvas with PDF hidden](pdf-side-hidden.png)

The PNGs are direct captures of the viewer's actual 2D canvas (1,984 × 220 backing pixels), extracted with `canvas.toDataURL()`. They do not include panel chrome. Full-page T3 snapshots failed repeatedly; no full-page screenshot was available. The colored rectangles and rotated text are content of the existing control PDF, not IFC window geometry.

## Reproduction

1. Open `https://www.ifclite.com/` in the T3 preview, load **Load demo project**, choose **Section → Down → 2D**. If no drawing is generated, use **Regenerate**; this was necessary during the recorded run. Wait until `window.__ifc_lite_viewer_store__.getState().drawing2DStatus` is `ready`.
2. The drawing container is `[data-drawing-canvas]`. Before each wheel case, activate **Fit to view**. Dispatch a bubbling, cancelable `WheelEvent('wheel', ...)` at its center; read the visible zoom percentage after React commits. Use the cases in `browser-observations.json`. For Ctrl, dispatch window keydown with `key: 'Control', ctrlKey: true` first and keyup after. This tests the listener, not OS-generated gestures.
3. Toggle **Projection**. Record `drawing2D.stats` and `drawing2D.config`, then choose **Side** and record again after generation is ready. Inspect the UI for a depth control. These observations do not validate a wall/window visual oracle.
4. Open **Underlays** and supply a `File` via DataTransfer to the `.dxf` file input, then dispatch a bubbling `change`. The test DXF has HEADER `$INSUNITS = 6` (metres) and one ENTITIES LINE on layer SPEC from `(0,0,0)` to `(5,3,0)`. Verify the imported row, plan-only notice and disabled centering. CAD fidelity requires a real CAD export later.
5. Open **Appearance**, select **Place as reference**, then upload the repository's `docs/architecture/evidence/pdf-fidelity-report/control-text-accepted.pdf` through **Upload appearance source**. Wait for its page controls; switching intent while upload is pending can cancel the draft, so select intent first.
6. Use page 1 with its default intrinsic rotation, full-page crop and 144 dpi. Choose calibration points at 25% and 75% of the thumbnail width, both at mid-height. Enter Distance A–B = 5 m, select **YZ · vertical**, retain world point A `(0,0,0)`, and wait for **Reference ready**. Activate **Place reference**. The synthetic control document tests decoding/registration, not architectural alignment quality.
7. With Side active, use Fit. Capture the drawing canvas's RGBA pixels and PNG. Toggle the committed reference's visibility with `updateAppearanceReference(id, { visible: false })`, wait for render and capture again without fitting. Compare each RGBA pixel tuple: the recorded run differed at 17,121 pixels. Restore visibility. The generated IFC drawing was not replaced with a mock.

The run used UI buttons and real file/calibration handlers, with DOM evaluation when focused click calls failed. The visibility comparison used the real store action. No source text was used as a behavior assertion. PDF password/crop edits, full exports, physical input devices, federation and original-reporter geometry were not exercised.

## Environment

Hosted UI v3.4.0; asset deployment `dpl_D9Z1NTZP4fQCNJFYAhtDiUy7A8R2`. T3 Code Alpha 0.0.44, Electron 44.4.2 / Chromium 152, macOS user-agent, 1,280 × 800 CSS viewport, DPR 2, WebGPU available. Source inspection used checkout `ab97764f42222177ac3c64b98f6aa2262c15a98a`; deployed commit identity was not established.

The sample model is the site's public `samples/building-architecture.ifc`. Its site extent means a 50% Side cut can miss the building entirely. Do not treat the 18 resulting projection lines or tiny geometry in the capture as evidence of the reported missing background wall.

The reviewed final source was reloaded for a fresh-model browser smoke: [final-smoke.json](final-smoke.json). It repeats depth 0/3/7 with stable cuts and magnitude-aware wheel behavior; the complete PDF/export screenshot run above remains earlier-source evidence.
