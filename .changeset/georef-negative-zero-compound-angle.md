---
'@ifc-lite/parser': patch
---

Fixed the legacy `IfcSite.RefLatitude`/`RefLongitude` fallback reporting a southern/western site as northern/eastern when the sub-degree sign was carried on a magnitude-zero degree component. `IfcCompoundPlaneAngleMeasure` degrees are STEP INTEGER literals, and a legal way to encode e.g. 0°30'S is `(-0, 30, 0)` — the sign is written on the degree token even though it is numerically zero. The STEP tokenizer parses that literal to IEEE-754 negative zero (`parseFloat('-0') === -0`), but the sign test was `degreesRaw < 0`, which evaluates `false` for `-0` in JavaScript, so the whole angle silently flipped positive. The sign check now also matches `Object.is(component, -0)` on every component (degrees, minutes, seconds, millionths), matching the function's existing "any negative component" intent.
