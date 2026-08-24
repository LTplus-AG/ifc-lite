/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `createRef`, `moveRef`, `protectRef` and `listRefs` back the `ifc-lite
 * ref` subcommands (create/move/protect/list) but had no test of their
 * own — only exercised incidentally, through `setupMain()`, by the layer
 * command suites. Mutation testing confirmed real gaps: dropping
 * `createRef`'s "already exists" guard, aliasing (not copying) the source
 * ref's layer array in `createRef({ from })`, and re-setting
 * `requireHumanApproval: false` from `protectRef` all left the CLI suite
 * green.
 */

import { describe, expect, it } from 'vitest';
import { getRef, readRefs } from './layer-store.js';
import { publishLayer } from './layer-publish.js';
import { createRef, listRefs, moveRef, protectRef } from './ref.js';
import { makeDelta, setupMain, tmpStore } from './layer-test-helpers.js';

describe('createRef', () => {
  it('creates an empty ref when no source is given', () => {
    const store = tmpStore();
    const entry = createRef(store, 'main');
    expect(entry.layers).toEqual([]);
    expect(getRef(store, 'main')).toEqual({ layers: [] });
  });

  it('refuses to overwrite an existing ref', () => {
    const store = tmpStore();
    createRef(store, 'main');
    expect(() => createRef(store, 'main')).toThrow(/already exists/);
    // The original ref survives the failed attempt untouched.
    expect(getRef(store, 'main')).toEqual({ layers: [] });
  });

  it('gives the new ref an independent layer list that "main" moving on does not affect', () => {
    const store = tmpStore();
    const baseId = setupMain(store);
    const entry = createRef(store, 'feature', 'main');
    expect(entry.layers).toEqual([baseId]);

    // Move "main" forward, NOT "feature". This is the direction the test is
    // named for, and the only one that can observe a shared list: moveRef
    // REPLACES the moved ref's entry, so moving "feature" would overwrite its
    // list wholesale and an implementation that handed it "main"'s own array
    // would still pass. Advancing "main" and asserting "feature" is unmoved
    // is what actually pins independence.
    const second = publishLayer(store, {
      delta: makeDelta([{ path: 'wall-1', attributes: {} }]),
      baseRef: 'main',
      intent: 'change',
      principal: 'bob',
    });
    moveRef(store, 'main', second.layerId);
    expect(getRef(store, 'main')?.layers).toEqual([second.layerId]);
    expect(getRef(store, 'feature')?.layers).toEqual([baseId]);
  });
});

describe('moveRef', () => {
  it('throws for a ref that does not exist', () => {
    const store = tmpStore();
    expect(() => moveRef(store, 'ghost', 'main')).toThrow(/No ref named "ghost"/);
  });

  it('points a ref at another ref\'s current stack', () => {
    const store = tmpStore();
    const baseId = setupMain(store);
    createRef(store, 'feature');
    const updated = moveRef(store, 'feature', 'main');
    expect(updated.layers).toEqual([baseId]);
  });

  it('accepts a comma-separated layer-id list when the target is not a ref', () => {
    const store = tmpStore();
    const baseId = setupMain(store);
    const second = publishLayer(store, {
      delta: makeDelta([{ path: 'wall-1', attributes: {} }]),
      baseRef: 'main',
      intent: 'second',
      principal: 'bob',
    });
    createRef(store, 'custom');
    const updated = moveRef(store, 'custom', `${baseId},${second.layerId}`);
    expect(updated.layers).toEqual([baseId, second.layerId]);
  });

  it('drops blank entries from the comma-separated list (trailing comma, whitespace)', () => {
    const store = tmpStore();
    const baseId = setupMain(store);
    createRef(store, 'custom');
    const updated = moveRef(store, 'custom', ` ${baseId} , `);
    expect(updated.layers).toEqual([baseId]);
  });

  it('preserves the existing policy when moving a protected ref', () => {
    const store = tmpStore();
    const baseId = setupMain(store);
    protectRef(store, 'main', { requireHumanApproval: true });
    const updated = moveRef(store, 'main', baseId);
    expect(updated.policy).toEqual({ requireHumanApproval: true });
  });
});

describe('protectRef', () => {
  it('sets requireHumanApproval', () => {
    const store = tmpStore();
    createRef(store, 'main');
    const updated = protectRef(store, 'main', { requireHumanApproval: true });
    expect(updated.policy).toEqual({ requireHumanApproval: true });
  });

  it('accumulates required checks across separate calls rather than replacing them', () => {
    const store = tmpStore();
    createRef(store, 'main');
    protectRef(store, 'main', { requiredChecks: ['ids:fire-rating'] });
    const updated = protectRef(store, 'main', { requiredChecks: ['ids:clearance'] });
    expect(updated.policy?.requiredChecks).toEqual(['ids:fire-rating', 'ids:clearance']);
  });

  it('an omitted requireHumanApproval leaves a previously-set true alone', () => {
    const store = tmpStore();
    createRef(store, 'main');
    protectRef(store, 'main', { requireHumanApproval: true });
    const updated = protectRef(store, 'main', { requiredChecks: ['ids:clearance'] });
    expect(updated.policy?.requireHumanApproval).toBe(true);
  });

  it('throws for a ref that does not exist', () => {
    const store = tmpStore();
    expect(() => protectRef(store, 'ghost', {})).toThrow(/No ref named "ghost"/);
  });
});

describe('listRefs', () => {
  it('returns refs sorted by name, with stack hash and policy', () => {
    const store = tmpStore();
    createRef(store, 'zeta');
    const baseId = setupMain(store); // creates "main"
    protectRef(store, 'main', { requireHumanApproval: true, requiredChecks: ['ids:x'] });

    const refs = listRefs(store);
    expect(refs.map((r) => r.name)).toEqual(['main', 'zeta']);
    const main = refs[0];
    expect(main.layers).toEqual([baseId]);
    expect(main.stackHash).toMatch(/^blake3:[0-9a-f]+$/);
    expect(main.policy).toEqual({ requireHumanApproval: true, requiredChecks: ['ids:x'] });
    // An unprotected ref carries no policy key at all.
    expect(refs[1].policy).toBeUndefined();
  });

  it('reads straight from the persisted refs.json', () => {
    const store = tmpStore();
    createRef(store, 'main');
    const persisted = readRefs(store);
    expect(Object.keys(persisted.refs)).toEqual(['main']);
  });
});
