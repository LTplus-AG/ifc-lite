/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary for type checking
/**
 * Create IFC from scratch: two storeys with attributed structure, filled
 * openings, a straight stair, and a parametric timber gridshell.
 * Positions passed to element constructors are relative to their storey.
 */

type Point3 = [number, number, number];
const footprintWidth = 5;
const footprintDepth = 8;
const storeyHeight = 3;
const wallThickness = 0.2;
const slabThickness = 0.3;
const concreteDensity = 2400;
const steelDensity = 7850;

const h = bim.create.project({
  Name: 'Sample Building',
  Description: 'Demonstration of ifc-lite IFC creation from scratch',
  Author: 'ifc-lite',
  Organization: 'ifc-lite',
});
const ground = bim.create.addIfcBuildingStorey(h, { Name: 'Ground Floor', Elevation: 0 });
const first = bim.create.addIfcBuildingStorey(h, { Name: 'First Floor', Elevation: storeyHeight });

function finish(
  id: number, colorName: string, rgb: [number, number, number],
  material: { Name: string; Category?: string; Layers?: { Name: string; Thickness: number; Category: string }[] },
): void {
  bim.create.setColor(h, id, colorName, rgb);
  bim.create.addIfcMaterial(h, id, material);
}

// The layers total the modeled 200 mm wall thickness.
const wallMaterial = {
  Name: 'Exterior Wall Assembly',
  Layers: [
    { Name: 'Gypsum Board', Thickness: 0.01, Category: 'Finish' },
    { Name: 'Mineral Wool Insulation', Thickness: 0.08, Category: 'Insulation' },
    { Name: 'Concrete C30/37', Thickness: 0.1, Category: 'Structural' },
    { Name: 'External Render', Thickness: 0.01, Category: 'Finish' },
  ],
};
const slabMaterial = {
  Name: 'Floor Slab Assembly',
  Layers: [
    { Name: 'Ceramic Tile', Thickness: 0.01, Category: 'Finish' },
    { Name: 'Screed', Thickness: 0.05, Category: 'Finish' },
    { Name: 'Reinforced Concrete C30/37', Thickness: 0.24, Category: 'Structural' },
  ],
};
const columnMaterial = { Name: 'Reinforced Concrete C30/37', Category: 'Concrete' };
const beamMaterial = { Name: 'Structural Steel S235', Category: 'Steel' };

type Opening = { Name: string; Width: number; Height: number; Position: Point3; Kind: 'door' | 'window' };
type WallSide = { Name: string; Start: Point3; End: Point3; Openings?: Opening[] };

