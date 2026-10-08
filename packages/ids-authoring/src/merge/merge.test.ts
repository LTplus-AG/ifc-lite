/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Three-way merge (IDS-106).
 *
 * Oracles:
 * - identities: merge(base, x, base) = merge(base, base, x) = merge(base, x, x) = x;
 * - preservation: on random corpus revisions, every change unit (diff key)
 *   that only one side made is in the merged document with that side's
 *   value, and nothing else changed; units both sides made identically
 *   appear once;
 * - conflicts: overlapping changes are reported, keep the base until
 *   resolved, and take the chosen side once resolved.
 */

import { describe, expect, it } from 'vitest';
import { counterIds } from '../../test/corpus.js';
import { corpusDocument, mutate, shape } from '../../test/mutate.js';
import { seeded } from '../../test/op-gen.js';
import { diffDocuments } from '../diff/diff.js';
import type { DiffEntry } from '../diff/types.js';
import { verifyNodeIndex } from '../document/node-index.js';
import type { StudioDocument } from '../document/types.js';
import { createGateContext } from '../gate/context.js';
import { canonical } from '../match/cascade.js';
import type { PrimitiveOp, StudioOp } from '../ops/types.js';
import { apply } from '../reducer/apply.js';
import { scopeOf } from './keys.js';
import { mergeDocuments, mergeOps } from './merge.js';
import { conflictView, resolveConflict } from './view.js';

const ids = counterIds(0x3e9);
const op = <K extends PrimitiveOp['kind']>(kind: K, payload: Extract<PrimitiveOp, { kind: K }>['payload']): StudioOp =>
  ({ kind, opId: ids(), payload }) as StudioOp;

/** Change units of `doc` relative to `base`: key → what it sets (order keys excluded). */
function units(base: StudioDocument, doc: StudioDocument): Map<string, string> {
  const out = new Map<string, DiffEntry[]>();
  for (const e of diffDocuments(base, doc, { byNodeId: true }).entries) {
    const { key } = scopeOf(e);
    if (key.endsWith(':order')) continue;
    out.set(key, [...(out.get(key) ?? []), e]);
  }
  const strip = (e: DiffEntry) => {
    const { specName: _n, facet: _f, optionality: _o, index: _i, ...rest } = e as DiffEntry & Record<string, unknown>;
    // Positions are order, which is settled per list, not per change.
    if (e.kind === 'facet.moved') return { ...rest, from: { ...e.from, index: 0 }, to: { ...e.to, index: 0 } };
    // Where a facet lives is context: the other side may have moved it.
    if ('facetId' in e && e.kind !== 'facet.added') return { ...rest, specId: undefined, section: undefined };
    return rest;
  };
  return new Map([...out].map(([k, list]) => [k, canonical(list.map(strip))]));
}

