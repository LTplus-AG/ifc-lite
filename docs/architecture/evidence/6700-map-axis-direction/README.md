# IfcMapConversion axis direction (#6700)

`XAxisAbscissa` / `XAxisOrdinate` give the DIRECTION of the local X axis; only
their ratio is meaningful, and `Scale` is applied separately. The viewer's
projection arithmetic now reduces the pair to a unit direction in one place,
`resolveMapAxisDirection` in `apps/viewer/src/lib/geo/map-axis-direction.ts`.
Authored values are never rewritten.

## The stated invariant, before and after

Metre model, metre CRS (EPSG:32632), offsets (0,0,0), Scale 1, no factors,
engineering point (500000, 4000000). `invariant.mts` runs it through the real
APIs: the Cesium model origin, the Location pin, the placement delta helper and
the shared spatial-reference boundary.

```
cd apps/viewer
npx tsx --import ./src/test/vite-module-hooks.mjs \
  ../../docs/architecture/evidence/6700-map-axis-direction/invariant.mts
```

On `upstream/main` (output as printed):

```
axis [1,0]   cesiumOrigin_EN [500000,4000000]   pin_latLon [36.14471809881776,9]                    placementDelta_EN [500000,4000000]   spatialReference_EN [500000,4000000]
axis [2,0]   cesiumOrigin_EN [1000000,8000000]  pin_latLon [71.56574032850011,23.28568567388505]   placementDelta_EN [1000000,8000000]  spatialReference_EN [500000,4000000]
axis [0.5,0] cesiumOrigin_EN [250000,2000000]   pin_latLon [18.07425280849823,6.638002079985051]   placementDelta_EN [250000,2000000]   spatialReference_EN [500000,4000000]
```

With the fix, all three axes print `[500000,4000000]` for the origin, the
placement delta and the spatial-reference result, and `[36.14471809881776, 9]`
for the pin.

The spatial-reference column is unchanged: `@ifc-lite/geometry` already
divided by the vector length, so that boundary did not have the defect. It is
pinned by tests so it keeps agreeing with the viewer's helper.

## Tests

```
cd apps/viewer
npx tsx --import ./src/test/vite-module-hooks.mjs --test \
  src/lib/geo/map-axis-direction.projection.test.ts \
  src/lib/geo/map-axis-direction.test.ts
cd ../../packages/export && npx vitest run src/step-georeferencing.test.ts
```

## Catalogued producer witness

None. All 122 catalogued `.ifc` / `.ifczip` fixtures (after `pnpm fixtures`)
were scanned: 17 `IFCMAPCONVERSION` records, 2 with `$` axis attributes, and
every other axis has length 1 to within 1.3e-10 (the bundled
`Building-Architecture` shape is `0.4999999999999999, 0.8660254037844387`). The
non-unit cases in the tests are labelled synthetic.
