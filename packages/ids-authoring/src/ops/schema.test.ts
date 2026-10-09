/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../../test/corpus.js';
import { fromIdsDocument } from '../document/from-ids.js';
import { getOpJsonSchema, OP_KINDS, validateAgainstDef, validateOp } from './schema.js';
import type { OpKind, StudioOp } from './types.js';

const S = '0190a000-0000-7000-8000-000000000001';
const F = '0190a000-0000-7000-8000-000000000002';
const O = '0190a000-0000-7000-8000-0000000000ff';

/** One well-formed example per kind; the Record type forces completeness. */
const EXAMPLES: Record<OpKind, StudioOp['payload']> = {
  'doc.setInfo': { field: 'author', value: 'someone@example.com' },
  'spec.add': { specId: S, name: 'Walls', ifcVersions: ['IFC4'], cardinality: 'required' },
  'spec.remove': { specId: S },
  'spec.duplicate': { specId: S, newSpecId: F, nameSuffix: ' (copy)' },
  'spec.move': { specId: S, toIndex: 0 },
  'spec.set': { specId: S, field: 'description', value: null },
  'spec.setCardinality': { specId: S, cardinality: 'optional' },
  'spec.setIfcVersions': { specId: S, versions: ['IFC2X3', 'IFC4'] },
  'spec.restore': {
    index: 0,
    spec: { id: S, name: 'x', ifcVersions: ['IFC4'], applicability: { facets: [] }, requirements: [] },
    nodes: { id: S, applicability: [], requirements: [] },
  },
  'spec.patch': { specId: S, set: { minOccurs: null, maxOccurs: 'unbounded', ifcVersionRaw: null } },
  'facet.add': {
    specId: S,
    section: 'requirements',
    facetId: F,
    facet: { type: 'property', propertySet: { kind: 'equals', value: 'Pset_WallCommon' }, baseName: { kind: 'equals', value: 'FireRating' } },
    optionality: 'required',
  },
  'facet.remove': { facetId: F },
  'facet.move': { facetId: F, toSection: 'applicability', toIndex: 0 },
  'facet.replace': { facetId: F, facet: { type: 'material', value: { kind: 'pattern', pattern: 'Concrete.*' } } },
  'facet.setField': { facetId: F, field: 'property.value', value: { kind: 'range', min: 30, unit: 'min' } },
  'facet.setRelation': { facetId: F, relation: 'IfcRelAggregates' },
  'facet.restore': {
    specId: S,
    section: 'requirements',
    index: 0,
    facet: { type: 'entity', name: { type: 'simpleValue', value: 'IFCWALL' } },
    requirement: { optionality: 'required' },
    nodes: { id: F, constraints: { 'entity.name': O } },
  },
  'facet.patch': { facetId: F, set: { cardinalityRaw: null, optionality: 'optional' } },
  'requirement.setOptionality': { facetId: F, optionality: 'prohibited' },
  'requirement.set': { facetId: F, field: 'instructions', value: 'Fill it in' },
  'value.set': { facetId: F, field: 'attribute.value', value: { kind: 'all', of: [{ kind: 'length', max: 10 }, { kind: 'pattern', pattern: '[A-Z]+' }] } },
  'value.addEnumValue': { facetId: F, field: 'property.value', value: 'EI60' },
  'value.removeEnumValue': { facetId: F, field: 'property.value', value: 3 },
  'meta.custom.declarePset': { decl: { name: 'Acme_Wall', properties: [{ name: 'Code', dataType: 'IFCLABEL' }] } },
  'meta.custom.removePset': { name: 'Acme_Wall' },
  'meta.custom.declareUserDefinedType': { entity: 'IfcSlab', value: 'SLABRADOR' },
  'meta.custom.removeUserDefinedType': { entity: 'IfcSlab', value: 'SLABRADOR' },
  'meta.comment.add': { nodeId: S, threadId: F, author: 'Ana', at: '2026-10-08T09:00:00Z', text: 'Is EI60 enough here?' },
  'meta.comment.reply': { threadId: F, author: 'Ben', at: '2026-10-08T10:00:00Z', text: '@Ana yes, per the fire concept' },
  'meta.comment.removeReply': { threadId: F },
  'meta.comment.resolve': { threadId: F, resolved: true },
  'meta.comment.removeThread': { threadId: F },
  'meta.comment.restoreThread': { nodeId: S, index: 0, thread: { id: F, resolved: false, comments: [{ author: 'Ana', at: '2026-10-08', text: 'x' }] } },
  'meta.test.add': {
    specId: S,
    testCase: { id: F, name: 'Doors without fire rating fail', fixture: { kind: 'synthetic', recipe: { generator: 'ids-testgen/1', ifcVersion: 'IFC4', variant: { kind: 'fail', requirementId: O } } }, expect: 'fail', expectFailureOn: [O] },
    index: 0,
  },
  'meta.test.remove': { testId: F },
  'meta.test.restore': { specId: S, index: 0, testCase: { id: F, name: 'x', fixture: { kind: 'file', path: 'fixtures/x.ifc' }, expect: 'pass' } },
  'meta.test.setExpectation': { testId: F, expect: 'pass', expectFailureOn: null },
  'bulk.renameProperty': { fromPset: 'Pset_WallCommon', fromName: 'Fire', toPset: 'Pset_WallCommon', toName: 'FireRating' },
  'bulk.retargetEntity': { from: 'IfcWallStandardCase', to: 'IfcWall', scope: [S] },
  'bulk.applyTemplate': {
    template: {
      id: 'tpl',
      params: [{ name: 'entity' }],
      ops: [{ kind: 'spec.add', payload: { specId: '{{id:s}}', name: '{{entity}}', ifcVersions: ['IFC4'] } }],
    },
    params: { entity: 'IfcDoor' },
  },
};