describe('mergeDocuments', () => {
  it('satisfies the merge identities on corpus revisions', () => {
    for (let seq = 0; seq < 120; seq++) {
      const base = corpusDocument(seq);
      const { doc: x } = mutate(seeded(0x1d + seq), base, 1 + (seq % 5), counterIds(0xe00 + seq));
      for (const [o, t] of [[x, base], [base, x], [x, x]] as const) {
        const r = mergeDocuments(base, o, t);
        expect(r.conflicts, `seq ${seq}`).toEqual([]);
        expect(shape(r.doc), `seq ${seq}`).toEqual(shape(x));
        expect(r.doc.meta.comments, `seq ${seq} comments`).toEqual(x.meta.comments);
      }
    }
  }, 60_000);

  it('keeps every one-sided change and only those (300 concurrent corpus revisions)', () => {
    let clean = 0;
    let conflicted = 0;
    for (let seq = 0; seq < 300; seq++) {
      const base = corpusDocument(seq, 6);
      const { doc: ours } = mutate(seeded(0x0a + seq), base, 1 + (seq % 4), counterIds(0xf00 + seq));
      const { doc: theirs } = mutate(seeded(0x7b + seq * 3), base, 1 + ((seq + 2) % 4), counterIds(0x1f00 + seq));
      const r = mergeDocuments(base, ours, theirs);
      expect(verifyNodeIndex(r.doc)).toEqual([]);
      const uo = units(base, ours);
      const ut = units(base, theirs);
      const um = units(base, r.doc);
      const inConflict = new Set(r.conflicts.flatMap((c) => [...c.ours, ...c.theirs].map((e) => scopeOf(e).key)));
      if (r.conflicts.length) conflicted++;
      else clean++;
      // Every change of the merge comes from one side, outside conflicts.
      for (const [key, value] of um) {
        expect(inConflict.has(key), `seq ${seq} ${key}`).toBe(false);
        expect([uo.get(key), ut.get(key)], `seq ${seq} ${key}`).toContain(value);
      }
      // Every non-conflicting change of either side is in the merge.
      for (const side of [uo, ut]) {
        for (const [key, value] of side) {
          if (inConflict.has(key)) continue;
          expect(um.get(key), `seq ${seq} ${key}`).toBe(value);
        }
      }
    }
    expect(clean).toBeGreaterThan(150);
    expect(conflicted).toBeGreaterThan(5);
  }, 120_000);

  it('reports a field conflict, keeps the base until resolved, then applies the chosen side', () => {
    const base = corpusDocument(4, 3);
    const spec = base.ids.specifications[0];
    const ours = apply(base, [op('spec.set', { specId: spec.id, field: 'description', value: 'ours' })]).doc;
    const theirs = apply(base, [op('spec.set', { specId: spec.id, field: 'description', value: 'theirs' })]).doc;
    const open = mergeDocuments(base, ours, theirs);
    expect(open.clean).toBe(false);
    expect(open.conflicts).toEqual([expect.objectContaining({ id: `spec:${spec.id}:description`, kind: 'field', specId: spec.id })]);
    expect(open.doc.ids.specifications[0].description).toBe(spec.description);
    const id = open.conflicts[0].id;
    expect(mergeDocuments(base, ours, theirs, { resolutions: { [id]: 'ours' } }).doc.ids.specifications[0].description).toBe('ours');
    const t = mergeDocuments(base, ours, theirs, { resolutions: { [id]: 'theirs' } });
    expect(t.clean).toBe(true);
    expect(t.doc.ids.specifications[0].description).toBe('theirs');
  });

  it('reports delete-versus-edit as one conflict over the node', () => {
    const base = corpusDocument(5, 3);
    const spec = base.ids.specifications[1];
    const req = spec.requirements[0];
    const ours = apply(base, [op('spec.remove', { specId: spec.id })]).doc;
    const theirs = apply(base, [
      op('requirement.setOptionality', { facetId: req.id, optionality: req.optionality === 'optional' ? 'required' : 'optional' }),
      op('spec.set', { specId: spec.id, field: 'name', value: 'Edited' }),
    ]).doc;
    const r = mergeDocuments(base, ours, theirs);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ kind: 'deleteEdit', specId: spec.id });
    expect(r.conflicts[0].theirs.map((e) => e.kind).sort()).toEqual(['requirement.changed', 'spec.changed']);
    expect(shape(r.doc)).toEqual(shape(base));
    expect(shape(mergeDocuments(base, ours, theirs, { resolutions: { [r.conflicts[0].id]: 'ours' } }).doc)).toEqual(shape(ours));
    expect(shape(mergeDocuments(base, ours, theirs, { resolutions: { [r.conflicts[0].id]: 'theirs' } }).doc)).toEqual(shape(theirs));
  });

  it('settles concurrent reorders by last writer with a diagnostic', () => {
    const base = corpusDocument(6, 4);
    const [s0, s1, s2, s3] = base.ids.specifications;
    const r = mergeOps(base, [op('spec.move', { specId: s3.id, toIndex: 0 })], [op('spec.move', { specId: s0.id, toIndex: 3 })]);
    expect(r.conflicts).toEqual([]);
    expect(r.diagnostics.map((d) => d.code)).toEqual(['MERGE-ORDER-001']);
    expect(r.doc.ids.specifications.map((s) => s.id)).toEqual([s1.id, s2.id, s3.id, s0.id]);
    // One-sided reorder plus a concurrent insertion: both survive.
    const added = ids();
    const m = mergeOps(base, [op('spec.move', { specId: s3.id, toIndex: 0 })], [op('spec.add', { specId: added, index: 2, name: 'New', ifcVersions: ['IFC4'] })]);
    expect(m.diagnostics).toEqual([]);
    expect(m.doc.ids.specifications.map((s) => s.id)).toEqual([s3.id, s0.id, s1.id, added, s2.id]);
  });

  it('re-checks the merged ops with the grounding gate', async () => {
    const ctx = await createGateContext();
    const base = apply(corpusDocument(7, 1), []).doc;
    const specId = ids();
    const start = apply(base, [op('spec.add', { specId, name: 'Facilities', ifcVersions: ['IFC4X3_ADD2'] })]).doc;
    const ours = apply(start, [op('spec.setIfcVersions', { specId, versions: ['IFC2X3'] })]).doc;
    const theirs = apply(start, [
      op('facet.add', { specId, section: 'applicability', facetId: ids(), facet: { type: 'entity', name: { kind: 'equals', value: 'IfcFacility' } } }),
    ]).doc;
    const r = mergeDocuments(start, ours, theirs, { gate: ctx });
    expect(r.conflicts).toEqual([]);
    expect(r.clean).toBe(false);
    expect(r.diagnostics.map((d) => [d.code, d.issue?.code])).toEqual([['MERGE-GATE-001', 'GATE-ENT-001']]);
  });
});

describe('conflictView', () => {
  it('turns conflicts into ours/theirs cards and round-trips the resolutions', () => {
    const base = corpusDocument(4, 3);
    const spec = base.ids.specifications[0];
    const ours = apply(base, [op('spec.set', { specId: spec.id, field: 'description', value: 'ours' })]).doc;
    const theirs = apply(base, [op('spec.set', { specId: spec.id, field: 'description', value: 'theirs' })]).doc;
    const view = conflictView(mergeDocuments(base, ours, theirs));
    expect(view.unresolved).toBe(1);
    expect(view.cards[0]).toMatchObject({ title: spec.name, kind: 'field' });
    expect(view.cards[0].ours[0]).toContain('"ours"');
    expect(view.cards[0].theirs[0]).toContain('"theirs"');
    const resolutions = resolveConflict(view.resolutions, view.cards[0].id, 'theirs');
    const after = conflictView(mergeDocuments(base, ours, theirs, { resolutions }));
    expect(after.unresolved).toBe(0);
    expect(after.cards[0].resolution).toBe('theirs');
  });
});
