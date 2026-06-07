---
"@ifc-lite/diff": minor
---

New package `@ifc-lite/diff`: a headless, store-agnostic model-diff engine.
`diffModels` classifies entities across two revisions as added / modified /
deleted / unchanged, with a `scope` toggle (`data` | `geometry` | `both`) that
selects whether attribute/property differences, geometry-fingerprint
differences, or both count as a modification. Ships `buildDataFingerprint` (a
canonical, order-independent data hash) and consumes the RTC-invariant geometry
hashes exposed from the WASM mesh pass.
