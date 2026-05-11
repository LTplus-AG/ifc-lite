---
"@ifc-lite/pointcloud": minor
"@ifc-lite/viewer": minor
---

PTS / XYZ ASCII point cloud reader.

Both formats are line-oriented plain-text scans common in legacy
survey workflows. They share the same syntax — they differ only in
the optional first-line point count (PTS may have one; XYZ never
does). One shared decoder + streaming source handles both.

Auto-detected per-line layouts (by column count of the first data
line):
- 3 cols → `X Y Z`
- 4 cols → `X Y Z I` (intensity)
- 6 cols → `X Y Z R G B`
- 7 cols → `X Y Z I R G B` (canonical PTS)
- 9 cols → `X Y Z R G B Nx Ny Nz` (XYZ-with-normals; normals dropped)
- 10 cols → `X Y Z I R G B Nx Ny Nz` (PTS-with-normals; normals dropped)
- For XYZ with unknown column counts ≥3 we still emit positions and
  skip the rest, so weird custom exports load instead of erroring.

Other behaviour:
- Comment lines (`#`, `//`) and blank lines are skipped.
- Intensity normalisation: 0..1 vs 0..255 vs raw sensor detected from
  the observed maximum, then mapped to u16.
- RGB normalisation: same heuristic (>1.0 → 0..255 source).
- Whole-file decode wrapped in `AsciiPointsStreamingSource`; the
  streaming host's 25M-point cap stride-downsamples on the way out.

Wired into the decode worker, format detection
(`detectPointCloudFormat` returns `'pts'` / `'xyz'`), the file
picker accept lists, drop handlers, and both `useIfcLoader` /
`useIfcFederation` ingest branches. The "PTS / XYZ ASCII points —
not yet supported" toast is removed from `describeUnsupportedFormat`.

10 new unit tests cover layout probing, decoder round-trips for the
common shapes, and the comment / header-count edge cases.
