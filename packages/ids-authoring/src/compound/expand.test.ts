/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { counterIds } from '../../test/corpus.js';
import { createStudioDocument } from '../document/from-ids.js';
import { verifyNodeIndex } from '../document/node-index.js';
import type { StudioDocument } from '../document/types.js';
import type { OpTemplate, StudioOp } from '../ops/types.js';
import { apply, OpApplyError } from '../reducer/apply.js';

const ids = counterIds(0xc0);
const eq = (value: string) => ({ kind: 'equals' as const, value });

function fixture(): { doc: StudioDocument; specs: string[]; facets: Record<string, string> } {
  const doc = createStudioDocument({ newId: ids });
  const specs = [ids(), ids()];
  const facets = { e0: ids(), p0: ids(), e1: ids(), p1: ids(), part: ids(), enumEntity: ids() };
  const ops: StudioOp[] = [
    { kind: 'spec.add', opId: ids(), payload: { specId: specs[0], name: 'A', ifcVersions: ['IFC2X3'] } },
    { kind: 'spec.add', opId: ids(), payload: { specId: specs[1], name: 'B', ifcVersions: ['IFC2X3'] } },
    { kind: 'facet.add', opId: ids(), payload: { specId: specs[0], section: 'applicability', facetId: facets.e0, facet: { type: 'entity', name: eq('IfcWallStandardCase') } } },
    { kind: 'facet.add', opId: ids(), payload: { specId: specs[0], section: 'requirements', facetId: facets.p0, facet: { type: 'property', propertySet: eq('Pset_WallCommon'), baseName: eq('Fire') } } },
    { kind: 'facet.add', opId: ids(), payload: { specId: specs[1], section: 'applicability', facetId: facets.e1, facet: { type: 'entity', name: eq('IFCWALLSTANDARDCASE') } } },
    { kind: 'facet.add', opId: ids(), payload: { specId: specs[1], section: 'requirements', facetId: facets.p1, facet: { type: 'property', propertySet: eq('Pset_WallCommon'), baseName: eq('Fire') } } },
    { kind: 'facet.add', opId: ids(), payload: { specId: specs[1], section: 'requirements', facetId: facets.part, facet: { type: 'partOf', relation: 'IfcRelAggregates', entity: { name: eq('IfcWallStandardCase') } } } },
    { kind: 'facet.add', opId: ids(), payload: { specId: specs[1], section: 'applicability', facetId: facets.enumEntity, facet: { type: 'entity', name: { kind: 'oneOf', values: ['IfcWallStandardCase', 'IfcWall'] } } } },
  ];
  return { doc: apply(doc, ops).doc, specs, facets };
}

describe('bulk.renameProperty', () => {
  it('renames literal property references in scope and undoes in one step', () => {
    const { doc, specs } = fixture();
    const op: StudioOp = {
      kind: 'bulk.renameProperty',
      opId: ids(),
      payload: { fromPset: 'Pset_WallCommon', fromName: 'Fire', toPset: 'Pset_WallCommon', toName: 'FireRating', scope: [specs[1]] },
    };
    const r = apply(doc, [op]);
    expect(r.expanded.map((o) => o.kind)).toEqual(['facet.setField']);
    const baseNames = r.doc.ids.specifications.map((s) => s.requirements[0].facet).map((f) => (f.type === 'property' ? f.baseName : undefined));
    expect(baseNames).toEqual([
      { type: 'simpleValue', value: 'Fire' },
      { type: 'simpleValue', value: 'FireRating' },
    ]);
    expect(apply(r.doc, r.inverses).doc).toEqual(doc);
  });
});

describe('bulk.retargetEntity', () => {
  it('retargets literal, enumerated and partOf entity names case-insensitively', () => {
    const { doc, facets } = fixture();
    const r = apply(doc, [{ kind: 'bulk.retargetEntity', opId: ids(), payload: { from: 'IfcWallStandardCase', to: 'IfcWall' } }]);
    expect(r.expanded).toHaveLength(4);
    const [a, b] = r.doc.ids.specifications;
    expect(a.applicability.facets[0]).toEqual({ type: 'entity', name: { type: 'simpleValue', value: 'IFCWALL' } });
    expect(b.applicability.facets[0]).toEqual({ type: 'entity', name: { type: 'simpleValue', value: 'IFCWALL' } });
    // Stored upper-case, the enumeration collapses its duplicate after the rename.
    expect(b.applicability.facets[1]).toEqual({ type: 'entity', name: { type: 'enumeration', values: ['IFCWALL'] } });
    expect(b.requirements[1].facet).toMatchObject({ entity: { name: { type: 'simpleValue', value: 'IFCWALL' } } });
    expect(r.touched.has(facets.part)).toBe(true);
    expect(apply(r.doc, r.inverses).doc).toEqual(doc);
  });
});

describe('bulk.applyTemplate', () => {
  const template: OpTemplate = {
    id: 'fire-rating',
    params: [{ name: 'entity' }, { name: 'pset' }, { name: 'versions', default: 'IFC4' }],
    ops: [
      { kind: 'spec.add', payload: { specId: '{{id:spec}}', name: '{{entity}} fire rating', ifcVersions: ['IFC4'] } },
      { kind: 'facet.add', payload: { specId: '{{id:spec}}', section: 'applicability', facetId: '{{id:app}}', facet: { type: 'entity', name: { kind: 'equals', value: '{{entity}}' } } } },
      {
        kind: 'facet.add',
        payload: {
          specId: '{{id:spec}}',
          section: 'requirements',
          facetId: '{{id:req}}',
          facet: { type: 'property', propertySet: { kind: 'equals', value: '{{pset}}' }, baseName: { kind: 'equals', value: 'FireRating' } },
        },
      },
    ],
  };

  it('expands parameters and template-local ids deterministically; one-step undo', () => {
    const doc = createStudioDocument({ newId: ids });
    const op: StudioOp = { kind: 'bulk.applyTemplate', opId: ids(), payload: { template, params: { entity: 'IfcDoor', pset: 'Pset_DoorCommon' } } };
    const r = apply(doc, [op]);
    expect(r.expanded.map((o) => o.kind)).toEqual(['spec.add', 'facet.add', 'facet.add']);
    const spec = r.doc.ids.specifications[0];
    expect(spec.name).toBe('IfcDoor fire rating');
    expect(spec.applicability.facets[0]).toEqual({ type: 'entity', name: { type: 'simpleValue', value: 'IFCDOOR' } });
    expect(spec.requirements[0].facet).toMatchObject({ propertySet: { value: 'Pset_DoorCommon' } });
    expect(verifyNodeIndex(r.doc)).toEqual([]);
    expect(apply(doc, [op]).doc).toEqual(r.doc);
    expect(apply(r.doc, r.inverses).doc).toEqual(doc);
  });

  it('refuses unknown or missing parameters and malformed template ops', () => {
    const doc = createStudioDocument({ newId: ids });
    const run = (params: Record<string, string>, t: OpTemplate = template) =>
      apply(doc, [{ kind: 'bulk.applyTemplate', opId: ids(), payload: { template: t, params } }]);
    expect(() => run({ entity: 'IfcDoor' })).toThrow(/needs parameter "pset"/);
    expect(() => run({ entity: 'IfcDoor', pset: 'X', colour: 'red' })).toThrow(/no parameter "colour"/);
    const broken: OpTemplate = { id: 'broken', params: [], ops: [{ kind: 'spec.add', payload: { name: 'x' } }] };
    expect(() => run({}, broken)).toThrow(OpApplyError);
    expect(() => run({}, broken)).toThrow(/\$\.payload\.\w+: is required/);
  });
});
