#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.5 -- one-command reproduction of the whole bet.
 *
 *   node run.mjs --scan <Apartment.e57> --reference <reference.ifc> \
 *                --work <scratchDir> [--stride 10]
 *
 * Runs ingest -> extract (both frames) -> generate -> score, and assembles the
 * committed `scorecard.json` next to this file.
 *
 * PRIVACY. The scan and the reference model are client data with a real site
 * location in them (the reference carries IfcSite RefLatitude/RefLongitude;
 * the E57 carries a projected-CRS definition). NEITHER source file, nor the
 * generated IFC, nor any room polygon is written into the repository, and
 * this script never copies them there. What lands in `scorecard.json` is
 * derived scalars only -- counts, areas, heights, deviations -- expressed in
 * the scan's own local metres, plus neutral labels (`ref_space_A`,
 * `scan_room_001`). `assertNoIdentifiers` fails the run if a string from
 * either source, or anything shaped like a geographic coordinate, reaches the
 * committed artifact.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const SCAN = opt('--scan');
const REFERENCE = opt('--reference');
const WORK = opt('--work');
const STRIDE = opt('--stride', '10');
const SKIP_INGEST = argv.includes('--skip-ingest');
if (!SCAN || !REFERENCE || !WORK) {
  console.error('usage: node run.mjs --scan <e57> --reference <ifc> --work <dir> [--stride N] [--skip-ingest]');
  process.exit(2);
}
mkdirSync(WORK, { recursive: true });

const node = process.execPath;
const run = (script, args) => {
  process.stderr.write(`\n== ${script} ${args.join(' ')}\n`);
  execFileSync(node, ['--max-old-space-size=6000', join(HERE, script), ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
};
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

const t0 = Date.now();
if (!SKIP_INGEST) run('ingest-scan.mjs', [SCAN, WORK, '--stride', STRIDE]);
const ingest = read(join(WORK, 'ingest.json'));

const variants = {};
for (const [name, extraArgs] of [['axisAligned', []], ['principalFrame', ['--principal-frame']]]) {
  run('extract-rooms.mjs', [WORK, ...extraArgs]);
  const rooms = read(join(WORK, 'rooms.json'));
  const ifcPath = join(WORK, `scan-derived-${name}.ifc`);
  run('generate-ifc.mjs', [WORK, ifcPath]);
  const emitted = read(join(WORK, 'emitted.json'));
  const cardPath = join(WORK, `scorecard-${name}.json`);
  run('score.mjs', [WORK, REFERENCE, ifcPath, cardPath]);
  variants[name] = { rooms, emitted, card: read(cardPath), ifcBytes: statSync(ifcPath).size };
}

// The pre-registered primary run is the axis-aligned one; the principal-frame
// run was added after the primary's outline was seen to be a raster staircase
// (a defect visible in the scan without the reference) and is reported beside
// it, not instead of it.
const PRIMARY = 'axisAligned';

const slim = (v) => ({
  ceilingCut: {
    used: v.rooms.ceilingCut.used,
    sweepLoM: v.rooms.ceilingCut.sweepLoM,
    sweepStepM: v.rooms.ceilingCut.sweepStepM,
    sweepSamples: v.rooms.ceilingCut.sweep.length,
    plateau: v.rooms.ceilingCut.plateau,
    /** Widest stable plateau at EVERY room count, not just the chosen one --
     *  this is what the "rank by room count, not by width" argument rests on,
     *  so it is emitted rather than asserted in prose. */
    plateausByRoomCount: v.rooms.ceilingCut.plateausByRoomCount,
    sweep: v.rooms.ceilingCut.sweep,
  },
  principalFrame: v.rooms.principalFrame,
  rooms: v.rooms.rooms.map((r) => ({
    id: r.id,
    rasterAreaM2: r.rasterAreaM2,
    outlineAreaM2: r.outlineAreaM2,
    polygonAreaM2: r.polygonAreaM2,
    polygonPerimeterM: r.polygonPerimeterM,
    polygonVertices: r.polygon.length,
    heightM: r.heightM,
    filledHoles: r.filledHoles,
    filledHoleAreaM2: r.filledHoleAreaM2,
    unfilledHoles: r.unfilledHoles,
    largestHoleM2: r.largestHoleM2,
  })),
  wallChannels: v.rooms.wallChannels,
  emitted: {
    ifcBytes: v.ifcBytes,
    spaceCount: v.emitted.spaces.length,
    wallCount: v.emitted.walls.length,
    slabCount: 1,
    modalWallThicknessM: v.emitted.modalWallThicknessM,
    slabThicknessNominalM: v.emitted.slabThicknessNominalM,
    /** ABSOLUTE base height of each placed type, resolved out of the emitted
     *  STEP by walking its IfcLocalPlacement chain to the world -- not the
     *  arguments that were passed in. The builder's placement parents are not
     *  uniform (walls and slabs are storey-relative, spaces are
     *  world-relative), so this is the only form of the check that can fail if
     *  those semantics change underneath the caller. */
    worldBaseZByType: v.emitted.worldBaseZByType,
  },
  frameCheck: { maxCornerOffsetM: v.card.frameCheck.maxCornerOffsetM, cornerOffsetsM: v.card.frameCheck.cornerOffsetsM },
  /**
   * The margin behind the correspondence, not just its outcome: how far the
   * bbox midpoint used for the containment test sits from the space's own
   * area-weighted plan centroid, and how far it sits from the boundary of the
   * room it landed in. While the clearance exceeds the separation the shortcut
   * cannot change an assignment on this data -- and `score.mjs` fails the run
   * outright if the two points ever resolve to different rooms.
   */
  correspondence: v.card.correspondence.map((c) => ({
    reference: c.reference,
    assignedTo: c.assignedTo,
    centroidSeparationM: c.centroidSeparationM,
    boundaryClearanceM: c.boundaryClearanceM,
    centroidAgrees: c.centroidAgrees,
  })),
  perRoom: v.card.perRoom,
  totals: v.card.totals,
  verdict: v.card.verdict,
});

const scorecard = {
  bet: 'B5.5 scan-to-parametric (M5 final)',
  generatedAt: new Date().toISOString(),
  bar: 0.05,
  elapsedSeconds: (Date.now() - t0) / 1000,
  /** Wall clock of extract + generate + score + assemble, i.e. everything
   *  after the one streaming pass over the E57. Reported separately because
   *  `--skip-ingest` reruns exclude the pass entirely. */
  elapsedSecondsAfterIngest: (Date.now() - t0) / 1000 - (SKIP_INGEST ? 0 : ingest.elapsedMs / 1000),
  primaryVariant: PRIMARY,
  scan: {
    sourceBytes: ingest.sourceBytes,
    decodedPointCount: ingest.decodedPointCount,
    keptPointCount: ingest.keptPointCount,
    stride: ingest.stride,
    hasColor: ingest.hasColor,
    hasIntensity: ingest.hasIntensity,
    nonFinite: ingest.nonFinite,
    bboxExtentM: ingest.bbox.extent,
    densityPerM3: ingest.densityPerM3,
    densityPerPlanM2: ingest.densityPerPlanM2,
    ingestSeconds: ingest.elapsedMs / 1000,
    megaPointsPerSecond: ingest.megaPointsPerSecond,
    planes: variants[PRIMARY].rooms.planes,
  },
  reference: {
    spaceCount: variants[PRIMARY].card.verdict.referenceSpaceCount,
    typeCounts: variants[PRIMARY].card.referenceTypeCounts,
    spaces: variants[PRIMARY].card.referenceSpaces,
    heightAudit: variants[PRIMARY].card.referenceHeightAudit,
  },
  variants: Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, slim(v)])),
};

