/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const binary = new URL('../pkg/ifc-lite_bg.wasm', import.meta.url);
const glue = new URL('../pkg/ifc-lite.js', import.meta.url);
async function engine(context) {
  if (!existsSync(binary) || !existsSync(glue)) {
    context.skip('WASM bundle missing; run pnpm build:wasm'); return;
  }
  const module = await import(glue.href);
  module.initSync({ module: readFileSync(binary) });
  return module;
}

test('retained WASM axis uses horizontal SI distance, exact EXPRESS metadata and f64 grade (#6603)', async context => {
  const module = await engine(context); if (!module) return;
  const content = `ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X1'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,$,#2);
#2=IFCUNITASSIGNMENT((#3));#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#10=IFCCARTESIANPOINT((0.,0.,0.));#11=IFCCARTESIANPOINT((10000.,0.,1000.));
#12=IFCPOLYLINE((#10,#11));#20=IFCALIGNMENT('axis-global-id',$,'Road',$,$,$,$,#12);
ENDSEC;END-ISO-10303-21;`;
  const axis = new module.AlignmentAxisJs(content, 20);
  try {
    assert.equal(axis.GlobalId, 'axis-global-id'); assert.equal(axis.Name, 'Road');
    assert.equal(axis.expressId, 20); assert.equal(axis.approximate, false);
    assert.equal(axis.geometricHorizontalLengthMeters, 10);
    const sample = axis.evaluate(5);
    assert.ok(sample instanceof Float64Array);
    assert.deepEqual(Array.from(sample.subarray(0, 4)), [5, 5, 0, 0.5]);
    assert.ok(Math.abs(Math.hypot(...sample.slice(4)) - 1) < 1e-12);
    for (const distance of [-1, 11, NaN, Infinity]) assert.throws(() => axis.evaluate(distance));
  } finally { axis.free(); }
});

test('real OIP circular alignment WASM sample matches independent analytic oracle (#6603)', async context => {
  const fixture = new URL('../../../tests/models/issues/844_terrain_and_alignment.ifc', import.meta.url);
  if (!existsSync(fixture)) { context.skip('Real alignment fixture missing; run pnpm fixtures'); return; }
  const module = await engine(context); if (!module) return;
  const axis = new module.AlignmentAxisJs(readFileSync(fixture, 'utf8'), 39);
  try {
    const radius = 15.00004036907433, heading = 5.246193083124705;
    const sample = axis.evaluate(10);
    const expected = [radius * (Math.sin(heading + 10 / radius) - Math.sin(heading)),
      radius * (Math.cos(heading) - Math.cos(heading + 10 / radius))];
    assert.ok(Math.abs(sample[1] - expected[0]) < 1e-8);
    assert.ok(Math.abs(sample[2] - expected[1]) < 1e-8);
    const horizontal = Math.hypot(sample[4], sample[5]);
    assert.ok(Math.abs(sample[4] / horizontal - Math.cos(heading + 10 / radius)) < 1e-8);
    assert.ok(Math.abs(sample[5] / horizontal - Math.sin(heading + 10 / radius)) < 1e-8);
  } finally { axis.free(); }
});
