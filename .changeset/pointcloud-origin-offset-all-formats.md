---
"@ifc-lite/pointcloud": minor
---

Extend #1804's LAS/LAZ `originOffset` precision fix to the other four point-cloud formats: `decodeE57Packet`/`decodeE57Scan`/`decodeE57`/`applyPoseInPlace`, `decodePcd`, `decodePly`, and `decodeAsciiPoints`/`decodeAsciiPointsFromText` all gain an optional `originOffset` (native X/Y/Z), subtracted in f64 before narrowing to f32, matching `decodeLasPoints`'s existing parameter shape. Their streaming sources (`E57StreamingSource`, `PcdStreamingSource`, `PlyStreamingSource`, `AsciiPointsStreamingSource`) thread it through the same way LAS/LAZ already did.

A georeferenced E57 scan or a PTS/XYZ export at survey/state-plane magnitude (~1e6 m) previously quantised to ~0.12 m of per-point noise on decode — worse at higher magnitudes — before any alignment math ever saw the coordinates. E57 scans with a `<pose>` compose the offset onto the pose's translation (post-rotation) rather than the pre-rotation local cartesian, so an origin shift never gets rotated along with the points.

All new parameters are optional and additive — omitting them reproduces prior behaviour byte-for-byte.

`decodePly` is now exported from the package root alongside `decodePcd`/`decodeAsciiPoints`/`decodeE57Scan`, matching the other three format decoders — it was the one omission from that set.

**Adversarial review fix**: the viewer's `computePointCloudAlignment()` (`apps/viewer/src/hooks/ingest/pointCloudAlignment.ts`) previously derived its decode-time offset in the model's `IfcProjectedCRS.MapUnit` unconditionally — correct for LAS/LAZ, which stores coordinates natively in that unit, but wrong for every format this change threads the offset to: E57 cartesian coordinates are metres by spec (ASTM E2807) regardless of MapUnit, and PCD/PLY/PTS/XYZ have no unit convention of their own. Removing the LAS/LAZ-only alignment gate (this PR) fed the same MapUnit-native offset into all five decoders unchanged, so a scan point exactly at the conversion origin under a non-metre MapUnit (e.g. feet) decoded thousands of kilometres off. `computePointCloudAlignment` now takes a `sourceUnit: 'mapUnit' | 'metre'` parameter that the viewer passes per format (`'mapUnit'` for LAS/LAZ, `'metre'` for E57/PCD/PLY/PTS/XYZ — metres is the explicit, documented assumption for the formats with no convention of their own, not a silent default); it derives both the offset and the aligned matrix's linear scale factor consistently for whichever unit was requested. LAS/LAZ behaviour is unchanged.
