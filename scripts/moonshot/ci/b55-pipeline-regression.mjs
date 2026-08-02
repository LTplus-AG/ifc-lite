#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.5 regression coverage: the scan-to-parametric pipeline on a SYNTHETIC
 * two-room apartment whose every quantity is known in closed form.
 *
 * WHY SYNTHETIC. The bet's committed result comes off a 3.9 GB client scan
 * that cannot be committed, fetched, or run in CI, so a fixture-backed gate on
 * the real input is not available. What IS available is the property that
 * makes the pipeline checkable at all: given a cloud whose rooms are known
 * rectangles, every stage's output is an arithmetic consequence of those
 * rectangles. This file builds such a cloud, runs the REAL stage scripts on
 * it, and asserts the numbers -- not that the scripts exited 0.
 *
 * WHAT IS ASSERTED, and what each case would catch:
 *
 *  A  extract-rooms.mjs   floor/ceiling plane, room count, per-room area and
 *                         clear height, and the measured wall-channel width.
 *                         Catches: a broken plane fit, a lost or merged
 *                         component, a raster/polygon area drift, a channel
 *                         measurement that stops finding the partition.
 *
 *  B  generate-ifc.mjs    the emitted model's ABSOLUTE placement datum, read
 *                         back out of the STEP. Catches the defect this file
 *                         was written for: `addIfcWall`/`addIfcSlab` place
 *                         relative to the storey while `addIfcSpace` places
 *                         relative to the world, so handing the same Z to
 *                         both puts the walls at 2x the storey elevation.
 *                         The exam cannot see this -- it scores IfcSpace
 *                         quantities, every one of which is invariant under a
 *                         rigid Z shift of the walls.
 *
 *  B' negative control    the same check must REJECT a model built the old
 *                         way. An assertion that cannot fail is not evidence,
 *                         so the doubled-elevation model is rebuilt here
 *                         through the same builder and required to be caught.
 *
 *  C  score.mjs           the scoring arithmetic against a reference model
 *                         with DELIBERATE, known deviations placed either
 *                         side of the 5% bar: the deviation percentages are
 *                         checked against closed-form values and the verdict
 *                         against the construction. Catches a sign error, a
 *                         wrong denominator, a bar comparison that drifted to
 *                         `<`, an unscored row silently counted as a pass, and
 *                         a correspondence that stops resolving.
 *
 * Runtime is a few seconds: the cloud is ~0.4 M points and both scored models
 * are a handful of extruded solids.
 *
 * Usage: node scripts/moonshot/ci/b55-pipeline-regression.mjs [--keep]
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { IfcCreator } from '../../../packages/create/dist/index.js';
import { measureSpaces } from '../b55-scan-to-parametric/measure-ifc.mjs';
import { assertCoherentStoreyDatum, worldBaseZByType }
  from '../b55-scan-to-parametric/placement-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BET = join(HERE, '../b55-scan-to-parametric');
const KEEP = process.argv.includes('--keep');

let failures = 0;
const results = [];
const fmt = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(6)) : String(v));
function check(name, ok, detail) {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
  if (!ok) failures++;
  return ok;
}
function near(name, got, want, tol, unit = '') {
  return check(name, Number.isFinite(got) && Math.abs(got - want) <= tol,
    `${fmt(got)}${unit} vs ${fmt(want)}${unit}, tol ${fmt(tol)}${unit}`);
}

// =========================================================== the synthetic ===
/**
 * Two rectangular rooms sharing one partition, in the same shape as the real
 * apartment: a floor well below the local origin -- so a placement bug that
 * doubles the elevation is visible rather than a no-op at z = 0 -- a partition
 * that appears as an unscanned channel in plan, and a ceiling only over the
 * rooms.
 */
const FLOOR_Z = -1.35;
const CEILING_Z = 1.15;
const CLEAR_H = CEILING_Z - FLOOR_Z;       // 2.50 m
const PARTITION = 0.20;                     // m, the unscanned channel width
/** Plan raster cell the extractor uses by default. Every plan-quantity
 *  tolerance below is stated as a multiple of it, never fitted to an output:
 *  a boundary is located to within one cell, so a channel measured between
 *  two boundaries carries at most two cells of quantization. */
