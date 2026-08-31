---
'@ifc-lite/parser': patch
---

Fixed the legacy `IfcSite.RefLatitude`/`RefLongitude` fallback silently flipping a southern/western site to northern/eastern when a writer carries the hemisphere sign on a zero-magnitude degree token. `IfcCompoundPlaneAngleMeasure` degrees are STEP INTEGER literals; the spec's canonical form puts the sign on the first non-zero component (0°30'S is `(0, -30, 0)`), which the extractor already honoured. Some writers instead sign the degree token itself even when it is `0`, e.g. `(-0, 30, 0)` for the same 0°30'S — a non-canonical but plausible (defensive) encoding. The STEP tokenizer parses that literal to IEEE-754 negative zero (`parseFloat('-0') === -0`), but the sign test was `degreesRaw < 0`, which evaluates `false` for `-0` in JavaScript, so the whole angle silently flipped positive. The sign check now also matches `Object.is(component, -0)` on every component (degrees, minutes, seconds, millionths).
