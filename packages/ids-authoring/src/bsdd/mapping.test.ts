/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The bSDD property → requirement mapping table, per bSDD data type (IDS-071). */

import type { IFCVersion } from '@ifc-lite/ids';
import { beforeAll, describe, expect, it } from 'vitest';
import { demoClass, demoProp, demoSource } from '../../test/bsdd/replay.js';
import { ids, specDoc } from '../../test/gate-helpers.js';
import { checkOps } from '../gate/check.js';
import { createGateContext, type GateContext } from '../gate/context.js';
import type { BsddClassSnapshot, BsddPropertySnapshot } from '../ops/types.js';
import { apply } from '../reducer/apply.js';
import { bsddInsertOp, snapshotBsddClass } from './insert.js';
import { BSDD_DATA_TYPES, BsddMappingError, DIMENSION_MEASURES, mapBsddDataType, mapBsddProperty, UNIT_MEASURES } from './mapping.js';

let gate: GateContext;
let door: BsddClassSnapshot;
let wallExt: BsddClassSnapshot;
beforeAll(async () => {
  gate = await createGateContext();
  const src = demoSource();
  const get = async (code: string) => {
    const cls = await src.getClass(demoClass(code));
    if (!cls) throw new Error(`fixture ${code} missing`);
    return snapshotBsddClass(cls, { dictionaryName: 'Demo Elements', gate });
  };
  door = await get('DOR');
  wallExt = await get('WAL-EXT');
});

const p = (code: string, extra: Partial<BsddPropertySnapshot> = {}): BsddPropertySnapshot => ({ code, propertySet: 'Demo_Set', ...extra });
const ALL: IFCVersion[] = ['IFC2X3', 'IFC4', 'IFC4X3_ADD2'];

describe('data types', () => {
  it.each([
    ['Boolean', 'IFCBOOLEAN'],
    ['Character', 'IFCLABEL'],
    ['String', 'IFCLABEL'],
    ['Integer', 'IFCINTEGER'],
    ['Real', 'IFCREAL'],
    ['Time', 'IFCDATETIME'],
    ['real', 'IFCREAL'],
  ])('bSDD %s → %s', (bsdd, ifc) => {
    const m = mapBsddProperty(p('X', { dataType: bsdd }));
    expect(m.dataType).toBe(ifc);
    expect(m.facet.dataType).toEqual({ kind: 'equals', value: ifc });
  });

  it('every IFC type in the table exists in the schema tables (Time only from IFC4)', () => {
    for (const rule of Object.values(BSDD_DATA_TYPES)) {
      for (const v of ALL) {
        if (rule.ifc === 'IFCDATETIME' && v === 'IFC2X3') continue; // IfcDateTime is IFC4+; the gate reports it on an IFC2X3 spec
        expect(gate.tables[v].dataTypes.has(rule.ifc), `${rule.ifc} in ${v}`).toBe(true);
      }
    }
    expect(gate.tables.IFC2X3.dataTypes.has('IFCDATETIME')).toBe(false);
    for (const measure of new Set([...Object.values(DIMENSION_MEASURES), ...Object.values(UNIT_MEASURES)])) {
      for (const v of ALL) expect(gate.tables[v].dataTypes.has(measure), `${measure} in ${v}`).toBe(true);
    }
  });

  it('refines Real to a measure by dimension first, then by unit', () => {
    expect(mapBsddDataType({ dataType: 'Real', dimension: '1 0 0 0 0 0 0' })).toBe('IFCLENGTHMEASURE');
    expect(mapBsddDataType({ dataType: 'Real', dimension: '0 1 -3 0 -1 0 0', units: ['m'] })).toBe('IFCTHERMALTRANSMITTANCEMEASURE');
    expect(mapBsddDataType({ dataType: 'Real', units: ['m²'] })).toBe('IFCAREAMEASURE');
    expect(mapBsddDataType({ dataType: 'Real', units: ['kg/m3'] })).toBe('IFCMASSDENSITYMEASURE');
    expect(mapBsddDataType({ dataType: 'Real', dimension: '0 0 0 0 0 0 0' })).toBe('IFCREAL');
    expect(mapBsddDataType({ dataType: 'Real', dimension: 'garbage', units: ['furlong'] })).toBe('IFCREAL');
    expect(mapBsddDataType({ dataType: 'Integer', units: ['m'] })).toBe('IFCINTEGER'); // only Real is measured
  });

  it('maps an unknown or missing data type to no dataType, with a note (lint IDSL-PROP-003 territory)', () => {
    const unknown = mapBsddProperty(p('X', { dataType: 'Rgb' }));
    expect(unknown.facet.dataType).toBeUndefined();
    expect(unknown.notes.map((n) => n.code)).toEqual(['unknown-data-type']);
    expect(mapBsddProperty(p('Y')).notes.map((n) => n.code)).toEqual(['no-data-type']);
  });

  it('keeps the EXPRESS data type of a standard property', () => {
    const isExternal = wallExt.properties?.find((x) => x.code === 'IsExternal');
    expect(isExternal?.standardDataType).toBe('IFCBOOLEAN');
    const m = mapBsddProperty({ ...p('FireRating', { dataType: 'Real' }), propertySet: 'Pset_WallCommon', standardDataType: 'IFCLABEL' });
    expect(m.dataType).toBe('IFCLABEL');
    expect(m.notes.map((n) => n.code)).toEqual(['standard-data-type']);
  });
});

