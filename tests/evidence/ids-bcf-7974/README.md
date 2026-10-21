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
It did not cover geometry-less failures or grouped snapshots. No direct
BIMcollab import result is claimed by this receipt.
