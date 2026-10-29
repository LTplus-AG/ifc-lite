/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { Table } from '@ifc-lite/flow';
import { withModelFile } from '../src/common.mjs';
import { influxGraph, latestPerSeries, runInfluxSpike } from '../src/influx-flow.mjs';
import { queryRequest, type InfluxSelection } from '@ifc-lite/flow-nodes/influx';
import { influxReport } from '../src/influx-report.mjs';

const selection: InfluxSelection = {
  url: 'https://influx.example.com', org: 'test', bucket: 'monitoring',
  measurement: 'environment', field: 'temperature', guidTag: 'ifc_guid', unit: '°C',
};
const modelPath = fileURLToPath(new URL('../../../apps/viewer/public/samples/building-architecture.ifc', import.meta.url));
const demoCsv = () => readFile(new URL('../influx-demo.csv', import.meta.url), 'utf8');
const env = { INFLUX_TOKEN: 'test-token-8090-never-export' };
const baseRow = {
  _measurement: 'environment', _field: 'temperature', ifc_guid: 'target', device: 'a',
  _time: '2026-10-24T10:00:00.000000001Z', _value: '20',
};
function table(rows: Table['rows']): Table {
  return { columns: Object.keys(baseRow).map(name => ({ name, type: 'string' })), key: 'ifc_guid', rows };
}

test('#8090 uses latest samples per series, retaining nanosecond order', () => {
  const result = latestPerSeries(table([
    { ...baseRow, _time: '2026-10-24T10:00:00.000000002Z', _value: '22.5' }, baseRow,
    { ...baseRow, device: 'b', _value: '19' },
  ]), selection);
  assert.deepEqual(result.rows.map(row => [row.device, row._value]), [['a', 22.5], ['b', 19]]);
});

test('#8090 refuses overflow, nonnumeric samples, malformed timestamps and conflicting readings', () => {
  assert.throws(() => latestPerSeries(table([baseRow, baseRow]), { ...selection, maxSamples: 1 }), /cap exceeded/);
  assert.throws(() => latestPerSeries(table([{ ...baseRow, _value: 'false' }]), selection), /numeric reading/);
  assert.throws(() => latestPerSeries(table([{ ...baseRow, _time: 'not a time' }]), selection), /RFC3339/);
  assert.throws(() => latestPerSeries(table([baseRow, { ...baseRow, _value: '21' }]), selection), /Conflicting/);
});

test('#8090 query is bounded and rejects interpolation, credentials and unsupported transport', () => {
  const request = queryRequest({ ...selection, maxSamples: 12, tags: { device: 'room "A"' } });
  const body = JSON.parse(request.body) as { query: string; dialect: { annotations: string[] } };
  // The generated request is the API contract; no source-file assertions.
  assert.ok(body.query.includes('limit(n: 13)'));
  assert.ok(body.query.includes('group(columns: [])'));
  assert.deepEqual(body.dialect.annotations, []);
  assert.throws(() => queryRequest({ ...selection, bucket: '${http.post()}' }), /interpolation/);
  assert.throws(() => queryRequest({ ...selection, url: 'http://192.168.1.2:8086' }), /HTTPS/);
  assert.throws(() => queryRequest({ ...selection, url: 'https://user:pass@influx.example.com' }), /credentials/);
  assert.throws(() => queryRequest({ ...selection, minutes: 1441 }), /minutes/);
  assert.throws(() => queryRequest({ ...selection, guidTag: '_value' }), /tag/);
  assert.equal(JSON.stringify(influxGraph(selection)).includes(env.INFLUX_TOKEN), false);
});

test('#8090 existing Flow HTTP, CSV and join nodes map a parsed IFC and separate competing series', async () => {
  const csv = await demoCsv();
  await withModelFile(modelPath, async model => {
    let requests = 0;
    const result = await runInfluxSpike(selection, {
      bim: model.bim,
      networkTransport: async (url, options) => {
        requests++;
        assert.equal(String(url), 'https://influx.example.com/api/v2/query?org=test');
        assert.equal(new Headers(options?.headers).get('Authorization'), `Token ${env.INFLUX_TOKEN}`);
        assert.equal(options?.method, 'POST');
        return new Response(csv);
      },
    }, env);
    assert.equal(requests, 1);
    assert.equal(result.history.rows.length, 6);
    assert.equal(result.matched.rows.length, 1);
    const reading = result.matched.rows[0];
    assert.equal(reading.GlobalId, '0xY$LvXaDEswJDk_VU74C_');
    assert.equal(reading._value, 22.5);
    assert.equal(model.bim.query().byType('IfcSpace').toArray().find(space => space.globalId === reading.GlobalId)?.name, 'living room');
    assert.equal(result.unmatched.rows.length, 1);
    assert.equal(result.ambiguous.rows.length, 2);
    assert.deepEqual(new Set(result.ambiguous.rows.map(row => row.device)), new Set(['hall-a', 'hall-b']));
    assert.ok(result.nodes.every(node => node.status === 'ok'));
    assert.equal(JSON.stringify(result).includes(env.INFLUX_TOKEN), false);
    const report = influxReport({ ...result, source: 'synthetic-demo', model: 'sample.ifc', guidTag: 'ifc_guid', entityNames: { [String(reading.GlobalId)]: '</script><img src=x>' } });
    assert.equal(report.includes('</script><img'), false);
  });
});

test('#8090 refuses HTTP failures and error tables, including an error after partial results', async () => {
  const csv = await demoCsv();
  await withModelFile(modelPath, async model => {
    for (const response of [
      () => new Response('unauthorized', { status: 401 }),
      () => new Response(',error,reference\n,failed,123\n'),
      () => new Response(csv + '\n,error,reference\n,failed,123\n'),
    ]) {
      await assert.rejects(runInfluxSpike(selection, { bim: model.bim, networkTransport: async () => response() }, env));
    }
  });
});

test('#8090 empty query result is empty, and unset secrets are refused before transport', async () => {
  await withModelFile(modelPath, async model => {
    let requests = 0;
    const host = { bim: model.bim, networkTransport: async () => { requests++; return new Response(''); } };
    await assert.rejects(runInfluxSpike(selection, host, {}), /INFLUX_TOKEN/);
    assert.equal(requests, 0);
    const result = await runInfluxSpike(selection, host, env);
    assert.equal(result.matched.rows.length, 0);
    assert.equal(result.history.rows.length, 0);
  });
});
