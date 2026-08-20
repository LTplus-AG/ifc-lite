---
'@ifc-lite/create': patch
---

Fix the eight in-store element builders that emitted invalid IFC when
given a `NaN` or `Infinity` dimension instead of throwing.

Every in-store builder (`addWallToStore`, `addBeamToStore`,
`addDoorToStore`, `addWindowToStore`, `addMemberToStore`,
`addPlateToStore`, `addRoofToStore`, `addSpaceToStore`,
`addSlabToStore`) validated its `Width`/`Height`/`Depth`/`Thickness`/
`FrameThickness` params with a bare `value <= 0` check. That check is
`false` for both `NaN` and `Infinity`, so those values passed
validation silently and landed as the literal STEP tokens `NaN` /
`Infinity` in the emitted `IfcExtrudedAreaSolid` and profile
attributes — e.g. `addWallToStore({ ..., Height: NaN })` threw
nothing and wrote an `IfcExtrudedAreaSolid` whose Depth attribute was
the string `"NaN"`.

`addColumnToStore` already guarded against this — the docstring at
`column.ts:14` records that the `Number.isFinite` check was added
while closing the merge-roundtrip gap from LTplus-AG/ifc-lite#592 —
but the fix never propagated to its eight siblings, each of which
carries its own copy of the same validation shape.

Rather than copy the guard into eight more places (which is how the
gap opened in the first place — one copy got fixed, eight did not),
the check is now a single `assertPositiveFinite` helper in
`_emit-helpers.ts`, and every builder — including `addColumnToStore`
itself — calls it. A parametrised test
(`in-store/dimension-validation.test.ts`) runs `NaN`/`Infinity`/
`-Infinity`/`0`/`-1` against every dimension field of every builder,
so a future builder added without the guard fails visibly instead of
shipping silently.

This is a behaviour change: builders that previously accepted a
`NaN`/`Infinity` dimension and produced invalid IFC now throw
`Error('add<Type>ToStore: <Fields> must be positive')` instead. No
caller in this repository relied on the previous permissiveness —
every call site passes numeric literals or values already validated
upstream.
