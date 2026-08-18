---
'@ifc-lite/create': patch
---

Reject non-finite (`NaN`/`Infinity`) dimensions and `Start`/`End` coordinates in `IfcCreator`, the from-scratch STEP builder, instead of silently emitting them into the file.

A bare `value <= 0` check is `false` for both `NaN` and `Infinity`, so those values used to pass every dimension guard and land in the emitted STEP as the literal strings `"NaN"`/`"Infinity"` — not valid STEP REAL tokens. `addIfcColumn` had no dimension guard at all, so a negative or zero `Width`/`Depth`/`Height` passed through too. Every dimension-taking method on `IfcCreator` (`addIfcWall`, `addIfcColumn`, `addIfcBeam`, `addIfcSlab`, `addIfcRoof`, `addIfcGableRoof`, `addIfcDoor`/`addIfcWindow` and their wall-hosted variants, `addIfcRamp`, `addIfcRailing`, `addIfcPlate`, `addIfcMember`, `addIfcFooting`, `addIfcPile`, `addIfcSpace`, `addIfcCurtainWall`, `addIfcFurnishingElement`, `addIfcBuildingElementProxy`, and the I/L/T/U/hollow-section shape methods) now validates through a shared `assertPositiveFinite` helper.

Separately, `addIfcWall`, `addIfcBeam`, `addIfcMember` and the shape-section methods compute a length from `Start`/`End` and only rejected an exact zero-length vector (`Start === End`). A non-finite coordinate makes the computed length `NaN`, and `NaN <= 0` is also `false`, so that guard never fired either — the point is now validated at the source via a new `assertFinitePoint3` helper before any arithmetic runs.

This is the same defect class as `@ifc-lite/create`'s `in-store/` builders fixed in #2767 (`assertPositiveFinite` there, and the `beamLen`/`wallLen`/`memberLen` distinct-points gap in `beam.ts`/`wall.ts`/`member.ts`), extended here to `ifc-creator.ts` — a separate, from-scratch builder class outside `in-store/` that shares no code with it — and to the equivalent `Start`/`End` distinct-points gap in those same `in-store/` builders, which #2767 left out of scope.

`addIfcColumn`'s new `Height` guard also rejects `0`, which is spec-correct (`IfcExtrudedAreaSolid.Depth` is an `IfcPositiveLengthMeasure`) but is a value adversarial test tooling deliberately constructs to exercise how the geometry pipeline handles degenerate, spec-invalid extrusions. `IfcCreator` now also exposes `addIfcColumnUnvalidated`, a deliberately unvalidated escape hatch for that kind of fixture-building; it is not meant for application code.
