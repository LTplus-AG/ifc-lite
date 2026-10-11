/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Insert a bSDD class as classification and/or entity facets through `bulk.fromBsddClass` (IDS-070). */

import { beforeAll, describe, expect, it } from 'vitest';
import { demoClass, demoSource } from '../../test/bsdd/replay.js';
import { ids, specDoc } from '../../test/gate-helpers.js';
import { createStudioDocument } from '../document/from-ids.js';
import { checkOps } from '../gate/check.js';
import { createGateContext, type GateContext } from '../gate/context.js';
import { validateOp } from '../ops/schema.js';
import type { BsddClassSnapshot } from '../ops/types.js';
import { apply } from '../reducer/apply.js';
import { bsddInsertOp, entityChoices, snapshotBsddClass, splitRelatedEntity } from './insert.js';

let gate: GateContext;
const snap: Record<string, BsddClassSnapshot> = {};
beforeAll(async () => {
  gate = await createGateContext();
  const src = demoSource();
  for (const code of ['WAL', 'WAL-EXT', 'WAL-INT', 'SHD']) {
    const cls = await src.getClass(demoClass(code));
    if (!cls) throw new Error(`fixture ${code} missing`);
    snap[code] = snapshotBsddClass(cls, { dictionaryName: 'Demo Elements', gate });
  }
});

describe('related IFC entities', () => {
  it('splits bSDD’s entity+predefined-type names only when the schema confirms both', () => {
    expect(splitRelatedEntity('IfcWallSOLIDWALL', gate)).toEqual({ entity: 'IfcWall', predefinedType: 'SOLIDWALL' });
    expect(splitRelatedEntity('IFCDOOR', gate)).toEqual({ entity: 'IfcDoor' });
    expect(splitRelatedEntity('IfcWallBOGUS', gate)).toEqual({ entity: 'IfcWallBOGUS' });
    expect(splitRelatedEntity('IfcWallSOLIDWALL')).toEqual({ entity: 'IfcWallSOLIDWALL' }); // no tables: kept whole
    expect(snap['WAL-EXT'].relatedIfcEntities).toEqual([{ entity: 'IfcWall' }, { entity: 'IfcWall', predefinedType: 'SOLIDWALL' }]);
    expect(entityChoices(snap.SHD)).toEqual(['IfcShadingDevice', 'IfcWindow']);
  });
});

