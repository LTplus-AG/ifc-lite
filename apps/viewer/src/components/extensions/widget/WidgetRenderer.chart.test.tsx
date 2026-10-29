/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChartNode } from '@ifc-lite/extensions';
import { cleanup, render } from '@/test/render.js';
import { setLocale } from '@/i18n';
import { WidgetRenderer } from './WidgetRenderer.js';

beforeEach(() => setLocale('en'));
afterEach(cleanup);

function chart(variant: ChartNode['variant'], readings: unknown[]) {
  return render(<WidgetRenderer
    node={{ type: 'Chart', variant, data: '$.readings', xField: 'time', yField: 'temperature' }}
    ctx={{ state: { readings } }}
  />);
}

// #8090: line used to fall through to the CSS bar renderer.
it('connects line-chart readings in input order using the selected fields and shared scale (#8090)', () => {
  const ui = chart('line', [
    { time: '09:00', temperature: 10 },
    { time: '11:00', temperature: 20 },
    { time: '10:00', temperature: 5 },
  ]);
  const line = ui.querySelector('svg polyline');
  assert.ok(line, 'line variant must draw a polyline');
  const points = line.getAttribute('points')!.trim().split(/\s+/).map(point => point.split(',').map(Number));
  assert.equal(points.length, 3);
  assert.ok(points[0][0] < points[1][0] && points[1][0] < points[2][0]);
  assert.ok(points[1][1] < points[0][1] && points[0][1] < points[2][1]);
  assert.equal(ui.querySelectorAll('rect, .bg-primary').length, 0, 'no SVG or CSS bars');
  assert.match(ui.textContent ?? '', /09:00.*10.*11:00.*20.*10:00.*5/);
});

it('preserves bar widths, values and labels (#8090)', () => {
  const ui = chart('bar', [{ time: 'First', temperature: 10 }, { time: 'Second', temperature: 20 }]);
  assert.equal(ui.querySelectorAll('svg').length, 0);
  const bars = [...ui.querySelectorAll<HTMLElement>('.bg-primary')];
  assert.deepEqual(bars.map(bar => bar.style.width), ['50%', '100%']);
  assert.match(ui.textContent ?? '', /First.*10.*Second.*20/);
});

it('keeps an empty line chart free of marks (#8090)', () => {
  const ui = chart('line', []);
  assert.equal(ui.querySelectorAll('polyline, circle, rect, .bg-primary').length, 0);
  assert.match(ui.textContent ?? '', /line/i);
});

it('renders a single zero reading without invalid coordinates (#8090)', () => {
  const ui = chart('line', [{ time: 'Now', temperature: 0 }]);
  const point = ui.querySelector('svg circle');
  assert.ok(point, 'a single reading must remain visible');
  assert.ok(Number.isFinite(Number(point.getAttribute('cx'))));
  assert.ok(Number.isFinite(Number(point.getAttribute('cy'))));
});