function addWalls(storey: number, floor: number): void {
  // Opening positions are wall local: distance along Start→End, 0, sill height.
  const sides: WallSide[] = [
    { Name: 'South Wall', Start: [0, 0, 0], End: [footprintWidth, 0, 0],
      Openings: [{ Name: floor === 0 ? 'W-01 Window' : 'W-03 Window',
        Width: 1.2, Height: 1.5, Position: [1.5, 0, 0.9], Kind: 'window' }] },
    { Name: 'East Wall', Start: [footprintWidth, 0, 0], End: [footprintWidth, footprintDepth, 0],
      Openings: floor === 0
        ? [{ Name: 'D-01 Entrance Door', Width: 0.9, Height: 2.1, Position: [3, 0, 0], Kind: 'door' }]
        : [{ Name: 'W-04 Window', Width: 1.4, Height: 1.5, Position: [3, 0, 0.9], Kind: 'window' }] },
    { Name: 'North Wall', Start: [footprintWidth, footprintDepth, 0], End: [0, footprintDepth, 0],
      Openings: [{ Name: floor === 0 ? 'W-02 Window' : 'W-05 Window',
        Width: 1.4, Height: 1.5, Position: [1.8, 0, 0.9], Kind: 'window' }] },
    { Name: 'West Wall', Start: [0, footprintDepth, 0], End: [0, 0, 0] },
  ];

  for (const side of sides) {
    const length = Math.hypot(side.End[0] - side.Start[0], side.End[1] - side.Start[1]);
    const id = bim.create.addIfcWall(h, storey, {
      Name: side.Name, Description: 'Exterior wall', ObjectType: 'Basic Wall:Exterior - 200mm',
      Start: side.Start, End: side.End, Thickness: wallThickness, Height: storeyHeight,
    });
    finish(id, 'Plaster - Beige', [0.92, 0.88, 0.80], wallMaterial);
    bim.create.addIfcPropertySet(h, id, {
      Name: 'Pset_WallCommon',
      Properties: [
        { Name: 'Reference', NominalValue: 'Exterior - 200mm', Type: 'IfcIdentifier' },
        { Name: 'IsExternal', NominalValue: true, Type: 'IfcBoolean' },
        { Name: 'LoadBearing', NominalValue: true, Type: 'IfcBoolean' },
        { Name: 'FireRating', NominalValue: 'REI60', Type: 'IfcLabel' },
        { Name: 'AcousticRating', NominalValue: 'STC 45', Type: 'IfcLabel' },
        // The current create API supports IfcReal, not the dedicated IFC measure type.
        { Name: 'ThermalTransmittance', NominalValue: 0.25, Type: 'IfcReal' },
      ],
    });
    bim.create.addIfcElementQuantity(h, id, {
      Name: 'Qto_WallBaseQuantities',
      Quantities: [
        { Name: 'Length', Value: length, Kind: 'IfcQuantityLength' },
        { Name: 'Height', Value: storeyHeight, Kind: 'IfcQuantityLength' },
        { Name: 'Width', Value: wallThickness, Kind: 'IfcQuantityLength' },
        { Name: 'GrossSideArea', Value: length * storeyHeight, Kind: 'IfcQuantityArea' },
        { Name: 'GrossVolume', Value: length * storeyHeight * wallThickness, Kind: 'IfcQuantityVolume' },
      ],
    });
    for (const opening of side.Openings ?? []) {
      const { Kind, ...params } = opening;
      const fillId = Kind === 'door'
        ? bim.create.addIfcWallDoor(h, id, params)
        : bim.create.addIfcWallWindow(h, id, params);
      finish(fillId, Kind === 'door' ? 'Timber - Door' : 'Glass - Blue',
        Kind === 'door' ? [0.55, 0.38, 0.23] : [0.48, 0.72, 0.85],
        Kind === 'door' ? { Name: 'Timber Door', Category: 'Timber' }
          : { Name: 'Glazing', Category: 'Glass' });
      bim.create.addIfcPropertySet(h, fillId, {
        Name: Kind === 'door' ? 'Pset_DoorCommon' : 'Pset_WindowCommon',
        Properties: [{ Name: 'IsExternal', NominalValue: true, Type: 'IfcBoolean' }],
      });
      bim.create.addIfcElementQuantity(h, fillId, {
        Name: Kind === 'door' ? 'Qto_DoorBaseQuantities' : 'Qto_WindowBaseQuantities',
        Quantities: [
          { Name: 'Width', Value: opening.Width, Kind: 'IfcQuantityLength' },
          { Name: 'Height', Value: opening.Height, Kind: 'IfcQuantityLength' },
          { Name: 'Area', Value: opening.Width * opening.Height, Kind: 'IfcQuantityArea' },
        ],
      });
    }
  }
}

const numRisers = 17;
const riserHeight = 0.176;
const treadLength = 0.28;
const stairWidth = 1;
const stairStartY = 1;
const stairRun = numRisers * treadLength;
const stairOpeningLength = 4.2;
const stairOpeningWidth = stairWidth + 0.2;
// The opening spans x=0..1.2 and y=1.56..5.76, within the slab.
const stairOpeningCenter: Point3 = [
  stairOpeningWidth / 2, stairStartY + stairRun - stairOpeningLength / 2, 0,
];

