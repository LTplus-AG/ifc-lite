/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { withModelFile } from './common.mjs';
import { runInfluxSpike } from './influx-flow.mjs';
import { influxReport, type InfluxReport } from './influx-report.mjs';
import type { InfluxSelection } from '@ifc-lite/flow-nodes/influx';

const [modelPath, configPath, outputPath] = process.argv.slice(2);
if (!modelPath || !configPath || !outputPath) {
  throw new Error('Usage: node influx.mjs MODEL.ifc CONFIG.json|--demo REPORT.html');
}
const demo = configPath === '--demo';
const selection: InfluxSelection = demo ? {
  url: 'https://demo.invalid', org: 'spike', bucket: 'monitoring', measurement: 'environment',
  field: 'temperature', guidTag: 'ifc_guid', unit: '°C',
} : JSON.parse(await readFile(configPath, 'utf8'));
const csv = demo ? await readFile(new URL('../influx-demo.csv', import.meta.url), 'utf8') : undefined;
const report = await withModelFile(modelPath, async model => {
  const result = await runInfluxSpike(selection, {
    bim: model.bim,
    defaultModelId: model.bim.model.list()[0]?.id,
    ...(demo ? { networkTransport: async () => new Response(csv, { headers: { 'Content-Type': 'text/csv' } }) } : {}),
  }, demo ? { INFLUX_TOKEN: 'synthetic-demo-token' } : process.env);
  return {
    ...result, source: demo ? 'synthetic-demo' : 'live-influxdb-2',
    model: basename(modelPath), guidTag: selection.guidTag,
    entityNames: Object.fromEntries(model.bim.query().toArray().map(entity => [entity.globalId, entity.name || entity.globalId])),
  } satisfies InfluxReport;
});
await writeFile(outputPath, influxReport(report), { flag: 'wx' });
console.log(JSON.stringify({
  source: report.source, matched: report.matched.rows.length, unmatched: report.unmatched.rows.length,
  ambiguous: report.ambiguous.rows.length, samples: report.history.rows.length, report: outputPath,
}));
