/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary for type checking
/**
 * Create IFC from scratch — generate a fully attributed building
 *
 * Demonstrates the bim.create API: build a complete IFC file with
 * walls, slab, columns, beams, stair, and a parametric timber gridshell
 * roof — each with material colours, standard IFC property sets, and
 * base quantities. The roof is a doubly-curved diamond lattice of
 * small-diameter timber laths generated from a mathematical surface.
 */

// ─── 1. Project ─────────────────────────────────────────────────────────

const h = bim.create.project({
  Name: 'Sample Building',
  Description: 'Demonstration of ifc-lite IFC creation from scratch',
  Author: 'ifc-lite',
  Organization: 'ifc-lite',
});

// ─── 2. Storey ──────────────────────────────────────────────────────────

const gf = bim.create.addIfcBuildingStorey(h, { Name: 'Ground Floor', Elevation: 0 });

// ─── 3. Walls — 5 × 8 m footprint, 3 m high, 0.2 m thick ─────────────

const southWall = bim.create.addIfcWall(h, gf, {
  Name: 'South Wall', Description: 'Exterior south façade', ObjectType: 'Basic Wall:Exterior - 200mm',
  Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3,
  Openings: [
    { Name: 'W-01 Window', Width: 1.2, Height: 1.5, Position: [1.5, 0, 0.9] },
  ],
});
const eastWall = bim.create.addIfcWall(h, gf, {
  Name: 'East Wall', Description: 'Exterior east façade', ObjectType: 'Basic Wall:Exterior - 200mm',
  Start: [5, 0, 0], End: [5, 8, 0], Thickness: 0.2, Height: 3,
  Openings: [
    { Name: 'D-01 Entrance Door', Width: 0.9, Height: 2.1, Position: [3, 0, 0] },
  ],
});
const northWall = bim.create.addIfcWall(h, gf, {
  Name: 'North Wall', Description: 'Exterior north façade', ObjectType: 'Basic Wall:Exterior - 200mm',
  Start: [5, 8, 0], End: [0, 8, 0], Thickness: 0.2, Height: 3,
  Openings: [
    { Name: 'W-02 Window', Width: 1.4, Height: 1.5, Position: [1.8, 0, 0.9] },
  ],
});
const westWall = bim.create.addIfcWall(h, gf, {
  Name: 'West Wall', Description: 'Exterior west façade', ObjectType: 'Basic Wall:Exterior - 200mm',
  Start: [0, 8, 0], End: [0, 0, 0], Thickness: 0.2, Height: 3,
});

// Wall colours and materials
for (const wId of [southWall, eastWall, northWall, westWall]) {
  bim.create.setColor(h, wId, 'Plaster - Beige', [0.92, 0.88, 0.80]);
  bim.create.addIfcMaterial(h, wId, {
    Name: 'Exterior Wall Assembly',
    Layers: [
      { Name: 'Gypsum Board', Thickness: 0.013, Category: 'Finish' },
      { Name: 'Mineral Wool Insulation', Thickness: 0.08, Category: 'Insulation' },
      { Name: 'Concrete C30/37', Thickness: 0.2, Category: 'Structural' },
      { Name: 'External Render', Thickness: 0.015, Category: 'Finish' },
    ],
  });
}

// Wall properties & quantities (all walls share the same spec)
for (const [wId, wName, wLen] of [
  [southWall, 'South Wall', 5],
  [eastWall, 'East Wall', 8],
  [northWall, 'North Wall', 5],
  [westWall, 'West Wall', 8],
] as [number, string, number][]) {
  bim.create.addIfcPropertySet(h, wId, {
    Name: 'Pset_WallCommon',
    Properties: [
      { Name: 'Reference', NominalValue: 'Exterior - 200mm', Type: 'IfcIdentifier' },
      { Name: 'IsExternal', NominalValue: true, Type: 'IfcBoolean' },
      { Name: 'LoadBearing', NominalValue: true, Type: 'IfcBoolean' },
      { Name: 'FireRating', NominalValue: 'REI60', Type: 'IfcLabel' },
      { Name: 'AcousticRating', NominalValue: 'STC 45', Type: 'IfcLabel' },
      { Name: 'ThermalTransmittance', NominalValue: 0.25, Type: 'IfcThermalTransmittanceMeasure' },
    ],
  });
  bim.create.addIfcElementQuantity(h, wId, {
    Name: 'Qto_WallBaseQuantities',
    Quantities: [
      { Name: 'Length', Value: wLen, Kind: 'IfcQuantityLength' },
      { Name: 'Height', Value: 3, Kind: 'IfcQuantityLength' },
      { Name: 'Width', Value: 0.2, Kind: 'IfcQuantityLength' },
      { Name: 'GrossSideArea', Value: wLen * 3, Kind: 'IfcQuantityArea' },
      { Name: 'GrossVolume', Value: wLen * 3 * 0.2, Kind: 'IfcQuantityVolume' },
    ],
  });
}

