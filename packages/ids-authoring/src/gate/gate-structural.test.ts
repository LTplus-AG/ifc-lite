/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeAll, describe, expect, it } from 'vitest';
import { addFacet, eq, ids, prop, specDoc } from '../../test/gate-helpers.js';
import type { FacetDraft, StudioOp, ValueInput } from '../ops/types.js';
import { apply } from '../reducer/apply.js';
import { checkOps } from './check.js';
import { createGateContext, type GateContext } from './context.js';

let ctx: GateContext;
beforeAll(async () => {
  ctx = await createGateContext();
});

const codes = (ops: unknown[], fixture = specDoc(['IFC4'], 'IfcWall')) => checkOps(ops, fixture.doc, ctx).issues.map((i) => i.code);

describe('custom declarations and reserved prefixes', () => {
  it('GATE-CUST-001: an undeclared custom set is refused, a declared one accepted', () => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcWall');
    const r = checkOps([addFacet(specId, prop('Acme_Wall', 'Code'))], doc, ctx);
    expect(r.issues.map((i) => i.code)).toEqual(['GATE-CUST-001']);
    // A lower-case standard name is not "reserved", so it lands here too, with the standard name suggested.
    const typo = checkOps([addFacet(specId, prop('pset_wallcommon', 'FireRating'))], doc, ctx);
    expect(typo.issues[0]).toMatchObject({ code: 'GATE-CUST-001' });
    expect(typo.issues[0].candidates[0].value).toBe('Pset_WallCommon');
    const declared = checkOps(
      [{ kind: 'meta.custom.declarePset', opId: ids(), payload: { decl: { name: 'Acme_Wall' } } }, addFacet(specId, prop('Acme_Wall', 'Code'))],
      doc,
      ctx,
    );
    expect(declared.issues).toEqual([]);
  });

  it('accepts custom sets declared by the context library', async () => {
    const lib = await createGateContext({ custom: [{ name: 'Org_Common' }] });
    const { doc, specId } = specDoc(['IFC4'], 'IfcWall');
    expect(checkOps([addFacet(specId, prop('Org_Common', 'Anything'))], doc, lib).ok).toBe(true);
  });

  it('GATE-CUST-002: custom sets cannot use a reserved prefix', () => {
    expect(codes([{ kind: 'meta.custom.declarePset', opId: ids(), payload: { decl: { name: 'Pset_AcmeWall' } } }])).toEqual(['GATE-CUST-002']);
  });

  it('GATE-CUST-003: a declared property list constrains the property name', () => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcWall');
    const declare: StudioOp = { kind: 'meta.custom.declarePset', opId: ids(), payload: { decl: { name: 'Acme_Wall', properties: [{ name: 'Code' }] } } };
    expect(checkOps([declare, addFacet(specId, prop('Acme_Wall', 'Code'))], doc, ctx).ok).toBe(true);
    const r = checkOps([declare, addFacet(specId, prop('Acme_Wall', 'Cod'))], doc, ctx);
    expect(r.issues.map((i) => [i.code, i.candidates[0]?.value])).toEqual([['GATE-CUST-003', 'Code']]);
  });

  it('GATE-CUST-004: removing an undeclared set is refused', () => {
    expect(codes([{ kind: 'meta.custom.removePset', opId: ids(), payload: { name: 'Nope' } }])).toEqual(['GATE-CUST-004']);
  });

  it('accepts a user-defined predefined type only once declared', () => {
    const { doc, specId } = specDoc(['IFC4']);
    const facet: FacetDraft = { type: 'entity', name: eq('IfcSlab'), predefinedType: eq('SLABRADOR') };
    expect(codes([addFacet(specId, facet, 'applicability')], { doc, specId })).toEqual(['GATE-PDT-001']);
    const declare: StudioOp = { kind: 'meta.custom.declareUserDefinedType', opId: ids(), payload: { entity: 'IfcSlab', value: 'SlabRador' } };
    expect(codes([declare, addFacet(specId, facet, 'applicability')], { doc, specId })).toEqual([]);
  });
});

