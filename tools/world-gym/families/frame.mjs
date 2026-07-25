/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Family A - rectangular multi-storey slab-and-column frame.
 *
 * Perimeter walls (with generic rectangular openings cut but never filled by
 * a door/window - "door/window-free openings" per the brief) ring each
 * storey; a column grid sits at every bay intersection; beams tie the grid
 * together at the top of each storey; a slab floors every level plus one
 * roof slab on top. Exercises IfcWall, IfcSlab, IfcColumn, IfcBeam,
 * IfcOpeningElement, IfcElementQuantity from packages/create.
 */

import {
  wallQuantities, slabQuantities, columnQuantities, beamQuantities, accumulate,
} from '../lib/quantities.mjs';

export const name = 'frame';

/** Draw a fully-determined parameter set from a seeded RNG. Pure - no I/O, no clock. */
export function paramSpace(rng) {
  const storeys = rng.int(1, 4);
  const storeyHeight = round3(rng.range(2.7, 3.9));
  const baysX = rng.int(2, 4);
  const baysY = rng.int(2, 3);
  const spanX = round3(rng.range(3.0, 7.5));
  const spanY = round3(rng.range(3.0, 6.5));
  const wallThickness = round3(rng.range(0.15, 0.30));
  const slabThickness = round3(rng.range(0.18, 0.32));
  const columnSize = round3(rng.range(0.25, 0.45));
  const beamWidth = round3(rng.range(0.2, 0.35));
  const beamHeight = round3(rng.range(0.3, 0.5));
  const openingsPerLongWall = rng.int(0, 3);
  const openingWidth = round3(rng.range(1.0, 1.8));
  const openingHeight = round3(rng.range(1.2, 1.8));
  const sillHeight = round3(rng.range(0.8, 1.0));

  return {
    family: 'frame',
    storeys, storeyHeight, baysX, baysY, spanX, spanY,
    wallThickness, slabThickness, columnSize, beamWidth, beamHeight,
    openingsPerLongWall, openingWidth, openingHeight, sillHeight,
  };
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

/** Build the model into `creator`. Returns ground-truth labels computed from the same numbers used to author geometry. */
export function build(creator, params) {
  const {
    storeys, storeyHeight, baysX, baysY, spanX, spanY,
    wallThickness, slabThickness, columnSize, beamWidth, beamHeight,
    openingsPerLongWall, openingWidth, openingHeight, sillHeight,
  } = params;

  const width = round3(baysX * spanX);
  const depth = round3(baysY * spanY);
  const longWallIsXAxis = width >= depth; // openings go on the two walls running the long way

  // Clamp openings to the host wall bounds. The sampled parameters can
  // otherwise leave the wall: sillHeight (<= 1.0) + openingHeight (<= 1.8)
  // can exceed the shortest storeyHeight (2.7), and with three openings on
  // the long walls the sampled width can overlap the neighbouring opening
  // (openings are centred at margin*k along the wall, so adjacent clearance
  // requires width <= margin). A 50mm ligament is kept at the top and
  // between openings; the clamp is a no-op for parameters that already fit.
  // Both long walls share the same length, so the clamped size is uniform
  // across the model and exported in the labels (openingWidthUsed /
  // openingHeightUsed) for independent oracles to consume.
  const longSegLength = longWallIsXAxis ? width : depth;
  const openingMargin = openingsPerLongWall > 0 ? longSegLength / (openingsPerLongWall + 1) : 0;
  const effOpeningHeight = round3(Math.min(openingHeight, Math.max(0.1, storeyHeight - sillHeight - 0.05)));
  const effOpeningWidth = openingsPerLongWall > 0
    ? round3(Math.min(openingWidth, Math.max(0.3, openingMargin - 0.05)))
    : openingWidth;

  const storeyIds = [];
  const totals = {};
  let openingCount = 0;

  for (let i = 0; i < storeys; i++) {
    const elevation = round3(i * storeyHeight);
    const storeyId = creator.addIfcBuildingStorey({ Name: `Level ${i}`, Elevation: elevation });
    storeyIds.push(storeyId);

    // Perimeter walls: bottom, right, top, left (CCW from origin).
    const corners = [
      [0, 0, 0], [width, 0, 0], [width, depth, 0], [0, depth, 0], [0, 0, 0],
    ];
    for (let side = 0; side < 4; side++) {
      const start = corners[side];
      const end = corners[side + 1];
      const isLongWall = (side === 0 || side === 2) === longWallIsXAxis;
      const segLength = side % 2 === 0 ? width : depth;

      const openings = [];
      if (isLongWall && openingsPerLongWall > 0) {
        for (let k = 1; k <= openingsPerLongWall; k++) {
          openings.push({
            Name: `Opening ${i}-${side}-${k}`,
            Width: effOpeningWidth,
            Height: effOpeningHeight,
            Position: [openingMargin * k, 0, sillHeight],
          });
        }
      }

      const wallId = creator.addIfcWall(storeyId, {
        Name: `Wall L${i}-${side}`,
        Start: start,
        End: end,
        Height: storeyHeight,
        Thickness: wallThickness,
        ...(openings.length > 0 ? { Openings: openings } : {}),
      });
      openingCount += openings.length;

      const q = wallQuantities(segLength, storeyHeight, wallThickness);
      creator.addIfcElementQuantity(wallId, q.qset);
      accumulate(totals, {
        wallCount: 1,
        wallGrossSideArea: q.grossSideArea,
        wallGrossVolume: q.grossVolume,
      });
    }

    // Floor slab for this level.
    const floorSlabId = creator.addIfcSlab(storeyId, {
      Name: `Floor Slab L${i}`,
      Position: [0, 0, 0],
      Width: width,
      Depth: depth,
      Thickness: slabThickness,
    });
    const floorQ = slabQuantities(width, depth, slabThickness);
    creator.addIfcElementQuantity(floorSlabId, floorQ.qset);
    accumulate(totals, {
      slabCount: 1,
      slabGrossArea: floorQ.grossArea,
      slabGrossVolume: floorQ.grossVolume,
    });

    // Column grid at every bay intersection.
    for (let gx = 0; gx <= baysX; gx++) {
      for (let gy = 0; gy <= baysY; gy++) {
        const colId = creator.addIfcColumn(storeyId, {
          Name: `Column L${i}-${gx}-${gy}`,
          Position: [round3(gx * spanX), round3(gy * spanY), 0],
          Width: columnSize,
          Depth: columnSize,
          Height: storeyHeight,
        });
        const q = columnQuantities(columnSize, columnSize, storeyHeight);
        creator.addIfcElementQuantity(colId, q.qset);
        accumulate(totals, {
          columnCount: 1,
          columnGrossVolume: q.grossVolume,
        });
      }
    }

    // Beams tying the grid together at the top of this storey.
    for (let gy = 0; gy <= baysY; gy++) {
      for (let gx = 0; gx < baysX; gx++) {
        const beamId = creator.addIfcBeam(storeyId, {
          Name: `Beam-X L${i}-${gx}-${gy}`,
          Start: [round3(gx * spanX), round3(gy * spanY), storeyHeight],
          End: [round3((gx + 1) * spanX), round3(gy * spanY), storeyHeight],
          Width: beamWidth,
          Height: beamHeight,
        });
        const q = beamQuantities(beamWidth, beamHeight, spanX);
        creator.addIfcElementQuantity(beamId, q.qset);
        accumulate(totals, { beamCount: 1, beamGrossVolume: q.grossVolume });
      }
    }
    for (let gx = 0; gx <= baysX; gx++) {
      for (let gy = 0; gy < baysY; gy++) {
        const beamId = creator.addIfcBeam(storeyId, {
          Name: `Beam-Y L${i}-${gx}-${gy}`,
          Start: [round3(gx * spanX), round3(gy * spanY), storeyHeight],
          End: [round3(gx * spanX), round3((gy + 1) * spanY), storeyHeight],
          Width: beamWidth,
          Height: beamHeight,
        });
        const q = beamQuantities(beamWidth, beamHeight, spanY);
        creator.addIfcElementQuantity(beamId, q.qset);
        accumulate(totals, { beamCount: 1, beamGrossVolume: q.grossVolume });
      }
    }
  }

  // Roof slab on top of the top storey.
  const topStoreyId = storeyIds[storeyIds.length - 1];
  const roofElevation = round3(storeys * storeyHeight);
  const roofSlabId = creator.addIfcSlab(topStoreyId, {
    Name: 'Roof Slab',
    Position: [0, 0, roofElevation],
    Width: width,
    Depth: depth,
    Thickness: slabThickness,
  });
  const roofQ = slabQuantities(width, depth, slabThickness);
  creator.addIfcElementQuantity(roofSlabId, roofQ.qset);
  accumulate(totals, {
    slabCount: 1,
    slabGrossArea: roofQ.grossArea,
    slabGrossVolume: roofQ.grossVolume,
  });

  return {
    storeyCount: storeys,
    footprint: { width, depth, area: round3(width * depth) },
    grossFloorArea: round3(width * depth * storeys),
    openingCount,
    // The clamped (as-built) opening size - can differ from the sampled
    // params.openingWidth/openingHeight; independent oracles must use these.
    ...(openingCount > 0 ? { openingWidthUsed: effOpeningWidth, openingHeightUsed: effOpeningHeight } : {}),
    totals,
    // Internal handle for the corruption layer (stripped from the label by
    // generator.mjs): where build-time defect injections attach.
    firstStoreyId: storeyIds[0],
  };
}
