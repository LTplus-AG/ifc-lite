# @ifc-lite/create

Create valid IFC4 STEP files from scratch, programmatically. `IfcCreator` builds a complete spatial structure (project, site, building, storeys) and adds building elements with real geometry, property sets, quantities, and materials. Inputs are in metres and elements are placed relative to an identity placement unless you specify otherwise.

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
- Space generation: `generateSpacesFromWalls` and `detectEnclosedAreas` derive IfcSpace footprints from wall layouts
- Fully typed parameter objects for every element

## Links

- Docs: https://ifclite.dev/docs/
- Source: https://github.com/LTplus-AG/ifc-lite

## License

MPL-2.0
