/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Picking a property's data type after its value carries the data type's XSD base onto the value. */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { commit, createGateContext, createStudioDocument, createStudioState, type GateContext, type StudioState, type Uuid } from '@ifc-lite/ids-authoring';
import { addFacetOps, addSpecOps, dataTypeOps, declarePsetOp, setFieldOp } from './ops';
import { formFromConstraint, inputFromForm } from './value-model';
import { studioXml } from './xml';

let gate: GateContext;
before(async () => { gate = await createGateContext(); });

/** A Conditionscore requirement whose value list was applied before any data type was chosen. */
function typedFirst(values: string[]): { state: StudioState; facetId: Uuid } {
  const spec = addSpecOps({ name: 'Condition', ifcVersions: ['IFC4'] });
  const property = addFacetOps(spec.specId, 'requirements', {
    type: 'property', propertySet: { kind: 'equals', value: 'Custom_Condition' }, baseName: { kind: 'equals', value: 'Conditionscore' },
  }, 'required');
  let state = commit(createStudioState(createStudioDocument({ title: 'T' })), [declarePsetOp('Custom_Condition'), ...spec.ops, ...property.ops]).state;
  const typed = inputFromForm({ ...formFromConstraint(undefined), kind: 'oneOf', values });
  assert.ok('input' in typed && typed.input);
  state = commit(state, [setFieldOp(property.facetId, 'property.value', typed.input)]).state;
  return { state, facetId: property.facetId };
}

function pick(state: StudioState, facetId: Uuid, dataType: string): string {
  const { facet } = state.doc.ids.specifications[0].requirements[0];
  assert.ok(facet.type === 'property');
  const result = commit(state, dataTypeOps(facetId, facet, { kind: 'equals', value: dataType }, gate, ['IFC4']));
  const xml = studioXml(result.state.doc);
  assert.ok(xml.ok);
  return xml.xml;
}

describe('a data type picked after the value', () => {
  // Reported from the field: Conditionscore (1-5, IFCINTEGER) was saved as xs:string.
  it('writes the data type\'s base, not xs:string', () => {
    const { state, facetId } = typedFirst(['1', '2', '3', '4', '5']);
    const xml = pick(state, facetId, 'IFCINTEGER');
    assert.match(xml, /dataType="IFCINTEGER"/);
    assert.match(xml, /<xs:restriction base="xs:integer">/);
    assert.doesNotMatch(xml, /xs:string/);
  });

  it('leaves a value that does not hold under the new base', () => {
    const { state, facetId } = typedFirst(['good', 'bad']);
    const xml = pick(state, facetId, 'IFCINTEGER');
    assert.match(xml, /<xs:restriction base="xs:string">/);
  });

  it('sets only the data type when the value needs no change', () => {
    const { state, facetId } = typedFirst(['1']);
    const { facet } = state.doc.ids.specifications[0].requirements[0];
    assert.ok(facet.type === 'property');
    assert.equal(dataTypeOps(facetId, facet, null, gate, ['IFC4']).length, 1);
    // An unbased list is already written as xs:string, so IFCLABEL needs no value op.
    assert.equal(dataTypeOps(facetId, facet, { kind: 'equals', value: 'IFCLABEL' }, gate, ['IFC4']).length, 1);
    assert.equal(dataTypeOps(facetId, facet, { kind: 'equals', value: 'IFCINTEGER' }, gate, ['IFC4']).length, 2);
    assert.equal(dataTypeOps(facetId, facet, { kind: 'equals', value: 'NOT_A_TYPE' }, gate, ['IFC4']).length, 1);
  });
});
