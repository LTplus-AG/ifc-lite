/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-conflict resolutions through the shared ref-merge flow (#1717 V3):
 * the review-UI loop is preview → decide each conflict → execute with
 * `MergeInit.resolutions`. Blanket `resolve` keeps its semantics;
 * partially-addressed plans surface the leftovers as conflicts.
 */

import { describe, expect, it } from 'vitest';
import { computeLayerId, computeStackHash, createProvenanceManifest, setProvenance } from '@ifc-lite/ifcx';
import type { IfcxFile, IfcxNode } from '@ifc-lite/ifcx';
import { extractStackState } from './component-state.js';
import { mergeIntoRef } from './ref-flow.js';
import type { LayerRefStore, RefEntry } from './ref-flow.js';

const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';
const SOUND = 'bsi::ifc::v5a::Pset_Acoustic::Rw';

class MemoryStore implements LayerRefStore {
  private layers = new Map<string, IfcxFile>();
  private refs = new Map<string, RefEntry>();
  storeLayer(file: IfcxFile): string {
    this.layers.set(file.header.id, structuredClone(file));
    return file.header.id;
  }
  loadLayer(id: string): IfcxFile {
    const f = this.layers.get(id);
    if (!f) throw new Error(`no layer ${id}`);
    return structuredClone(f);
  }
  getRef(name: string): RefEntry | undefined {
    const e = this.refs.get(name);
    return e ? structuredClone(e) : undefined;
  }
  setRef(name: string, entry: RefEntry): void {
    this.refs.set(name, structuredClone(entry));
  }
}

function publishable(data: IfcxNode[], intent: string, baseIds: string[] | null): IfcxFile {
  const bare: IfcxFile = {
    header: { id: '', ifcxVersion: 'ifcx_alpha', dataVersion: '1.0.0', author: 't', timestamp: '2026-07-11T00:00:00Z' },
    imports: [],
    schemas: {},
    data,
  };
  const manifest = createProvenanceManifest({
    author: { kind: 'human', principal: 'alice' },
    intent,
    base: baseIds === null ? null : { kind: 'stack', id: computeStackHash(baseIds) },
    created: '2026-07-11T00:00:00Z',
  });
  const withManifest = setProvenance(bare, manifest);
  const id = computeLayerId(withManifest);
  return { ...withManifest, header: { ...withManifest.header, id } };
}

/** Store with a two-conflict setup: ours and theirs edit FIRE and SOUND divergently. */
function conflictingSetup() {
  const store = new MemoryStore();
  const base = publishable(
    [{ path: 'wall-1', attributes: { 'bsi::ifc::class': { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI60', [SOUND]: 40 } }],
    'Base',
    null,
  );
  store.storeLayer(base);
  const ours = publishable([{ path: 'wall-1', attributes: { [FIRE]: 'REI90', [SOUND]: 45 } }], 'Ours', [base.header.id]);
  store.storeLayer(ours);
  store.setRef('main', { layers: [base.header.id, ours.header.id] });
  const candidate = publishable([{ path: 'wall-1', attributes: { [FIRE]: 'REI120', [SOUND]: 50 } }], 'Theirs', [base.header.id]);
  store.storeLayer(candidate);
  return { store, base, candidate };
}

describe('MergeInit.resolutions (per-conflict, review-UI flow)', () => {
  it('previews conflicts, then merges with mixed per-conflict choices', () => {
    const { store, candidate } = conflictingSetup();

    const preview = mergeIntoRef(store, { candidateId: candidate.header.id, into: 'main', preview: true });
    expect(preview.status).toBe('preview');
    if (preview.status !== 'preview') return;
    expect(preview.plan.conflicts).toHaveLength(2);

    const outcome = mergeIntoRef(store, {
      candidateId: candidate.header.id,
      into: 'main',
      created: '2026-07-11T01:00:00Z',
      resolutions: [
        { path: 'wall-1', componentKey: 'pset:Pset_FireSafety', choice: 'theirs' },
        { path: 'wall-1', componentKey: 'pset:Pset_Acoustic', choice: 'ours' },
      ],
    });
    expect(outcome.status).toBe('merged');
    if (outcome.status !== 'merged') return;

    const state = extractStackState(outcome.refLayers.map((id) => store.loadLayer(id)));
    const wall = state.get('wall-1');
    expect(wall?.components.get('pset:Pset_FireSafety')?.[FIRE]).toBe('REI120'); // theirs
    expect(wall?.components.get('pset:Pset_Acoustic')?.[SOUND]).toBe(45); // ours
  });

  it('surfaces unaddressed conflicts instead of merging past them', () => {
    const { store, candidate } = conflictingSetup();
    const outcome = mergeIntoRef(store, {
      candidateId: candidate.header.id,
      into: 'main',
      resolutions: [{ path: 'wall-1', componentKey: 'pset:Pset_FireSafety', choice: 'theirs' }],
    });
    expect(outcome.status).toBe('conflicts');
    if (outcome.status !== 'conflicts') return;
    expect(outcome.conflicts).toHaveLength(1);
    expect(outcome.conflicts[0].componentKey).toBe('pset:Pset_Acoustic');
  });

  it('per-conflict resolutions take precedence over a blanket resolve', () => {
    const { store, candidate } = conflictingSetup();
    const outcome = mergeIntoRef(store, {
      candidateId: candidate.header.id,
      into: 'main',
      created: '2026-07-11T01:00:00Z',
      resolve: 'ours',
      resolutions: [
        { path: 'wall-1', componentKey: 'pset:Pset_FireSafety', choice: 'theirs' },
        { path: 'wall-1', componentKey: 'pset:Pset_Acoustic', choice: 'theirs' },
      ],
    });
    expect(outcome.status).toBe('merged');
    if (outcome.status !== 'merged') return;
    const state = extractStackState(outcome.refLayers.map((id) => store.loadLayer(id)));
    expect(state.get('wall-1')?.components.get('pset:Pset_FireSafety')?.[FIRE]).toBe('REI120');
  });
});

describe('candidate already on the ref (published drafts re-merged into their home ref)', () => {
  /**
   * Publishing appends the draft to its home ref, and the draft's declared
   * base is the COMPOSITION it was authored against — a stack that need
   * not be representable on the ref (e.g. URI-id base files fail the
   * content-address gate). Re-merging that layer into the same ref must
   * no-op, not refuse as unrelated-base.
   */
  function publishedOntoRef() {
    const store = new MemoryStore();
    // Base declared against a stack hash that matches nothing on the ref.
    const candidate = publishable(
      [{ path: 'wall-1', attributes: { [FIRE]: 'REI180' } }],
      'Draft',
      ['uri:not-on-any-ref'],
    );
    store.storeLayer(candidate);
    store.setRef('local', { layers: [candidate.header.id] });
    return { store, candidate };
  }

  it('previews as an empty plan with a matched ancestor', () => {
    const { store, candidate } = publishedOntoRef();
    const outcome = mergeIntoRef(store, { candidateId: candidate.header.id, into: 'local', preview: true });
    expect(outcome.status).toBe('preview');
    if (outcome.status !== 'preview') return;
    expect(outcome.plan.conflicts).toHaveLength(0);
    expect(outcome.plan.stats.touched).toBe(0);
    expect(outcome.ancestorMatched).toBe(true);
  });

  it('executes as a no-op fast-forward with the ref unchanged', () => {
    const { store, candidate } = publishedOntoRef();
    const outcome = mergeIntoRef(store, { candidateId: candidate.header.id, into: 'local' });
    expect(outcome.status).toBe('fast-forward');
    if (outcome.status !== 'fast-forward') return;
    expect(outcome.refLayers).toEqual([candidate.header.id]);
    expect(store.getRef('local')?.layers).toEqual([candidate.header.id]);
  });

  it('still refuses a genuinely unrelated candidate NOT on the ref', () => {
    const { store } = publishedOntoRef();
    const stranger = publishable(
      [{ path: 'wall-2', attributes: { [FIRE]: 'REI30' } }],
      'Stranger',
      ['uri:some-other-history'],
    );
    store.storeLayer(stranger);
    const outcome = mergeIntoRef(store, { candidateId: stranger.header.id, into: 'local' });
    expect(outcome.status).toBe('unrelated-base');
  });
});