function addSlab(storey: number, name: string, hasStairOpening: boolean): void {
  const openingArea = hasStairOpening ? stairOpeningWidth * stairOpeningLength : 0;
  const grossArea = footprintWidth * footprintDepth;
  const id = bim.create.addIfcSlab(h, storey, {
    Name: name, Description: 'Reinforced concrete floor slab', ObjectType: 'Floor:Concrete - 300mm',
    Position: [0, 0, -slabThickness], Thickness: slabThickness,
    Width: footprintWidth, Depth: footprintDepth,
    Openings: hasStairOpening ? [{
      Name: 'Stair Opening', Width: stairOpeningWidth, Height: stairOpeningLength,
      Position: stairOpeningCenter,
    }] : undefined,
  });
  finish(id, 'Concrete - Grey', [0.65, 0.65, 0.65], slabMaterial);
  bim.create.addIfcPropertySet(h, id, {
    Name: 'Pset_SlabCommon',
    Properties: [
      { Name: 'Reference', NominalValue: 'Concrete - 300mm', Type: 'IfcIdentifier' },
      { Name: 'IsExternal', NominalValue: false, Type: 'IfcBoolean' },
      { Name: 'LoadBearing', NominalValue: true, Type: 'IfcBoolean' },
      { Name: 'FireRating', NominalValue: 'REI90', Type: 'IfcLabel' },
      { Name: 'AcousticRating', NominalValue: 'STC 52', Type: 'IfcLabel' },
      { Name: 'Combustible', NominalValue: false, Type: 'IfcBoolean' },
    ],
  });
  bim.create.addIfcElementQuantity(h, id, {
    Name: 'Qto_SlabBaseQuantities',
    Quantities: [
      { Name: 'Width', Value: slabThickness, Kind: 'IfcQuantityLength' },
      { Name: 'GrossArea', Value: grossArea, Kind: 'IfcQuantityArea' },
      { Name: 'NetArea', Value: grossArea - openingArea, Kind: 'IfcQuantityArea' },
      { Name: 'GrossVolume', Value: grossArea * slabThickness, Kind: 'IfcQuantityVolume' },
      { Name: 'NetVolume', Value: (grossArea - openingArea) * slabThickness, Kind: 'IfcQuantityVolume' },
      { Name: 'GrossWeight', Value: grossArea * slabThickness * concreteDensity, Kind: 'IfcQuantityWeight' },
    ],
  });
}

const columnPositions: [string, number, number][] = [
  ['C-01 SW', 0.1, 0.1], ['C-02 SE', 4.7, 0.1],
  ['C-03 NE', 4.7, 7.7], ['C-04 NW', 0.1, 7.7],
];
function addColumns(storey: number): void {
  const sectionArea = 0.3 * 0.3;
  for (const [name, x, y] of columnPositions) {
    const id = bim.create.addIfcColumn(h, storey, {
      Name: name, Description: 'Reinforced concrete column', ObjectType: 'Column:Concrete 300x300',
      Position: [x, y, 0], Width: 0.3, Depth: 0.3, Height: storeyHeight,
    });
    finish(id, 'Concrete - Light', [0.72, 0.72, 0.74], columnMaterial);
    bim.create.addIfcPropertySet(h, id, {
      Name: 'Pset_ColumnCommon',
      Properties: [
        { Name: 'Reference', NominalValue: 'Concrete 300x300', Type: 'IfcIdentifier' },
        { Name: 'LoadBearing', NominalValue: true, Type: 'IfcBoolean' },
        { Name: 'IsExternal', NominalValue: false, Type: 'IfcBoolean' },
        { Name: 'FireRating', NominalValue: 'R120', Type: 'IfcLabel' },
        { Name: 'Slope', NominalValue: 0, Type: 'IfcReal' },
      ],
    });
    bim.create.addIfcElementQuantity(h, id, {
      Name: 'Qto_ColumnBaseQuantities',
      Quantities: [
        { Name: 'Length', Value: storeyHeight, Kind: 'IfcQuantityLength' },
        { Name: 'CrossSectionArea', Value: sectionArea, Kind: 'IfcQuantityArea' },
        { Name: 'GrossVolume', Value: sectionArea * storeyHeight, Kind: 'IfcQuantityVolume' },
        { Name: 'GrossWeight', Value: sectionArea * storeyHeight * concreteDensity, Kind: 'IfcQuantityWeight' },
      ],
    });
  }
}

