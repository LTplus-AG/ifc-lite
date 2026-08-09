#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.5 stage 4 -- the exam. Scores the scan-derived IFC against the manually
 * modelled reference IFC of the same apartment, at the 5% bar.
 *
 * MEASUREMENT SYMMETRY. Both models are meshed by the same kernel call
 * (`measure-ifc.mjs`, which runs `buildPrePassOnce` + `processGeometryBatch`)
 * and reduced by the same `solidQuantities`. No stored quantity from either
 * file is read: the reference carries no IfcElementQuantity at all, and using
 * one model's asserted numbers against the other's computed ones would make
 * the comparison meaningless.
 *
 * CORRESPONDENCE, FIXED BEFORE SCORING. A reference space belongs to the
 * generated room whose plan outline CONTAINS its plan centroid. This is a
 * containment test against the scan-derived polygon, so it cannot be tuned;
 * it also handles the many-to-one case honestly, which matters here because
 * the extraction merges two reference spaces into one room. Where n reference
 * spaces map to one generated room, the reference side of that row is their
 * aggregate, and the row is flagged `merged: n`. A generated room that no
 * centroid lands in is reported UNSCORED rather than scored against nothing.
 *
 * Which polygon belongs to which generated space is an IDENTITY lookup on the
 * room id the generator stamped into the IfcSpace Name, checked to be total
 * and injective -- never an area match, which would be an inference standing
 * in for a fact at the exact point where the whole correspondence is decided.
 *
 * NO FITTING TO THE REFERENCE. Nothing upstream of this file reads the
 * reference model. The two coordinate frames coincide as a property of the
 * data (the reference was modelled on this scan), which this script verifies
 * and reports rather than assumes -- see `frameCheck`.
 *
 * Usage: node score.mjs <workDir> <reference.ifc> <generated.ifc> <out.json>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { measureSpaces } from './measure-ifc.mjs';

const WORK = process.argv[2];
const REF = process.argv[3];
const GEN = process.argv[4];
const OUT = process.argv[5];

/** The exam bar. */
const BAR = 0.05;

/**
 * Kernel meshes come out in the viewer frame (Y up). The scan and the
 * generated model's authoring frame are IFC/E57 (Z up). Plan coordinates
 * therefore map viewer (x, z) -> scan (x, -z).
 */
const toScanPlan = (bboxMin, bboxMax) => ({
  x: [(bboxMin[0] + bboxMax[0]) / 2],
  center: [(bboxMin[0] + bboxMax[0]) / 2, -(bboxMin[2] + bboxMax[2]) / 2],
});
/** Viewer-frame plan point (axes 0, 2) -> scan plan. */
const viewerPlanToScan = (c) => (c ? [c[0], -c[1]] : null);

function pointInPolygon([px, py], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Shortest distance from a plan point to a polygon's boundary, metres. */
function distanceToBoundary([px, py], poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
    const d = Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
    if (d < best) best = d;
  }
  return best;
}

const rooms = JSON.parse(readFileSync(join(WORK, 'rooms.json'), 'utf8'));
const ref = measureSpaces(REF);
const gen = measureSpaces(GEN);

// Neutral labels: the reference is client data, so nothing carried from its
// strings reaches this file's output.
const refSpaces = ref.spaces
  .map((s, i) => ({ ...s, label: `ref_space_${String.fromCharCode(65 + i)}` }));
for (const s of refSpaces) { delete s.name; delete s.longName; }
// The generated model's IfcSpace Name IS the extracted room id -- `generate-ifc.mjs`
// stamps `Name: room.id` -- so it is the correspondence key. It is lifted out
// here and then deleted from the space records themselves, so only the
// RESOLVED `roomId` can reach the output.
const genRoomIdOf = new Map(gen.spaces.map((s) => [s.expressId, s.name]));
for (const s of gen.spaces) { delete s.name; }

// -------------------------------------------------------------- frame check ---
const bboxOf = (list) => {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const s of list) for (let a = 0; a < 3; a++) {
    if (s.bbox.min[a] < mn[a]) mn[a] = s.bbox.min[a];
    if (s.bbox.max[a] > mx[a]) mx[a] = s.bbox.max[a];
  }
  return { min: mn, max: mx };
};
const refBox = bboxOf(refSpaces);
const genBox = bboxOf(gen.spaces);
const frameCheck = {
  note: 'Both models meshed by the same kernel, so both boxes are in the viewer frame (Y up). No transform was applied to either side.',
  referenceSpacesBBox: refBox,
  generatedSpacesBBox: genBox,
  cornerOffsetsM: [0, 1, 2].map((a) => ({
    axis: 'xyz'[a],
    minDelta: genBox.min[a] - refBox.min[a],
    maxDelta: genBox.max[a] - refBox.max[a],
  })),
  maxCornerOffsetM: Math.max(...[0, 1, 2].flatMap((a) => [
    Math.abs(genBox.min[a] - refBox.min[a]), Math.abs(genBox.max[a] - refBox.max[a]),
  ])),
};

