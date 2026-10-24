/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseCapabilities } from '@ifc-lite/extensions';
import { runFlow, type FlowDocument, type Row, type Table } from '@ifc-lite/flow';
import {
  buildRedactionMap, createStandardRegistry, headlessFeatures, interpolateSecrets,
  redactDeep, resolveSecretValues, validateSecretReferences, type FlowHost, type FlowNodeDef,
} from '@ifc-lite/flow-nodes';
import { queryRequest, type InfluxSelection } from './influx-query.mjs';

const tablePort = { kind: 'table', access: 'item' } as const;
const scalarPort = { kind: 'scalar', access: 'item' } as const;
const reserved = new Set(['', 'result', 'table', '_start', '_stop', '_time', '_value']);

/** Influx CSV has a leading unnamed annotation column, even with annotations
 * disabled. Flow tables require named columns; remove only that empty envelope. */
function dataTable(table: Table): Table {
  if (table.columns[0]?.name !== '') return table;
  if (table.rows.some(row => row[''] !== '') || table.columns.slice(1).some(column => column.name === '')) {
    throw new Error('Invalid InfluxDB CSV envelope');
  }
  return {
    columns: table.columns.slice(1), key: table.key,
    rows: table.rows.map(row => Object.fromEntries(Object.entries(row).filter(([name]) => name !== ''))),
  };
}

/** Preserve ns precision for ordering while retaining the original timestamp. */
function timestamp(value: unknown): bigint {
  if (typeof value !== 'string') throw new Error('Missing timestamp');
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value);
  const seconds = match ? Date.parse(`${match[1]}Z`) : NaN;
  if (!match || !Number.isFinite(seconds) || new Date(seconds).toISOString().slice(0, 19) !== match[1]) {
    throw new Error('Expected an RFC3339 UTC timestamp');
  }
  return BigInt(seconds) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}

/** Several samples are history; several tag sets for one GUID are ambiguity. */
export function latestPerSeries(table: Table, selection: InfluxSelection): Table {
  table = dataTable(table);
  const maxSamples = selection.maxSamples ?? 1000;
  if (table.rows.length > maxSamples) throw new Error('Sample cap exceeded; narrow the time range or tag filters');
  if (table.rows.length === 0 && table.columns.length === 0) {
    return { columns: [{ name: selection.guidTag, type: 'identifier' }], rows: [], key: selection.guidTag };
  }
  const columns = table.columns.map(column => column.name);
  if (columns.includes('error') || columns.includes('reference')) throw new Error('InfluxDB returned an error table');
  if (new Set(columns).size !== columns.length) throw new Error('Duplicate CSV columns');
  for (const required of ['_time', '_value', '_measurement', '_field', selection.guidTag]) {
    if (!columns.includes(required)) throw new Error(`InfluxDB response lacks ${required}`);
  }
  const identityColumns = columns.filter(name => !reserved.has(name)).sort();
  const latest = new Map<string, { row: Row; time: bigint }>();
  for (const row of table.rows) {
    const raw = row._value;
    const value = typeof raw === 'string' && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isFinite(value)) throw new Error('Expected a finite numeric reading');
    if (row._measurement !== selection.measurement || row._field !== selection.field) throw new Error('Unexpected measurement or field');
    if (typeof row[selection.guidTag] !== 'string' || !row[selection.guidTag]) throw new Error('Missing IFC GUID tag');
    const time = timestamp(row._time);
    const key = JSON.stringify(identityColumns.map(column => [column, row[column]]));
    const previous = latest.get(key);
    if (!previous || time > previous.time) latest.set(key, { row: { ...row, _value: value }, time });
    else if (time === previous.time && value !== previous.row._value) throw new Error('Conflicting values at one series timestamp');
  }
  return {
    columns: table.columns.map(column => column.name === '_value' ? { ...column, type: 'real' } : column),
    rows: [...latest.values()].map(item => item.row), key: selection.guidTag,
  };
}

