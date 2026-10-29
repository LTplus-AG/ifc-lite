/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Row, Table } from '@ifc-lite/flow';
import type { InfluxSelection } from './influx-query.js';

const reserved = new Set(['', 'result', 'table', '_start', '_stop', '_time', '_value']);

/** Influx CSV has a leading unnamed annotation column, even with annotations
 * disabled. Flow tables require named columns; remove only that empty envelope. */
export function dataTable(table: Table): Table {
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
  // Flux error tables carry error/reference and no _value; a data table may have an `error` tag column.
  if (!columns.includes('_value') && (columns.includes('error') || columns.includes('reference'))) throw new Error('InfluxDB returned an error table');
  if (new Set(columns).size !== columns.length) throw new Error('Duplicate CSV columns');
  for (const required of ['_time', '_value', '_measurement', '_field', selection.guidTag]) {
    if (!columns.includes(required)) throw new Error(`InfluxDB response lacks ${required}`);
  }
  const identityColumns = columns.filter(name => !reserved.has(name)).sort();
  const valuesAtTime = new Map<string, number>();
  const latest = new Map<string, { row: Row; time: bigint }>();
  for (const row of table.rows) {
    const raw = row._value;
    const value = typeof raw === 'string' && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isFinite(value)) throw new Error('Expected a finite numeric reading');
    if (row._measurement !== selection.measurement || row._field !== selection.field) throw new Error('Unexpected measurement or field');
    if (typeof row[selection.guidTag] !== 'string' || !row[selection.guidTag]) throw new Error('Missing IFC GUID tag');
    const time = timestamp(row._time);
    const key = JSON.stringify(identityColumns.map(column => [column, row[column]]));
    const sampleKey = JSON.stringify([key, String(time)]);
    const seenValue = valuesAtTime.get(sampleKey);
    if (seenValue !== undefined && seenValue !== value) throw new Error('Conflicting values at one series timestamp');
    valuesAtTime.set(sampleKey, value);
    const previous = latest.get(key);
    if (!previous || time > previous.time) latest.set(key, { row: { ...row, _value: value }, time });
    else if (time === previous.time && value !== previous.row._value) throw new Error('Conflicting values at one series timestamp');
  }
  return {
    columns: table.columns.map(column => column.name === '_value' ? { ...column, type: 'real' } : column),
    rows: [...latest.values()].map(item => item.row), key: selection.guidTag,
  };
}