describe('values', () => {
  it('allowed values → oneOf over the codes, with the base of the data type', () => {
    const m = mapBsddProperty(p('FireRating', { dataType: 'String', allowedValues: [{ code: 'EI30', value: 'EI 30' }, { code: 'EI60' }] }));
    expect(m.facet.value).toEqual({ kind: 'oneOf', values: ['EI30', 'EI60'], base: 'xs:string' });
    expect(mapBsddProperty(p('B', { dataType: 'Boolean', allowedValues: [{ code: 'true' }] })).facet.value).toBeUndefined();
    const both = mapBsddProperty(p('N', { dataType: 'Integer', allowedValues: [{ code: '1' }, { code: '2' }], minInclusive: 0 }));
    expect(both.facet.value).toEqual({ kind: 'oneOf', values: ['1', '2'], base: 'xs:integer' });
    expect(both.notes.map((n) => n.code)).toEqual(['values-over-range']);
  });

  it('bounds → range, in/exclusive kept, a non-SI unit converted to SI by the reducer', () => {
    const t = mapBsddProperty(p('Thickness', { dataType: 'Real', dimension: '1 0 0 0 0 0 0', units: ['mm'], minInclusive: 50, maxExclusive: 1000 }));
    expect(t.facet.value).toEqual({ kind: 'range', base: 'xs:double', min: 50, minInclusive: true, max: 1000, maxInclusive: false, unit: 'mm' });
    expect(t.notes[0]).toMatchObject({ code: 'unit-converted', message: 'Thickness: bounds converted to SI (50 mm → 0.05, 1000 mm → 1)' });
    const { doc, specId } = specDoc(['IFC4'], 'IfcWall');
    const after = apply(doc, [{ kind: 'facet.add', opId: ids(), payload: { specId, section: 'requirements', facetId: ids(), facet: t.facet } }]).doc;
    expect(after.ids.specifications[0].requirements[0].facet).toMatchObject({ value: { type: 'bounds', minInclusive: 0.05, maxExclusive: 1, base: 'xs:double' } });
    const si = mapBsddProperty(p('U', { dataType: 'Real', units: ['W/(m2·K)'], maxInclusive: 0.3 }));
    expect(si.facet.value).toEqual({ kind: 'range', base: 'xs:double', max: 0.3, maxInclusive: true });
    expect(si.notes).toEqual([]);
    expect(mapBsddProperty(p('Q', { dataType: 'Real', units: ['lux·h'], minInclusive: 1 })).notes.map((n) => n.code)).toEqual(['unit-unknown']);
  });

  it('pattern → pattern; bounds on a string are ignored', () => {
    expect(mapBsddProperty(p('Grade', { dataType: 'Character', pattern: '[A-C]' })).facet.value).toEqual({ kind: 'pattern', pattern: '[A-C]', base: 'xs:string' });
    expect(mapBsddProperty(p('S', { dataType: 'String', minInclusive: 3 })).facet.value).toBeUndefined();
  });

  it('a non-single value kind gets no restriction, only presence', () => {
    const m = mapBsddProperty(p('Accessories', { dataType: 'String', propertyValueKind: 'List', allowedValues: [{ code: 'a' }] }));
    expect(m.facet.value).toBeUndefined();
    expect(m.notes.map((n) => n.code)).toEqual(['value-not-mapped']);
  });
});

