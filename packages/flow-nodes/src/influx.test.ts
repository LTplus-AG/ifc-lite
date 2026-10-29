/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it, expect } from 'vitest';
import { fetchInfluxReadings, latestPerSeries, matchInfluxSeries, parseInfluxCsv, queryRequest, redactInfluxError, selectionContainsToken, type InfluxSelection } from './influx.js';

const selection: InfluxSelection = {
  url: 'https://influx.example.com', org: 'test', bucket: 'monitoring', measurement: 'environment',
  field: 'temperature', guidTag: 'ifc_guid', unit: '°C',
};
const header = ',result,table,_time,_value,_measurement,_field,ifc_guid,device\n';
const row = (value = '20', guid = 'space', device = 'a', time = '2026-10-24T10:00:00.000000001Z') => `,,0,${time},${value},environment,temperature,${guid},${device}\n`;
const csv = header + row('20') + row('22.5', 'space', 'a', '2026-10-24T10:00:00.000000002Z') + row('19', 'hall', 'b') + row('21', 'hall', 'c') + row('18', 'missing');
const token = 'test-token-never-persist';

describe('InfluxDB shared adapters (#8090)', () => {
  it('generates bounded escaped Flux and permits only HTTPS or http://localhost', () => {
    const body = JSON.parse(queryRequest({ ...selection, maxSamples: 12, tags: { device: 'room "A"' } }).body);
    expect(body.query).toContain('limit(n: 13)');
    expect(body.query).toContain('group(columns: [])');
    expect(body.dialect.annotations).toEqual([]);
    expect(queryRequest({ ...selection, url: 'http://localhost:8086' }).url).toContain('/api/v2/query?org=test');
    for (const url of ['http://192.168.1.2:8086', 'http://localhost.evil', 'https://u:p@example.com', 'https://example.com?token=secret']) {
      expect(() => queryRequest({ ...selection, url })).toThrow();
    }
    // Deliberately literal Flux interpolation is hostile input for this regression.
    // eslint-disable-next-line no-template-curly-in-string
    for (const patch of [{ bucket: '${http.post()}' }, { minutes: 1441 }, { maxSamples: 10001 }, { guidTag: '_value' }]) {
      expect(() => queryRequest({ ...selection, ...patch })).toThrow();
    }
  });
  it('#8297 accepts ordinary ASCII punctuation and rejects control bytes', () => {
    const request = queryRequest({ ...selection, bucket: 'ABC[]^_@' });
    expect(JSON.parse(request.body).query).toContain('from(bucket: "ABC[]^_@")');
    expect(() => queryRequest({ ...selection, bucket: String.fromCharCode(1) })).toThrow(/control/);
  });
  it('#8297 accepts an empty display unit while required Flux fields remain non-empty', () => {
    expect(queryRequest({ ...selection, unit: '' })).toEqual(queryRequest(selection));
    for (const field of ['bucket', 'measurement', 'field', 'guidTag'] as const) {
      expect(() => queryRequest({ ...selection, [field]: '' })).toThrow(/empty/);
    }
  });
  it('retains nanosecond ordering, history and separate tag sets', () => {
    const parsed = parseInfluxCsv(csv, selection, 'unrelated-token');
    expect(parsed.history.rows).toHaveLength(5);
    expect(parsed.latest.rows).toHaveLength(4);
    expect(parsed.latest.rows[0]._value).toBe(22.5);
    expect(latestPerSeries(parsed.history, selection).rows[0]._time).toBe('2026-10-24T10:00:00.000000002Z');
  });
  it('reports unmatched, competing series and duplicate model GUIDs without choosing', () => {
    const latest = parseInfluxCsv(csv, selection, 'unrelated-token').latest;
    const targets = [{ GlobalId: 'space', modelId: 'one' }, { GlobalId: 'hall', modelId: 'one' }];
    const result = matchInfluxSeries(latest, targets);
    expect(result.matched.map(item => item.row._value)).toEqual([22.5]);
    expect(result.unmatched).toHaveLength(1);
    expect(result.ambiguous).toHaveLength(2);
    const duplicate = matchInfluxSeries(latest, [...targets, { GlobalId: 'space', modelId: 'two' }]);
    expect(duplicate.matched).toHaveLength(0);
    expect(duplicate.ambiguous).toHaveLength(3);
  });
  it('fails on overflow, malformed data, error tables, invalid numbers/timestamps and conflicts', () => {
    expect(() => parseInfluxCsv(csv, { ...selection, maxSamples: 1 }, 'unrelated-token')).toThrow(/cap exceeded/);
    for (const bad of [header + row('false'), header + row('NaN'), header + row('Infinity'), header + row('1', 'space', 'a', '2026-02-30T00:00:00Z'),
      header + row('20') + row('21'), header + 'wrong,width\n', ',error,reference\n,failed,123\n', csv + '\n,error,reference\n,failed,123\n',
      header + row('"20'), header + row('20"'), header.replace('device', '_value') + row(), header + row('20', '')]) {
      expect(() => parseInfluxCsv(bad, selection, 'unrelated-token')).toThrow();
    }
    expect(parseInfluxCsv('', selection, 'unrelated-token').latest.rows).toEqual([]);
  });
  it('redacts literal and encoded credentials and suppresses upstream error content', async () => {
    expect(redactInfluxError(new Error(`failure ${token} ${token}`), token)).not.toContain(token);
    expect(redactInfluxError(new Error('secret a%2Fb'), 'a/b')).toBe('secret [REDACTED]');
    for (const transport of [async () => { throw new Error(`network ${token}`); }, async () => new Response(token, { status: 401 })]) {
      await expect(fetchInfluxReadings(selection, token, transport)).rejects.not.toThrow(token);
    }
    await expect(fetchInfluxReadings(selection, token, async () => { throw new TypeError(token); })).rejects.toMatchObject({ kind: 'network' });
    await expect(fetchInfluxReadings(selection, token, async () => new Response(header + row('20', token)))).rejects.toMatchObject({ kind: 'data' });
  });
  it('#8297 rejects CSV-escaped token echoes in decoded cells and headers', async () => {
    const credential = 'secret"quote';
    for (const echoed of [header + row('20', 'space', '"prefix-secret""quote-suffix"'), header.replace('device', '"secret""quote"') + row()]) {
      await expect(fetchInfluxReadings(selection, credential, async () => new Response(echoed))).rejects.toMatchObject({
        kind: 'data', message: 'InfluxDB response contains credentials',
      });
    }
  });
  it('#8297 rejects raw/encoded token echoes instead of collapsing distinct series', async () => {
    const credential = 'secret/a+b';
    const echoed = header + row('20', 'space', credential) + row('21', 'space', encodeURIComponent(credential), '2026-10-24T10:00:00.000000002Z');
    const unchanged = parseInfluxCsv(echoed, selection, '').latest;
    expect(unchanged.rows).toHaveLength(2);
    expect(matchInfluxSeries(unchanged, [{ GlobalId: 'space' }]).ambiguous).toHaveLength(2);
    await expect(fetchInfluxReadings(selection, credential, async () => new Response(echoed))).rejects.toMatchObject({
      kind: 'data', message: 'InfluxDB response contains credentials',
    });
    expect(() => parseInfluxCsv(header + row('22', 'space', 'secret%2fa%2bb'), selection, credential)).toThrow(/contains credentials/);
  });
  it('uses direct authenticated POST, fails oversized responses and sends no request with invalid config', async () => {
    let count = 0;
    const transport: typeof fetch = async (url, init) => {
      count++;
      expect(String(url)).toBe('https://influx.example.com/api/v2/query?org=test');
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Token ${token}`);
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      return new Response(csv);
    };
    expect((await fetchInfluxReadings(selection, token, transport)).history.rows).toHaveLength(5);
    await expect(fetchInfluxReadings(selection, '', transport)).rejects.toMatchObject({ kind: 'config' });
    await expect(fetchInfluxReadings({ ...selection, org: token }, token, transport)).rejects.toMatchObject({ kind: 'config' });
    expect(count).toBe(1);
    await expect(fetchInfluxReadings(selection, token, async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)))).rejects.toMatchObject({ kind: 'data' });
  });
  it('#8297 flags a token in any selection field or tag', () => {
    expect(selectionContainsToken({ ...selection, org: 'org-secret/a+b' }, 'secret/a+b')).toBe(true);
    expect(selectionContainsToken({ ...selection, tags: { site: encodeURIComponent('secret/a+b') } }, 'secret/a+b')).toBe(true);
    expect(selectionContainsToken({ ...selection, unit: 'secret%2fa%2bb' }, 'secret/a+b')).toBe(true);
    expect(selectionContainsToken({ ...selection, unit: 'secret%2Fa+b' }, 'secret/a+b')).toBe(true);
    expect(selectionContainsToken({ ...selection, unit: '100%' }, 'secret/a+b')).toBe(false);
    expect(selectionContainsToken(selection, 'secret/a+b')).toBe(false);
  });
});
