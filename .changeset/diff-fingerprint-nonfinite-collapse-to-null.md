---
'@ifc-lite/diff': patch
---

`buildDataFingerprint`/`buildComponentFingerprints` no longer hash a non-finite property/quantity value (`NaN`/`Infinity`/`-Infinity` — reachable from a STEP `IfcReal` with an extreme exponent, e.g. `1.0E400`) the same as that value being absent. `JSON.stringify`, which both functions feed into, has no non-finite numeric literal (RFC 8259) and silently maps all three to `null`; `normalizeValue` now stringifies a non-finite number first, so it survives as a distinct token instead of colliding with a genuinely `null` property. Left unfixed, that collision let `matchUnpairedByContent` retire a real `added`/`deleted` pair as one "unchanged" match whenever the only difference was a corrupt-but-present value versus an absent one.
