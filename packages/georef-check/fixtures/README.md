# georef-check fixtures

Small synthetic IFC files, one per diagnosis, plus clean ones that must produce
no finding. `src/fixtures.test.ts` maps every file to the exact findings it
must produce. No teaching or customer model is included; each defect is
reproduced from scratch.

- `clean-*`: correct models (LV95 in millimetres, LV95 turned 30°, the
  zone-prefixed EPSG:4647, IFC2X3 with the ePSet convention).
- every other file: the defect its name says, departing from `clean-lv95-mm`
  in one field.

## Third-party file

`control-terrain-epsg3006.ifc` is `fixtures/ifc-lite-control/terrain.ifc` from
[louistrue/openBIM-surveyor](https://github.com/louistrue/openBIM-surveyor),
unchanged. It is a synthetic control fixture (an IFC 4.3 terrain in a local
frame with an IfcMapConversion to EPSG:3006, SWEREF 99 TM), dedicated to the
public domain under CC0 1.0
(<https://creativecommons.org/publicdomain/zero/1.0/>). Here it is a clean
reference: a correct IFC 4.3 georeference from an independent source.
