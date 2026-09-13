/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Offline CC BY 4.0 CRAS real-pair run (#4381): registers the frozen fit/check
// landmarks from cras-landmarks.py through the canonical WASM solver, derives
// the accuracy tolerance from the HELD-OUT residuals only, then runs the RGB
// point-cloud transfer onto one IFC wall of the IFC4 derivative and records
// coverage. Nothing here invents a correspondence or approves accuracy.
// Usage: node cras-register-transfer.mjs LANDMARKS.json IFC4.ifc STRIP.ply WALL_GUID OUT_DIR [ARCHIVE_SHA256]
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { initSync, IfcAPI } from '../../packages/wasm/pkg/ifc-lite.js';
import { unpackTransfer } from '../../scripts/lib/wasm-mesh-transfer-contract.mjs';

const [landmarksPath, ifcPath, plyPath, wallGuid, outDir, archiveSha] = process.argv.slice(2);
initSync({ module: await readFile(new URL('../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url)) });
await mkdir(outDir, { recursive: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const landmarks = JSON.parse(await readFile(landmarksPath, 'utf8'));
const ifc = new Uint8Array(await readFile(ifcPath));
const plyBytes = await readFile(plyPath);

/** Binary little-endian PLY written by cras-archive-subset.py: double xyz, uchar rgb, uchar label, uint source_index. */
function readPly(bytes) {
  const end = bytes.indexOf('end_header\n') + 'end_header\n'.length;
  const header = bytes.subarray(0, end).toString('latin1');
  const count = Number(/element vertex (\d+)/.exec(header)[1]);
  const positions = new Float64Array(count * 3), colors = new Uint8Array(count * 3), rows = new Uint32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset + end);
  for (let i = 0, o = 0; i < count; i++, o += 32) {
    positions[i * 3] = view.getFloat64(o, true); positions[i * 3 + 1] = view.getFloat64(o + 8, true); positions[i * 3 + 2] = view.getFloat64(o + 16, true);
    colors[i * 3] = view.getUint8(o + 24); colors[i * 3 + 1] = view.getUint8(o + 25); colors[i * 3 + 2] = view.getUint8(o + 26);
    rows[i] = view.getUint32(o + 28, true);
  }
  return { count, positions, colors, rows, header };
}
const cloud = readPly(plyBytes);

// ------------------------------------------------------------ registration
const measured = landmarks.features.filter(f => f.status === 'ok');
// Source identity: the three fitted planes named by the SHA-256 of their supporting
// archive rows; target identity: the IFC GlobalIds whose faces intersect plus the
// named face/reveal (two corners of one opening share entities but not planes).
const pair = f => ({ id: f.id, sourceObservation: `planes:${f.planes_fit.map(p => p.support_rows_sha256.slice(0, 16)).join('+')}`,
  targetFeature: `${f.entities.join('+')}:${f.planes.map(p => p.name).join('+')}:${f.id}`, source: f.scan, target: f.ifc });
const registration = {
  sourceFrame: { assetSha256: archiveSha ?? sha256(plyBytes), frameKey: 'cras-archive-native-metres-v1' },
  targetFrame: { assetSha256: sha256(ifc), frameKey: 'ifc-world-z-up-metres' },
  fit: measured.filter(f => f.partition === 'fit').map(pair),
  heldOut: measured.filter(f => f.partition === 'check').map(pair),
};
const api = new IfcAPI();
try {
  const report = JSON.parse(new TextDecoder().decode(api.registerScanCorrespondences(JSON.stringify(registration))));
  const heldOut = report.heldOut.points.map(p => p.distanceMetres).sort((a, b) => a - b);
  const fit = report.fit.points.map(p => p.distanceMetres).sort((a, b) => a - b);
  // Tolerance rule, fixed before this run: the largest held-out residual rounded
  // UP to the next centimetre. Fit residuals never enter the choice.
  const toleranceMetres = Math.ceil(heldOut[heldOut.length - 1] * 100) / 100;
  const quantile = (v, q) => v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)];
  const summary = {
    algorithm: report.algorithm, requestSha256: report.requestSha256,
    counts: { fit: registration.fit.length, heldOut: registration.heldOut.length },
    rotation: report.rotation, sourceAnchor: report.sourceAnchor, targetAnchor: report.targetAnchor,
    fit: { rmsMetres: report.fit.rmsMetres, maxMetres: report.fit.maxMetres, medianMetres: quantile(fit, 0.5) },
    heldOut: { rmsMetres: report.heldOut.rmsMetres, maxMetres: report.heldOut.maxMetres, medianMetres: quantile(heldOut, 0.5), p90Metres: quantile(heldOut, 0.9), residuals: report.heldOut.points },
    fitResiduals: report.fit.points, spread: { source: report.sourceSpread, target: report.targetSpread }, diagnostics: report.diagnostics,
    toleranceRule: 'largest held-out residual, rounded up to the next centimetre; chosen after the solve from held-out points only',
    toleranceMetres,
  };
  await writeFile(join(outDir, 'registration-request.json'), JSON.stringify(registration, null, 1) + '\n');
  await writeFile(join(outDir, 'registration-report.json'), JSON.stringify({ ...report, summary }, null, 1) + '\n');
  console.log(JSON.stringify({ registration: summary }, null, 1));

  // ------------------------------------------------------------- transfer
  const ifcText = new TextDecoder().decode(ifc);
  const line = new RegExp(`^#(\\d+)=IFCWALL(?:STANDARDCASE)?\\('${wallGuid.replace(/\$/g, '\\$')}'`, 'm').exec(ifcText);
  if (!line) throw new Error(`wall ${wallGuid} not found in ${ifcPath}`);
  const wallId = Number(line[1]);
  let nextExpressId = 1;
  for (const m of ifcText.matchAll(/^#(\d+)=/gm)) nextExpressId = Math.max(nextExpressId, Number(m[1]) + 1);
  // Texel densities are tried from the densest down: the fixed 128,000,000-unit
  // work budget refuses a plan it cannot finish, and that refusal is recorded as a
  // result of its own. The half-tolerance control runs at the accepted density.
  const densities = (process.env.CRAS_TEXELS_PER_METRE ?? '64,32').split(',').map(Number);
  const half = Math.max(0.005, toleranceMetres / 2);
  const attempts = densities.map(texels => ['tolerance', toleranceMetres, toleranceMetres, texels]);
  const runs = [];
  let accepted = null;
  while (attempts.length) {
    const [label, maxDistanceMetres, maxBehindMetres, texelsPerMetre] = attempts.shift();
    const request = {
      schema: 'IFC4', sourceRevision: `cras-ifc4-${sha256(ifc).slice(0, 12)}`, nextExpressId, productIds: [wallId],
      registration, registrationSha256: report.requestSha256,
      targetFromIfcWorld: { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], sourceAnchor: [0, 0, 0], targetAnchor: [0, 0, 0] },
      source: { kind: 'points', pointCount: cloud.count, orientation: 'target-referenced', neighborhoodRadiusMetres: 0.04, minNeighbors: 6, maxNeighbors: 48, surfaceBandMetres: 0.006, viewpoints: [] },
      sourceImages: [], texelsPerMetre, maxDistanceMetres, minNormalDot: 0.8, ambiguityDistanceMetres: 0.002, maxBehindMetres,
    };
    const started = performance.now();
    let output;
    try {
      output = unpackTransfer(api.planPointTransfer(ifc, JSON.stringify(request), new Uint8Array(0), cloud.positions, cloud.colors, new Float32Array(0), new Uint32Array(0)));
    } catch (error) {
      const refused = { label, texelsPerMetre, maxDistanceMetres, maxBehindMetres, wallId, wallGuid, points: cloud.count, ms: Math.round(performance.now() - started), refused: error instanceof Error ? error.message : String(error) };
      runs.push(refused); console.log(JSON.stringify({ run: refused }, null, 1));
      continue;
    }
    if (label === 'tolerance' && accepted === null) { accepted = texelsPerMetre; attempts.length = 0; attempts.push(['half-tolerance', half, half, texelsPerMetre]); }
    const { metadata, png } = output;
    const ms = Math.round(performance.now() - started);
    const coverage = metadata.transfer.coverage;
    const row = { label, texelsPerMetre, maxDistanceMetres, maxBehindMetres, wallId, wallGuid, points: cloud.count, ms, applicable: metadata.transfer.applicable,
      source: metadata.transfer.source, budget: metadata.transfer.budget, coverage, items: metadata.transfer.items, diagnostics: metadata.transfer.diagnostics, exclusions: metadata.transfer.exclusions,
      preparedSha256: metadata.transfer.preparedSha256, assets: metadata.assets, planEntities: metadata.plan ? { created: metadata.plan.created.length, edits: metadata.plan.edits.length, removed: metadata.plan.removed.length } : null };
    runs.push(row);
    await writeFile(join(outDir, `transfer-${label}.json`), JSON.stringify({ request: { ...request, registration: '(see registration-request.json)' }, metadata: { ...metadata, plan: metadata.plan ? { ...metadata.plan } : null } }, null, 1) + '\n');
    if (png.length) await writeFile(join(outDir, `transfer-${label}.png`), png);
    console.log(JSON.stringify({ run: { ...row, items: undefined } }, null, 1));
  }
  await writeFile(join(outDir, 'transfer-summary.json'), JSON.stringify({ ifc: { file: basename(ifcPath), sha256: sha256(ifc), bytes: ifc.length }, strip: { file: basename(plyPath), sha256: sha256(plyBytes), points: cloud.count }, runs }, null, 1) + '\n');
} finally { api.free(); }
