---
"@ifc-lite/create": minor
---

Derive wall thickness from geometry when there's no material layer set.
`extractWallSegmentsForStorey` previously read thickness only from
`IfcMaterialLayerSet`, so models without material layers (e.g. structural
"Tragwerk" exports) reported `undefined` for every wall and the net/gross room
boundary had nothing to offset by. It now falls back to the wall's body
footprint — the extent perpendicular to its principal (length) axis is the
thickness — which is geometric and schema-agnostic (no reliance on optional or
locale-specific property sets). Material-layer total stays preferred when
present; overlay (authored) walls report their footprint thickness too.
Verified on a 1036-wall structural model: every wall now resolves a real,
per-wall thickness (0.08–1.0 m) instead of nothing.
