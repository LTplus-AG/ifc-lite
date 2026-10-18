---
"@ifc-lite/wasm": patch
---

Fixed rebates authored flush with a wall face being cut through the whole wall when the wall sits tens of metres from the origin. The recess check compared faces with a tolerance of `thickness * 1e-5`, below the f32 rounding of the wall's vertices at that distance (4.3 µm at 51 m against 2.5 µm for a 250 mm wall), so a 190 mm rebate in a 250 mm wall was extended through the remaining 60 mm. The tolerance is now floored at the f32 noise of the coordinates.