/**
 * Figures the prose quotes that are neither a raw measurement nor a deviation:
 * emitted here rather than computed in a sentence, so the numerals gate can
 * back them.
 */
{
  const card = variants[PRIMARY].card;
  const audit = card.referenceHeightAudit;
  const defaulted = audit.spaces.filter((s) => s.unsupportedByScan);
  const primaryRooms = variants[PRIMARY].rooms.rooms;
  const refPerim = card.referenceSpaces.map((s) => ({ label: s.label, perimeterM: s.lateralAreaM2 / s.clearHeightM }));
  const mergedRefPerimeter = ['ref_space_A', 'ref_space_D']
    .map((l) => refPerim.find((p) => p.label === l).perimeterM).reduce((a, b) => a + b, 0);
  scorecard.derived = {
    referencePerimeterM: refPerim,
    generatedPerimeterM: primaryRooms.map((r) => ({ id: r.id, perimeterM: r.polygonPerimeterM })),
    mergedReferencePerimeterM: mergedRefPerimeter,
    room001PerimeterExcessM: primaryRooms[0].polygonPerimeterM - mergedRefPerimeter,
    room001PerimeterExcessPercent: ((primaryRooms[0].polygonPerimeterM - mergedRefPerimeter) / mergedRefPerimeter) * 100,
    ceilingEvidenceRatio: audit.pointsAtScanFittedCeiling / defaulted[0].scanPointsWithin1cmOfTop,
    defaultedReferenceSpaceCount: defaulted.length,
    defaultedReferenceHeightM: defaulted[0].heightM,
    /** 8 ft in metres -- what the defaulted reference height turns out to be. */
    eightFeetInMetres: 8 * 0.3048,
    scanMinusDefaultedHeightM: scorecard.scan.planes.clearHeightM - defaulted[0].heightM,
    /** Depth of the fitted floor plane below the scan's local origin: the
     *  same plane as `scan.planes.floor.z`, sign removed, because prose
     *  quotes the magnitude. */
    floorPlaneDepthBelowScanOriginM: -scorecard.scan.planes.floor.z,
    subsampleBytes: statSync(join(WORK, 'sub.f32')).size,
    derivedIntermediateBytes: ['sub.f32', 'ingest.json', 'rooms.json'].reduce((a, f) => a + statSync(join(WORK, f)).size, 0),
  };
}

