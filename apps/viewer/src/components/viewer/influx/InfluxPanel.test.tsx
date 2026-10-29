/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { cleanup, click, render, type, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { DEFAULT_INFLUX_CONFIG, INFLUX_CONFIG_KEY, saveInfluxConfig } from '@/lib/influx/config';
import { InfluxPanel } from './InfluxPanel';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; localStorage.clear(); });

test('#8090 selected real IFC space shows latest/history, ambiguity stays explicit and save excludes token', async () => {
  const source = await readFile(new URL('../../../../public/samples/building-architecture.ifc', import.meta.url));
  const parsed = await new IfcParser().parseColumnar(new Uint8Array(source).buffer);
  const roomId = parsed.entities.getExpressIdByGlobalId('0xY$LvXaDEswJDk_VU74C_');
  const model = { ...fixtureModel('building'), ifcDataStore: parsed, maxExpressId: parsed.entities.expressId.reduce((max, id) => Math.max(max, id), 0) };
  useViewerStore.setState({ ...fixtureModels(model), selectedEntityId: roomId, mutationViews: new Map() });
  const token = 'panel-token-must-not-persist';
  const csv = await readFile(new URL('../../../../../../examples/headless-workflows/influx-demo.csv', import.meta.url), 'utf8');
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    requests++;
    assert.equal(String(url), 'http://localhost:8086/api/v2/query?org=spike');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Token ${token}`);
    return new Response(csv);
  };
  const ui = render(<InfluxPanel />);
  const values = ['http://localhost:8086', 'spike', 'monitoring', 'environment', 'temperature', 'ifc_guid', '°C', token];
  const inputs = ui.querySelectorAll('input');
  assert.equal(inputs.length, values.length);
  values.forEach((value, index) => type(inputs[index], value));
  assert.equal(inputs[7].type, 'password');
  click(ui.querySelector('button')!);
  await waitFor(() => Boolean(ui.querySelector('svg[aria-label]')), 'real selected space history');
  assert.equal(requests, 1);
  assert.match(ui.textContent ?? '', /Latest: 22.5 °C/);
  assert.match(ui.textContent ?? '', /living room/);
  assert.equal(ui.querySelector('svg')?.getAttribute('aria-label'), 'History for living room: 3 samples');
  assert.equal(ui.querySelector('svg title')?.textContent, 'History for living room: 3 samples');
  assert.match(ui.querySelector('output')?.textContent ?? '', /6 samples/);
  assert.equal(ui.querySelector('polyline')?.getAttribute('points')?.split(' ').length, 3);
  assert.match(ui.textContent ?? '', /Ambiguous series \(2\)/);
  assert.match(ui.textContent ?? '', /hall-a/);
  assert.match(ui.textContent ?? '', /hall-b/);
  assert.match(ui.textContent ?? '', /Unmatched series \(1\)/);
  const saved = localStorage.getItem(INFLUX_CONFIG_KEY)!;
  assert.equal(JSON.parse(saved).bucket, 'monitoring');
  assert.equal(saved.includes(token), false);
  assert.equal(saved.includes('token'), false);

  // A competing entity in a second model must invalidate a previously unique
  // match; selection resolution also survives a nonzero federation offset.
  const second = { ...model, id: 'second', idOffset: 1_000_000 };
  act(() => useViewerStore.setState({ models: new Map([['building', model], ['second', second]]), selectedEntityId: roomId }));
  assert.doesNotMatch(ui.textContent ?? '', /Latest: 22.5/);
  assert.match(ui.textContent ?? '', /Ambiguous series \(3\)/);
  act(() => useViewerStore.setState({ ...fixtureModels(second), selectedEntityId: roomId + second.idOffset }));
  assert.match(ui.textContent ?? '', /Latest: 22.5/);
  globalThis.fetch = async () => { throw new TypeError(`network failure ${token}`); };
  click(ui.querySelector('button')!);
  await waitFor(() => Boolean(ui.querySelector('[role="alert"]')), 'CORS guidance');
  assert.match(ui.querySelector('[role="alert"]')?.textContent ?? '', /allow this viewer origin/);
  assert.equal(ui.textContent?.includes(token), false);
  assert.equal(localStorage.getItem(INFLUX_CONFIG_KEY)?.includes(token), false);
});

// #8297: token overlap must never corrupt a previously saved connection.
test('#8297 short and URI-encoded tokens skip persistence without rewriting fields', () => {
  const previous = { ...DEFAULT_INFLUX_CONFIG, url: 'https://monitor.example.org', bucket: 'monitoring' };
  saveInfluxConfig(previous, 'safe-token');
  const saved = localStorage.getItem(INFLUX_CONFIG_KEY);
  assert.deepEqual(JSON.parse(saved!), previous);
  for (const [token, url] of [['x', 'https://influx.example.com'], ['a/b', 'https://example.org/a%2Fb']]) {
    const config = { ...previous, url };
    saveInfluxConfig(config, token);
    assert.equal(localStorage.getItem(INFLUX_CONFIG_KEY), saved);
    assert.equal(config.url, url);
    localStorage.removeItem(INFLUX_CONFIG_KEY);
    saveInfluxConfig(config, token);
    assert.equal(localStorage.getItem(INFLUX_CONFIG_KEY), null);
    localStorage.setItem(INFLUX_CONFIG_KEY, saved!);
  }
});

// #8297: first-open Load must work when the optional display unit stays blank.
test('#8297 Load accepts the default blank display unit', async () => {
  useViewerStore.setState({ ...fixtureModels(), ifcDataStore: null, selectedEntityId: null, mutationViews: new Map() });
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response(''); };
  const ui = render(<InfluxPanel />);
  const inputs = ui.querySelectorAll('input');
  const values = ['http://localhost:8086', 'spike', 'monitoring', 'environment', 'temperature', 'ifc_guid'];
  values.forEach((value, index) => type(inputs[index], value));
  assert.equal(inputs[6].value, '');
  type(inputs[7], 'valid-token-8297');
  click(ui.querySelector('button')!);
  await waitFor(() => Boolean(ui.querySelector('output')), 'Load with a blank unit');
  assert.equal(requests, 1);
  assert.match(ui.querySelector('output')?.textContent ?? '', /Loaded 0 samples/);
  assert.equal(ui.querySelector('[role="alert"]'), null);
  assert.equal(JSON.parse(localStorage.getItem(INFLUX_CONFIG_KEY)!).unit, '');
});
