---
"@ifc-lite/pointcloud": minor
---

Extend #1804's LAS/LAZ `originOffset` precision fix to the other four point-cloud formats: `decodeE57Packet`/`decodeE57Scan`/`decodeE57`/`applyPoseInPlace`, `decodePcd`, `decodePly`, and `decodeAsciiPoints`/`decodeAsciiPointsFromText` all gain an optional `originOffset` (native X/Y/Z), subtracted in f64 before narrowing to f32, matching `decodeLasPoints`'s existing parameter shape. Their streaming sources (`E57StreamingSource`, `PcdStreamingSource`, `PlyStreamingSource`, `AsciiPointsStreamingSource`) thread it through the same way LAS/LAZ already did.

A georeferenced E57 scan or a PTS/XYZ export at survey/state-plane magnitude (~1e6 m) previously quantised to ~0.12 m of per-point noise on decode — worse at higher magnitudes — before any alignment math ever saw the coordinates. E57 scans with a `<pose>` compose the offset onto the pose's translation (post-rotation) rather than the pre-rotation local cartesian, so an origin shift never gets rotated along with the points.

All new parameters are optional and additive — omitting them reproduces prior behaviour byte-for-byte.
