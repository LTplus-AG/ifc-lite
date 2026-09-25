---
"@ifc-lite/clash": patch
"@ifc-lite/wasm": patch
---

A through-penetration between two boxes no longer reports a depth larger than the distance that actually separates them.

When one box pierces clean through another (a duct through a wall, two crossing walls), the engine reports the bounding-box estimate instead of the exact box depth, because the exact depth is inflated by the piercing member's own length. For rotated boxes that estimate is inflated too, and when a member pokes out of the far face by only microns, float32 rounding decides per placement whether the pair counts as a through-penetration. A 26 mm overlap was reported as 0.026 m at one position and 0.786 m at another, depending only on where the model sat.

The reported depth of a through-penetration between two boxes is now capped by the exact box depth. That distance is proven to separate the pair, so a larger number over-reports it. In the case above, both sides of the tie now report the same 26 mm, and the result is still labelled an estimate. A thin member through a thick element, where the estimate is smaller than the exact depth, is unchanged. On 11 sample models (about 370 clash records), no reported depth or label changes.
