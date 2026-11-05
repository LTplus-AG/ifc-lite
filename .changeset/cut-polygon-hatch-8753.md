---
"@ifc-lite/renderer": minor
---

Section caps accept an optional per-polygon hatch (`CutPolygon2D.hatch`): each cut polygon can carry its own pattern, spacing, angles, width and stroke colour, and any field it omits falls back to `capStyle`. Without `hatch` the cap renders exactly as before (#8753).