describe('bulk.fromBsddClass: classification and entity', () => {
  it('"applies to IfcWall classified as X": a new spec, gated, applied and undone in one step', () => {
    const doc = createStudioDocument({ newId: ids });
    const specId = ids();
    const op = bsddInsertOp({ classes: [snap['WAL-INT']], target: { newSpec: { specId, name: 'Internal walls', ifcVersions: ['IFC4'] } }, mode: 'both', opId: ids() });
    expect(validateOp(op).ok).toBe(true);
    expect(checkOps([op], doc, gate)).toEqual({ ok: true, issues: [] });
    const result = apply(doc, [op]);
    const spec = result.doc.ids.specifications[0];
    expect(spec.name).toBe('Internal walls');
    expect(spec.applicability.facets).toEqual([
      { type: 'entity', name: { type: 'simpleValue', value: 'IFCWALL' } },
      { type: 'classification', system: { type: 'simpleValue', value: 'Demo Elements' }, value: { type: 'simpleValue', value: 'WAL-INT' } },
    ]);
    expect(result.expanded.map((o) => o.kind)).toEqual(['spec.add', 'facet.add', 'facet.add']);
    expect(apply(result.doc, result.inverses).doc).toEqual(doc);
    // Deterministic: the same op expands to the same ids.
    expect(apply(doc, [op]).doc).toEqual(result.doc);
  });

  it('takes the predefined type when the class names exactly one', () => {
    const { doc, specId } = specDoc(['IFC4']);
    const only: BsddClassSnapshot = { ...snap['WAL-EXT'], relatedIfcEntities: [{ entity: 'IfcWall', predefinedType: 'SOLIDWALL' }] };
    const after = apply(doc, [bsddInsertOp({ classes: [only], target: { specId }, mode: 'entity', opId: ids() })]).doc;
    expect(after.ids.specifications[0].applicability.facets).toEqual([
      { type: 'entity', name: { type: 'simpleValue', value: 'IFCWALL' }, predefinedType: { type: 'simpleValue', value: 'SOLIDWALL' } },
    ]);
  });

  it('keeps the class URI on a classification requirement only (IDS 1.0 has no @uri in the applicability)', () => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcWall');
    const req = bsddInsertOp({ classes: [snap.WAL], target: { specId }, mode: 'classification', section: 'requirements', opId: ids() });
    expect(checkOps([req], doc, gate).ok).toBe(true);
    const facet = apply(doc, [req]).doc.ids.specifications[0].requirements[0].facet;
    expect(facet).toMatchObject({ type: 'classification', uri: demoClass('WAL') });
    const app = bsddInsertOp({ classes: [snap.WAL], target: { specId }, mode: 'classification', opId: ids() });
    expect('uri' in apply(doc, [app]).doc.ids.specifications[0].applicability.facets[1]).toBe(false);
  });

  it('several classes give one enumeration of codes; entities can be narrowed to the user’s choice', () => {
    const { doc, specId } = specDoc(['IFC4']);
    const op = bsddInsertOp({ classes: [snap['WAL-EXT'], snap['WAL-INT']], target: { specId }, mode: 'both', opId: ids() });
    const facets = apply(doc, [op]).doc.ids.specifications[0].applicability.facets;
    expect(facets[1]).toMatchObject({ value: { type: 'enumeration', values: ['WAL-EXT', 'WAL-INT'] } });
    const all = apply(doc, [bsddInsertOp({ classes: [snap.SHD], target: { specId }, mode: 'entity', opId: ids() })]).doc;
    expect(all.ids.specifications[0].applicability.facets[0]).toMatchObject({ name: { type: 'enumeration', values: ['IFCSHADINGDEVICE', 'IFCWINDOW'] } });
    const one = apply(doc, [bsddInsertOp({ classes: [snap.SHD], target: { specId }, mode: 'entity', entities: ['IfcWindow'], opId: ids() })]).doc;
    expect(one.ids.specifications[0].applicability.facets[0]).toEqual({ type: 'entity', name: { type: 'simpleValue', value: 'IFCWINDOW' } });
  });

  it('refuses through the gate: mixed dictionaries, no related entity, unknown entity, unknown spec', () => {
    const { doc, specId } = specDoc(['IFC4']);
    const other: BsddClassSnapshot = { ...snap.WAL, uri: 'https://identifier.example.org/uri/other/x/1/class/A', dictionaryUri: 'https://identifier.example.org/uri/other/x/1' };
    const codes = (op: unknown) => checkOps([op], doc, gate).issues.map((i) => i.code);
    expect(codes(bsddInsertOp({ classes: [snap.WAL, other], target: { specId }, mode: 'classification' }))).toEqual(['GATE-OP-002']);
    const bare: BsddClassSnapshot = { ...snap.WAL, relatedIfcEntities: [] };
    expect(codes(bsddInsertOp({ classes: [bare], target: { specId }, mode: 'entity' }))).toEqual(['GATE-OP-002']);
    const odd: BsddClassSnapshot = { ...snap.WAL, relatedIfcEntities: [{ entity: 'IfcWal' }] };
    const r = checkOps([bsddInsertOp({ classes: [odd], target: { specId }, mode: 'entity' })], doc, gate);
    expect(r.issues.map((i) => [i.code, i.path, i.candidates[0]?.value])).toEqual([['GATE-ENT-001', 'ops[0].expanded[0].payload.facet.name', 'IfcWall']]);
    expect(codes(bsddInsertOp({ classes: [snap.WAL], target: { specId: ids() }, mode: 'entity' }))).toEqual(['GATE-STR-001']);
  });
});
