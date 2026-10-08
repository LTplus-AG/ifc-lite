# Scan section outline evidence (#6871)

These files back the viewer PR for issue #6871, the vector outline traced from a scan section slab.

- `synthetic-floor-outline.png` and `synthetic-floor-outline-with-dots.png` show the built viewer:
  - Plan section at 1.5 m, a 300 mm band, and Vector outline on.
  - 11 rings on 20 mm cells from 100,301 in-band points.
  - The first image dims the dots to 10 %.
- `make-synthetic-floor.mjs` is the seeded generator of the scan (binary PLY):
  - A floor rotated 12° with partitions, door and window openings, a column, furniture, floor, ceiling and clutter.
  - `node make-synthetic-floor.mjs out.ply` writes the 1.5 M point file used for the screenshots.
  - The worker measurement below used about 9.3 M points (`DENS` and the floor/ceiling count scaled ×6.6).
- `floor-slab.ifc` is the small IFC4 file (five columns) loaded with the scan so that the drawing has a cut to fit to.

No real scan was reachable: the fixture manifest has no LAS/LAZ/E57.

## Main-thread jank (#6884 review)

The measurement used the 9.3 M point PLY, so 2 M points were retained in the scan cache. The band was 2 m with 914 k points in it, and the setting was changed three times. Durations are long tasks in milliseconds, from `PerformanceObserver('longtask')`.

| Build | Long tasks per change | Longest |
| --- | --- | --- |
| Outline on, before (band and trace on the main thread) | 238 + 166, 245 + 185, 255 + 183 | 255 |
| Outline on, after (band and trace in the worker, one commit) | 131 + 191, 111 + 249, 114 + 245 | 249 |
| Outline off, same build (dot layer only) | 112 + 213, 111 + 215, 144 + 278 | 278 |

The outline's own work no longer runs on the main thread: about 130 ms of band collection and about 180 ms of tracing per change. What remains is the dot layer's selection (about 110 ms) and one canvas redraw of the dense band (about 200 ms). Both exist with the outline off. With the outline on, the dots and the rings are committed together, so the canvas repaints once per change.
