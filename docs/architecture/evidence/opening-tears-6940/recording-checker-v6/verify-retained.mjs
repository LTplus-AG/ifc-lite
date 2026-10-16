// SPDX-License-Identifier: MPL-2.0
// Untimed integration diagnostic. Never emits cohort or performance acceptance.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateFrameTimes, sidecarPath } from './contracts.mjs';

const root = path.resolve(process.argv[2]);
const read = file => JSON.parse(fs.readFileSync(file));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const must = (value, why) => { if (!value) throw Error(why); };
function load(ref) {
  const bytes = fs.readFileSync(ref.path);
  must(sha(bytes) === ref.sha256, 'Retained receipt hash differs');
  let value = JSON.parse(bytes);
  for (const part of (ref.pointer ?? '').split('/').slice(1)) {
    value = value[part.replaceAll('~1', '/').replaceAll('~0', '~')];
  }
  return value;
}
const plan = read(path.join(root, 'plan.json'));
const rows = [], missing = [];
for (const [index, sample] of plan.samples.entries()) {
  const file = sidecarPath(root, index, sample);
  if (!fs.existsSync(file)) { missing.push(sample.id); continue; }
  const s = read(file);
  must(s.id === sample.id && s.side === sample.side && s.pair === sample.pair
    && s.fixture === sample.fixture, 'Wrong finalized sidecar');
  for (const key of ['preCadence', 'postCadence']) {
    const probe = load(s[key]);
    must(probe.samples.length === 60, 'Incomplete retained cadence');
    validateFrameTimes(probe.samples.map(s => s.timestamp), probe.startNow, probe.finishNow, must);
    must(probe.samples.every(s => s.hasFocus === true && s.visibility === 'visible'), 'Focus/visibility failed');
    must(probe.samples.slice(1).every((s, i) =>
      Math.abs(s.timestamp - probe.samples[i].timestamp - 1000 / 30) <= (1000 / 30) * .03),
    'Retained 59-interval cadence failed');
  }
  for (const ref of Object.values(s.markers)) {
    const marker = load(ref);
    validateFrameTimes(marker.frames, marker.startNow, marker.finishNow, must);
  }
  rows.push({ id: s.id, path: file, sha256: sha(fs.readFileSync(file)) });
}
console.log(JSON.stringify({ scope: 'Retained sidecar discovery and frame-contract diagnostic only',
  historicalPlanUnmodified: true, performanceQualified: false, recordingAdmissionPassed: false,
  found: rows.length, missing, rows }, null, 2));