const CELL = 0.025;
const ROOM_A = { x0: 0.0, y0: 0.0, x1: 4.0, y1: 3.0 };
const ROOM_B = { x0: 4.0 + PARTITION, y0: 0.0, x1: 4.0 + PARTITION + 2.5, y1: 3.0 };
const AREA_A = (ROOM_A.x1 - ROOM_A.x0) * (ROOM_A.y1 - ROOM_A.y0);   // 12.00 m2
const AREA_B = (ROOM_B.x1 - ROOM_B.x0) * (ROOM_B.y1 - ROOM_B.y0);   //  7.50 m2

/** Point spacing: 12.5 mm puts >= 4 points in every 25 mm raster cell, which
 *  is what the extractor's `--min-cell-points 2` needs on floor and ceiling. */
const SPACING = 0.0125;
const BIN = 0.01;
const HALF = 16;

/** Deviations built into the reference, and therefore assertable in closed
 *  form. Room A lands inside the 5% bar, room B outside it. */
const REF_AREA_SCALE_A = 0.98;
const REF_HEIGHT_SCALE_B = 0.90;

function buildCloud() {
  const xyz = [];
  for (const r of [ROOM_A, ROOM_B]) {
    for (let x = r.x0; x <= r.x1 + 1e-9; x += SPACING) {
      for (let y = r.y0; y <= r.y1 + 1e-9; y += SPACING) {
        xyz.push(x, y, FLOOR_Z, x, y, CEILING_Z);
      }
    }
  }
  return Float32Array.from(xyz);
}

/** The `ingest.json` fields the later stages actually read: bbox and the 1 cm
 *  z histogram. Built from the cloud itself, so it cannot disagree with it. */
function buildIngest(pts) {
  const n = pts.length / 3;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const origin = -HALF;
  const counts = new Array(Math.round((2 * HALF) / BIN)).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const v = pts[i * 3 + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
    const b = Math.round((pts[i * 3 + 2] - origin) / BIN);
    if (b >= 0 && b < counts.length) counts[b]++;
  }
  return {
    sourceBytes: 0, decodedPointCount: n, keptPointCount: n, stride: 1,
    hasColor: false, hasIntensity: false, nonFinite: 0, elapsedMs: 0, megaPointsPerSecond: 0,
    bbox: { min, max, extent: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] },
    densityPerM3: 0, densityPerPlanM2: 0,
    histograms: { z: { origin, binSize: BIN, counts } },
  };
}

/**
 * A reference model whose spaces deviate from the generated ones by EXACTLY
 * the factors case C asserts.
 *
 * The scales are applied to what the generated model MEASURES, not to the
 * nominal rectangles the cloud was built from: the extraction's plan raster
 * over-reads a room by up to half a cell all round, so a reference derived
 * from the nominal rectangle would carry that quantization into the deviation
 * and case C would be asserting the raster's bias rather than the scorer's
 * arithmetic. Deriving it from the measurement makes the expected deviation
 * `1/scale - 1` to meshing precision, which is what a scoring test wants.
 *
 * Each reference space is a rectangle centred on its generated room's plan
 * centroid, so the containment test that decides correspondence resolves the
 * way the construction intends.
 */
function writeReference(path, specs) {
  const creator = new IfcCreator({ Name: 'B5.5 regression reference' });
  const storey = creator.addIfcBuildingStorey({ Name: 'Storey 0', Elevation: FLOOR_Z });
  for (const s of specs) {
    const half = Math.sqrt(s.targetAreaM2) / 2;   // square, so its own area is exact
    creator.addIfcSpace(storey, {
      Position: [0, 0, FLOOR_Z],
      Profile: [
        [s.centroid[0] - half, s.centroid[1] - half], [s.centroid[0] + half, s.centroid[1] - half],
        [s.centroid[0] + half, s.centroid[1] + half], [s.centroid[0] - half, s.centroid[1] + half],
      ],
      Height: s.targetHeightM,
      Name: 'reference space',
    });
  }
  writeFileSync(path, creator.toIfc().content);
}

/**
 * The model as the REVIEWED revision built it: the storey carries the floor
 * elevation and the wall and slab coordinates carry it a second time. Used
 * only as the negative control for the datum check.
 */
