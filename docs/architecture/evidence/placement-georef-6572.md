# Placement georeference with World/Map disabled (#6569, #6572)

Verified on 2026-10-01 using the reporter's Allplan 2026.1 IFC4X3_ADD2
[attachment](https://github.com/user-attachments/files/32858853/ifc.txt).
SHA-256: `ed9263543567357324d52ecf737e46e4be96c2688dd9c65d003294dfbab4b57d`.

## Real-model UI oracle

Download the attachment, then run from the repository root:

```sh
curl -L --fail -o /tmp/issue6569.ifc https://github.com/user-attachments/files/32858853/ifc.txt
PLACEMENT_GEOREF_IFC=/tmp/issue6569.ifc TEST_SHARDS=1000003 TEST_SHARD=945454 pnpm test --filter=@ifc-lite/viewer --env-mode=loose --force
```

Observed output: **3 tests, 3 passed, 0 failed, 0 skipped**. Each test parses
that full IFC with `IfcParser`, mounts the real `ViewportContainer` and
`PlacementPanel`, and checks the published context and panel content with
`cesiumEnabled=false`, `solarEnabled=false`, and editing disabled. Cases cover
legacy loading, one federated model, and two models with the georeferenced
anchor second. The context assertions observed:

```json
{"crs":"EPSG:2056","eastings":2619073.0368,"baseEastings":2619073.0368}
```

The panel displays its georeference edit control and guidance instead of
“No georeferenced model”. Removing the georeferenced model clears the context
and restores that empty state.

## Browser verification

Loaded the same full attachment through the viewer's file input: 1.12 MB,
13,466 entities, 146 elements with geometry. Opened Placement > Georeference,
then toggled View > World on and off. The georeference tab stayed available.
Enabled the tab's Move Georef switch while World remained off. The panel showed:

- Eastings: `2619073.04 m`
- Northings: `1263523.60 m`
- OrthogonalHeight: `0.00 m`
- XAxis angle: `0.00 deg`

The World control's tooltip read “Show 3D world context (Cesium)”, confirming
it was off. No placement edit was applied to the file.

## Regression sensitivity

`node scripts/check-test-revert-oracle.mjs --base origin/main --ci --json`
returned `OBSERVED`: the regression tests pass with the fix, and restoring the
base `ViewportContainer.tsx` turns their panel-content assertions red.
