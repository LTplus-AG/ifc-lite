---
'@ifc-lite/geometry': patch
---

Stop a wall layer's cut geometry collapsing when the wall sits far from the project origin.

`try_cut_wall_local_frame` rotates a wall into its own frame so the boolean runs at small coordinates, which is the entire reason that path exists. It then returned through `mesh_from_frame`, which computed `center + axes * local` in f64 and cast it into **absolute world f32** while leaving `Mesh::origin` at zero. The translation the frame existed to avoid was baked straight back into the coordinates, and the precision the local frame bought was spent at the last step.

The damage lands on thin geometry far from the origin. On the reporter's Archicad model an `IfcBuildingElementPart` 3.3 mm thick, centred at (199, 213, 77), cut correctly to **+3.650545 m3** in its own frame and came back measuring **-94.58 m3** once the centre was folded into f32: one f32 ULP there is ~15 µm, so the cut's sliver triangles cross. The uncut mesh survives the same round trip because its triangles are coarse, which is why the defect only ever showed on cut walls and why comparing the cut against the uncut solid looked clean.

`mesh_from_frame` is deleted. The behaviour it should have had already existed beside it as `rotate_mesh_from_frame`, which returns rotation-only positions with the frame centre in `Mesh::origin` and whose doc already gave the reason ("keeping positions small is what makes the cut survive f32 storage at building/national-grid magnitude"). The local-frame cut now returns through that, so there is one such transform rather than two that disagree. The relativizing branch also **composes** the inner cut's origin instead of assigning over it, which previously discarded any translation the inner cut produced.

Measured on the four `IfcBuildingElementPart` layers of the reporter's wall, against ifcopenshell 0.8.2. It never applies the parent wall's `IfcRelVoidsElement` to its aggregated parts, so its numbers are the authored solids:

| part | before | after | ifcopenshell |
|---|---|---|---|
| #412188 | 42.214 | 41.6701 | 41.6703 |
| #412196 | 60.621 | 60.2801 | 60.2805 |
| #412191 | -94.582 | 3.6506 | 3.6533 |
| #412193 | 41.961 | 43.8307 | 43.8307 |

All four land within 0.07%, from errors of +1.3%, +0.56%, -2688% and -4.3%.

Corpus-wide the change is large. Unmatched edges fall **20348 to 17863** (-2485), triangles rise **137757 to 141799** (+4042), and the far-field host count drops **164 to 32**. The golden moves on 132 rows and was audited before blessing: none added, none removed, and every one of the 132 carries the same single cause, the `far` flag flipping 1 to 0 as a host's coordinates stop being world-absolute. 120 rows gain triangles and **none loses any**. 111 rows shed open edges; the 4 that gain them each gained far more geometry first (one goes 174 to 293 triangles), so the extra boundary is material that now survives rather than new tearing.

Two golden-derived corpus ceilings move with it, stated here because a bless loosens them permanently. Closed-but-not-watertight solids go **46 to 105**: that one is the reclassification, since the reading is gated on `!far` and a host leaving far-field joins the population whose tearing is counted at all. Hosts with snap-collapsed triangles go **51 to 66**, and that is NOT a reclassification — `coll` is counted for every host regardless of `far`. All 16 hosts that gained it also gained triangles (55 to 131, 174 to 293, and so on), so the finer geometry that now survives f32 includes triangles below the 1 mm snap. Neither ceiling is new tearing, both are now permitted without a red build, and both should be ratcheted back separately.

Two in-repo guards compared a cut mesh's `bounds()` against a world-absolute host without folding `Mesh::origin`, so they read two different frames once the cut stopped being world-absolute. Both now fold it on each side; both still fail when the centre is double-counted, so the guard is intact and only its frame was corrected.
