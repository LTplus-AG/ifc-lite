/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Semantic diff on corpus mutations (IDS-104).
 *
 * Oracle: the reducer. A revision is produced by applying random ops to a
 * corpus document, so the truth is known. The diff must (1) be empty
 * exactly when nothing changed, and (2) be COMPLETE: the ops `diffToOps`
 * builds from the diff entries alone must turn the old revision into the
 * new one, node ids included. A change the diff missed is a change the
 * patch cannot reproduce.
 */

import { describe, expect, it } from 'vitest';
import { counterIds, loadCorpus } from '../../test/corpus.js';
import { corpusDocument, mutate, shape } from '../../test/mutate.js';
import { seeded } from '../../test/op-gen.js';
import { fromIdsDocument } from '../document/from-ids.js';
import { verifyNodeIndex } from '../document/node-index.js';
import type { StudioDocument } from '../document/types.js';
import type { PrimitiveOp, StudioOp } from '../ops/types.js';
import { apply } from '../reducer/apply.js';
import { fingerprintIds } from '../sidecar/sidecar.js';
import { diffDocuments, diffToOps, type DiffEntry } from './index.js';

const ids = counterIds(0xd1f);
const op = <K extends PrimitiveOp['kind']>(kind: K, payload: Extract<PrimitiveOp, { kind: K }>['payload']): StudioOp =>
  ({ kind, opId: ids(), payload }) as StudioOp;

function withDeclarations(doc: StudioDocument): StudioDocument {
  return apply(doc, [
    op('meta.custom.declarePset', { decl: { name: 'Acme_A' } }),
    op('meta.custom.declarePset', { decl: { name: 'Acme_B', properties: [{ name: 'Code' }] } }),
    op('meta.custom.declareUserDefinedType', { entity: 'IfcWall', value: 'UDT_1' }),
  ]).doc;
}

function kinds(entries: DiffEntry[]): string[] {
  return entries.map((e) => e.kind);
}

