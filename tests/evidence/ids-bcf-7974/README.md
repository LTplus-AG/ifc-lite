# Grouped validation BCF viewpoints (#7974)

`grouped-export.bcfzip` is the actual download from the production viewer
bundle in native Chrome, using the public Archicad AC20-FZK-Haus model. The
browser ran two real information-validation rules requiring a nonexistent
name: 13 IfcWallStandardCase failures and one IfcBuilding failure. The export
dialog grouped by specification, with cameras and snapshots enabled.

Both topics contain a perspective camera, selected IFC components, and a PNG
snapshot. All six XML entries pass the committed official BCF 2.1 schemas with
`xmllint --noout --schema`. File hashes and validation results are recorded in
`grouped-export-receipt.json`; `grouped-export.png` shows the browser result.

Reproduce after building and starting the production viewer preview on port 3000:

```sh
IDS_BCF_VIEWER_URL=http://127.0.0.1:3000 IDS_BCF_EVIDENCE_DIR=/tmp \
  pnpm exec playwright test tests/e2e/ids-bcf-export.e2e.spec.ts \
  --project=viewer-e2e --reporter=list
```

The full-export regression in `idsBcfExport.test.ts` additionally covers
federated assembly descendant GUIDs in isolation/coloring, missing geometry,
perspective/orthographic fallback, world translation, camera-disabled snapshots,
active clipping, and failed capture. Restoring only the original
`idsBcfExport.ts` from base commit `6f5f76339a` makes all six new tests fail;
the fixed source was restored afterward.

The earlier `bounds.oracle.patch` documents #7988's mesh-only regression.
It did not cover geometry-less failures or grouped snapshots. Native BIMcollab Zoom 9.9.3.0 activated both corrected viewpoints: 13 walls
selected/framed, and the building framed with 123 selected elements. Louis
independently confirmed both, then confirmed failure with `main-negative-export.bcfzip`
(exported through the actual UI with main export code at `81a93228c4`). That
negative archive has no building camera and no topic snapshots.

`bimcollab-walls.png` and `bimcollab-building.png` record native activation before
the final spatial-context thumbnail refinement. The final archive here was
verified in the strict production browser: geometry-less spatial containers
retain visible model context and the same real camera in BCF and snapshot,
rather than isolating only aggregated storeys/spaces. The full-export spatial
regression fails against the previous production code and passes with the fix.

The browser test uses the shared `gpu-device-loss.ts` guard around model loading
and GPU snapshot capture. Hosted CI (`E2E_GPU_STRICT=0`) skips only on recorded
device-loss evidence; strict hardware runs still fail on errors. This was checked
with a passing strict production run and a forced device-loss run that skipped
with the expected diagnostic. Archive assertions remain outside the GPU guard.
