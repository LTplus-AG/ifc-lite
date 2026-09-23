# @ifc-lite/create

Create valid IFC4 STEP files from scratch, programmatically. `IfcCreator` builds a complete spatial structure (project, site, building, storeys) and adds building elements with real geometry, property sets, quantities, and materials. Inputs are in metres. Element coordinates are relative to the storey you add the element to: the storey placement carries `Elevation` and every element chains to it, so an element standing on a storey at `Elevation: 3` is created with `Z = 0`.

## Install

```bash
npm install @ifc-lite/create
```

## Usage

```ts
import { IfcCreator } from '@ifc-lite/create';

const creator = new IfcCreator({ Name: 'My Project' });
const storey = creator.addIfcBuildingStorey({ Name: 'Ground Floor', Elevation: 0 });
creator.addIfcWall(storey, {
  Start: [0, 0, 0], End: [5, 0, 0],
  Thickness: 0.2, Height: 3,
});
const { content } = creator.toIfc(); // IFC STEP text
```

## Features

- Element builders: walls, slabs, columns, beams, stairs, roofs, doors, windows, ramps, railings, plates, members, footings, piles, spaces, curtain walls, furnishing, proxies, and parametric profile shapes (I, L, T, U, C, hollow sections)
- Openings: `addIfcWallDoor` and `addIfcWallWindow` cut hosted doors and windows into walls
- Property sets, element quantities, materials, and colors
- 4D scheduling entities: IfcWorkSchedule, IfcTask, IfcRelSequence
- In-store builders (`addWallToStore`, `addSlabToStore`, ...) that emit elements into an existing parsed model
- `resolveSpatialAnchor(store, storeyId, view)` reads the live mutation view when
  authoring into an edited model. Pass the same view as the `StoreEditor` so a
  created storey or placement, and deletions or retypes of source anchors, are
  reflected before an element is emitted. Omitting `view` reads the parsed model.
- `applyStylesInStore` reads styled items and representation chains from the
  editor's live overlay, so a deleted style can be replaced and an authored
  style is found before adding another one to the same representation item.
- Loaded-model cost builders (`addCostScheduleToStore`, `addCostItemToStore`, `addCostValueToStore`,
  `addCostQuantityToStore`) plus relationship helpers for nesting, schedule/object assignment, value lists,
  and safe removal. They require a `CostAnchor` for schema/owner-history/GUID allocation, accept existing
  relationship maps from the host, reject IFC2X3 authoring, and make destructive removal explicit with
  `{ detach: true }` when surviving references must be rewritten. Removal referrer data distinguishes
  required relationship endpoints (whose relationship is deleted) from optional scalar and list
  attributes on non-relationship owners. Optional scalars are rewritten to `$`; optional lists retain
  their surviving members, or become `$` when emptied, so detaching a cost value never deletes its owner.
- Space generation: `generateSpacesFromWalls` and `detectEnclosedAreas` derive IfcSpace footprints from wall layouts
- Fully typed parameter objects for every element

## Links

- Docs: https://ifclite.dev/docs/
- Source: https://github.com/LTplus-AG/ifc-lite

## License

MPL-2.0
