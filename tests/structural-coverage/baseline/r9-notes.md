# R9 mapped topology

Product source: main `40dd89f534`. No product changes. R9 corrects the member render oracle (`lib/topology.mjs`); R0 to R8 are retained.

Rows: **106/119 -> 106/119** (met 93, partial 26, missing 0). Cells: **755.5/774 -> 756/774**. Render: 42/43 -> 42.5/43. All other level totals are unchanged. Both online ratchet runs (against R8, then R9) pass with no row or cell dropped.

## Every changed cell

The full summary comparison has exactly one changed cell.

| Row | Level | R8 -> R9 | Why |
|---|---|---|---|
| IFC4/IfcStructuralCurveMember | render | partial -> pass | `analysis-models/cantilever_01.ifc#133` has a topology representation, reached through a mapped item: `#131` (Reference, MappedRepresentation) -> `IfcMappedItem #130` -> `IfcRepresentationMap #84` -> `IfcTopologyRepresentation #83`, edge (0,0,0)-(3,0,0). The oracle read only direct `IfcTopologyRepresentation`s and reported "the file gives it no topology representation". It now follows mapped items (MappingOrigin, then MappingTarget, as IfcOpenShell composes them), and the product's mesh reaches both vertices: 708 of 708 members drawn. |

The row stays partial on its convert cell, which is out of scope here.

## Not changed: IFC4X3/IfcStructuralPointReaction render

`puntal-alfa/portal-demo.ifc#161` and `#163` stay undrawn, on evidence. Neither is the relating activity of any `IfcRelConnectsStructuralActivity`, neither has an `ObjectPlacement` or `Representation`, and their only group is the load case `#86`. The product reads both (`appliesToGlobalId` undefined). The only hint at a position is the connection GlobalId inside the `Name` string, which IFC does not define. `structuralGlyphs` never draws at a guessed position, and the probe keeps counting an unplaceable record as a miss, as the member probe does. The fix belongs in the fixture's exporter (puntal-alfa): connect each reaction to its point connection.

## Regression evidence

`node --test scripts/structural-render-probe.test.mjs` runs 10 tests. Against the R8 `lib/topology.mjs` and `render-members.mjs`, the six new oracle tests fail; against R9 all 10 pass.

- `follows a mapped topology representation, origin then target`: a non-identity MappingOrigin and a rotating, scaling MappingTarget; a mapped shape representation without topology yields no vertices; a mesh on the unmapped edge still fails.
- `a mapped topology it cannot follow leaves the member unplaced`: an unreadable MappingOrigin, an unreadable or zero origin Axis, an unreadable target Axis1, a zero scale and a map cycle through topology each make the member unplaced (fail, "the oracle cannot follow its placement or mapped topology", kept apart from "the file gives it no topology representation"), even with a mesh on every edge, never checked on the direct edge alone. Seventeen and 1200 nested maps, a dangling map, and a cycle among maps without topology beside topology are followed, with the same result in either member order. More than 10000 vertices through a representation's mapped items, in any item order, are unplaced; direct topology is read whole, as in R8. The walk is iterative and memoised per file, so each map is walked once at any nesting; a map that yields no vertices is skipped before its frames are read. A direction must be an `IfcDirection`.
- `schema default axes`: `IfcSecondProjAxis` defaults y to (0, 1, 0), so a mirroring target keeps its sign; `IfcFirstProjAxis` defaults x to (1, 0, 0) unless z lies along x (|z.x| > 0.999999, as rust/retained-native's oracle).

Placements and transform operators read directions the same way: omitted takes the schema default; given but unreadable, zero or not an `IfcDirection` makes the frame unreadable (before, a placement fell back to defaults there). A RefDirection along Axis keeps R8's fallback. The default x switched at |z.x| > 0.9 before. `IfcAxis2Placement2D` origins and 2D operators are read as well. The R9 summary is byte-identical before and after these changes.