describe('op schema v1', () => {
  it('lists exactly the kinds of the TypeScript vocabulary', () => {
    expect([...OP_KINDS].sort()).toEqual(Object.keys(EXAMPLES).sort());
  });

  it.each(OP_KINDS)('accepts a well-formed %s', (kind) => {
    const result = validateOp({ kind, opId: O, payload: EXAMPLES[kind] });
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it('names the offending path for malformed ops', () => {
    const bad = (v: unknown) => {
      const r = validateOp(v);
      return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
    };
    expect(bad({ kind: 'spec.explode', opId: O, payload: {} })[0]).toMatch(/^\$\.kind: expected one of/);
    expect(bad({ kind: 'spec.remove', opId: 'nope', payload: { specId: S } })).toEqual(['$.opId: must match ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$']);
    expect(bad({ kind: 'spec.remove', opId: O, payload: {} })).toEqual(['$.payload.specId: is required']);
    expect(bad({ kind: 'spec.remove', opId: O, payload: { specId: S, extra: 1 } })).toEqual(['$.payload.extra: is not allowed']);
    expect(bad({ kind: 'spec.add', opId: O, payload: { specId: S, name: 'x', ifcVersions: [] } })).toEqual([
      '$.payload.ifcVersions: must have at least 1 items',
    ]);
    expect(bad({ kind: 'facet.setField', opId: O, payload: { facetId: F, field: 'property.value', value: { kind: 'range', min: Infinity } } }).length).toBeGreaterThan(0);
    expect(bad({ kind: 'value.set', opId: O, payload: { facetId: F, field: 'property.colour', value: { kind: 'any' } } })[0]).toMatch(/^\$\.payload\.field/);
  });

  it('exports a self-contained JSON Schema whose every $ref resolves', () => {
    const schema = getOpJsonSchema();
    const json = JSON.parse(JSON.stringify(schema)) as { $defs: Record<string, unknown>; oneOf: unknown[] };
    expect(json.oneOf).toHaveLength(OP_KINDS.length);
    const refs = JSON.stringify(json).match(/"\$ref":"#\/\$defs\/[^"]+"/g) ?? [];
    expect(refs.length).toBeGreaterThan(50);
    for (const r of refs) {
      const name = r.slice('"$ref":"#/$defs/'.length, -1);
      expect(json.$defs[name], name).toBeDefined();
    }
  });

  it('describes every specification the parser produces (restore-op fidelity)', () => {
    for (const { name, ids } of loadCorpus()) {
      const doc = fromIdsDocument(ids);
      doc.ids.specifications.forEach((spec, i) => {
        expect(validateAgainstDef(spec, 'IDSSpecification'), name).toEqual([]);
        expect(validateAgainstDef(doc.nodes.specs[i], 'SpecNodes'), name).toEqual([]);
      });
    }
  });
});
