/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Matching accuracy on corpus mutations (backlog acceptance: ≥ 98%).
 *
 * Ground truth comes from the reducer: a mutated revision is produced by
 * applying random edit ops to the previous document, and ops keep node
 * ids, so the mutated document KNOWS which node continues which. Its ids
 * are then stripped (as if it arrived as plain XML from a client) and the
 * matcher has to recover them.
 *
 * Excluded edits, whose "truth" is a modelling choice rather than a fact:
 * `facet.replace` (a different facet under the same id) and moves of a
 * facet into another specification or section.
 */

import { describe, expect, it } from 'vitest';
import type { IDSDocument } from '@ifc-lite/ids';
import { counterIds, loadCorpus } from '../../test/corpus.js';
import { randomOp, seeded } from '../../test/op-gen.js';
import { fromIdsDocument } from '../document/from-ids.js';
import { locateFacet, verifyNodeIndex } from '../document/node-index.js';
import type { StudioDocument } from '../document/types.js';
import { apply } from '../reducer/apply.js';
import { createSidecar, attachSidecar } from '../sidecar/sidecar.js';
import { reidentify } from './reidentify.js';

function strip(ids: IDSDocument): IDSDocument {
  return {
    ...ids,
    specifications: ids.specifications.map((s, i) => ({ ...s, id: `spec-${i}`, requirements: s.requirements.map((r, j) => ({ ...r, id: `req-${j}` })) })),
  };
}

function allIds(doc: StudioDocument): { spec: string; facets: string[] }[] {
  return doc.nodes.specs.map((s) => ({ spec: s.id, facets: [...s.applicability, ...s.requirements].map((f) => f.id) }));
}

describe('reidentify', () => {
  const corpus = loadCorpus();

  it('recovers ids on unchanged and reordered documents exactly', () => {
    const merged: IDSDocument = { info: { title: 'm' }, specifications: corpus.slice(0, 12).flatMap((c) => c.ids.specifications) };
    const prev = fromIdsDocument(merged);
    const same = reidentify(prev, strip(prev.ids));
    expect(allIds(same.doc)).toEqual(allIds(prev));
    expect(verifyNodeIndex(same.doc)).toEqual([]);
    const reversed = { ...prev.ids, specifications: [...prev.ids.specifications].reverse() };
    const r = reidentify(prev, strip(reversed));
    expect(allIds(r.doc)).toEqual([...allIds(prev)].reverse());
    expect(r.report.specs.added).toEqual([]);
  });

  it('matches ≥ 98% of surviving nodes across 300 mutated corpus revisions', () => {
    let total = 0;
    let correct = 0;
    let stolen = 0;
    for (let seq = 0; seq < 300; seq++) {
      const rng = seeded(0xa11 + seq);
      const newId = counterIds(0x900 + seq);
      const merged: IDSDocument = {
        info: { title: 'rev A' },
        specifications: [0, 1, 2, 3, 4].flatMap((k) => corpus[(seq * 7 + k * 53) % corpus.length].ids.specifications),
      };
      const prev = fromIdsDocument(merged, { newId });
      let next = prev;
      for (let n = 0, tries = 0; n < 4 && tries < 40; tries++) {
        const op = randomOp(rng, next, newId);
        if (!op || op.kind === 'facet.replace' || op.kind.startsWith('meta.') || op.kind === 'spec.duplicate') continue;
        if (op.kind === 'facet.move') {
          const loc = locateFacet(next, op.payload.facetId);
          if (!loc || (op.payload.toSpecId ?? loc.specId) !== loc.specId || (op.payload.toSection ?? loc.section) !== loc.section) continue;
        }
        next = apply(next, [op]).doc;
        n++;
      }
      const prevIds = new Set(allIds(prev).flatMap((s) => [s.spec, ...s.facets]));
      const { doc } = reidentify(prev, strip(next.ids), { newId: counterIds(0xf00 + seq) });
      const truth = allIds(next);
      const got = allIds(doc);
      truth.forEach((t, i) => {
        const pairs: [string, string][] = [[t.spec, got[i].spec], ...t.facets.map((f, j): [string, string] => [f, got[i].facets[j]])];
        for (const [want, have] of pairs) {
          if (prevIds.has(want)) {
            total++;
            if (want === have) correct++;
          } else if (prevIds.has(have)) {
            stolen++; // a new node took the id of an old one
          }
        }
      });
    }
    const accuracy = correct / total;
    expect(total).toBeGreaterThan(3000);
    expect(accuracy).toBeGreaterThanOrEqual(0.98);
    expect(stolen / total).toBeLessThan(0.02);
  }, 120_000);

  it('keeps comments attached when a revised XML arrives without a matching sidecar', () => {
    const { ids } = corpus.find((c) => c.ids.specifications.length > 0)!;
    const prev = fromIdsDocument(ids);
    const specId = prev.nodes.specs[0].id;
    prev.meta.comments[specId] = [{ id: specId, resolved: false, comments: [{ author: 'x@example.com', at: '2026-10-08', text: 'keep me' }] }];
    const sidecar = createSidecar(prev);
    const revised = strip({ ...prev.ids, specifications: prev.ids.specifications.map((s) => ({ ...s, description: 'rev B' })) });
    const result = attachSidecar(revised, sidecar, { previous: prev });
    expect(result.binding).toBe('reidentified');
    expect(result.doc.nodes.specs[0].id).toBe(specId);
    expect(result.doc.meta.comments[specId]).toBeDefined();
  });
});
