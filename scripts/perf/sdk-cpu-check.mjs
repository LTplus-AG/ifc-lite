/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { available, quiet } from './sdk-resources.mjs';
const report = { scope: 'Hosted Linux CPU sampler functional evidence only; no model or timing verdict',
  status: 'started', capturedUTC: new Date().toISOString(), checks: [] };
const output = resolve('cpu-check.json');
writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx' });
try {
  if (process.platform !== 'linux' || process.env.CI !== 'true') throw new Error('hosted Linux CI required');
  report.availableBytes = available();
  for (let index = 0; index < 3; index++) report.checks.push(await quiet());
  report.status = 'complete-three-sampler-controls';
} catch (error) {
  report.status = 'refused'; report.reason = String(error);
  report.refusedObservation = error.receipt ?? null; process.exitCode = 1;
}
report.finishedUTC = new Date().toISOString();
writeFileSync(output, JSON.stringify(report, null, 2));
