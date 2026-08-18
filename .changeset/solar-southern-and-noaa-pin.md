---
'@ifc-lite/solar': patch
---

Test coverage only: no production logic changed.

Every non-pole latitude fixture in `packages/solar`'s test suite was
northern (51.4769, 78, 47); mutating `latitude` to `Math.abs(latitude)` at
both `solar-position.ts:131` and `sun-times.ts:53` left the full 38-test
suite green. Added a Sydney (-33.87, 151.21) fixture asserting the season
flip (December altitude/day-length exceeds June, the opposite of the
package's northern-hemisphere fixtures) and the azimuth flip (solar noon
transits near due north, not due south), with a wraparound-safe azimuth
check.

Also added the package's first comparison against a reference sourced
outside the repo: every existing assertion was a round-trip, an invariant,
or a cross-check between `sunPosition` and `sunTimes.solarNoon` -- both
built on the same `solarGeometry`, so self-consistent but not validated
against the published NOAA Solar Position Calculator this package claims to
implement. Pinned `solarGeometry` at the 2024 June solstice and `sunPosition`
at NOAA's own Boulder, CO worked example against values independently
re-derived from the published NOAA equations.
