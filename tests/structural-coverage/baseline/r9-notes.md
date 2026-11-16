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

`node --test scripts/structural-render-probe.test.mjs`: `#9668 topology oracle: follows a mapped topology representation, origin then target` fails against the R8 `lib/topology.mjs` (4 pass, 1 fail) and passes against R9 (5 pass). It checks a non-identity MappingOrigin and a rotating, scaling MappingTarget, that a mapped shape representation without topology yields no vertices, and that a mesh on the unmapped edge still fails.
