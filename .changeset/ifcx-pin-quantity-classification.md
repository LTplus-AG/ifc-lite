---
'@ifc-lite/ifcx': patch
---

Pin `isQuantityProperty` / `routesToQuantityTable` quantity-vs-property
classification against real third-party IFC5 fixtures (buildingSMART sample
scenes under `tests/models/ifc5/`), not our own writer's output.

`exactQuantityNames` and `suffixPatterns` in `property-extractor.ts` are two
hand-maintained, asymmetric name lists (e.g. `Height`/`Width`/`Depth`/
`Thickness` are exact-match only, absent from the suffix list) with no prior
test coverage in the package. A corpus-wide census of every
`bsi::ifc::prop::*` short name across the whole downloaded fixture set found
no real misclassification: every name present (`Height`, `Width`, `Depth`,
`Volume`, `Length`, `NetArea`, `NetSideArea`, `NetVolume`,
`CrossSectionArea`, plus non-quantity names like `ElevationOfRefHeight`,
`ElevationOfTerrain`, `NumberOfStoreys`) already classifies correctly — this
is a coverage gap, not a bug fix.

New tests pin the exact quantity/property split for `Hello_Wall_hello-wall.ifcx`
and the PCERT `Building-Architecture`/`Building-Structural` sample scenes by
value, so a future edit to either list can no longer silently regress the
split (deleting `Height` from `exactQuantityNames` previously left the
package's whole suite green while dropping Hello Wall's extracted quantities
from 10 to 5).
