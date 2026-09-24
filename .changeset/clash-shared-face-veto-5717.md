---
"@ifc-lite/clash": patch
---

Fix a genuine interpenetration being reported as a zero-depth touch when the two elements also share a coplanar face and sit off the world axes. A curtain-wall panel and a mullion authored to the same height overlap laterally by 20 mm while their tops and bottoms are flush; rotated off-axis, the pair read as `touch` at distance 0, and with touch reporting off the clash vanished from the report entirely. Tolerance made no difference, and every overlap from 0.5 mm to 20 mm behaved the same way.

The cause was the scope of one of the three candidates the noise-floor gate tests. `crossingVertexPenetration` is a sampling probe, not a depth metric — its own documentation says so, and it underestimates by an amount that depends on tessellation. It exists to stop a *fabricated AABB estimate* promoting a flush contained pair to `hard`. But it was consulted even when the pair had a certified exact box depth, and there a mullion corner lying on a face the two boxes share bakes, through f32, a noise-width inside once the pair is rotated. The probe reported that as a sub-floor penetration and vetoed a depth the box MTD had already measured correctly.

Mesh evidence now guards the estimate and only the estimate. Two boxes that are genuinely flush still report `touch` through the box-MTD term instead, so the flush case is unchanged.
