/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS-037: the XML tab's selection sync. Oracle: the IDS parser. The range
 * found for a node, cut out of the XML, is exactly that node's element, so
 * parsing the document back yields the same facet at the same place.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseIDS } from '@ifc-lite/ids';
import { commit } from '@ifc-lite/ids-authoring';
import { wallFixture } from '@/test/ids-studio-fixture';
import { addFacetOps, addSpecOps } from './ops';
import { studioXml, xmlRangeOf } from './xml';

describe('XML preview (IDS-037)', () => {
  it('locates the document info, each specification and each facet element', async () => {
    const { state, specId, entityId, propertyId } = await wallFixture();
    const second = addSpecOps({ name: 'Doors', ifcVersions: ['IFC4'] });
    const door = addFacetOps(second.specId, 'applicability', { type: 'entity', name: { kind: 'equals', value: 'IfcDoor' } });
    const doc = commit(state, [...second.ops, ...door.ops]).state.doc;
    const out = studioXml(doc);
    assert.ok(out.ok);
    const xml = out.xml;
    const slice = (id: string) => {
      const range = xmlRangeOf(xml, doc, id);
      assert.ok(range, id);
      return xml.slice(range.from, range.to);
    };
    assert.match(slice(doc.nodes.document), /^<info>[\s\S]*<title>Fire safety<\/title>[\s\S]*<\/info>$/);
    assert.match(slice(specId), /^<specification name="Walls – fire rating"[\s\S]*<\/specification>$/);
    assert.match(slice(second.specId), /^<specification name="Doors"/);
    assert.match(slice(entityId), /^<entity>[\s\S]*IFCWALL[\s\S]*<\/entity>$/);
    assert.match(slice(door.facetId), /IFCDOOR/);
    const property = slice(propertyId);
    assert.match(property, /^<property[\s\S]*<\/property>$/);
    assert.match(property, /FireRating/);
    // The parser reads the document the ranges were cut from, facet for facet.
    const parsed = parseIDS(xml);
    assert.equal(parsed.specifications[0].requirements[0].facet.type, 'property');
    assert.equal(parsed.specifications[1].applicability.facets[0].type, 'entity');
  });

  it('reports content the shared writer cannot express instead of throwing', async () => {
    const { state, propertyId } = await wallFixture();
    const doc = commit(state, [{ kind: 'facet.setField', opId: '0190a8a0-0000-7000-8000-000000000001', payload: { facetId: propertyId, field: 'property.value', value: { kind: 'length', max: 8 } } }]).state.doc;
    const out = studioXml(doc);
    assert.equal(out.ok, false);
    assert.ok(!out.ok && /length or digit bounds/.test(out.error));
  });
});
