/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Where does the registered scan surface lie relative to a modelled wall (#4381)?
// Applies the canonical registration to a CRAS subset and histograms, at 1 cm,
// the position of every point that falls within the wall's footprint along the
// wall's thickness axis, measured from the wall's minimum face. Values below 0
// or above the thickness lie outside the solid; values in between lie inside
// it. This is the measured basis for the "in front of / inside the modelled
// face" statements in the evidence README; it never enters any transfer.
// Usage: node cras-face-depth.mjs SUBSET.ply registration-report.json IFC4.ifc WALL_GUID x|y OUT.json
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';

const [plyPath, reportPath, ifcPath, guid, axis, outPath] = process.argv.slice(2);
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const bytes = await readFile(plyPath);
const end = bytes.indexOf('end_header\n') + 'end_header\n'.length;
const count = Number(/element vertex (\d+)/.exec(bytes.subarray(0, end).toString('latin1'))[1]);
const view = new DataView(bytes.buffer, bytes.byteOffset + end);
const { rotation: R, sourceAnchor: sa, targetAnchor: ta } = report;

// The wall's tessellated body from the IFC4 derivative: its bounding box is the
// wall's footprint and thickness (all reference walls are axis-aligned boxes).
const ifc = await readFile(ifcPath, 'utf8');
const escaped = guid.replace(/\$/g, '\\$');
const wall = new RegExp(`^#(\\d+)=IFCWALL\\('${escaped}'.*?,#(\\d+),\\$`, 'm').exec(ifc);
if (!wall) throw new Error(`wall ${guid} not found in ${ifcPath}`);
const shape = new RegExp(`^#${wall[2]}=IFCPRODUCTDEFINITIONSHAPE\\([^;]*\\(([^)]*)\\)`, 'm').exec(ifc)[1];
const representation = new RegExp(`^${shape.split(',')[0]}=IFCSHAPEREPRESENTATION\\([^;]*\\(([^)]*)\\)`, 'm').exec(ifc)[1];
const faceSet = new RegExp(`^${representation.split(',')[0]}=IFCTRIANGULATEDFACESET\\((#\\d+)`, 'm').exec(ifc)[1];
const list = new RegExp(`^${faceSet}=IFCCARTESIANPOINTLIST3D\\(\\((.*)\\)\\)`, 'm').exec(ifc)[1];
const coordinates = [...list.matchAll(/\(([^)]*)\)/g)].map(m => m[1].split(',').map(Number));
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (const c of coordinates) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], c[a]); max[a] = Math.max(max[a], c[a]); }

const along = 'xyz'.indexOf(axis);
if (along < 0) throw new Error('axis must be x or y');
const thickness = max[along] - min[along];
const inset = 0.2; // stay clear of the wall ends and of floor/ceiling junctions
const histogram = new Map();
let considered = 0;
for (let i = 0, o = 0; i < count; i++, o += 32) {
  const p = [view.getFloat64(o, true), view.getFloat64(o + 8, true), view.getFloat64(o + 16, true)];
  const d = [p[0] - sa[0], p[1] - sa[1], p[2] - sa[2]];
  const q = [0, 1, 2].map(a => R[a][0] * d[0] + R[a][1] * d[1] + R[a][2] * d[2] + ta[a]);
  let inFootprint = true;
  for (let a = 0; a < 3; a++) if (a !== along && (q[a] < min[a] + inset || q[a] > max[a] - inset)) inFootprint = false;
  if (!inFootprint) continue;
  const relative = q[along] - min[along];
  if (relative < -0.3 || relative > thickness + 0.3) continue;
  const bin = Math.round(relative * 100);
  histogram.set(bin, (histogram.get(bin) ?? 0) + 1);
  considered++;
}
const bins = [...histogram].sort((a, b) => a[0] - b[0]).map(([cm, points]) => ({
  fromMinFaceMetres: cm / 100, points, share: Math.round((points / considered) * 1000) / 1000,
  where: cm < 0 ? 'outside, on the minimum-face side' : cm > Math.round(thickness * 100) ? 'outside, on the maximum-face side' : 'inside the modelled solid',
}));
const peaks = bins.filter(b => b.share >= 0.02);
const result = {
  wall: { globalId: guid, expressId: Number(wall[1]), axis, minFace: min[along], maxFace: max[along], thicknessMetres: Math.round(thickness * 1000) / 1000 },
  subset: { file: basename(plyPath), sha256: createHash('sha256').update(bytes).digest('hex'), points: count },
  registration: { requestSha256: report.requestSha256 },
  footprintInsetMetres: inset, pointsConsidered: considered, binMetres: 0.01,
  peaks, bins,
};
await writeFile(outPath, JSON.stringify(result, null, 1) + '\n');
console.log(JSON.stringify({ wall: result.wall, pointsConsidered: considered, peaks }, null, 1));
