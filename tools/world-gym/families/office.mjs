/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Family B — single-storey partitioned office slab.
 *
 * One floor slab, a perimeter wall ring, and a lattice of partition walls
 * carving the footprint into a rows x cols grid of rooms, each captured as
 * an IfcSpace. Exercises IfcWall, IfcSlab, IfcSpace, IfcElementQuantity from
 * packages/create — the room-partition family that Family A (frame) does
 * not cover.
 */

import { wallQuantities, slabQuantities, spaceQuantities, accumulate } from '../lib/quantities.mjs';

export const name = 'office';

/** Draw a fully-determined parameter set from a seeded RNG. Pure — no I/O, no clock. */
export function paramSpace(rng) {
  const rows = rng.int(2, 4);
  const cols = rng.int(2, 5);
  const roomSpanX = round3(rng.range(3.0, 6.0));
  const roomSpanY = round3(rng.range(3.0, 5.5));
  const wallHeight = round3(rng.range(2.7, 3.6));
  const perimeterThickness = round3(rng.range(0.2, 0.35));
  const partitionThickness = round3(rng.range(0.1, 0.15));
  const slabThickness = round3(rng.range(0.15, 0.30));

  return {
    family: 'office',
    rows, cols, roomSpanX, roomSpanY, wallHeight,
    perimeterThickness, partitionThickness, slabThickness,
  };
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

/** Build the model into `creator`. Returns ground-truth labels computed from the same numbers used to author geometry. */
export function build(creator, params) {
  const {
    rows, cols, roomSpanX, roomSpanY, wallHeight,
    perimeterThickness, partitionThickness, slabThickness,
  } = params;

  const width = round3(cols * roomSpanX);
  const depth = round3(rows * roomSpanY);

  const storeyId = creator.addIfcBuildingStorey({ Name: 'Ground Floor', Elevation: 0 });
  const totals = {};

  // Floor slab.
  const slabId = creator.addIfcSlab(storeyId, {
    Name: 'Floor Slab',
    Position: [0, 0, 0],
    Width: width,
    Depth: depth,
    Thickness: slabThickness,
  });
  const slabQ = slabQuantities(width, depth, slabThickness);
  creator.addIfcElementQuantity(slabId, slabQ.qset);
  accumulate(totals, { slabCount: 1, slabGrossArea: slabQ.grossArea, slabGrossVolume: slabQ.grossVolume });

  // Perimeter wall ring.
  const corners = [[0, 0, 0], [width, 0, 0], [width, depth, 0], [0, depth, 0], [0, 0, 0]];
  for (let side = 0; side < 4; side++) {
    const start = corners[side];
    const end = corners[side + 1];
    const segLength = side % 2 === 0 ? width : depth;
    const wallId = creator.addIfcWall(storeyId, {
      Name: `Perimeter Wall ${side}`,
      Start: start,
      End: end,
      Height: wallHeight,
      Thickness: perimeterThickness,
    });
    const q = wallQuantities(segLength, wallHeight, perimeterThickness);
    creator.addIfcElementQuantity(wallId, q.qset);
    accumulate(totals, {
      wallCount: 1,
      wallGrossSideArea: q.grossSideArea,
      wallGrossVolume: q.grossVolume,
    });
  }

  // Partition lattice: vertical dividers between columns, horizontal between rows.
  for (let c = 1; c < cols; c++) {
    const x = round3(c * roomSpanX);
    const wallId = creator.addIfcWall(storeyId, {
      Name: `Partition V${c}`,
      Start: [x, 0, 0],
      End: [x, depth, 0],
      Height: wallHeight,
      Thickness: partitionThickness,
    });
    const q = wallQuantities(depth, wallHeight, partitionThickness);
    creator.addIfcElementQuantity(wallId, q.qset);
    accumulate(totals, {
      partitionWallCount: 1,
      wallGrossSideArea: q.grossSideArea,
      wallGrossVolume: q.grossVolume,
    });
  }
  for (let r = 1; r < rows; r++) {
    const y = round3(r * roomSpanY);
    const wallId = creator.addIfcWall(storeyId, {
      Name: `Partition H${r}`,
      Start: [0, y, 0],
      End: [width, y, 0],
      Height: wallHeight,
      Thickness: partitionThickness,
    });
    const q = wallQuantities(width, wallHeight, partitionThickness);
    creator.addIfcElementQuantity(wallId, q.qset);
    accumulate(totals, {
      partitionWallCount: 1,
      wallGrossSideArea: q.grossSideArea,
      wallGrossVolume: q.grossVolume,
    });
  }

  // Rooms: one IfcSpace per grid cell. Uses the room-centerline footprint
  // (does not subtract partition half-thickness) — documented approximation,
  // good enough for reward-channel ground truth at v1.
  let roomCount = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const spaceId = creator.addIfcSpace(storeyId, {
        Name: `Room ${r}-${c}`,
        LongName: `Office ${r}-${c}`,
        Position: [round3(c * roomSpanX), round3(r * roomSpanY), 0],
        Width: roomSpanX,
        Depth: roomSpanY,
        Height: wallHeight,
      });
      const q = spaceQuantities(roomSpanX, roomSpanY, wallHeight);
      creator.addIfcElementQuantity(spaceId, q.qset);
      accumulate(totals, {
        roomCount: 1,
        roomNetFloorArea: q.netFloorArea,
        roomNetVolume: q.netVolume,
      });
      roomCount++;
    }
  }

  return {
    storeyCount: 1,
    footprint: { width, depth, area: round3(width * depth) },
    grossFloorArea: round3(width * depth),
    roomCount,
    grid: { rows, cols },
    totals,
  };
}