function buildDoubledElevationModel(floorZ, slabThickness) {
  const creator = new IfcCreator({ Name: 'B5.5 negative control' });
  const storey = creator.addIfcBuildingStorey({ Name: 'Storey 0', Elevation: floorZ });
  creator.addIfcSpace(storey, {
    Position: [0, 0, floorZ],
    Profile: [[0, 0], [4, 0], [4, 3], [0, 3]],
    Height: CLEAR_H,
    Name: 'scan_room_001',
  });
  creator.addIfcWall(storey, {
    Start: [0, 0, floorZ], End: [4, 0, floorZ], Thickness: 0.1, Height: CLEAR_H, Name: 'w',
  });
  creator.addIfcSlab(storey, {
    Position: [0, 0, floorZ - slabThickness], Thickness: slabThickness, Width: 4, Depth: 3, Name: 's',
  });
  return creator.toIfc().content;
}

// ===================================================================== run ===
const WORK = mkdtempSync(join(tmpdir(), 'b55-regression-'));
const node = process.execPath;
const runStage = (script, args) =>
  execFileSync(node, [join(BET, script), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

try {
  const pts = buildCloud();
  writeFileSync(join(WORK, 'sub.f32'), Buffer.from(pts.buffer, pts.byteOffset, pts.byteLength));
  writeFileSync(join(WORK, 'ingest.json'), JSON.stringify(buildIngest(pts)));

  // ------------------------------------------------------------- case A ---
  runStage('extract-rooms.mjs', [WORK]);
  const rooms = JSON.parse(readFileSync(join(WORK, 'rooms.json'), 'utf8'));
  const floorZ = rooms.planes.floor.z;

  near('A1 fitted floor plane', floorZ, FLOOR_Z, 0.005, ' m');
  near('A2 fitted ceiling plane', rooms.planes.ceiling.z, CEILING_Z, 0.005, ' m');
  near('A3 clear height', rooms.planes.clearHeightM, CLEAR_H, 0.01, ' m');
  check('A4 room count', rooms.rooms.length === 2, `${rooms.rooms.length} rooms, expected 2`);

  if (rooms.rooms.length === 2) {
    const [big, small] = [...rooms.rooms].sort((a, b) => b.polygonAreaM2 - a.polygonAreaM2);
    // The raster over-reads by up to half a cell all round; on a 4 x 3 m room
    // that is under 2%. The tolerance is stated, not fitted to the output.
    near('A5 larger room polygon area', big.polygonAreaM2, AREA_A, AREA_A * 0.03, ' m2');
    near('A6 smaller room polygon area', small.polygonAreaM2, AREA_B, AREA_B * 0.03, ' m2');
    near('A7 larger room clear height', big.heightM, CLEAR_H, 0.02, ' m');
    near('A8 smaller room clear height', small.heightM, CLEAR_H, 0.02, ' m');
  } else {
    check('A5-A8 per-room quantities', false, 'skipped: room count wrong');
  }

  // The partition is never scanned, so it reads as an empty channel exactly
  // one partition wide, to within a raster cell either side.
  check('A9 exactly one wall channel found', rooms.wallChannels.length === 1, `${rooms.wallChannels.length} channels`);
  if (rooms.wallChannels[0]) {
    near('A10 measured partition thickness', rooms.wallChannels[0].thicknessM, PARTITION, 2 * CELL, ' m');
  }

  // ------------------------------------------------------------- case B ---
  const genPath = join(WORK, 'generated.ifc');
  runStage('generate-ifc.mjs', [WORK, genPath]);
  const emitted = JSON.parse(readFileSync(join(WORK, 'emitted.json'), 'utf8'));
  const genText = readFileSync(genPath, 'utf8');
  const slabT = emitted.slabThicknessNominalM;

  const baseZ = worldBaseZByType(genText, ['IFCBUILDINGSTOREY', 'IFCSPACE', 'IFCWALL', 'IFCSLAB']);
  const zsOf = (t) => (baseZ.get(t) ?? []).map((e) => e.worldZ);
  const allNear = (list, want) => list.length > 0 && list.every((z) => Math.abs(z - want) <= 1e-6);
  const show = (t) => `${[...new Set(zsOf(t).map(fmt))].join(', ') || 'none'} (n=${zsOf(t).length})`;

  check('B1 storey elevation is the fitted floor plane', allNear(zsOf('IFCBUILDINGSTOREY'), floorZ), `${show('IFCBUILDINGSTOREY')} vs ${fmt(floorZ)}`);
  check('B2 spaces stand ON the floor plane', allNear(zsOf('IFCSPACE'), floorZ), `${show('IFCSPACE')} vs ${fmt(floorZ)}`);
  check('B3 walls stand ON the floor plane, not at 2x the elevation', allNear(zsOf('IFCWALL'), floorZ), `${show('IFCWALL')} vs ${fmt(floorZ)}`);
  check('B4 slab hangs below the floor plane by its own thickness', allNear(zsOf('IFCSLAB'), floorZ - slabT), `${show('IFCSLAB')} vs ${fmt(floorZ - slabT)}`);
  check('B5 the model has spaces, walls and a slab',
    zsOf('IFCSPACE').length === 2 && zsOf('IFCWALL').length > 0 && zsOf('IFCSLAB').length === 1,
    `${zsOf('IFCSPACE').length} spaces / ${zsOf('IFCWALL').length} walls / ${zsOf('IFCSLAB').length} slabs`);

  // ------------------------------------------------------------ case B' ---
  let caught = null;
  try {
    assertCoherentStoreyDatum(buildDoubledElevationModel(floorZ, slabT), { elevationM: floorZ, slabThicknessM: slabT });
  } catch (e) { caught = String(e.message); }
  check("B' the datum check REJECTS a doubled storey elevation",
    caught !== null && /IFCWALL .* base world Z/.test(caught) && /IFCSLAB .* base world Z/.test(caught),
    caught ? caught.split('\n').slice(1, 3).map((s) => s.trim()).join(' | ') : 'the doubled model was ACCEPTED');
  // ...and must still accept the real one, so B' is not passing by rejecting
  // everything it is handed.
  let acceptedGood = true;
  try { assertCoherentStoreyDatum(genText, { elevationM: floorZ, slabThicknessM: slabT }); }
  catch (e) { acceptedGood = false; results.push(`      (control detail: ${String(e.message).split('\n')[1]?.trim()})`); }
  check("B'' the same check ACCEPTS the corrected model", acceptedGood);

  // ------------------------------------------------------------- case C ---
  // Measure the generated model with the bet's own measurement code, then
  // build the reference off that measurement, one scale per room.
  const genMeasured = measureSpaces(genPath).spaces;   // sorted by floor area, descending
  check('C0 the generated model measures two spaces', genMeasured.length === 2, `${genMeasured.length} spaces`);
  const scaleOf = [
    { areaScale: REF_AREA_SCALE_A, heightScale: 1 },                  // largest room
    { areaScale: 1, heightScale: REF_HEIGHT_SCALE_B },                // the other one
  ];
  const specs = genMeasured.map((s, i) => {
    const room = rooms.rooms.find((r) => r.id === s.name);
    if (!room) throw new Error(`generated space ${s.name} is not in rooms.json`);
    return {
      roomId: room.id,
      centroid: room.centroid,
      targetAreaM2: s.floorArea * scaleOf[i].areaScale,
      targetHeightM: s.height * scaleOf[i].heightScale,
      ...scaleOf[i],
    };
  });
  const refPath = join(WORK, 'reference.ifc');
  writeReference(refPath, specs);
  const cardPath = join(WORK, 'card.json');
  runStage('score.mjs', [WORK, refPath, genPath, cardPath]);
  const card = JSON.parse(readFileSync(cardPath, 'utf8'));

  check('C1 every reference space is assigned to a room', card.verdict.unassignedReferenceSpaces === 0, `${card.verdict.unassignedReferenceSpaces} unassigned`);
  check('C2 no unscored rows', card.verdict.rowsUnscored.length === 0, JSON.stringify(card.verdict.rowsUnscored));
  check('C3 every row scored', card.verdict.rowsScored === card.verdict.rowsTotal && card.verdict.rowsTotal === 12,
    `${card.verdict.rowsScored}/${card.verdict.rowsTotal}, expected 12/12 (4 totals + 2 rooms x 4)`);

  const q = (room, name) => card.perRoom.find((r) => r.room === room)?.quantities[name];
  // The correspondence must land each reference space on the room its
  // rectangle was centred in -- checked here rather than assumed, because
  // every deviation below is read through it.
  const assignedRooms = card.correspondence.map((c) => c.assignedTo);
  check('C4 correspondence resolved to distinct rooms, one per reference space',
    assignedRooms.length === specs.length && new Set(assignedRooms).size === specs.length && assignedRooms.every(Boolean),
    JSON.stringify(assignedRooms));

  /** A reference scaled by `s` must read as `1/s - 1`: the deviation is
   *  generated-over-reference. Tolerance is meshing/serialization noise. */
  const expected = (s) => (1 / s - 1) * 100;
  const TOL = 0.02;   // percentage points
  for (const spec of specs) {
    const assigned = card.correspondence.filter((c) => c.assignedTo === spec.roomId);
    if (assigned.length !== 1) { check(`C5 ${spec.roomId} has exactly one reference space`, false, `${assigned.length}`); continue; }
    const tag = `${spec.roomId} (area x${spec.areaScale}, height x${spec.heightScale})`;
    near(`C5 ${tag} floorArea deviation`, q(spec.roomId, 'floorAreaM2').deviationPercent, expected(spec.areaScale), TOL, '%');
    near(`C6 ${tag} clearHeight deviation`, q(spec.roomId, 'clearHeightM').deviationPercent, expected(spec.heightScale), TOL, '%');
    near(`C7 ${tag} volume deviation`, q(spec.roomId, 'volumeM3').deviationPercent,
      expected(spec.areaScale * spec.heightScale), TOL, '%');
    // The decomposition the scorer records must reconstruct its own volume row.
    near(`C8 ${tag} volume decomposition reconstructs its row`,
      q(spec.roomId, 'volumeM3').decomposition.product * 100, q(spec.roomId, 'volumeM3').deviationPercent, 1e-9, '%');
    // And the bar must fall where the construction put it: 1/0.98 - 1 is
    // inside 5%, 1/0.90 - 1 is outside it.
    const inside = Math.abs(expected(spec.areaScale * spec.heightScale)) <= 5;
    check(`C9 ${tag} volume lands ${inside ? 'INSIDE' : 'OUTSIDE'} the 5% bar`,
      q(spec.roomId, 'volumeM3').withinBar === inside, `${fmt(q(spec.roomId, 'volumeM3').deviationPercent)}%`);
  }

  // The totals are a SECOND, independent route to the same reference numbers:
  // a per-room row that is right while the total is wrong means the
  // aggregation is broken, not the deviation.
  const refFloor = card.referenceSpaces.reduce((a, s) => a + s.floorAreaM2, 0);
  const genFloor = card.generatedSpaces.reduce((a, s) => a + s.floorAreaM2, 0);
  near('C15 total floorArea deviation is its own rows aggregated',
    card.totals.floorAreaM2.deviationPercent, ((genFloor - refFloor) / refFloor) * 100, 1e-9, '%');

  // The headline reduction: the maximum must be the maximum of the rows it
  // reduces, over the SCORED rows only.
  const scored = [
    ...Object.values(card.totals),
    ...card.perRoom.flatMap((r) => Object.values(r.quantities)),
  ].filter((r) => r.withinBar !== null);
  near('C16 maxAbsDeviationPercent is the max over the scored rows',
    card.verdict.maxAbsDeviationPercent, Math.max(...scored.map((r) => Math.abs(r.deviationPercent))), 1e-9, '%');
  check('C17 rowsWithinBar counts exactly the rows flagged withinBar',
    card.verdict.rowsWithinBar === scored.filter((r) => r.withinBar).length,
    `${card.verdict.rowsWithinBar} vs ${scored.filter((r) => r.withinBar).length}`);
} catch (e) {
  /**
   * A stage that THROWS is a failure of this suite, not a crash of it: the
   * pipeline's own fail-closed guards (the empty-extraction refusal, the
   * placement datum check) surface here, and they must be reported as a red
   * check with the rest rather than as an unhandled rejection that scrolls
   * the passing lines off the top of a CI log.
   */
  const msg = String(e?.stderr || e?.message || e);
  const informative = msg.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^at\s/.test(l) && !/^Node\.js v/.test(l));
  check('stage completed', false, informative.slice(0, 4).join(' | ').slice(0, 600) || msg.slice(0, 300));
} finally {
  if (KEEP) process.stderr.write(`kept work dir: ${WORK}\n`);
  else rmSync(WORK, { recursive: true, force: true });
}

for (const line of results) console.log(line);
console.log(`\n${results.filter((l) => l.startsWith('PASS')).length}/${results.filter((l) => /^(PASS|FAIL)/.test(l)).length} checks passed`);
if (failures) {
  console.error(`::error::B5.5 pipeline regression: ${failures} check(s) failed.`);
  process.exit(1);
}
