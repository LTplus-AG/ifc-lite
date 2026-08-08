---
"@ifc-lite/solar": patch
---

Fix `domeGraticule` hanging on a denormal `altitudeStep` or `resolution` (e.g. `Number.MIN_VALUE`): both passed the existing `step > 0` check but were too small to advance their loop's accumulator, so the loop never terminated. Each option now has a bound-relative guard — `altitudeStep` against its loop's bound of 90, `resolution` against 360 (the larger of the two bounds it drives, which also covers its 90-bounded use) — matching the guard shape already applied to `dayPath` and `analemmaPaths`. `NaN` for either option was already rejected immediately (not a hang) and still is. Legitimate fine-grained values (e.g. `altitudeStep: 0.5`, `resolution: 0.1`) are unaffected.