// ----------------------------------------------------------- correspondence ---
/**
 * Generated space -> extracted room BY IDENTITY, and verified total and
 * injective. An earlier revision inferred the link from |polygonArea -
 * floorArea| < 0.02 with a positional fallback; that is a guess wearing a
 * measurement's clothes. Two rooms whose areas land within 2 dm2 of each
 * other, or any future change to the emitted profile, would silently score one
 * room's quantities against another room's polygon -- and the polygon is what
 * the reference centroids are tested against, so the whole correspondence
 * would move without a single error. The id is written by the generator and is
 * read back here.
 */
const roomById = new Map();
for (const r of rooms.rooms) {
  if (roomById.has(r.id)) throw new Error(`rooms.json declares room id ${r.id} twice`);
  roomById.set(r.id, r);
}
const claimed = new Set();
const genRooms = gen.spaces.map((s) => {
  const id = genRoomIdOf.get(s.expressId);
  if (!id) throw new Error(`generated IfcSpace #${s.expressId} carries no Name to resolve against rooms.json`);
  const room = roomById.get(id);
  if (!room) throw new Error(`generated IfcSpace #${s.expressId} names room "${id}", which is not in rooms.json`);
  if (claimed.has(id)) throw new Error(`two generated IfcSpaces resolve to room "${id}"`);
  claimed.add(id);
  return { ...s, roomId: room.id, polygon: room.polygon };
});
if (claimed.size !== rooms.rooms.length) {
  throw new Error(`rooms.json holds ${rooms.rooms.length} rooms but the generated model has ${claimed.size} spaces`);
}
/**
 * ASSIGNMENT RULE, and the failure mode it is checked against.
 *
 * The rule is unchanged: a reference space belongs to the generated room whose
 * outline contains its plan point. The plan point is the midpoint of its
 * bounding box -- which for a CONCAVE or L-shaped space is not its centroid
 * and can in principle fall outside the space altogether, or across a
 * neighbouring room's boundary. That is not hypothetical on this data: two of
 * the four reference spaces here have a solidity of about 84%.
 *
 * So the space's TRUE area-weighted plan centroid is computed as well, and
 * both are resolved. If they ever land in different rooms the run FAILS rather
 * than quietly scoring one room's quantities against another room's polygon.
 * The margin is recorded either way -- the separation between the two points
 * and the bbox midpoint's clearance from the boundary of the room it landed
 * in -- so "the shortcut does not bite here" is a committed measurement rather
 * than a sentence.
 */
const assignments = [];
const disagreements = [];
for (const rs of refSpaces) {
  const c = toScanPlan(rs.bbox.min, rs.bbox.max).center;
  const trueC = viewerPlanToScan(rs.planCentroid);
  const hit = genRooms.find((g) => pointInPolygon(c, g.polygon));
  const trueHit = trueC ? genRooms.find((g) => pointInPolygon(trueC, g.polygon)) : null;
  const assignedTo = hit ? hit.roomId : null;
  const centroidAssignedTo = trueHit ? trueHit.roomId : null;
  if (trueC && centroidAssignedTo !== assignedTo) {
    disagreements.push(`${rs.label}: bbox midpoint -> ${assignedTo}, area-weighted plan centroid -> ${centroidAssignedTo}`);
  }
  assignments.push({
    reference: rs.label,
    refExpressId: rs.expressId,
    planCentroid: c,
    areaWeightedPlanCentroid: trueC,
    centroidSeparationM: trueC ? Math.hypot(c[0] - trueC[0], c[1] - trueC[1]) : null,
    boundaryClearanceM: hit ? distanceToBoundary(c, hit.polygon) : null,
    centroidAgrees: trueC ? centroidAssignedTo === assignedTo : null,
    assignedTo,
  });
}
if (disagreements.length) {
  throw new Error(`the plan point used for correspondence disagrees with the space's own centroid:\n  ${disagreements.join('\n  ')}\n`
    + 'A bounding-box midpoint is not a centroid for a concave space. Switch the rule to the '
    + 'area-weighted centroid rather than scoring across the wrong room boundary.');
}