function addStructuralBeams(storey: number): void {
  // The creator emits rectangular sections, so describe and quantify them as such.
  const sectionArea = 0.2 * 0.4;
  for (const [name, y] of [['B-01 South Beam', 0], ['B-02 North Beam', footprintDepth]] as [string, number][]) {
    const id = bim.create.addIfcBeam(h, storey, {
      Name: name, Description: 'Rectangular steel beam', ObjectType: 'Beam:Steel 200x400',
      Start: [0, y, storeyHeight], End: [footprintWidth, y, storeyHeight],
      Width: 0.2, Height: 0.4,
    });
    finish(id, 'Steel - Grey', [0.55, 0.55, 0.58], beamMaterial);
    bim.create.addIfcPropertySet(h, id, {
      Name: 'Pset_BeamCommon',
      Properties: [
        { Name: 'Reference', NominalValue: 'Steel 200x400', Type: 'IfcIdentifier' },
        { Name: 'LoadBearing', NominalValue: true, Type: 'IfcBoolean' },
        { Name: 'IsExternal', NominalValue: false, Type: 'IfcBoolean' },
        { Name: 'FireRating', NominalValue: 'R60', Type: 'IfcLabel' },
        { Name: 'Span', NominalValue: footprintWidth, Type: 'IfcReal' },
      ],
    });
    bim.create.addIfcElementQuantity(h, id, {
      Name: 'Qto_BeamBaseQuantities',
      Quantities: [
        { Name: 'Length', Value: footprintWidth, Kind: 'IfcQuantityLength' },
        { Name: 'CrossSectionArea', Value: sectionArea, Kind: 'IfcQuantityArea' },
        { Name: 'GrossVolume', Value: footprintWidth * sectionArea, Kind: 'IfcQuantityVolume' },
        { Name: 'GrossWeight', Value: footprintWidth * sectionArea * steelDensity, Kind: 'IfcQuantityWeight' },
      ],
    });
  }
}

addWalls(ground, 0);
addSlab(ground, 'Ground Floor Slab', false);
addColumns(ground);
addStructuralBeams(ground);

// Direction rotates the stair run toward +Y and its width toward -X.
const stair = bim.create.addIfcStair(h, ground, {
  Name: 'ST-01 Main Stair', Description: 'Straight-run concrete stair',
  ObjectType: 'Stair:Concrete - Straight Run',
  Position: [stairWidth, stairStartY, 0], Direction: Math.PI / 2,
  NumberOfRisers: numRisers, RiserHeight: riserHeight,
  TreadLength: treadLength, Width: stairWidth,
});
finish(stair, 'Concrete - Warm', [0.80, 0.78, 0.74],
  { Name: 'Reinforced Concrete C25/30', Category: 'Concrete' });
bim.create.addIfcPropertySet(h, stair, {
  Name: 'Pset_StairCommon',
  Properties: [
    { Name: 'Reference', NominalValue: 'Concrete - Straight Run', Type: 'IfcIdentifier' },
    { Name: 'FireRating', NominalValue: 'REI60', Type: 'IfcLabel' },
    { Name: 'NumberOfRiser', NominalValue: numRisers, Type: 'IfcInteger' },
    { Name: 'NumberOfTreads', NominalValue: numRisers, Type: 'IfcInteger' },
    { Name: 'RiserHeight', NominalValue: riserHeight, Type: 'IfcReal' },
    { Name: 'TreadLength', NominalValue: treadLength, Type: 'IfcReal' },
    { Name: 'IsExternal', NominalValue: false, Type: 'IfcBoolean' },
    { Name: 'HandicapAccessible', NominalValue: false, Type: 'IfcBoolean' },
  ],
});
// The creator emits one rectangular tread solid for each riser.
bim.create.addIfcElementQuantity(h, stair, {
  Name: 'Example_StairQuantities', // Qto_StairFlightBaseQuantities targets IfcStairFlight.
  Quantities: [
    { Name: 'Length', Value: stairRun, Kind: 'IfcQuantityLength' },
    { Name: 'GrossVolume', Value: stairRun * stairWidth * riserHeight, Kind: 'IfcQuantityVolume' },
  ],
});

