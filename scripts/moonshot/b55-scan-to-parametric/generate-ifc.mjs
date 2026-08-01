#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.5 stage 3 -- rooms.json to a real parametric IFC, through the shipped
 * `@ifc-lite/create` builder. No hand-written STEP: every entity here comes
 * out of the same API a user would call, so the output is a model the rest of
 * the toolchain (kernel, viewer, exporters) reads without special-casing.
 *
 * What is emitted, and what each thing is grounded in:
 *   IfcBuildingStorey  elevation = the fitted floor plane
 *   IfcSpace (n)       profile = the room's simplified ceiling-visibility
 *                      outline; height = that room's ceiling mode minus the
 *                      floor plane. Extruded solid, so its quantities are
 *                      derivable rather than asserted.
 *   IfcSlab            floor slab under the union of the rooms. Thickness is
 *                      NOT measurable from an interior scan (the scanner
 *                      never sees the slab soffit) -- it is emitted at the
 *                      nominal SLAB_THICKNESS and flagged, never scored.
 *   IfcWall (n)        one per room-outline edge at or above WALL_MIN_EDGE,
 *                      axis offset outward by half the thickness so the room
 *                      face lands on the measured outline. Interior partition
 *                      thickness comes from the measured wall channels;
 *                      EXTERIOR thickness is not observable from a
 *                      single-sided interior scan and is emitted at the modal
 *                      interior thickness with `inferred: false` recorded.
 *
 * Usage: node generate-ifc.mjs <workDir> <out.ifc>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IfcCreator } from '../../../packages/create/dist/index.js';

const WORK = process.argv[2];
const OUT = process.argv[3];

/** Nominal, NOT measured -- an interior scan never sees the slab soffit. */
const SLAB_THICKNESS = 0.20;
/** Outline edges shorter than this are raster staircase, not wall runs. */
const WALL_MIN_EDGE = 0.60;
/** Douglas-Peucker tolerance for the wall-generation outline (coarser than
 *  the space profile: a wall run should not chase 5 cm of scan noise). */
const WALL_DP_EPS = 0.12;

const rooms = JSON.parse(readFileSync(join(WORK, 'rooms.json'), 'utf8'));
// With no rooms there is nothing to extrude and, further down, the slab's
// bounding box stays at +-Infinity -- which would emit an IfcSlab with
// Infinity extents rather than fail. An empty extraction is a result to
// report, not a model to write.
if (!Array.isArray(rooms.rooms) || rooms.rooms.length === 0) {
  throw new Error(`${join(WORK, 'rooms.json')} contains no rooms; there is no space, wall or slab to generate`);
}
const floorZ = rooms.planes.floor.z;

/** Modal interior partition thickness from the measured wall channels. */
const measuredThicknesses = rooms.wallChannels.map((c) => c.thicknessM);
const modalThickness = measuredThicknesses.length
  ? measuredThicknesses.slice().sort((a, b) => a - b)[Math.floor(measuredThicknesses.length / 2)]
  : 0.10;

function simplify(poly, eps) {
  const dp = (ps) => {
    if (ps.length < 3) return ps;
    let maxD = 0, idx = 0;
    const [ax, ay] = ps[0], [bx, by] = ps[ps.length - 1];
    const len = Math.hypot(bx - ax, by - ay);
    for (let i = 1; i < ps.length - 1; i++) {
      const [px, py] = ps[i];
      const d = len === 0 ? Math.hypot(px - ax, py - ay)
        : Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD <= eps) return [ps[0], ps[ps.length - 1]];
    return [...dp(ps.slice(0, idx + 1)).slice(0, -1), ...dp(ps.slice(idx))];
  };
  let ia = 0, ib = 0, bestD = -1;
  for (let i = 0; i < poly.length; i++) {
    for (let j = i + 1; j < poly.length; j++) {
      const d = Math.hypot(poly[j][0] - poly[i][0], poly[j][1] - poly[i][1]);
      if (d > bestD) { bestD = d; ia = i; ib = j; }
    }
  }
  return [...dp(poly.slice(ia, ib + 1)).slice(0, -1), ...dp([...poly.slice(ib), ...poly.slice(0, ia + 1)]).slice(0, -1)];
}
function signedArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a / 2;
}

const creator = new IfcCreator({ Name: 'Scan-derived apartment (B5.5)' });
const storey = creator.addIfcBuildingStorey({ Name: 'Storey 0', Elevation: floorZ });

const emitted = { spaces: [], walls: [], slab: null };

for (const room of rooms.rooms) {
  const id = creator.addIfcSpace(storey, {
    Position: [0, 0, floorZ],
    Profile: room.polygon,
    Height: room.heightM,
    Name: room.id,
    LongName: room.id,
  });
  emitted.spaces.push({
    expressId: id, roomId: room.id, height: room.heightM,
    profileVertices: room.polygon.length, profileAreaM2: room.polygonAreaM2,
  });

  // Walls along the coarsened outline. Outward normal from a CCW polygon is
  // the edge direction rotated -90 degrees.
  const coarse = simplify(room.polygon, WALL_DP_EPS);
  const ccw = signedArea(coarse) > 0 ? coarse : coarse.slice().reverse();
  for (let i = 0; i < ccw.length; i++) {
    const a = ccw[i], b = ccw[(i + 1) % ccw.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < WALL_MIN_EDGE) continue;
    const t = modalThickness;
    const ox2 = (dy / len) * (t / 2), oy2 = (-dx / len) * (t / 2);
    const wid = creator.addIfcWall(storey, {
      Start: [a[0] + ox2, a[1] + oy2, floorZ],
      End: [b[0] + ox2, b[1] + oy2, floorZ],
      Thickness: t,
      Height: room.heightM,
      Name: `${room.id}_wall_${i}`,
    });
    emitted.walls.push({ expressId: wid, roomId: room.id, lengthM: len, thicknessM: t, thicknessInferred: false });
  }
}

// Floor slab: bounding rectangle of every room, at nominal thickness.
let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
for (const r of rooms.rooms) for (const [x, y] of r.polygon) {
  if (x < x0) x0 = x; if (x > x1) x1 = x;
  if (y < y0) y0 = y; if (y > y1) y1 = y;
}
const slabId = creator.addIfcSlab(storey, {
  Position: [x0, y0, floorZ - SLAB_THICKNESS],
  Thickness: SLAB_THICKNESS,
  Width: x1 - x0,
  Depth: y1 - y0,
  Name: 'Floor slab (nominal thickness, not measured)',
});
emitted.slab = { expressId: slabId, thicknessM: SLAB_THICKNESS, thicknessInferred: false };

const { content } = creator.toIfc();
writeFileSync(OUT, content);
writeFileSync(join(WORK, 'emitted.json'), JSON.stringify({
  out: OUT, bytes: content.length,
  storeyElevation: floorZ,
  modalWallThicknessM: modalThickness,
  slabThicknessNominalM: SLAB_THICKNESS,
  ...emitted,
}, null, 2));
console.log(JSON.stringify({
  bytes: content.length, spaces: emitted.spaces.length, walls: emitted.walls.length,
  modalWallThicknessM: modalThickness,
}, null, 2));