const rowsPerRoom = genRooms.map((g) => {
  const mine = assignments.filter((a) => a.assignedTo === g.roomId).map((a) => refSpaces.find((r) => r.label === a.reference));
  const refFloor = mine.reduce((a, s) => a + s.floorArea, 0);
  const refVol = mine.reduce((a, s) => a + s.volume, 0);
  const refLat = mine.reduce((a, s) => a + s.lateralArea, 0);
  const refHeight = refFloor > 0 ? mine.reduce((a, s) => a + s.height * s.floorArea, 0) / refFloor : 0;
  /**
   * A generated room that NO reference centroid falls into has no reference
   * side at all. The sums above are then 0, and 0 as a denominator prints
   * Infinity into the scorecard exactly where a deviation belongs -- a room
   * the exam never scored would read as a room that failed by an infinite
   * margin, or, once `Math.max` is applied, would carry Infinity into the
   * headline. Such a row is emitted with a null reference and is counted
   * separately in the verdict (`rowsUnscored`), never as a pass and never as
   * a fail.
   */
  const matched = mine.length > 0;
  const q = (generated, reference) => ({ generated, reference: matched ? reference : null });
  return {
    room: g.roomId,
    mergedReferenceSpaces: mine.length,
    referenceLabels: mine.map((s) => s.label),
    quantities: {
      floorAreaM2: q(g.floorArea, refFloor),
      clearHeightM: q(g.height, refHeight),
      volumeM3: q(g.volume, refVol),
      lateralAreaM2: q(g.lateralArea, refLat),
    },
  };
});

const totals = {
  floorAreaM2: {
    generated: gen.spaces.reduce((a, s) => a + s.floorArea, 0),
    reference: refSpaces.reduce((a, s) => a + s.floorArea, 0),
  },
  volumeM3: {
    generated: gen.spaces.reduce((a, s) => a + s.volume, 0),
    reference: refSpaces.reduce((a, s) => a + s.volume, 0),
  },
  lateralAreaM2: {
    generated: gen.spaces.reduce((a, s) => a + s.lateralArea, 0),
    reference: refSpaces.reduce((a, s) => a + s.lateralArea, 0),
  },
  areaWeightedClearHeightM: {
    generated: gen.spaces.reduce((a, s) => a + s.height * s.floorArea, 0) / gen.spaces.reduce((a, s) => a + s.floorArea, 0),
    reference: refSpaces.reduce((a, s) => a + s.height * s.floorArea, 0) / refSpaces.reduce((a, s) => a + s.floorArea, 0),
  },
};

// ------------------------------------------------------ reference audit ---
/**
 * Does the reference's space height come from the building or from the
 * authoring tool's default? Testable without opening the reference's UI: take
 * each reference space's TOP elevation and count how many scan points sit
 * within +-1 cm of it. A modelled ceiling that was measured has the ceiling's
 * point mass underneath it; a defaulted one sits in empty air.
 */
const ingest = JSON.parse(readFileSync(join(WORK, 'ingest.json'), 'utf8'));
const hz = ingest.histograms.z;
const pointsNear = (z) => {
  const i = Math.round((z - hz.origin) / hz.binSize);
  return (hz.counts[i - 1] ?? 0) + (hz.counts[i] ?? 0) + (hz.counts[i + 1] ?? 0);
};
const scanCeilingZ = rooms.planes.ceiling.z;
/**
 * Background level: the median 1 cm bin strictly between floor + 0.3 m and
 * ceiling - 0.3 m, i.e. the open air of the rooms, times three bins. An
 * elevation carrying LESS than this has no surface at it at all.
 */
const interior = [];
for (let i = 0; i < hz.counts.length; i++) {
  const z = hz.origin + i * hz.binSize;
  if (z > rooms.planes.floor.z + 0.3 && z < scanCeilingZ - 0.3) interior.push(hz.counts[i]);
}
interior.sort((a, b) => a - b);
const backgroundPer3Bins = 3 * interior[Math.floor(interior.length / 2)];
const referenceHeightAudit = {
  method: 'full-cloud z histogram, 1 cm bins, +-1 cm around the tested elevation',
  scanFittedCeilingZ: scanCeilingZ,
  pointsAtScanFittedCeiling: pointsNear(scanCeilingZ),
  backgroundPer3Bins,
  spaces: refSpaces.map((s) => ({
    label: s.label,
    floorAreaM2: s.floorArea,
    heightM: s.height,
    topElevationM: s.bbox.max[1],
    scanPointsWithin1cmOfTop: pointsNear(s.bbox.max[1]),
    /** True when the modelled ceiling has no more point mass under it than
     *  empty air does -- i.e. it was not measured from this scan. */
    unsupportedByScan: pointsNear(s.bbox.max[1]) < backgroundPer3Bins,
  })),
};

