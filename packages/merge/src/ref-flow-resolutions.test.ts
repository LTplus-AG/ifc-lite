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

describe('MergeInit.allowUnrelated (override the unrelated-base refusal)', () => {
  /**
   * A ref with an ours-only entity (wall-2, untouched by the candidate)
   * and an entity the candidate also touches (wall-1, divergent value).
   * The candidate's declared base matches no prefix of the ref.
   */
  function unrelatedSetup() {
    const store = new MemoryStore();
    const oursBase = publishable(
      [{ path: 'wall-1', attributes: { [FIRE]: 'REI60' } }],
      'OursBase',
      null,
    );
    store.storeLayer(oursBase);
    const oursOnly = publishable(
      [{ path: 'wall-2', attributes: { [FIRE]: 'REI30' } }],
      'OursOnly',
      [oursBase.header.id],
    );
    store.storeLayer(oursOnly);
    store.setRef('main', { layers: [oursBase.header.id, oursOnly.header.id] });

    const foreignBase = publishable([], 'ForeignBase', null);
    store.storeLayer(foreignBase);
    const candidate = publishable(
      [
        // Overlaps ours' wall-1 with a divergent value.
        { path: 'wall-1', attributes: { [FIRE]: 'REI999' } },
        // An entity that exists only in the candidate's unrelated history.
        { path: 'wall-3', attributes: { [FIRE]: 'REI45' } },
      ],
      'Candidate',
      [foreignBase.header.id],
    );
    store.storeLayer(candidate);
    return { store, candidate };
  }

  it('refuses without the flag, and is bypassed with it (same candidate, same ref)', () => {
    const { store, candidate } = unrelatedSetup();

    const refused = mergeIntoRef(store, { candidateId: candidate.header.id, into: 'main' });
    expect(refused.status).toBe('unrelated-base');

    // Non-preview execution is where the refusal actually bites (preview
    // never refuses, flag or not — `!init.preview` already short-circuits
    // it). Exercise the real bypass on the executing path.
    const bypassed = mergeIntoRef(store, {
      candidateId: candidate.header.id,
      into: 'main',
      allowUnrelated: true,
      resolutions: [{ path: 'wall-1', componentKey: 'pset:Pset_FireSafety', choice: 'ours' }],
    });
    expect(bypassed.status).not.toBe('unrelated-base');
    expect(bypassed.status).toBe('merged');
  });

  it('does not steamroll the ref: ours-only content survives, overlapping paths conflict instead of being overwritten', () => {
    const { store, candidate } = unrelatedSetup();

    const preview = mergeIntoRef(store, {
      candidateId: candidate.header.id,
      into: 'main',
      preview: true,
      allowUnrelated: true,
    });
    expect(preview.status).toBe('preview');
    if (preview.status !== 'preview') return;
    // The overlapping path surfaces as a conflict for a human to decide —
    // planning against an empty ancestor must NOT read it as "theirs
    // wholesale" and silently overwrite ours' value.
    expect(preview.plan.conflicts).toHaveLength(1);
    expect(preview.plan.conflicts[0]).toMatchObject({
      kind: 'concurrent-edit',
      path: 'wall-1',
      componentKey: 'pset:Pset_FireSafety',
    });
    // wall-2 (ours-only, untouched by the candidate) is not itself a
    // conflict and is not queued for any destructive op.
    expect(preview.plan.conflicts.some((c) => c.path === 'wall-2')).toBe(false);
    expect(
      preview.plan.autoOps.some((op) => 'path' in op && op.path === 'wall-2' && op.op === 'tombstone-entity')
    ).toBe(false);

    const outcome = mergeIntoRef(store, {
      candidateId: candidate.header.id,
      into: 'main',
      allowUnrelated: true,
      resolutions: [{ path: 'wall-1', componentKey: 'pset:Pset_FireSafety', choice: 'ours' }],
      created: '2026-07-11T02:00:00Z',
    });
    expect(outcome.status).toBe('merged');
    if (outcome.status !== 'merged') return;

    const state = extractStackState(outcome.refLayers.map((id) => store.loadLayer(id)));
    // Ours' pre-existing, candidate-untouched entity survives verbatim.
    expect(state.get('wall-2')?.components.get('pset:Pset_FireSafety')?.[FIRE]).toBe('REI30');
    // The overlapping conflict resolved to ours, as instructed — not
    // silently overwritten by treating the candidate's value as "new".
    expect(state.get('wall-1')?.components.get('pset:Pset_FireSafety')?.[FIRE]).toBe('REI60');
    // The candidate's genuinely new entity is added.
    expect(state.get('wall-3')?.components.get('pset:Pset_FireSafety')?.[FIRE]).toBe('REI45');
  });
});
