/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IDSSpecification } from '@ifc-lite/ids';
import { describe, expect, it } from 'vitest';
import { counterIds, loadCorpus } from '../../test/corpus.js';
import { randomOp, seeded } from '../../test/op-gen.js';
import { createStudioDocument, fromIdsDocument } from '../document/from-ids.js';
import { locateNode, verifyNodeIndex } from '../document/node-index.js';
import type { StudioDocument } from '../document/types.js';
import { OP_KINDS, validateOp } from '../ops/schema.js';
import type { PrimitiveOp, StudioOp } from '../ops/types.js';
import { apply, OpApplyError } from './apply.js';

const ids = counterIds(0xabc);
const op = <K extends PrimitiveOp['kind']>(kind: K, payload: Extract<PrimitiveOp, { kind: K }>['payload']): StudioOp =>
  ({ kind, opId: ids(), payload }) as StudioOp;

describe('apply: primitive ops', () => {
  it('builds a specification from ops and stamps node ids', () => {
    const doc = createStudioDocument({ title: 'T', newId: ids });
    const specId = ids();
    const facetId = ids();
    const reqId = ids();
    const r = apply(doc, [
      op('spec.add', { specId, name: 'Walls', ifcVersions: ['IFC4'] }),
      op('facet.add', { specId, section: 'applicability', facetId, facet: { type: 'entity', name: { kind: 'equals', value: 'IfcWall' } } }),
      op('facet.add', {
        specId,
        section: 'requirements',
        facetId: reqId,
        facet: { type: 'property', propertySet: { kind: 'equals', value: 'Pset_WallCommon' }, baseName: { kind: 'equals', value: 'FireRating' } },
        optionality: 'optional',
      }),
    ]);
    expect(r.doc.ids.specifications).toEqual([
      {
        id: specId,
        name: 'Walls',
        ifcVersions: ['IFC4'],
        minOccurs: 1,
        applicability: { facets: [{ type: 'entity', name: { type: 'simpleValue', value: 'IFCWALL' } }] },
        requirements: [
          {
            id: reqId,
            optionality: 'optional',
            facet: {
              type: 'property',
              propertySet: { type: 'simpleValue', value: 'Pset_WallCommon' },
              baseName: { type: 'simpleValue', value: 'FireRating' },
            },
          },
        ],
      },
    ]);
    expect(verifyNodeIndex(r.doc)).toEqual([]);
    expect([...r.touched]).toEqual(expect.arrayContaining([specId, facetId, reqId]));
    expect(locateNode(r.doc, reqId)).toMatchObject({ kind: 'requirement', facetIndex: 0 });
    // The input document is untouched (pure reducer).
    expect(doc.ids.specifications).toEqual([]);
  });

  it('shares untouched specifications structurally', () => {
    const doc = fromIdsDocument(loadCorpus().find((c) => c.ids.specifications.length > 1)?.ids ?? loadCorpus()[0].ids);
    const first = doc.ids.specifications[0];
    const last = doc.ids.specifications[doc.ids.specifications.length - 1];
    const r = apply(doc, [op('spec.set', { specId: first.id, field: 'description', value: 'changed' })]);
    expect(r.doc.ids.specifications[0]).not.toBe(first);
    if (last !== first) expect(r.doc.ids.specifications[r.doc.ids.specifications.length - 1]).toBe(last);
  });

  it('throws without partial effects when an op does not apply', () => {
    const doc = createStudioDocument({ newId: ids });
    expect(() => apply(doc, [op('spec.remove', { specId: ids() })])).toThrow(OpApplyError);
    const specId = ids();
    expect(() =>
      apply(doc, [op('spec.add', { specId, name: 'x', ifcVersions: ['IFC4'] }), op('spec.add', { specId, name: 'dup', ifcVersions: ['IFC4'] })]),
    ).toThrow(/already exists/);
    expect(doc.ids.specifications).toEqual([]);
  });

  it('restores removed partOf entity fields with their original ids on undo', () => {
    const doc = createStudioDocument({ newId: ids });
    const specId = ids();
    const facetId = ids();
    const built = apply(doc, [
      op('spec.add', { specId, name: 's', ifcVersions: ['IFC4'] }),
      op('facet.add', {
        specId,
        section: 'requirements',
        facetId,
        facet: { type: 'partOf', relation: 'IfcRelAggregates', entity: { name: { kind: 'equals', value: 'IfcBuildingStorey' }, predefinedType: { kind: 'equals', value: 'X' } } },
      }),
    ]).doc;
    const cleared = apply(built, [op('facet.setField', { facetId, field: 'partOf.entity.name', value: null })]);
    expect(cleared.doc.ids.specifications[0].requirements[0].facet).toEqual({ type: 'partOf', relation: 'IfcRelAggregates' });
    expect(cleared.inverses.map((i) => i.kind)).toEqual(['facet.setField', 'facet.setField']);
    expect(apply(cleared.doc, cleared.inverses).doc).toEqual(built);
  });
});

