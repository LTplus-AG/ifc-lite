/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addIfcxOverlay, parseFederatedIfcx, parseIfcx } from './index.js';
const geo = { IfcProjectedCRS: { Name: 'EPSG:32632', MapUnit: 'METRE' }, IfcMapConversion: {
  Eastings: 500000, Northings: 6000000, OrthogonalHeight: 0, XAxisAbscissa: 1, XAxisOrdinate: 0, Scale: 1,
} };
function file(values: unknown[]) {
  return new TextEncoder().encode(JSON.stringify({ header: { ifcxVersion: 'ifcx_alpha' }, imports: [], schemas: {},
    data: values.map((value, i) => ({ path: `site-${i}`, attributes: { 'ifclite::georeference::v1': value } })) })).buffer;
}
describe('IFCX projected coordinate transport', () => {
  it('preserves finite projected placement with exact EXPRESS attribute names', async () => {
    const model = await parseIfcx(file([geo]));
    assert.equal(model.georeferencing?.IfcProjectedCRS.Name, 'EPSG:32632');
    assert.equal(model.georeferencing?.IfcMapConversion.Eastings, 500000);
    assert.equal(model.georeferencing?.IfcMapConversion.OrthogonalHeight, 0);
  });
  it('rejects malformed or conflicting placements instead of fabricating an origin', async () => {
    await assert.rejects(parseIfcx(file([{ ...geo, IfcMapConversion: { ...geo.IfcMapConversion, Scale: 0 } }])), /map conversion/);
    await assert.rejects(parseIfcx(file([{ ...geo, IfcProjectedCRS: { Name: 'unknown', MapUnit: 'METRE' } }])), /CRS/);
    await assert.rejects(parseIfcx(file([geo, { ...geo, IfcMapConversion: { ...geo.IfcMapConversion, Eastings: 600000 } }])), /conflicting/);
  });
  // #6824: inheritance copies a single placement onto each inheriting node.
  it('accepts equal authored and inherited placements in both composition paths', async () => {
    const source = new TextEncoder().encode(JSON.stringify({ header: { ifcxVersion: 'ifcx_alpha' }, imports: [], schemas: {}, data: [
      { path: 'site', attributes: { 'ifclite::georeference::v1': geo } },
      { path: 'building', inherits: { placement: 'site' } },
    ] })).buffer;
    assert.deepEqual((await parseIfcx(file([geo, geo]))).georeferencing, geo);
    assert.deepEqual((await parseIfcx(source)).georeferencing, geo);
    assert.deepEqual((await parseFederatedIfcx([{ buffer: source, name: 'base.ifcx' }])).georeferencing, geo);
  });
  it('retains placement through layers and applies stronger overlay placement (#6824)', async () => {
    const base = await parseFederatedIfcx([{ buffer: file([geo]), name: 'base.ifcx' }]);
    const unchanged = await addIfcxOverlay(base, file([]), 'empty.ifcx');
    assert.deepEqual(unchanged.georeferencing, geo);
    const updated = { ...geo, IfcMapConversion: { ...geo.IfcMapConversion, Eastings: 650000 } };
    assert.deepEqual((await addIfcxOverlay(unchanged, file([updated]), 'placement.ifcx')).georeferencing, updated);
    assert.deepEqual((await parseFederatedIfcx([
      { buffer: file([geo]), name: 'base.ifcx' }, { buffer: file([updated]), name: 'placement.ifcx' },
    ])).georeferencing, updated);
  });
  it('rejects invalid placement before reporting extraction complete (#6824)', async () => {
    for (const layered of [false, true]) {
      const phases: string[] = [];
      const options = { onProgress: (event: { phase: string; percent: number }) => { if (event.percent === 100) phases.push(event.phase); } };
      const bad = file([{ ...geo, IfcMapConversion: { ...geo.IfcMapConversion, Scale: 0 } }]);
      const result = layered ? parseFederatedIfcx([{ buffer: bad, name: 'bad.ifcx' }], options) : parseIfcx(bad, options);
      await assert.rejects(result, /map conversion/);
      assert.equal(phases.includes('relationships'), false);
    }
  });
});
