# Recorded BAFU surface-runoff map responses

Real responses of `https://wms.geo.admin.ch/`, recorded on 2026-11-15, used to
test exact legend decoding (including antialiased class edges) without network
access. Each request is WMS 1.3.0 GetMap of layer
`ch.bafu.gefaehrdungskarte-oberflaechenabfluss`, `CRS=EPSG:2056`,
`FORMAT=image/png`, `TRANSPARENT=true`, `STYLES=` (empty); BBOX is easting,
northing.

| File | BBOX (EPSG:2056) | Size | Cell |
| --- | --- | --- | --- |
| `bern-three-classes-200px.png` | 2599537,1199703,2599637,1199803 | 200 x 200 | 0.5 m |
| `bern-sparse-200px.png` | 2600500,1199450,2600600,1199550 | 200 x 200 | 0.5 m |
| `bern-uniform-9px.png` | 2599560,1199720,2599569,1199729 | 9 x 9 | 1 m |
| `bern-aare-watercourse-100px.png` | 2600500,1198900,2600600,1199000 | 100 x 100 | 1 m |

`legend-de.png` is the published legend,
`https://api3.geo.admin.ch/static/images/legends/ch.bafu.gefaehrdungskarte-oberflaechenabfluss_de.png`;
its five swatches are the legend colours pinned in `src/bafu/dataset.ts`.

Source: Bundesamt für Umwelt BAFU, «Gefährdungskarte Oberflächenabfluss»,
https://www.bafu.admin.ch/en/surface-runoff. Federal geodata under the
geo.admin.ch terms of use (https://www.geo.admin.ch/en/general-terms-of-use-fsdi);
source reference mandatory.

Full request for the first file:

```
https://wms.geo.admin.ch/?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ch.bafu.gefaehrdungskarte-oberflaechenabfluss&STYLES=&CRS=EPSG:2056&BBOX=2599537,1199703,2599637,1199803&WIDTH=200&HEIGHT=200&FORMAT=image/png&TRANSPARENT=true
```