/** Non-canonical raw attributes an import may leave behind; undo must keep them. */
function withImportLeftovers(spec: IDSSpecification): IDSSpecification {
  return {
    ...spec,
    ifcVersionRaw: 'ifc4  ',
    applicability: { ...spec.applicability, cardinality: 'Required' },
    requirements: spec.requirements.map((r) => ({
      ...r,
      cardinalityRaw: 'Required',
      facet: r.facet.type === 'partOf' ? { ...r.facet, rawRelation: 'IFCRELBOGUS' } : r.facet,
    })),
  };
}

describe('apply ∘ inverses = id (seeded property test)', () => {
  const corpus = loadCorpus();
  const SEQUENCES = 1500;

  it(`holds for ${SEQUENCES} random op sequences over corpus documents`, () => {
    let applied = 0;
    const kinds = new Set<string>();
    for (let seq = 0; seq < SEQUENCES; seq++) {
      const rng = seeded(0x5eed + seq);
      const newId = counterIds(seq + 1);
      const original: StudioDocument =
        seq % 10 === 0
          ? createStudioDocument({ title: 'empty', newId })
          : fromIdsDocument(
              {
                // Merge 1–3 corpus files so moves across specs are exercised.
                info: corpus[seq % corpus.length].ids.info,
                specifications: [0, 1, 2]
                  .slice(0, 1 + (seq % 3))
                  .flatMap((k) => corpus[(seq + k * 97) % corpus.length].ids.specifications)
                  .map((spec) => (seq % 4 === 1 ? withImportLeftovers(spec) : spec)),
              },
              { newId },
            );
      const length = 1 + Math.floor(rng() * 15);
      const ops: StudioOp[] = [];
      let doc = original;
      for (let attempts = 0; ops.length < length && attempts < length * 6; attempts++) {
        const next = randomOp(rng, doc, newId);
        if (!next) continue;
        const valid = validateOp(next);
        expect(valid.ok ? [] : valid.errors, `seq ${seq} ${next.kind}`).toEqual([]);
        doc = apply(doc, [next]).doc;
        expect(verifyNodeIndex(doc), `seq ${seq} after ${next.kind}`).toEqual([]);
        ops.push(next);
      }
      const result = apply(original, ops);
      expect(result.doc, `seq ${seq}`).toEqual(doc);
      for (const o of [...ops, ...result.inverses]) kinds.add(o.kind);
      for (const inverse of result.inverses) {
        const v = validateOp(inverse);
        expect(v.ok ? [] : v.errors, `seq ${seq} inverse ${inverse.kind}`).toEqual([]);
      }
      const undone = apply(result.doc, result.inverses).doc;
      expect(undone, `seq ${seq} undo`).toEqual(original);
      expect(verifyNodeIndex(undone)).toEqual([]);
      // Redo is deterministic: replaying the same ops yields the same doc.
      expect(apply(undone, ops).doc, `seq ${seq} redo`).toEqual(result.doc);
      applied += ops.length;
    }
    expect(applied).toBeGreaterThan(SEQUENCES * 4);
    // Every primitive kind (fidelity ops via inverses) was exercised.
    expect([...kinds].sort()).toEqual(OP_KINDS.filter((k) => !k.startsWith('bulk.')).sort());
  });
});
