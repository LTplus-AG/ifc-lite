# R13 Axis policy

Product source: main `cd8eec2c64`. There are no product changes. R13 adds one policy limit (`axisPolicy` in `tests/structural-coverage/limits.mjs`) for the two `Axis` cells R12 left reachable, after the decision on #10597. R0 to R12 are retained.

Rows: **111/119** (met 103, partial 16, missing 0). Cells: **762/774**. Every level total is unchanged. The online ratchet against R12 passes with no row or cell dropped.

Of the 16 cells not met: 12 out of reach (schema), 3 policy-limited, 1 upstream, 0 reachable.

## Every changed cell

Compared with R12, two cells gain a `limits` label. Their status, points and reasons are unchanged, and no other cell changes.

| Row | Level | R12 -> R13 | Why |
|---|---|---|---|
| IFC4/IfcStructuralCurveMember | convert | policy-limited, and reachable -> policy-limited | beam_01 #86 and the edge-curve file's #16 and #25 lose `Axis`. |
| IFC4/IfcStructuralCurveMemberVarying | convert | reachable -> policy-limited | Generated IFC4 #33 loses `Axis`. |

## The decision

IFC2X3 has no `Axis` (IFC2X3_TC1.exp:7281). Its only slot is `IfcRelAssociatesProfileProperties.ProfileOrientation` (IFC2X3_TC1.exp:6548), and that relationship's `RelatingProfileProperties` is required. None of the three source files (beam_01, the edge-curve file, the generated IFC4 file) has an `IfcProfileProperties`, so carrying `Axis` there means writing an `IfcGeneralProfileProperties` the source never had, for the sole purpose of giving the required reference something to name.

The converter already has a rule for a required value the source does not give. `Ifc2x3SlotFill` (#4714) fills a required enum with `.NOTDEFINED.` and a BOOLEAN with `.F.`, values that claim nothing. A measure, label, identifier or entity reference "has no such value, so the slot keeps `$`" and the file is reported not valid IFC2X3. OwnerHistory is reused, never invented (#4686). The #10551 carriers do add records, but each one either holds a source value (the load-case and thickness property sets) or links source records (the 'Causes' relationship). The profile-properties record would do neither: it would exist only so that a required entity reference points at something. That is the case #4714 refuses.

Two of the four members are also placed (beam_01 #86 by #74, generated #33 by #32). The upgrade reads `ProfileOrientation` back only on unplaced members (`StructuralAxes.axis`), so even with the record, those two would need a frame transform the upgrade does not undo. The edge-curve members (#16, #25) are unplaced, but their file is already policy-limited by OwnerHistory.

If a source file gains any `IfcProfileProperties`, the limit's fact no longer holds: the scorer reports it and exits 1, so the decision has to be revisited for that file.
