# Registered scan appearance: bounded browser control

This is a same-source workflow control, not an independent scan-to-BIM accuracy
claim. It uses the public textured boulder GLB and a previously authored IFC
capture of the same geometry. Source provenance and the original full-surface
alignment control are recorded in [scan-alignment-workbench](../scan-alignment-workbench/README.md).
The source has 66,122 triangles. This run explicitly creates and selects a
350-triangle destination; no scope reduction happens inside transfer.

## Reproduce the interaction

1. Open the captured IFCZIP, then Add `boulder-albedo.glb` through the canonical
   loader. Fixture content hashes and actual browser/WASM versions are in
   [runtime.json](runtime.json).
2. In Author → Appearance → Create from scan, choose the GLB surface and Select
   region. The rectangle runs from `(0.48, 0.48)` to `(0.50, 0.515)` of the default
   preview canvas. Create **Transfer control region**. [declared-region.png](declared-region.png)
   shows the explicit through-surface region; both front and back triangles remain.
3. Use the existing Apply to IFC action to give that selected object an 8×8
   solid-blue PNG (`#1746df`). This makes retained unknown appearance independently
   distinguishable from the brown scan image. Other IFC objects remain unchanged.
4. Hide the GLB in the main view and open Align scan. For this known same-source
   control only, arrange the main camera using the actual source preview camera
   and the fixtures' known translation. Pick four fit and four independent check
   pairs through normal preview/main-view clicks. No observations are injected.
   The recorded [good.json](good.json) retains triangle/barycentric identities and
   the native request/report. Normalized preview click positions are
   `(0.40,0.45)`, `(0.58,0.44)`, `(0.43,0.62)`, `(0.58,0.64)`,
   `(0.48,0.40)`, `(0.38,0.54)`, `(0.53,0.47)`, `(0.49,0.53)`.
5. Choose **Transfer control region** in the searchable target list. Review the
   fit/check errors and spread against a 0.01 m project tolerance.
6. First preview at 64 pixels/m, 0.02 m maximum distance, 0.8 normal agreement and
   0.001 m ambiguity distance. [sparse-no-apply.png](sparse-no-apply.png) shows
   **0/540 transferred interior texels**, despite 324 observed diagnostic
   centroids. Apply is absent. The [native paired regression](../mesh-transfer-texel-gate/README.md)
   separately proves that the former sparse atlas contained only old blue pixels.
7. Explicitly change sampling to 512 pixels/m and 0.00001 m ambiguity distance;
   leave the other settings unchanged. Preview reports **6,117/7,963 observed
   interior texels**, with an estimated observed area of 79.7%.
8. Isolate the chosen owner through canonical visibility state for this controlled
   comparison, select it with an actual canvas click, and use the ordinary
   orthographic projection, Frame and wheel controls. Compare the same view:
   [original blue](compare-original.png) and [transferred appearance](transfer-preview.png).
   Brown scan pixels and blue unknown boundaries are visibly different. These
   conservative seams and partial coverage are deliberate retained-appearance
   behavior, not a claim of seamless texture synthesis.
9. Apply. [refreshed.json](refreshed.json) retains all eight pairs and a new native
   digest against the changed effective IFC. Undo and explicitly Revalidate
   retained landmarks; Redo and revalidate again. Export through the ordinary
   IFCZIP dialog. [applied.png](applied.png), [undo.png](undo.png), and
   [redo.png](redo.png) record that history journey.
10. Open that IFCZIP in a fresh browser, isolate the region through canonical
    visibility state, and select it with an actual mouse click. The
    [reimport witness](reopened-selected.png) and [reopen-proof.json](reopen-proof.json)
    record the selected owner, texture, triangle count and decoded-pixel digest.

## Independent export checks

[ifc-oracle.json](ifc-oracle.json) records an IfcOpenShell 0.8.2 inspection of the
exact pre-Apply IFC and exported IFCZIP. The destination's coordinate list,
triangle indices and placement are unchanged. Every reopened triangle corner
matches the exported IFC world position and its associated native V-up UV after
one flip to GPU V-down. Maximum discrepancies are about `7.3e-8 m` and `4.45e-8`
UV units, within the expected Float32 representation.

All decoded atlas pixels match the fresh browser bitmap exactly. The exported
256×271 PNG contains 21,970 opaque non-blue pixels and 25,230 retained-blue pixels;
those counts include atlas padding and must not be confused with the native
interior-texel coverage counters. [exported-atlas.png](exported-atlas.png) is the
actual exported image. The original scan JPEG remains in the IFCZIP for the
untouched full-surface object.

## Verification and limits

[validation.json](validation.json) records exact input/output hashes and local
checks. The six changed-test groups pass all 31 tests on Node 22.23.2 through
root Turbo: mounted cancellation/settings/stale/removal, geometry rebind guards,
actual native transfer and PDF envelopes, rotated IFC parent plus unequal
rebases, worker ownership and snapshot fencing. Root typecheck, full build,
lint, API/module/license gates and documentation checks pass.

The broader Node 26 viewer run has 7,668 passing tests, 12 skips and one existing
registry failure: `layerStackSlice` was both registered and exempt. That defect
is tracked independently as #4424; it is not hidden as a passing full suite.
Build graphs and final acceptance runs were separated. Chromium and owned dev
servers are closed after acceptance.

The control does not validate independent surveyed registration, RGB-point or
posed-photo transfer, general scan reconstruction, arbitrary full-model
capacity, or room sharing of this specific transfer. Those remain #4381 and
future-adapter acceptance. The existing native work/memory limits remain active;
the full boulder target is not silently substituted for this explicitly selected
small region.
