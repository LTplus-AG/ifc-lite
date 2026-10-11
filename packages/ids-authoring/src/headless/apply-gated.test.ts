/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `applyOpsGated` and the schema lookups behind the MCP authoring tools
 * (IDS-118). The hard rule: a batch with one hallucinated name changes
 * nothing, and the caller gets the gate's reason and candidates back.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createGateContext, type GateContext } from '../gate/context.js';
import { createStudioDocument } from '../document/from-ids.js';
import type { StudioOp } from '../ops/types.js';
import { apply } from '../reducer/apply.js';
import { applyOpsGated } from './apply-gated.js';
import { describeEntity, describePset, searchSchema } from './schema-lookup.js';

let ctx: GateContext;
beforeAll(async () => {
  ctx = await createGateContext();
});

const SPEC = '00000000-0000-7000-8000-000000000001';
const APPLIES = '00000000-0000-7000-8000-000000000002';
const REQUIRES = '00000000-0000-7000-8000-000000000003';

function doorOps(property: string): StudioOp[] {
  return [
    { kind: 'spec.add', opId: '00000000-0000-7000-8000-0000000000a1', payload: { specId: SPEC, name: 'Doors', ifcVersions: ['IFC4'] } },
    {
      kind: 'facet.add',
      opId: '00000000-0000-7000-8000-0000000000a2',
      payload: { specId: SPEC, section: 'applicability', facetId: APPLIES, facet: { type: 'entity', name: { kind: 'equals', value: 'IfcDoor' } } },
    },
    {
      kind: 'facet.add',
      opId: '00000000-0000-7000-8000-0000000000a3',
      payload: {
        specId: SPEC,
        section: 'requirements',
        facetId: REQUIRES,
        facet: { type: 'property', propertySet: { kind: 'equals', value: 'Pset_DoorCommon' }, baseName: { kind: 'equals', value: property } },
      },
    },
  ];
}

describe('applyOpsGated', () => {
  it('applies a grounded batch and returns its inverses', () => {
    const doc = createStudioDocument({ title: 't' });
    const out = applyOpsGated(doc, doorOps('FireRating'), ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.doc.ids.specifications).toHaveLength(1);
    expect(out.doc.ids.specifications[0].requirements[0].facet).toMatchObject({ baseName: { type: 'simpleValue', value: 'FireRating' } });
    expect(out.touched).toContain(REQUIRES);
    // The inverses undo the whole batch.
    expect(apply(out.doc, out.inverses).doc).toEqual(doc);
  });

  it('refuses a batch with a hallucinated property, changes nothing, and says why', () => {
    const doc = createStudioDocument({ title: 't' });
    const out = applyOpsGated(doc, doorOps('FireRatingClass'), ctx);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.doc).toBe(doc);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0]).toMatchObject({ code: 'GATE-PROP-001', opIndex: 2, path: 'ops[2].payload.facet.baseName', value: 'FireRatingClass' });
    expect(out.issues[0].candidates[0].value).toBe('FireRating');
  });

  it('refuses a hallucinated entity', () => {
    const ops = doorOps('FireRating');
    ops[1] = { ...ops[1], payload: { ...(ops[1].payload as object), facet: { type: 'entity', name: { kind: 'equals', value: 'IfcFireDoor' } } } } as StudioOp;
    const out = applyOpsGated(createStudioDocument(), ops, ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.issues[0]).toMatchObject({ code: 'GATE-ENT-001', value: 'IFCFIREDOOR' });
  });

  it('refuses malformed input through validateOp', () => {
    const out = applyOpsGated(createStudioDocument(), [{ kind: 'spec.explode', opId: 'x', payload: {} }], ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.issues[0].code).toBe('GATE-OP-001');
    const notArray = applyOpsGated(createStudioDocument(), { kind: 'spec.add' }, ctx);
    expect(notArray).toMatchObject({ ok: false, issues: [{ code: 'GATE-OP-001', path: 'ops' }] });
  });
});

describe('schema lookups', () => {
  it('finds the property an agent misspelt, with the sets that define it', () => {
    const hits = searchSchema(ctx, 'FireRatng', { kind: 'property' });
    expect(hits[0]).toMatchObject({ kind: 'property', value: 'FireRating' });
    expect(hits[0].reason).toMatch(/^in Pset_/);
  });

  it('searches every kind when none is given, best first', () => {
    const hits = searchSchema(ctx, 'IfcDoor', { limit: 3 });
    expect(hits[0]).toMatchObject({ kind: 'entity', value: 'IfcDoor', score: 1 });
    expect(hits).toHaveLength(3);
  });

  it('describes an entity with its supertypes and applicable sets', () => {
    const door = describeEntity(ctx, 'IFCDOOR', 'IFC4');
    expect(door).toMatchObject({ name: 'IfcDoor', abstract: false });
    expect(door?.ancestors).toContain('IfcBuildingElement');
    expect(door?.predefinedTypes).toContain('DOOR');
    expect(door?.propertySets).toContain('Pset_DoorCommon');
    expect(describeEntity(ctx, 'IfcFireDoor')).toBeUndefined();
  });

  it('describes a property set', () => {
    const pset = describePset(ctx, 'Pset_DoorCommon', 'IFC4');
    expect(pset?.applicableEntities).toContain('IfcDoor');
    expect(pset?.properties.map((p) => p.name)).toContain('FireRating');
    expect(describePset(ctx, 'Pset_DoorCommonn')).toBeUndefined();
  });
});
