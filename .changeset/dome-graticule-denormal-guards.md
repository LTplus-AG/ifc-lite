---
"@ifc-lite/solar": patch
---

Fix `domeGraticule` hanging on a non-positive or denormal `altitudeStep`, `azimuthStep` or `resolution` (e.g. `0` or `Number.MIN_VALUE`): a denormal step is too small to advance its loop's accumulator (`90 + Number.MIN_VALUE === 90`), so the loop never terminated. Each option now has a finite, positive, bound-relative guard — `altitudeStep` against its loop's bound of 90, `azimuthStep` against its bound of 360, `resolution` against 360 (the larger of the two bounds it drives, which also covers its 90-bounded use). `NaN` for `altitudeStep` and `resolution` was already rejected immediately (not a hang) and still is; `NaN` for `azimuthStep` previously returned a graticule with only the azimuth-0 spoke and now throws. Legitimate fine-grained values (e.g. `altitudeStep: 0.5`, `resolution: 0.1`) are unaffected.