addSlab(first, 'First Floor Slab', true);
addWalls(first, 1);
addColumns(first);
addStructuralBeams(first);

// Two diagonal families form a diamond lattice on a doubly curved surface.
const crown = 1.8;
const divisionsX = 10;
const divisionsY = 16;
const lathWidth = 0.06;
const lathDepth = 0.08;
// Replace roofZ to explore a symmetric dome:
// return storeyHeight + crown * Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
// Or rolling dunes: multiply that envelope by several Gaussian peaks.
function roofZ(u: number, v: number): number {
  const envelope = Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
  const twist = (2 * u - 1) * (2 * v - 1);
  return storeyHeight + crown * envelope * (1 + 0.8 * twist);
}
const grid: Point3[][] = [];
for (let i = 0; i <= divisionsX; i++) {
  const row: Point3[] = [];
  for (let j = 0; j <= divisionsY; j++) {
    const u = i / divisionsX;
    const v = j / divisionsY;
    row.push([u * footprintWidth, v * footprintDepth, roofZ(u, v)]);
  }
  grid.push(row);
}
function timberBeam(name: string, start: Point3, end: Point3, ring: boolean): void {
  const id = bim.create.addIfcBeam(h, first, {
    Name: name, Description: ring ? 'Gridshell perimeter ring beam' : 'Gridshell lath',
    ObjectType: ring ? 'Beam:GL28h 120x200' : 'Timber Lath:GL24h 60x80',
    Start: start, End: end, Width: ring ? 0.12 : lathWidth, Height: ring ? 0.20 : lathDepth,
  });
  finish(id, ring ? 'Timber - Dark' : name.startsWith('GL-A') ? 'Timber - Larch' : 'Timber - Oak',
    ring ? [0.45, 0.32, 0.20] : name.startsWith('GL-A') ? [0.82, 0.62, 0.38] : [0.72, 0.52, 0.30],
    { Name: ring ? 'Glulam GL28h Larch' : 'Glulam GL24h Spruce', Category: 'Timber' });
}
let lathCount = 0;
for (let i = 0; i < divisionsX; i++) {
  for (let j = 0; j < divisionsY; j++) {
    timberBeam(`GL-A/${i}/${j}`, grid[i][j], grid[i + 1][j + 1], false);
    timberBeam(`GL-B/${i}/${j}`, grid[i][j + 1], grid[i + 1][j], false);
    lathCount += 2;
  }
}
const ringPoints: Point3[] = [];
for (let i = 0; i <= divisionsX; i++) ringPoints.push(grid[i][0]);
for (let j = 1; j <= divisionsY; j++) ringPoints.push(grid[divisionsX][j]);
for (let i = divisionsX - 1; i >= 0; i--) ringPoints.push(grid[i][divisionsY]);
for (let j = divisionsY - 1; j >= 1; j--) ringPoints.push(grid[0][j]);
for (let k = 0; k < ringPoints.length; k++) {
  timberBeam(`GL-Ring/${k}`, ringPoints[k], ringPoints[(k + 1) % ringPoints.length], true);
}
console.log(`Gridshell roof: ${lathCount} laths + ${ringPoints.length} ring segments`);

const result = bim.create.toIfc(h);
console.log(
  `Created ${result.entities.length} entities, ${result.stats.entityCount} STEP lines, ` +
  `${(result.stats.fileSize / 1024).toFixed(1)} KB`,
);
bim.model.loadIfc(result.content, 'sample-building.ifc');
bim.export.download(result.content, 'sample-building.ifc', 'application/x-step');