// ─── 4. Floor slab ──────────────────────────────────────────────────────

const slab = bim.create.addIfcSlab(h, gf, {
  Name: 'Ground Floor Slab', Description: 'Reinforced concrete floor slab', ObjectType: 'Floor:Concrete - 300mm',
  Position: [0, 0, -0.3], Thickness: 0.3, Width: 5, Depth: 8,
});
bim.create.setColor(h, slab, 'Concrete - Grey', [0.65, 0.65, 0.65]);
bim.create.addIfcMaterial(h, slab, {
  Name: 'Floor Slab Assembly',
  Layers: [
    { Name: 'Ceramic Tile', Thickness: 0.01, Category: 'Finish' },
    { Name: 'Screed', Thickness: 0.05, Category: 'Finish' },
    { Name: 'Reinforced Concrete C30/37', Thickness: 0.24, Category: 'Structural' },
  ],
});
bim.create.addIfcPropertySet(h, slab, {
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
bim.create.addIfcElementQuantity(h, slab, {
  Name: 'Qto_SlabBaseQuantities',
  Quantities: [
    { Name: 'Width', Value: 0.3, Kind: 'IfcQuantityLength' },
    { Name: 'GrossArea', Value: 40, Kind: 'IfcQuantityArea' },
    { Name: 'NetArea', Value: 40, Kind: 'IfcQuantityArea' },
    { Name: 'GrossVolume', Value: 12, Kind: 'IfcQuantityVolume' },
    { Name: 'GrossWeight', Value: 28800, Kind: 'IfcQuantityWeight' },
  ],
});

// ─── 5. Columns at corners ──────────────────────────────────────────────

const columnPositions: [string, number, number][] = [
  ['C-01 SW', 0.1, 0.1],
  ['C-02 SE', 4.7, 0.1],
  ['C-03 NE', 4.7, 7.7],
  ['C-04 NW', 0.1, 7.7],
];
for (const [cName, cx, cy] of columnPositions) {
  const colId = bim.create.addIfcColumn(h, gf, {
    Name: cName, Description: 'Reinforced concrete column', ObjectType: 'Column:Concrete 300x300',
    Position: [cx, cy, 0], Width: 0.3, Depth: 0.3, Height: 3,
  });
  bim.create.setColor(h, colId, 'Concrete - Light', [0.72, 0.72, 0.74]);
  bim.create.addIfcMaterial(h, colId, { Name: 'Reinforced Concrete C30/37', Category: 'Concrete' });
  bim.create.addIfcPropertySet(h, colId, {
    Name: 'Pset_ColumnCommon',
    Properties: [
      { Name: 'Reference', NominalValue: 'Concrete 300x300', Type: 'IfcIdentifier' },
      { Name: 'LoadBearing', NominalValue: true, Type: 'IfcBoolean' },
      { Name: 'IsExternal', NominalValue: false, Type: 'IfcBoolean' },
      { Name: 'FireRating', NominalValue: 'R120', Type: 'IfcLabel' },
      { Name: 'Slope', NominalValue: 0, Type: 'IfcPlaneAngleMeasure' },
    ],
  });
  bim.create.addIfcElementQuantity(h, colId, {
    Name: 'Qto_ColumnBaseQuantities',
    Quantities: [
      { Name: 'Length', Value: 3, Kind: 'IfcQuantityLength' },
      { Name: 'CrossSectionArea', Value: 0.09, Kind: 'IfcQuantityArea' },
      { Name: 'GrossVolume', Value: 0.27, Kind: 'IfcQuantityVolume' },
      { Name: 'GrossWeight', Value: 648, Kind: 'IfcQuantityWeight' },
    ],
  });
}

// ─── 6. Beams along the top ─────────────────────────────────────────────

const beamDefs: [string, [number, number, number], [number, number, number]][] = [
  ['B-01 South Beam', [0, 0, 3], [5, 0, 3]],
  ['B-02 North Beam', [0, 8, 3], [5, 8, 3]],
];
for (const [bName, bStart, bEnd] of beamDefs) {
  const bLen = Math.sqrt(
    (bEnd[0] - bStart[0]) ** 2 + (bEnd[1] - bStart[1]) ** 2 + (bEnd[2] - bStart[2]) ** 2,
  );
  const beamId = bim.create.addIfcBeam(h, gf, {
    Name: bName, Description: 'Steel I-beam', ObjectType: 'Beam:IPE 200',
    Start: bStart, End: bEnd, Width: 0.2, Height: 0.4,
  });
  bim.create.setColor(h, beamId, 'Steel - Grey', [0.55, 0.55, 0.58]);
  bim.create.addIfcMaterial(h, beamId, { Name: 'Structural Steel S235', Category: 'Steel' });
  bim.create.addIfcPropertySet(h, beamId, {
    Name: 'Pset_BeamCommon',
    Properties: [
      { Name: 'Reference', NominalValue: 'IPE 200', Type: 'IfcIdentifier' },
      { Name: 'LoadBearing', NominalValue: true, Type: 'IfcBoolean' },
      { Name: 'IsExternal', NominalValue: false, Type: 'IfcBoolean' },
      { Name: 'FireRating', NominalValue: 'R60', Type: 'IfcLabel' },
      { Name: 'Span', NominalValue: bLen, Type: 'IfcPositiveLengthMeasure' },
    ],
  });
  bim.create.addIfcElementQuantity(h, beamId, {
    Name: 'Qto_BeamBaseQuantities',
    Quantities: [
      { Name: 'Length', Value: bLen, Kind: 'IfcQuantityLength' },
      { Name: 'CrossSectionArea', Value: 0.08, Kind: 'IfcQuantityArea' },
      { Name: 'GrossVolume', Value: bLen * 0.08, Kind: 'IfcQuantityVolume' },
      { Name: 'GrossWeight', Value: bLen * 0.08 * 7850, Kind: 'IfcQuantityWeight' },
    ],
  });
}

// ─── 7. Stair ───────────────────────────────────────────────────────────

const numRisers = 17;
const riserH = 0.176;
const treadL = 0.28;
const stairW = 1.0;
// Run along +Y (the 8 m axis) so the 4.76 m run fits comfortably.
// Position is stair origin; with Direction = PI/2 the width extends toward −X.
// Place at x = stairW so the stair sits flush against the west wall (x = 0).
const stairId = bim.create.addIfcStair(h, gf, {
  Name: 'ST-01 Main Stair', Description: 'Straight-run concrete stair', ObjectType: 'Stair:Concrete - Straight Run',
  Position: [stairW, 1, 0], Direction: Math.PI / 2,
  NumberOfRisers: numRisers, RiserHeight: riserH, TreadLength: treadL, Width: stairW,
});
bim.create.setColor(h, stairId, 'Concrete - Warm', [0.80, 0.78, 0.74]);
bim.create.addIfcMaterial(h, stairId, { Name: 'Reinforced Concrete C25/30', Category: 'Concrete' });
bim.create.addIfcPropertySet(h, stairId, {
  Name: 'Pset_StairCommon',
  Properties: [
    { Name: 'Reference', NominalValue: 'Concrete - Straight Run', Type: 'IfcIdentifier' },
    { Name: 'FireRating', NominalValue: 'REI60', Type: 'IfcLabel' },
    { Name: 'NumberOfRiser', NominalValue: numRisers, Type: 'IfcCountMeasure' },
    { Name: 'NumberOfTreads', NominalValue: numRisers - 1, Type: 'IfcCountMeasure' },
    { Name: 'RiserHeight', NominalValue: riserH, Type: 'IfcPositiveLengthMeasure' },
    { Name: 'TreadLength', NominalValue: treadL, Type: 'IfcPositiveLengthMeasure' },
    { Name: 'IsExternal', NominalValue: false, Type: 'IfcBoolean' },
    { Name: 'HandicapAccessible', NominalValue: false, Type: 'IfcBoolean' },
  ],
});
bim.create.addIfcElementQuantity(h, stairId, {
  Name: 'Qto_StairBaseQuantities',
  Quantities: [
    { Name: 'Length', Value: numRisers * treadL, Kind: 'IfcQuantityLength' },
    { Name: 'GrossVolume', Value: numRisers * treadL * stairW * riserH * 0.5, Kind: 'IfcQuantityVolume' },
  ],
});

// ─── 8. Second floor ─────────────────────────────────────────────────

const ff = bim.create.addIfcBuildingStorey(h, { Name: 'First Floor', Elevation: 3 });

// Floor slab — position is relative to storey elevation (3m)
// Opening must be long enough for headroom (≥ 2.1 m) over the ascending stair.
// At the slab level the stair is still rising, so the opening needs to extend
// back far enough that a person standing on a lower step has full clearance.
const stairRunEnd = 1 + numRisers * treadL;       // y ≈ 5.76
const stairOpenLen = 4.2;                          // ~1.5 × run ensures headroom
const stairOpenY = stairRunEnd - stairOpenLen / 2; // center near arrival end
const ffSlab = bim.create.addIfcSlab(h, ff, {
  Name: 'First Floor Slab', Description: 'Reinforced concrete floor slab', ObjectType: 'Floor:Concrete - 300mm',
  Position: [0, 0, -0.3], Thickness: 0.3, Width: 5, Depth: 8,
  Openings: [
    { Name: 'Stair Opening', Width: stairW + 0.2, Height: stairOpenLen, Position: [stairW / 2, stairOpenY, 0] },
  ],
});
bim.create.setColor(h, ffSlab, 'Concrete - Grey', [0.65, 0.65, 0.65]);
bim.create.addIfcMaterial(h, ffSlab, {
  Name: 'Floor Slab Assembly',
  Layers: [
    { Name: 'Ceramic Tile', Thickness: 0.01, Category: 'Finish' },
    { Name: 'Screed', Thickness: 0.05, Category: 'Finish' },
    { Name: 'Reinforced Concrete C30/37', Thickness: 0.24, Category: 'Structural' },
  ],
});
bim.create.addIfcPropertySet(h, ffSlab, {
  Name: 'Pset_SlabCommon',
  Properties: [
    { Name: 'Reference', NominalValue: 'Concrete - 300mm', Type: 'IfcIdentifier' },
    { Name: 'IsExternal', NominalValue: false, Type: 'IfcBoolean' },
    { Name: 'LoadBearing', NominalValue: true, Type: 'IfcBoolean' },
    { Name: 'FireRating', NominalValue: 'REI90', Type: 'IfcLabel' },
  ],
});

// Second floor walls — same footprint, Z=0 relative to storey elevation
const ffSouthWall = bim.create.addIfcWall(h, ff, {
  Name: 'South Wall', Description: 'Exterior south façade', ObjectType: 'Basic Wall:Exterior - 200mm',
  Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3,
  Openings: [
    { Name: 'W-03 Window', Width: 1.2, Height: 1.5, Position: [1.5, 0, 0.9] },
  ],
});
const ffEastWall = bim.create.addIfcWall(h, ff, {
  Name: 'East Wall', Description: 'Exterior east façade', ObjectType: 'Basic Wall:Exterior - 200mm',
  Start: [5, 0, 0], End: [5, 8, 0], Thickness: 0.2, Height: 3,
  Openings: [
    { Name: 'W-04 Window', Width: 1.4, Height: 1.5, Position: [3, 0, 0.9] },
  ],
});
const ffNorthWall = bim.create.addIfcWall(h, ff, {
  Name: 'North Wall', Description: 'Exterior north façade', ObjectType: 'Basic Wall:Exterior - 200mm',
  Start: [5, 8, 0], End: [0, 8, 0], Thickness: 0.2, Height: 3,
  Openings: [
    { Name: 'W-05 Window', Width: 1.4, Height: 1.5, Position: [1.8, 0, 0.9] },
  ],
});
const ffWestWall = bim.create.addIfcWall(h, ff, {
  Name: 'West Wall', Description: 'Exterior west façade', ObjectType: 'Basic Wall:Exterior - 200mm',
  Start: [0, 8, 0], End: [0, 0, 0], Thickness: 0.2, Height: 3,
});

for (const wId of [ffSouthWall, ffEastWall, ffNorthWall, ffWestWall]) {
  bim.create.setColor(h, wId, 'Plaster - Beige', [0.92, 0.88, 0.80]);
  bim.create.addIfcMaterial(h, wId, {
    Name: 'Exterior Wall Assembly',
    Layers: [
      { Name: 'Gypsum Board', Thickness: 0.013, Category: 'Finish' },
      { Name: 'Mineral Wool Insulation', Thickness: 0.08, Category: 'Insulation' },
      { Name: 'Concrete C30/37', Thickness: 0.2, Category: 'Structural' },
      { Name: 'External Render', Thickness: 0.015, Category: 'Finish' },
    ],
  });
}

for (const [wId, wName, wLen] of [
  [ffSouthWall, 'South Wall', 5],
  [ffEastWall, 'East Wall', 8],
  [ffNorthWall, 'North Wall', 5],
  [ffWestWall, 'West Wall', 8],
] as [number, string, number][]) {
  bim.create.addIfcPropertySet(h, wId, {
    Name: 'Pset_WallCommon',
    Properties: [
      { Name: 'Reference', NominalValue: 'Exterior - 200mm', Type: 'IfcIdentifier' },
      { Name: 'IsExternal', NominalValue: true, Type: 'IfcBoolean' },
      { Name: 'LoadBearing', NominalValue: true, Type: 'IfcBoolean' },
      { Name: 'FireRating', NominalValue: 'REI60', Type: 'IfcLabel' },
      { Name: 'ThermalTransmittance', NominalValue: 0.25, Type: 'IfcThermalTransmittanceMeasure' },
    ],
  });
  bim.create.addIfcElementQuantity(h, wId, {
    Name: 'Qto_WallBaseQuantities',
    Quantities: [
      { Name: 'Length', Value: wLen, Kind: 'IfcQuantityLength' },
      { Name: 'Height', Value: 3, Kind: 'IfcQuantityLength' },
      { Name: 'Width', Value: 0.2, Kind: 'IfcQuantityLength' },
      { Name: 'GrossSideArea', Value: wLen * 3, Kind: 'IfcQuantityArea' },
      { Name: 'GrossVolume', Value: wLen * 3 * 0.2, Kind: 'IfcQuantityVolume' },
    ],
  });
}

// Second floor columns — Z=0 relative to storey elevation
for (const [cName, cx, cy] of columnPositions) {
  const colId = bim.create.addIfcColumn(h, ff, {
    Name: cName, Description: 'Reinforced concrete column', ObjectType: 'Column:Concrete 300x300',
    Position: [cx, cy, 0], Width: 0.3, Depth: 0.3, Height: 3,
  });
  bim.create.setColor(h, colId, 'Concrete - Light', [0.72, 0.72, 0.74]);
  bim.create.addIfcMaterial(h, colId, { Name: 'Reinforced Concrete C30/37', Category: 'Concrete' });
}

// Second floor beams — Z=3 relative to storey elevation (→ world Z=6)
for (const [bName, bStart, bEnd] of beamDefs) {
  const beamId = bim.create.addIfcBeam(h, ff, {
    Name: bName, Description: 'Steel I-beam', ObjectType: 'Beam:IPE 200',
    Start: [bStart[0], bStart[1], 3], End: [bEnd[0], bEnd[1], 3], Width: 0.2, Height: 0.4,
  });
  bim.create.setColor(h, beamId, 'Steel - Grey', [0.55, 0.55, 0.58]);
  bim.create.addIfcMaterial(h, beamId, { Name: 'Structural Steel S235', Category: 'Steel' });
}

// ─── 9. Parametric timber gridshell roof ─────────────────────────────
//
// A doubly-curved gridshell spanning the 5 × 8 m footprint.
// Two families of diagonal timber laths form a diamond lattice.
// Three surface shapes are provided — uncomment one at a time.

const ROOF_W = 5;           // building width (X)
const ROOF_D = 8;           // building depth (Y)
const WALL_H = 3;           // wall-top relative to first floor storey (elevation 3)
const CROWN  = 1.8;         // rise above walls
const NU     = 10;          // grid divisions along X
const NV     = 16;          // grid divisions along Y
const LATH_W = 0.06;        // lath width  60 mm
const LATH_D = 0.08;        // lath depth  80 mm

// ── Shape A: sinusoidal dome — smooth symmetric shell ──────────────
// function roofZ(u: number, v: number): number {
//   return WALL_H + CROWN * Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
// }

// ── Shape B: rolling dunes — three asymmetric peaks ────────────────
// function roofZ(u: number, v: number): number {
//   const env = Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
//   const p1 = 1.0  * Math.exp(-((u - 0.3) ** 2 + (v - 0.30) ** 2) / 0.04);
//   const p2 = 0.65 * Math.exp(-((u - 0.72) ** 2 + (v - 0.55) ** 2) / 0.06);
//   const p3 = 0.45 * Math.exp(-((u - 0.40) ** 2 + (v - 0.80) ** 2) / 0.03);
//   return WALL_H + CROWN * env * (0.25 + p1 + p2 + p3);
// }

// ── Shape C: twisted hypar — saddle with raised diagonal corners ───
function roofZ(u: number, v: number): number {
  const env = Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
  const twist = (2 * u - 1) * (2 * v - 1);
  return WALL_H + CROWN * env * (1.0 + 0.8 * twist);
}
// Build grid of surface points
const grid: [number, number, number][][] = [];
for (let i = 0; i <= NU; i++) {
  const row: [number, number, number][] = [];
  for (let j = 0; j <= NV; j++) {
    const u = i / NU, v = j / NV;
    row.push([u * ROOF_W, v * ROOF_D, roofZ(u, v)]);
  }
  grid.push(row);
}

let lathCount = 0;

// Family A — diagonal (i+1, j+1): warm larch tone
for (let d = -NV; d <= NU; d++) {
  const i0 = Math.max(0, d);
  const i1 = Math.min(NU, NV + d);
  for (let i = i0; i < i1; i++) {
    const j = i - d;
    if (j < 0 || j >= NV) continue;
    const s = grid[i][j], e = grid[i + 1][j + 1];
    const id = bim.create.addIfcBeam(h, ff, {
      Name: `GL-A${(d + NV).toString().padStart(2, '0')}/${i - i0}`,
      Description: 'Gridshell lath family A', ObjectType: 'Timber Lath:GL24h 60x80',
      Start: s, End: e, Width: LATH_W, Height: LATH_D,
    });
    bim.create.setColor(h, id, 'Timber - Larch', [0.82, 0.62, 0.38]);
    bim.create.addIfcMaterial(h, id, { Name: 'Glulam GL24h Spruce', Category: 'Timber' });
    lathCount++;
  }
}

// Family B — diagonal (i+1, j-1): darker oak tone
for (let s = 0; s <= NU + NV; s++) {
  const i0 = Math.max(0, s - NV);
  const i1 = Math.min(NU, s);
  for (let i = i0; i < i1; i++) {
    const j = s - i;
    if (j <= 0 || j > NV) continue;
    const p0 = grid[i][j], p1 = grid[i + 1][j - 1];
    const id = bim.create.addIfcBeam(h, ff, {
      Name: `GL-B${s.toString().padStart(2, '0')}/${i - i0}`,
      Description: 'Gridshell lath family B', ObjectType: 'Timber Lath:GL24h 60x80',
      Start: p0, End: p1, Width: LATH_W, Height: LATH_D,
    });
    bim.create.setColor(h, id, 'Timber - Oak', [0.72, 0.52, 0.30]);
    bim.create.addIfcMaterial(h, id, { Name: 'Glulam GL24h Spruce', Category: 'Timber' });
    lathCount++;
  }
}

// Perimeter ring beam at wall top — ties laths together
const RING_N = 2 * (NU + NV);
const ringPts: [number, number, number][] = [];
for (let i = 0; i <= NU; i++) ringPts.push(grid[i][0]);       // south edge
for (let j = 1; j <= NV; j++) ringPts.push(grid[NU][j]);      // east edge
for (let i = NU - 1; i >= 0; i--) ringPts.push(grid[i][NV]);  // north edge
for (let j = NV - 1; j >= 1; j--) ringPts.push(grid[0][j]);   // west edge
for (let k = 0; k < ringPts.length; k++) {
  const rStart = ringPts[k];
  const rEnd = ringPts[(k + 1) % ringPts.length];
  const rId = bim.create.addIfcBeam(h, ff, {
    Name: `GL-Ring/${k.toString().padStart(2, '0')}`,
    Description: 'Gridshell perimeter ring beam', ObjectType: 'Beam:GL28h 120x200',
    Start: rStart, End: rEnd, Width: 0.12, Height: 0.20,
  });
  bim.create.setColor(h, rId, 'Timber - Dark', [0.45, 0.32, 0.20]);
  bim.create.addIfcMaterial(h, rId, { Name: 'Glulam GL28h Larch', Category: 'Timber' });
}

console.log(`Gridshell roof: ${lathCount} laths + ${ringPts.length} ring segments`);

// ─── 10. Generate, preview, download ────────────────────────────────────

const result = bim.create.toIfc(h);

console.log(
  `Created ${result.entities.length} entities, ` +
  `${result.stats.entityCount} STEP lines, ` +
  `${(result.stats.fileSize / 1024).toFixed(1)} KB`,
);

bim.model.loadIfc(result.content, 'sample-building.ifc');
bim.export.download(result.content, 'sample-building.ifc', 'application/x-step');