describe('diffDocuments', () => {
  it('reports nothing for identical documents', () => {
    for (let seq = 0; seq < 40; seq++) {
      const doc = corpusDocument(seq);
      const diff = diffDocuments(doc, doc);
      expect(diff.identical).toBe(true);
      expect(diff.entries).toEqual([]);
      expect(diffToOps(doc, diff)).toEqual([]);
    }
  });

  it('is complete on 400 random corpus revisions: the patch rebuilds the new revision exactly', () => {
    let changed = 0;
    const seen = new Set<string>();
    for (let seq = 0; seq < 400; seq++) {
      const rng = seeded(0x5eed + seq);
      // Half the revisions start with custom declarations, so removals occur.
      const a = seq % 2 ? withDeclarations(corpusDocument(seq)) : corpusDocument(seq);
      const { doc: b, ops } = mutate(rng, a, 1 + (seq % 6), counterIds(0x800 + seq));
      const diff = diffDocuments(a, b);
      for (const k of kinds(diff.entries)) seen.add(k);
      if (!diff.identical) changed++;
      const patched = apply(a, diffToOps(a, diff)).doc;
      expect(verifyNodeIndex(patched)).toEqual([]);
      expect(shape(patched), `seq ${seq}: ${ops.map((o) => o.kind).join(', ')}`).toEqual(shape(b));
      // And the patched document has nothing left to diff.
      expect(diffDocuments(patched, b).entries).toEqual([]);
    }
    expect(changed).toBeGreaterThan(300);
    // Every entry kind a reducer edit can cause shows up at least once.
    expect([...seen].sort()).toEqual(
      [
        'custom.psetDeclared',
        'custom.psetRemoved',
        'custom.userDefinedTypeDeclared',
        'custom.userDefinedTypeRemoved',
        'facet.added',
        'facet.moved',
        'facet.relationChanged',
        'facet.removed',
        'facet.replaced',
        'facet.valueChanged',
        'info.changed',
        'requirement.changed',
        'spec.added',
        'spec.changed',
        'spec.moved',
        'spec.removed',
      ].sort(),
    );
  }, 120_000);

  it('diffs two unrelated files by content (no shared node ids)', () => {
    for (let seq = 0; seq < 120; seq++) {
      const rng = seeded(0xc0de + seq);
      const a = corpusDocument(seq);
      const { doc: edited } = mutate(rng, a, 1 + (seq % 4), counterIds(0x900 + seq));
      // As if `b` arrived as a separate file: fresh ids, another docId.
      const b = fromIdsDocument(edited.ids, { newId: counterIds(0xa00 + seq) });
      const diff = diffDocuments(a, b);
      const patched = apply(a, diffToOps(a, diff)).doc;
      expect(fingerprintIds(patched.ids), `seq ${seq}`).toBe(fingerprintIds(b.ids));
    }
  }, 60_000);

  it('names the edited node and field for single edits', () => {
    const a = corpusDocument(3);
    const spec = a.ids.specifications[1];
    const req = spec.requirements[0];
    const cases: [StudioOp, Partial<DiffEntry>][] = [
      [op('spec.set', { specId: spec.id, field: 'name', value: 'Renamed' }), { kind: 'spec.changed', specId: spec.id, field: 'name', old: spec.name, new: 'Renamed' }],
      [op('spec.set', { specId: spec.id, field: 'description', value: 'Why' }), { kind: 'spec.changed', specId: spec.id, field: 'description', new: 'Why' }],
      [op('spec.move', { specId: spec.id, toIndex: a.ids.specifications.length - 1 }), { kind: 'spec.moved', specId: spec.id, from: 1 }],
      [op('spec.remove', { specId: spec.id }), { kind: 'spec.removed', specId: spec.id, index: 1 }],
      [op('requirement.setOptionality', { facetId: req.id, optionality: req.optionality === 'optional' ? 'required' : 'optional' }), { kind: 'requirement.changed', facetId: req.id, field: 'optionality' }],
      [op('facet.remove', { facetId: req.id }), { kind: 'facet.removed', facetId: req.id, section: 'requirements' }],
      [op('doc.setInfo', { field: 'purpose', value: 'Handover' }), { kind: 'info.changed', field: 'purpose', new: 'Handover' }],
    ];
    for (const [edit, expected] of cases) {
      const b = apply(a, [edit]).doc;
      const { entries } = diffDocuments(a, b);
      expect(entries.filter((e) => e.kind === expected.kind), edit.kind).toEqual([expect.objectContaining(expected)]);
    }
  });

  it('reports one move when one specification moves to the top, not N', () => {
    const a = corpusDocument(9, 8);
    const last = a.ids.specifications[a.ids.specifications.length - 1];
    const b = apply(a, [op('spec.move', { specId: last.id, toIndex: 0 })]).doc;
    const diff = diffDocuments(a, b);
    expect(kinds(diff.entries)).toEqual(['spec.moved']);
    expect(diff.specs.map((s) => s.status)).toEqual(['moved', ...Array(7).fill('unchanged')]);
  });

  it('aligns the side-by-side outline (b order, removed rows kept)', () => {
    const a: StudioDocument = corpusDocument(11, 3);
    const [s0, s1] = a.ids.specifications;
    const b = apply(a, [op('spec.remove', { specId: s0.id }), op('spec.set', { specId: s1.id, field: 'description', value: 'new text' })]).doc;
    const { specs } = diffDocuments(a, b);
    expect(specs.map((s) => [s.a?.index, s.b?.index, s.status])).toEqual([
      [1, 0, 'changed'],
      [2, 1, 'unchanged'],
      [0, undefined, 'removed'],
    ]);
  });

  it('matches a re-ordered corpus without shared ids', () => {
    const corpus = loadCorpus();
    const a = fromIdsDocument({ info: { title: 'x' }, specifications: corpus.slice(0, 10).flatMap((c) => c.ids.specifications) });
    const b = fromIdsDocument({ ...a.ids, specifications: [...a.ids.specifications].reverse() });
    const diff = diffDocuments(a, b);
    expect(new Set(kinds(diff.entries))).toEqual(new Set(['spec.moved']));
    expect(diff.specs.every((s) => s.a && s.b)).toBe(true);
  });
});
