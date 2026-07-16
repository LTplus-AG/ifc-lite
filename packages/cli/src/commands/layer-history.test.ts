/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** `layer bake|revert|log|diff` and `ref` command suites (split from layer.test.ts). */

import { describe, expect, it } from 'vitest';
import { IFCLITE_ATTR, computeStackHash } from '@ifc-lite/ifcx';
import { extractStackState } from '@ifc-lite/merge';
import { getRef, loadLayer, loadRefLayers } from './layer-store.js';
import { publishLayer } from './layer-publish.js';
import { diffLayerStacks } from './layer-diff.js';
import { mergeIntoRef } from './layer-merge.js';
import { bakeRef, logRef, revertInRef } from './layer-history.js';
import { createRef, listRefs, protectRef } from './ref.js';
import { CLASS, FIRE, makeDelta, setupMain, tmpStore } from './layer-test-helpers.js';

describe('bake', () => {
  it('writes tombstone-free output', () => {
    const store = tmpStore();
    setupMain(store);
    const tombstone = publishLayer(store, {
      delta: makeDelta([{ path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: true } }]),
      baseRef: 'main',
      intent: 'Delete wall-1',
      principal: 'bob',
    });
    mergeIntoRef(store, { candidateId: tombstone.layerId, into: 'main' });

    const baked = bakeRef(store, 'main');
    const paths = baked.data.map((n) => n.path);
    expect(paths).not.toContain('wall-1');
    for (const node of baked.data) {
      for (const key of Object.keys(node.attributes ?? {})) {
        expect(key.startsWith('ifclite::')).toBe(false);
      }
    }
  });
});

describe('revert', () => {
  it('restores the base state and appends to the ref', () => {
    const store = tmpStore();
    const baseId = setupMain(store);
    const edit = publishLayer(store, {
      delta: makeDelta([{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }]),
      baseRef: 'main',
      intent: 'Bump fire rating',
      principal: 'bob',
    });
    mergeIntoRef(store, { candidateId: edit.layerId, into: 'main' });

    const result = revertInRef(store, edit.layerId, 'main', { principal: 'carol' });
    if (result.status !== 'reverted') throw new Error('expected clean revert');
    expect(getRef(store, 'main')?.layers).toEqual([baseId, edit.layerId, result.revertLayerId]);

    const reverted = extractStackState(loadRefLayers(store, 'main'));
    const baseline = extractStackState([loadLayer(store, baseId)]);
    expect(reverted.get('wall-1')?.components.get('pset:Pset_FireSafety')).toEqual(
      baseline.get('wall-1')?.components.get('pset:Pset_FireSafety')
    );
    expect(() => revertInRef(store, 'blake3:0000', 'main')).toThrow();
  });

  it('conflicts instead of clobbering later edits to the same component', () => {
    // A→B (revert target), then a later B→C edit: reverting A→B must not
    // silently produce A.
    const store = tmpStore();
    setupMain(store);
    const toB = publishLayer(store, {
      delta: makeDelta([{ path: 'wall-1', attributes: { [FIRE]: 'B' } }]),
      baseRef: 'main',
      intent: 'A to B',
      principal: 'bob',
    });
    mergeIntoRef(store, { candidateId: toB.layerId, into: 'main' });
    const toC = publishLayer(store, {
      delta: makeDelta([{ path: 'wall-1', attributes: { [FIRE]: 'C' } }]),
      baseRef: 'main',
      intent: 'B to C',
      principal: 'dave',
    });
    mergeIntoRef(store, { candidateId: toC.layerId, into: 'main' });

    const outcome = revertInRef(store, toB.layerId, 'main');
    if (outcome.status !== 'conflicts') throw new Error('expected conflicts');
    expect(outcome.conflicts.map((c) => c.componentKey)).toEqual(['pset:Pset_FireSafety']);

    // ours keeps the later edit (C); the disjoint parts still revert.
    const kept = revertInRef(store, toB.layerId, 'main', { resolve: 'ours' });
    if (kept.status !== 'reverted') throw new Error('expected revert with resolution');
    const state = extractStackState(loadRefLayers(store, 'main'));
    expect(state.get('wall-1')?.components.get('pset:Pset_FireSafety')).toEqual({ [FIRE]: 'C' });
  });
});

describe('log', () => {
  it('lists intents newest first, with author and created', () => {
    const store = tmpStore();
    setupMain(store);
    const edit = publishLayer(store, {
      delta: makeDelta([{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }]),
      baseRef: 'main',
      intent: 'Bump fire rating',
      principal: 'bob',
      kind: 'agent',
    });
    mergeIntoRef(store, { candidateId: edit.layerId, into: 'main' });

    const entries = logRef(store, 'main');
    expect(entries.map((e) => e.intent)).toEqual(['Bump fire rating', 'Import base model']);
    expect(entries[0]).toMatchObject({ authorKind: 'agent', principal: 'bob', hasManifest: true });
    expect(entries[0].created).toBeTruthy();
  });
});

describe('diff', () => {
  it('reports added, deleted and modified entities with component keys', () => {
    const store = tmpStore();
    setupMain(store);
    const base = loadRefLayers(store, 'main');
    const next = makeDelta([
      { path: 'wall-1', attributes: { [FIRE]: 'REI120' } },
      { path: 'wall-2', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' } } },
      { path: 'storey-eg', attributes: { [IFCLITE_ATTR.DELETED]: true } },
    ]);
    const result = diffLayerStacks(base, [...base, next]);
    expect(result.added).toEqual(['wall-2']);
    // Tombstoning the storey shadows its subtree: wall-1 is deleted with
    // it, so its concurrent pset edit is no longer a "modified" entry.
    expect(result.deleted).toEqual(['storey-eg', 'wall-1']);
    expect(result.modified).toEqual([]);
  });
});

describe('refs', () => {
  it('creates, moves, protects and lists refs', () => {
    const store = tmpStore();
    const baseId = setupMain(store);
    createRef(store, 'option-b', 'main');
    expect(getRef(store, 'option-b')?.layers).toEqual([baseId]);
    expect(() => createRef(store, 'main')).toThrow(/already exists/);

    protectRef(store, 'main', { requireHumanApproval: true });
    const refs = listRefs(store);
    expect(refs.map((r) => r.name)).toEqual(['main', 'option-b']);
    expect(refs[0].policy?.requireHumanApproval).toBe(true);
    expect(refs[0].stackHash).toBe(computeStackHash([baseId]));

    // requireHumanApproval blocks agent-authored fast-forwards without approval.
    const agentEdit = publishLayer(store, {
      delta: makeDelta([{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }]),
      baseRef: 'main',
      intent: 'Agent edit',
      principal: 'agent-1',
      kind: 'agent',
    });
    const blocked = mergeIntoRef(store, { candidateId: agentEdit.layerId, into: 'main' });
    expect(blocked.status).toBe('policy-failure');
    const approved = mergeIntoRef(store, {
      candidateId: agentEdit.layerId,
      into: 'main',
      approvedBy: 'alice',
    });
    expect(approved.status).toBe('fast-forward');
  });
});