describe('patterns on names are not blocked', () => {
  it.each<[string, FacetDraft]>([
    ['pset pattern', prop('x', 'y', { propertySet: { kind: 'pattern', pattern: 'Pset_.*Common' }, baseName: { kind: 'pattern', pattern: 'Fire.*' } })],
    ['entity pattern', { type: 'entity', name: { kind: 'pattern', pattern: 'IFC.*WALL.*' } }],
    ['attribute pattern', { type: 'attribute', name: { kind: 'pattern', pattern: '.*Name' } }],
  ])('%s', (_label, facet) => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcWall');
    expect(checkOps([addFacet(specId, facet)], doc, ctx).issues).toEqual([]);
  });
});

describe('structural rules (GATE-STR-00x)', () => {
  const unknown = ids();
  it.each<[string, () => unknown[], string]>([
    ['STR-001 unknown spec', () => [addFacet(unknown, { type: 'material' })], 'GATE-STR-001'],
    ['STR-001 unknown facet', () => [{ kind: 'facet.remove', opId: ids(), payload: { facetId: unknown } }], 'GATE-STR-001'],
    ['STR-003 optionality on applicability', () => {
      const { specId } = fixture;
      return [{ kind: 'facet.add', opId: ids(), payload: { specId, section: 'applicability', facetId: ids(), facet: { type: 'material' }, optionality: 'optional' } }];
    }, 'GATE-STR-003'],
    ['STR-004 partOf without entity', () => [addFacet(fixture.specId, { type: 'partOf', relation: 'IfcRelAggregates' })], 'GATE-STR-004'],
    ['STR-005 dataType restriction', () => [addFacet(fixture.specId, prop('Pset_WallCommon', 'FireRating', { dataType: { kind: 'oneOf', values: ['IFCLABEL', 'IFCTEXT'] } }))], 'GATE-STR-005'],
    ['STR-006 index out of range', () => [{ kind: 'spec.move', opId: ids(), payload: { specId: fixture.specId, toIndex: 3 } }], 'GATE-STR-006'],
    ['STR-007 empty spec name', () => [{ kind: 'spec.add', opId: ids(), payload: { specId: ids(), name: ' ', ifcVersions: ['IFC4'] } }], 'GATE-STR-007'],
    ['STR-007 duplicate versions', () => [{ kind: 'spec.setIfcVersions', opId: ids(), payload: { specId: fixture.specId, versions: ['IFC4', 'IFC4'] } }], 'GATE-STR-007'],
    ['STR-008 optional entity requirement', () => [{ kind: 'facet.add', opId: ids(), payload: { specId: fixture.specId, section: 'requirements', facetId: ids(), facet: { type: 'entity', name: eq('IfcWall') }, optionality: 'optional' } }], 'GATE-STR-008'],
  ])('%s', (_label, ops, code) => {
    expect(codes(ops(), fixture)).toEqual([code]);
  });

  const fixture = specDoc(['IFC4'], 'IfcWall');

  it('STR-002: a required field cannot be cleared', () => {
    const facetId = ids();
    const built = apply(fixture.doc, [{ kind: 'facet.add', opId: ids(), payload: { specId: fixture.specId, section: 'requirements', facetId, facet: prop('Pset_WallCommon', 'FireRating') } }]).doc;
    const r = checkOps([{ kind: 'facet.setField', opId: ids(), payload: { facetId, field: 'property.baseName', value: null } }], built, ctx);
    expect(r.issues.map((i) => i.code)).toEqual(['GATE-STR-002']);
    const wrongField = checkOps([{ kind: 'facet.setField', opId: ids(), payload: { facetId, field: 'material.value', value: eq('x') } }], built, ctx);
    expect(wrongField.issues.map((i) => i.code)).toEqual(['GATE-STR-002']);
  });

  it('GATE-OP-001: malformed ops are data, not exceptions', () => {
    const r = checkOps([{ kind: 'spec.add', payload: {} }, 'nonsense', null], fixture.doc, ctx);
    expect(new Set(r.issues.map((i) => i.code))).toEqual(new Set(['GATE-OP-001']));
    expect(r.issues.map((i) => i.opIndex)).toEqual(expect.arrayContaining([0, 1, 2]));
    expect(r.issues[0].path).toMatch(/^ops\[0\]/);
  });
});