const OUT = join(HERE, 'scorecard.json');
const text = JSON.stringify(scorecard, null, 2);

/**
 * Fail closed if anything identifying reached the committed artifact. Two
 * independent gates, because either alone is too weak: an allowlist of the
 * string VALUES this pipeline is allowed to emit (so nothing can leak in by
 * accident), plus a denylist of the reference file's own quoted strings (so a
 * future edit that widens the allowlist still cannot carry a person, an
 * organisation, a file name or a Revit family through).
 */
const ALLOWED_VALUE = [
  /^scan_room_\d{3}$/,
  /^ref_space_[A-Z]$/,
  /^Ifc[A-Za-z]+$/,
  /^(axisAligned|principalFrame)$/,
  /^model$/,
  /^(floorAreaM2|clearHeightM|volumeM3|lateralAreaM2|areaWeightedClearHeightM)$/,
  /^[xyz]$/,
  /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/,
  /^B5\.5 scan-to-parametric \(M5 final\)$/,
  /^full-cloud z histogram, 1 cm bins, \+-1 cm around the tested elevation$/,
  /^Both models meshed by the same kernel, so both boxes are in the viewer frame \(Y up\)\. No transform was applied to either side\.$/,
];
/**
 * Every quoted STEP string in `text`, with `''` escapes honoured.
 *
 * The denylist below used to scan with `/'([^']{10,})'/g`, which loses quote
 * PARITY at the first doubled quote and then pairs each closing quote with the
 * next string's opening one for the rest of the file. Measured on this bet's
 * reference model: 150 of its 570 identifying strings were invisible to the
 * check, all of them after the first escape, and a string planted past that
 * point in a leak test was not flagged. The allowlist above still caught it --
 * that arm is the primary defence and fails closed -- but the denylist exists
 * precisely so a future widening of the allowlist cannot carry a person, an
 * organisation or a file name through, and it cannot do that job blind.
 */
function stepStrings(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("'", i);
    if (start < 0) break;
    let j = start + 1, buf = '', closed = false;
    for (;;) {
      const q = text.indexOf("'", j);
      if (q < 0) break;                                  // unterminated: stop
      if (text[q + 1] === "'") { buf += `${text.slice(j, q)}'`; j = q + 2; continue; }
      buf += text.slice(j, q);
      i = q + 1;
      closed = true;
      break;
    }
    if (!closed) break;
    out.push(buf);
  }
  return out;
}

function assertNoIdentifiers(s, obj) {
  const hits = new Set();
  const walk = (v, path) => {
    if (Array.isArray(v)) { v.forEach((e, i) => walk(e, `${path}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      for (const [k, e] of Object.entries(v)) {
        if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(k)) hits.add(`key ${path}.${k}`);
        walk(e, `${path}.${k}`);
      }
      return;
    }
    if (typeof v === 'string' && !ALLOWED_VALUE.some((re) => re.test(v))) hits.add(`value ${path} = ${JSON.stringify(v)}`);
  };
  walk(obj, '$');
  // Denylist: quoted STEP strings from the reference that carry a letter and
  // are long enough to identify something (short ones like 'Reference' or a
  // bare year collide with this pipeline's own vocabulary and mean nothing).
  const refText = readFileSync(REFERENCE, 'latin1');
  for (const str of stepStrings(refText)) {
    if (str.length >= 10 && /[A-Za-z]/.test(str) && s.includes(str)) {
      hits.add(`reference string ${JSON.stringify(str)}`);
    }
  }
  // Anything shaped like the IfcSite degrees/minutes/seconds tuple.
  if (/\b\d{1,3}\s*,\s*\d{1,2}\s*,\s*\d{1,2}\s*,\s*\d{5,}\b/.test(s)) hits.add('<dms tuple>');
  if (hits.size) {
    throw new Error(`scorecard carries identifiers:\n  ${[...hits].slice(0, 8).join('\n  ')}`);
  }
}
assertNoIdentifiers(text, scorecard);
writeFileSync(OUT, text);

const p = variants[PRIMARY].card.verdict;
console.log(`\nprimary (${PRIMARY}): ${p.rowsWithinBar}/${p.rowsScored} rows within the ${scorecard.bar * 100}% bar`);
for (const r of p.rowsOutsideBar) console.log(`  outside: ${r.scope}/${r.quantity} ${r.deviationPercent.toFixed(2)}%`);
for (const r of p.rowsUnscored) console.log(`  UNSCORED: ${r.scope}/${r.quantity} (no reference space assigned)`);
console.log(`scorecard -> ${OUT}`);
