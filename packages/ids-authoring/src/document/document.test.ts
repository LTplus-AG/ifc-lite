/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { counterIds, loadCorpus } from '../../test/corpus.js';
import { isUuid } from '../uuid.js';
import { presentFields } from './fields.js';
import { createStudioDocument, fromIdsDocument } from './from-ids.js';
import { allNodeIds, locateFacet, locateNode, verifyNodeIndex } from './node-index.js';

describe('fromIdsDocument over the conformance corpus', () => {
  const corpus = loadCorpus();

  it('gives every node exactly one UUID (invariant 3)', () => {
    for (const { name, ids } of corpus) {
      const doc = fromIdsDocument(ids);
      expect(verifyNodeIndex(doc), name).toEqual([]);
      let expected = 1; // document
      for (const spec of doc.ids.specifications) {
        expected += 1;
        for (const f of spec.applicability.facets) expected += 1 + presentFields(f).length;
        for (const r of spec.requirements) expected += 1 + presentFields(r.facet).length;
      }
      const ids2 = allNodeIds(doc);
      expect(ids2.length, name).toBe(expected);
      expect(new Set(ids2).size, name).toBe(expected);
      expect(ids2.every(isUuid), name).toBe(true);
    }
  });

  it('does not mutate the parsed input and keeps the content otherwise identical', () => {
    const { ids } = corpus[0];
    const snapshot = structuredClone(ids);
    const doc = fromIdsDocument(ids);
    expect(ids).toEqual(snapshot);
    const stripIds = (d: typeof ids) =>
      d.specifications.map((s) => ({ ...s, id: '', requirements: s.requirements.map((r) => ({ ...r, id: '' })) }));
    expect(stripIds(doc.ids)).toEqual(stripIds(ids));
  });

  it('stamps spec and requirement ids with their node UUIDs and locates every node', () => {
    const withReqs = corpus.find((c) => c.ids.specifications.some((s) => s.requirements.length > 0));
    expect(withReqs).toBeDefined();
    const doc = fromIdsDocument(withReqs!.ids, { newId: counterIds() });
    doc.ids.specifications.forEach((spec, i) => {
      expect(locateNode(doc, spec.id)).toEqual({ kind: 'spec', specIndex: i, specId: spec.id });
      spec.requirements.forEach((req, j) => {
        expect(locateFacet(doc, req.id)).toEqual({ specIndex: i, specId: spec.id, section: 'requirements', facetIndex: j });
      });
      doc.nodes.specs[i].applicability.forEach((fn, j) => {
        const loc = locateNode(doc, fn.id);
        expect(loc).toMatchObject({ kind: 'applicabilityFacet', facetIndex: j });
        for (const [field, cid] of Object.entries(fn.constraints)) {
          expect(locateNode(doc, cid!)).toMatchObject({ kind: 'constraint', facetId: fn.id, field });
        }
      });
    });
  });
});

describe('createStudioDocument', () => {
  it('creates an empty, valid document', () => {
    const doc = createStudioDocument({ title: 'Untitled' });
    expect(doc.ids.specifications).toEqual([]);
    expect(doc.ids.info.title).toBe('Untitled');
    expect(verifyNodeIndex(doc)).toEqual([]);
    expect(doc.schemaVersion).toBe(1);
  });
});