describe('value well-formedness (GATE-VAL-00x)', () => {
  const fixture = specDoc(['IFC4'], 'IfcWall');
  const withValue = (value: ValueInput) => [addFacet(fixture.specId, { type: 'attribute', name: eq('Name'), value })];
  it.each<[string, ValueInput, string]>([
    ['VAL-001 unknown unit', { kind: 'range', min: 1, unit: 'cubits' }, 'GATE-VAL-001'],
    ['VAL-002 min above max', { kind: 'range', min: 5, max: 1 }, 'GATE-VAL-002'],
    ['VAL-002 empty exclusive range', { kind: 'range', min: 1, max: 1, maxInclusive: false }, 'GATE-VAL-002'],
    ['VAL-003 pattern does not compile', { kind: 'pattern', pattern: '[A-Z' }, 'GATE-VAL-003'],
    ['VAL-004 ReDoS shape', { kind: 'pattern', pattern: '(a+)+$' }, 'GATE-VAL-004'],
    ['VAL-005 minLength above maxLength', { kind: 'length', min: 5, max: 2 }, 'GATE-VAL-005'],
    ['VAL-005 fraction above total digits', { kind: 'digits', total: 2, fraction: 3 }, 'GATE-VAL-005'],
    ['VAL-006 non-numeric literal for numeric base', { kind: 'oneOf', values: ['1.5', 'abc'], base: 'xs:double' }, 'GATE-VAL-006'],
    ['VAL-002 inside a conjunction', { kind: 'raw', constraint: { type: 'pattern', pattern: '[0-9]+', and: [{ type: 'bounds', minInclusive: 9, maxInclusive: 1 }] } }, 'GATE-VAL-002'],
  ])('%s', (_label, value, code) => {
    expect(codes(withValue(value), fixture)).toEqual([code]);
  });

  it('accepts well-formed XSD patterns, including XSD-only escapes', () => {
    expect(codes(withValue({ kind: 'pattern', pattern: '\\i\\c*-[0-9]{2}' }), fixture)).toEqual([]);
  });

  it('GATE-VAL-007: author must be an e-mail and date an xs:date', () => {
    expect(codes([{ kind: 'doc.setInfo', opId: ids(), payload: { field: 'author', value: 'Jane' } }])).toEqual(['GATE-VAL-007']);
    expect(codes([{ kind: 'doc.setInfo', opId: ids(), payload: { field: 'date', value: '08.10.2026' } }])).toEqual(['GATE-VAL-007']);
    expect(codes([{ kind: 'doc.setInfo', opId: ids(), payload: { field: 'date', value: '2026-10-08' } }])).toEqual([]);
  });

  it('GATE-VAL-008: enumeration edits need an enumeration', () => {
    const facetId = ids();
    const built = apply(fixture.doc, [{ kind: 'facet.add', opId: ids(), payload: { specId: fixture.specId, section: 'requirements', facetId, facet: { type: 'attribute', name: eq('Name'), value: { kind: 'pattern', pattern: 'A.*' } } } }]).doc;
    const r = checkOps([{ kind: 'value.addEnumValue', opId: ids(), payload: { facetId, field: 'attribute.value', value: 'B' } }], built, ctx);
    expect(r.issues.map((i) => i.code)).toEqual(['GATE-VAL-008']);
  });
});

describe('batches', () => {
  it('checks later ops against the state earlier accepted ops leave, and keeps reporting after a refusal', () => {
    const { doc } = specDoc(['IFC4']);
    const specId = ids();
    const r = checkOps(
      [
        { kind: 'spec.add', opId: ids(), payload: { specId, name: 'Doors', ifcVersions: ['IFC4'] } },
        addFacet(specId, { type: 'entity', name: eq('IfcDoorr') }, 'applicability'),
        addFacet(specId, prop('Pset_DoorCommon', 'FireRatin')),
      ],
      doc,
      ctx,
    );
    expect(r.issues.map((i) => [i.opIndex, i.code])).toEqual([
      [1, 'GATE-ENT-001'],
      [2, 'GATE-PROP-001'],
    ]);
  });

  it('checks compound ops through their expansion', () => {
    const fixture2 = specDoc(['IFC4'], 'IfcWallStandardCase');
    const r = checkOps([{ kind: 'bulk.retargetEntity', opId: ids(), payload: { from: 'IfcWallStandardCase', to: 'IfcWallz' } }], fixture2.doc, ctx);
    expect(r.issues.map((i) => [i.code, i.path])).toEqual([['GATE-ENT-001', 'ops[0].expanded[0].payload.value']]);
  });
});
