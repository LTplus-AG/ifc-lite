/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseIfcx } from './index.js';
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
    await assert.rejects(parseIfcx(file([geo, geo])), /conflicting/);
  });
});
