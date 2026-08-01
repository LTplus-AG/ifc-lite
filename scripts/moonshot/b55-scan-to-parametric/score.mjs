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
 * aggregate, and the row is flagged `merged: n`.
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

function pointInPolygon([px, py], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const rooms = JSON.parse(readFileSync(join(WORK, 'rooms.json'), 'utf8'));
const ref = measureSpaces(REF);
const gen = measureSpaces(GEN);

// Neutral labels: the reference is client data, so nothing carried from its
// strings reaches this file's output.
const refSpaces = ref.spaces
  .map((s, i) => ({ ...s, label: `ref_space_${String.fromCharCode(65 + i)}` }));
for (const s of refSpaces) { delete s.name; delete s.longName; }
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
const genRooms = gen.spaces.map((s) => {
  const room = rooms.rooms.find((r) => Math.abs(r.polygonAreaM2 - s.floorArea) < 0.02)
    ?? rooms.rooms[gen.spaces.indexOf(s)];
  return { ...s, roomId: room.id, polygon: room.polygon };
});
const assignments = [];
for (const rs of refSpaces) {
  const c = toScanPlan(rs.bbox.min, rs.bbox.max).center;
  const hit = genRooms.find((g) => pointInPolygon(c, g.polygon));
  assignments.push({ reference: rs.label, refExpressId: rs.expressId, planCentroid: c, assignedTo: hit ? hit.roomId : null });
}

const rowsPerRoom = genRooms.map((g) => {
  const mine = assignments.filter((a) => a.assignedTo === g.roomId).map((a) => refSpaces.find((r) => r.label === a.reference));
  const refFloor = mine.reduce((a, s) => a + s.floorArea, 0);
  const refVol = mine.reduce((a, s) => a + s.volume, 0);
  const refLat = mine.reduce((a, s) => a + s.lateralArea, 0);
  const refHeight = refFloor > 0 ? mine.reduce((a, s) => a + s.height * s.floorArea, 0) / refFloor : 0;
  return {
    room: g.roomId,
    mergedReferenceSpaces: mine.length,
    referenceLabels: mine.map((s) => s.label),
    quantities: {
      floorAreaM2: { generated: g.floorArea, reference: refFloor },
      clearHeightM: { generated: g.height, reference: refHeight },
      volumeM3: { generated: g.volume, reference: refVol },
      lateralAreaM2: { generated: g.lateralArea, reference: refLat },
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

const withDeviation = (o) => ({
  ...o,
  deviation: (o.generated - o.reference) / o.reference,
  deviationPercent: ((o.generated - o.reference) / o.reference) * 100,
  // Magnitude carried explicitly: it is what the bar is tested against, and
  // it is what prose quotes when it says a row is "inside 1%".
  absDeviationPercent: Math.abs(((o.generated - o.reference) / o.reference) * 100),
  withinBar: Math.abs((o.generated - o.reference) / o.reference) <= BAR,
});
for (const r of rowsPerRoom) for (const k of Object.keys(r.quantities)) r.quantities[k] = withDeviation(r.quantities[k]);
// Volume is area x height, so its deviation is the product of the two -- worth
// carrying explicitly so a volume miss can be attributed rather than guessed.
for (const r of rowsPerRoom) {
  const a = r.quantities.floorAreaM2.deviation, h = r.quantities.clearHeightM.deviation;
  r.quantities.volumeM3.decomposition = { areaDeviation: a, heightDeviation: h, product: (1 + a) * (1 + h) - 1 };
}
for (const k of Object.keys(totals)) totals[k] = withDeviation(totals[k]);

const allRows = [
  ...Object.entries(totals).map(([k, v]) => ({ scope: 'model', quantity: k, ...v })),
  ...rowsPerRoom.flatMap((r) => Object.entries(r.quantities).map(([k, v]) => ({ scope: r.room, quantity: k, ...v }))),
];
const verdict = {
  bar: BAR,
  rowsTotal: allRows.length,
  rowsWithinBar: allRows.filter((r) => r.withinBar).length,
  rowsOutsideBar: allRows.filter((r) => !r.withinBar).map((r) => ({ scope: r.scope, quantity: r.quantity, deviationPercent: r.deviationPercent })),
  maxAbsDeviationPercent: Math.max(...allRows.map((r) => Math.abs(r.deviationPercent))),
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

console.log(JSON.stringify({ verdict, totals, rows: allRows.map((r) => `${r.scope}/${r.quantity}: ${r.deviationPercent.toFixed(2)}% ${r.withinBar ? 'PASS' : 'FAIL'}`) }, null, 2));
