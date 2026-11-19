# Recorded 3D Tiles fixtures

Small extracts of swisstopo's hosted swissBUILDINGS3D 3D Tiles, used by the
offline tests. No test touches the network.

- Source: <https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json>
  (documented at <https://docs.geo.admin.ch/visualize-data/3d-tiles.html>), release `20260520`.
- Recorded: 2026-11-15.
- Attribution: © swisstopo. Open government data, free use with mandatory source reference.

| File | Origin | Change |
| --- | --- | --- |
| `swisstopo-root-tileset.json` | `v1/tileset.json` | verbatim |
| `swisstopo-20260520/tileset.json` | `v1/20260520/tileset.json` | trimmed to the paths to `tileset9`, `tileset21` and `tileset29` |
| `swisstopo-20260520/tileset29.json` | `v1/20260520/tileset29.json` | trimmed to the path to `tileset23` |
| `swisstopo-20260520/tileset23.json` | `v1/20260520/tileset23.json` | trimmed to the path to `11/668/1170.b3dm` and its three sibling leaves |
| `swisstopo-20260520/tileset9.json` | `v1/20260520/tileset9.json` | trimmed to the path to `tileset1` |
| `swisstopo-20260520/tileset1.json` | `v1/20260520/tileset1.json` | trimmed to the path to `11/83/393.b3dm` and its three sibling leaves |
| `swisstopo-20260520/11/668/1170.b3dm` | Bern, 4 buildings | verbatim (16,012 bytes) |
| `swisstopo-20260520/11/83/393.b3dm` | Geneva, 9 buildings | verbatim (16,448 bytes) |

Trimming only removes nodes. Every kept node, bounding volume and geometric
error is unchanged, so traversal over the fixtures follows the same chain as
the live service (root, dated release, subtree, sub-subtree, leaf). Only the
two leaves above are recorded; the trimmed siblings answer 404 in the tests.
