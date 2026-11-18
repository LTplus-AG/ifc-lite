# R13 curve member Axis

Product source: this change on main `79a3e8cd0a` (R12). The IFC4 -> IFC2X3 converter writes a curve member's `Axis` as `IfcRelAssociatesProfileProperties.ProfileOrientation`, and the upgrade reads it back for placed members too. TypeScript only; R0 to R12 are retained.

Rows: **111/119 -> 111.5/119** (met 103 -> 104, partial 16 -> 15, missing 0 -> 0). Cells: **762/774 -> 762.5/774**. Convert: 60.5/72 -> 61/72. All other level totals are unchanged. The online ratchet against R12 passes with no row or cell dropped.

Of the 15 cells not met: 12 out of reach (schema), 2 policy-limited, 1 upstream, 0 reachable.

## Every changed cell

The full summary comparison against R12 has two changed cells. No other cell, reason or label changes.

| Row | Level | R12 -> R13 | Why |
|---|---|---|---|
| IFC4/IfcStructuralCurveMemberVarying | convert | partial -> pass | generated IFC4 #33 `Axis` comes back. Its placement #32 is unrotated, so the carrier names the source direction #15. |
| IFC4/IfcStructuralCurveMember | convert | partial -> partial | The three `Axis` problems (edge curve #16, #25; beam_01 #86) are gone. The cell keeps the edge-curve OwnerHistory problem, labelled policy (#4686), so no problem is left open. Score unchanged. |

No limit in `limits.mjs` labelled the `Axis` problems (they were open), so none goes stale.

## The carrier

IFC4 gives `Axis` "relative to ... the SELF\IfcProduct.ObjectPlacement" (IFC4 IfcStructuralCurveMember.Axis). IFC2X3 gives `ProfileOrientation` in "the structural coordinate system of the analysis model" (IFC2x3 TC1 IfcRelAssociatesProfileProperties), the world frame an unplaced member is given in (IFC2x3 TC1 IfcStructuralCurveMember, Placement). So:

- Downgrade: `Axis` turned by the member's placement chain into the world frame. A member with no association gets a new one named `IFC4 Axis` relating it to an `IfcGeneralProfileProperties($,$,$,$,$,$,$)`: every attribute is OPTIONAL and WR1 holds on an unset area (IFC2X3_TC1.exp:4831). OwnerHistory is the member's, filled by the existing reuse when it is `$`; none is invented. A member with one association reuses it: an unset orientation is filled when every member it relates agrees, a set one counts when it already holds the value. Two associations, an angle, or a disagreeing value leave `Axis` reported lost.
- Upgrade: the orientation turned back by the inverse rotation, for placed members as well. An unrotated frame names the same direction record; a rotated one names a source direction of equal value, or a new one.
- The upgrade leaves out an association only when it is named `IFC4 Axis`, relates one curve member, has no section location, and its empty properties record is named by nothing else. The world direction goes too when the frame is rotated and nothing else names it. A source's own profile-properties records are kept.

## Regression evidence

`schema-converter-structural-carriers.test.ts`, `curve member Axis IFC4 -> IFC2X3 -> IFC4 #9668`. Before the change four of its six cases fail: the unplaced and unrotated carrier, the turned carrier (a frame turning +X to +Y, and a child frame under it), the exact round trip (sorted records of IFC4 -> IFC2X3 -> IFC4 equal the source's, for both files), and filling the orientation of an association the member already has. The other two pass before and after: an association that already holds the value or another one is left alone (the second reported lost), and an empty association an IFC2X3 source had is kept.

## Deferred

- Rust parity in `rust/export` for the structural carriers, now including this one (the Rust upgrade still reads orientation only for unplaced members).
- The carried-attribute exclusion in `schema-conversion-loss-report.ts`.