/**
 * A row is SCORABLE only against a finite, non-zero reference. Anything else
 * would make the deviation Infinity or NaN, and there is no honest way to
 * print that as a percentage; the row keeps its generated measurement, states
 * null for everything derived, and is excluded from the bar count and from
 * the maximum rather than silently distorting either.
 */
const withDeviation = (o) => {
  if (!Number.isFinite(o.generated) || !Number.isFinite(o.reference) || o.reference === 0) {
    return { ...o, scored: false, deviation: null, deviationPercent: null, absDeviationPercent: null, withinBar: null };
  }
  const d = (o.generated - o.reference) / o.reference;
  return {
    ...o,
    deviation: d,
    deviationPercent: d * 100,
    // Magnitude carried explicitly: it is what the bar is tested against, and
    // it is what prose quotes when it says a row is "inside 1%".
    absDeviationPercent: Math.abs(d * 100),
    withinBar: Math.abs(d) <= BAR,
  };
};
for (const r of rowsPerRoom) for (const k of Object.keys(r.quantities)) r.quantities[k] = withDeviation(r.quantities[k]);
// Volume is area x height, so its deviation is the product of the two -- worth
// carrying explicitly so a volume miss can be attributed rather than guessed.
for (const r of rowsPerRoom) {
  const a = r.quantities.floorAreaM2.deviation, h = r.quantities.clearHeightM.deviation;
  r.quantities.volumeM3.decomposition = { areaDeviation: a, heightDeviation: h, product: a === null || h === null ? null : (1 + a) * (1 + h) - 1 };
}
for (const k of Object.keys(totals)) totals[k] = withDeviation(totals[k]);

const allRows = [
  ...Object.entries(totals).map(([k, v]) => ({ scope: 'model', quantity: k, ...v })),
  ...rowsPerRoom.flatMap((r) => Object.entries(r.quantities).map(([k, v]) => ({ scope: r.room, quantity: k, ...v }))),
];
// An unscored row is neither a pass nor a fail: it is reported on its own line
// so `rowsWithinBar / rowsScored` can never be read as a result the exam did
// not produce, and it is kept out of the maximum, which is otherwise the one
// place a single Infinity would swallow the whole headline.
const scoredRows = allRows.filter((r) => r.withinBar !== null);
const verdict = {
  bar: BAR,
  rowsTotal: allRows.length,
  rowsScored: scoredRows.length,
  rowsWithinBar: scoredRows.filter((r) => r.withinBar).length,
  rowsUnscored: allRows.filter((r) => r.withinBar === null).map((r) => ({ scope: r.scope, quantity: r.quantity })),
  rowsOutsideBar: scoredRows.filter((r) => !r.withinBar).map((r) => ({ scope: r.scope, quantity: r.quantity, deviationPercent: r.deviationPercent })),
  maxAbsDeviationPercent: scoredRows.length ? Math.max(...scoredRows.map((r) => Math.abs(r.deviationPercent))) : null,
  referenceSpaceCount: refSpaces.length,
  generatedSpaceCount: gen.spaces.length,
  unassignedReferenceSpaces: assignments.filter((a) => !a.assignedTo).length,
};

writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  bar: BAR,
  frameCheck,
  correspondence: assignments,
  perRoom: rowsPerRoom,
  totals,
  referenceHeightAudit,
  verdict,
  referenceSpaces: refSpaces.map((s) => ({
    label: s.label, floorAreaM2: s.floorArea, volumeM3: s.volume,
    clearHeightM: s.height, lateralAreaM2: s.lateralArea,
  })),
  generatedSpaces: genRooms.map((s) => ({
    room: s.roomId, floorAreaM2: s.floorArea, volumeM3: s.volume,
    clearHeightM: s.height, lateralAreaM2: s.lateralArea, profileVertices: s.polygon.length,
  })),
  referenceTypeCounts: ref.typeCounts,
  generatedTypeCounts: gen.typeCounts,
}, null, 2));

console.log(JSON.stringify({
  verdict,
  totals,
  rows: allRows.map((r) => (r.withinBar === null
    ? `${r.scope}/${r.quantity}: UNSCORED (no reference space assigned to this room)`
    : `${r.scope}/${r.quantity}: ${r.deviationPercent.toFixed(2)}% ${r.withinBar ? 'PASS' : 'FAIL'}`)),
}, null, 2));