describe('set, name, uri, cardinality', () => {
  it('code → baseName; uri → @uri (unless switched off); isRequired → optionality, overridable', () => {
    const m = mapBsddProperty(p('FireExit', { name: 'Fire exit', dataType: 'Boolean', uri: demoProp('FireExit'), isRequired: true }));
    expect(m.facet).toMatchObject({ baseName: { kind: 'equals', value: 'FireExit' }, uri: demoProp('FireExit') });
    expect(m.optionality).toBe('required');
    expect(mapBsddProperty(p('X', { isRequired: false })).optionality).toBe('optional');
    expect(mapBsddProperty(p('X', { isRequired: false }), { optionality: 'required' }).optionality).toBe('required');
    expect(mapBsddProperty(p('X', { uri: demoProp('X') }), { uri: false }).facet.uri).toBeUndefined();
  });

  it('a property without a set needs the caller’s fallback set', () => {
    expect(() => mapBsddProperty({ code: 'Manufacturer' })).toThrow(BsddMappingError);
    const m = mapBsddProperty({ code: 'Manufacturer', dataType: 'String' }, { fallbackPropertySet: 'Project_Common' });
    expect(m.propertySet).toBe('Project_Common');
    expect(m.notes.map((n) => n.code)).toEqual(['fallback-property-set']);
  });
});

describe('bulk.fromBsddClass with properties', () => {
  it('declares the custom sets, adds gated requirements, and undoes in one step', () => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcDoor');
    const op = bsddInsertOp({
      classes: [door],
      target: { specId },
      mode: 'none',
      properties: { select: ['FireExit', 'ClearWidth', 'LeafCount', 'Grade', 'Manufacturer', demoProp('InstallationDate')], fallbackPropertySet: 'Project_Door' },
      opId: ids(),
    });
    expect(checkOps([op], doc, gate)).toEqual({ ok: true, issues: [] });
    const result = apply(doc, [op]);
    expect(result.doc.meta.custom.psets).toEqual([
      {
        name: 'Demo_Door',
        properties: [
          { name: 'FireExit', dataType: 'IFCBOOLEAN' },
          { name: 'ClearWidth', dataType: 'IFCLENGTHMEASURE' },
          { name: 'LeafCount', dataType: 'IFCINTEGER' },
          { name: 'Grade', dataType: 'IFCLABEL' },
          { name: 'InstallationDate', dataType: 'IFCDATETIME' },
        ],
      },
      { name: 'Project_Door', properties: [{ name: 'Manufacturer', dataType: 'IFCLABEL' }] },
    ]);
    const reqs = result.doc.ids.specifications[0].requirements;
    expect(reqs.map((r) => [r.optionality, r.facet.type === 'property' ? r.facet.dataType : undefined])).toEqual([
      ['required', { type: 'simpleValue', value: 'IFCBOOLEAN' }],
      ['required', { type: 'simpleValue', value: 'IFCLENGTHMEASURE' }],
      ['optional', { type: 'simpleValue', value: 'IFCINTEGER' }],
      ['optional', { type: 'simpleValue', value: 'IFCLABEL' }],
      ['optional', { type: 'simpleValue', value: 'IFCLABEL' }],
      ['optional', { type: 'simpleValue', value: 'IFCDATETIME' }],
    ]);
    expect(reqs[1].facet).toMatchObject({ value: { type: 'bounds', minInclusive: 0.8 }, uri: demoProp('ClearWidth') });
    expect(apply(result.doc, result.inverses).doc).toEqual(doc);
  });

  it('extends a closed custom declaration instead of tripping GATE-CUST-003', () => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcDoor');
    const declared = apply(doc, [{ kind: 'meta.custom.declarePset', opId: ids(), payload: { decl: { name: 'Demo_Door', properties: [{ name: 'Existing' }] } } }]).doc;
    const op = bsddInsertOp({ classes: [door], target: { specId }, mode: 'none', properties: { select: ['FireExit'] }, opId: ids() });
    expect(checkOps([op], declared, gate).ok).toBe(true);
    expect(apply(declared, [op]).doc.meta.custom.psets[0].properties?.map((x) => x.name)).toEqual(['Existing', 'FireExit']);
  });

  it('refuses a property the class does not define, or one without a set and no fallback', () => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcDoor');
    const codes = (select: string[]) => checkOps([bsddInsertOp({ classes: [door], target: { specId }, mode: 'none', properties: { select } })], doc, gate).issues.map((i) => i.code);
    expect(codes(['Nope'])).toEqual(['GATE-OP-002']);
    expect(codes(['Manufacturer'])).toEqual(['GATE-OP-002']);
    // An IFC2X3 spec cannot take IFCDATETIME: the gate, not the table, says so.
    const old = specDoc(['IFC2X3'], 'IfcDoor');
    const r = checkOps([bsddInsertOp({ classes: [door], target: { specId: old.specId }, mode: 'none', properties: { select: ['InstallationDate'] } })], old.doc, gate);
    expect(r.issues.map((i) => i.code)).toEqual(['GATE-DT-001']);
  });
});