export function influxGraph(selection: InfluxSelection): FlowDocument {
  const request = queryRequest(selection);
  return {
    flowVersion: 1, id: 'influxdb-8090-spike', name: 'InfluxDB latest readings to IFC',
    capabilities: ['model.read', `network.fetch:${request.hostname}`, 'secret.read:INFLUX_TOKEN'],
    inputs: [], outputs: [],
    nodes: [
      { id: 'request', type: 'http.request', params: {
        url: request.url, method: 'POST', body: request.body, timeoutMs: 15000, maxBytes: 2 * 1024 * 1024,
        headers: { Authorization: 'Token {{secret:INFLUX_TOKEN}}', 'Content-Type': 'application/json', Accept: 'application/csv' },
      } },
      { id: 'response', type: 'spike.influxResponse' },
      { id: 'csv', type: 'table.readCsv', params: { key: selection.guidTag } },
      { id: 'latest', type: 'spike.latestSeries' },
      { id: 'spaces', type: 'model.byType', params: { type: 'IfcSpace' } },
      { id: 'sensors', type: 'model.byType', params: { type: 'IfcSensor' } },
      { id: 'targets', type: 'spike.targets' },
      { id: 'join', type: 'table.joinByKey', params: { strategy: 'globalId', column: selection.guidTag } },
    ],
    edges: [
      ...['body', 'ok', 'truncated'].map(port => ({ from: ['request', port] as const, to: ['response', port] as const })),
      { from: ['response', 'text'], to: ['csv', 'text'] },
      { from: ['csv', 'table'], to: ['latest', 'table'] },
      { from: ['csv', 'problems'], to: ['latest', 'problems'] },
      { from: ['spaces', 'entities'], to: ['targets', 'spaces'] },
      { from: ['sensors', 'entities'], to: ['targets', 'sensors'] },
      { from: ['targets', 'entities'], to: ['join', 'entities'] },
      { from: ['latest', 'table'], to: ['join', 'table'] },
    ],
  };
}

function spikeNodes(selection: InfluxSelection): FlowNodeDef[] {
  return [
    {
      type: 'spike.influxResponse', title: 'Validate Influx response', category: 'spike', params: [], capabilities: [],
      inputs: ['body', 'ok', 'truncated'].map(name => ({ name, type: scalarPort })),
      outputs: [{ name: 'text', type: scalarPort }],
      run: (_ctx, inputs) => {
        if (inputs.ok !== true || inputs.truncated !== false) throw new Error('InfluxDB query failed or response was truncated');
        return { text: inputs.body };
      },
    },
    {
      type: 'spike.latestSeries', title: 'Latest per series', category: 'spike', params: [], capabilities: [],
      inputs: [{ name: 'table', type: tablePort }, { name: 'problems', type: { kind: 'scalar', access: 'list' } }],
      outputs: [{ name: 'table', type: tablePort }, { name: 'history', type: tablePort }],
      run: (_ctx, inputs) => {
        if (!Array.isArray(inputs.problems) || inputs.problems.length) throw new Error('Malformed or multi-table CSV response');
        const history = dataTable(inputs.table as Table);
        return { table: latestPerSeries(history, selection), history };
      },
    },
    {
      type: 'spike.targets', title: 'Monitoring targets', category: 'spike', params: [], capabilities: [],
      inputs: ['spaces', 'sensors'].map(name => ({ name, type: { kind: 'entity', access: 'list' } as const })),
      outputs: [{ name: 'entities', type: { kind: 'entity', access: 'list' } }],
      run: (_ctx, inputs) => ({ entities: [...inputs.spaces as unknown[], ...inputs.sensors as unknown[]] }),
    },
  ];
}

export async function runInfluxSpike(selection: InfluxSelection, host: FlowHost, env: Readonly<Record<string, string | undefined>>) {
  const graph = influxGraph(selection);
  const errors = validateSecretReferences(graph, env);
  if (errors.length) throw new Error(errors.map(error => error.message).join('; '));
  const values = resolveSecretValues(graph, env);
  if ([...values.values()].some(value => value.length < 6)) throw new Error('Token is too short for reliable output redaction');
  const parsed = parseCapabilities(graph.capabilities);
  if (!parsed.ok) throw new Error('Invalid graph capabilities');
  const registry = createStandardRegistry().registerAll(spikeNodes(selection));
  const result = await runFlow(interpolateSecrets(graph, values), {
    host: { ...host, networkGrants: parsed.value }, registry, features: headlessFeatures(values.keys()),
  });
  if (!result.ok) throw new Error(redactDeep(result.reports.filter(report => report.error).map(report => report.error).join('; '), buildRedactionMap(values)));
  function table(node: string, port: string): Table {
    const output = result.outputs.get(node)?.get(port);
    if (output?.kind !== 'item') throw new Error(`Missing ${node}.${port}`);
    return output.value as Table;
  }
  return redactDeep({
    unit: selection.unit, matched: table('join', 'matched'), unmatched: table('join', 'unmatched'),
    ambiguous: table('join', 'ambiguous'), history: table('latest', 'history'),
    nodes: result.reports.map(report => ({ id: report.nodeId, status: report.status })),
  }, buildRedactionMap(values));
}
