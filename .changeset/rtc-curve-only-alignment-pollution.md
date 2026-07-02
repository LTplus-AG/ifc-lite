---
"@ifc-lite/geometry": patch
"@ifc-lite/wasm": patch
---

Fix shredded geometry in georeferenced IFC4.3 infrastructure models (e.g. Quadri/Trimble road exports). RTC-offset detection sampled a bogus `(0,0,0)` world position for origin-placed, curve-only entities such as `IfcAlignmentSegment` (their only representation is an axis curve, so no body vertex could be read). Those spurious origin votes outnumbered the handful of large-coordinate solids and dragged the detected re-basing offset to zero, so vertices at national-grid magnitudes (~166 km) were cast to f32 with ~16 mm quantization and small features (signals, kerbs) rendered mangled. Curve/axis-only elements now abstain from the RTC sample when they have no meshable body representation, letting the real solids anchor the offset; body elements at the origin still cast their "no shift" vote. Fixes #1526.
