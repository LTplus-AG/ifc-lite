/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `releaseOwnedIdsFocusVisibility`'s own contract, over the surface it is
 * actually typed for — a plain object with every member optional, not the
 * combined store.
 *
 * The store now invalidates ownership records at its `set`
 * (`store/visibility-invalidation.ts`), so when this function DOES release a
 * channel through the live store, the record would be dropped for it anyway.
 * That is what makes `state.setIdsFocusVisibilityOwned?.(null)` invisible to
 * every store-driven test, and an untested line is a line that gets deleted.
 * It is not redundant here: the "still ours?" answer can be NO — in which case
 * nothing is written, nothing invalidates, and the drop is the only thing
 * standing between a mismatched record and the next owner of that content
 * (#2654 fourth review).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  endIdsRowFocusPresentation,
  releaseOwnedIdsFocusVisibility,
  type IDSFocusVisibilityChannels,
  type IDSFocusVisibilityOwnership,
  type IDSRowFocusPresentation,
} from './visibility-ownership.js';
import { IDS_FOCUS_COLOR } from '../../hooks/ids/idsColorSystem.js';

function channels(over: Partial<IDSFocusVisibilityChannels> = {}): {
  state: IDSFocusVisibilityChannels;
  recorded: IDSFocusVisibilityOwnership[];
  cleared: string[];
} {
  const recorded: IDSFocusVisibilityOwnership[] = [];
  const cleared: string[] = [];
  const state: IDSFocusVisibilityChannels = {
    isolatedEntities: null,
    ghostExceptEntities: null,
    clearIsolation: () => { cleared.push('isolate'); },
    clearGhost: () => { cleared.push('ghost'); },
    setIdsFocusVisibilityOwned: (owned) => { recorded.push(owned); },
    ...over,
  };
  return { state, recorded, cleared };
}

describe('releaseOwnedIdsFocusVisibility', () => {
  it('releases the channel it still owns, and drops the record', () => {
    const { state, recorded, cleared } = channels({
      isolatedEntities: new Set([5]),
      idsFocusVisibilityOwned: { channel: 'isolate', ids: new Set([5]) },
    });

    assert.equal(releaseOwnedIdsFocusVisibility(state), true);
    assert.deepEqual(cleared, ['isolate']);
    assert.deepEqual(recorded, [null], 'the row focus makes no further claim once released');
  });

  it('drops the record even when the channel is NOT ours — that is the whole point', () => {
    // Another owner holds the isolate channel. Nothing is released; if the
    // record were left behind it would start matching again the moment anyone
    // installed {5} there, and the next release would destroy THAT owner's
    // presentation.
    const { state, recorded, cleared } = channels({
      isolatedEntities: new Set([9]),
      idsFocusVisibilityOwned: { channel: 'isolate', ids: new Set([5]) },
    });

    assert.equal(releaseOwnedIdsFocusVisibility(state), false, "we are not the owner");
    assert.deepEqual(cleared, [], "and another owner's isolation must not be touched");
    assert.deepEqual(recorded, [null], 'the stale record must go — no write invalidates it for us here');
  });

  it('writes nothing at all when there is no record', () => {
    const { state, recorded, cleared } = channels({ ghostExceptEntities: new Set([1]) });

    assert.equal(releaseOwnedIdsFocusVisibility(state), false);
    assert.deepEqual(cleared, []);
    assert.deepEqual(
      recorded,
      [],
      'an unconditional null would commit a fresh store state on every ownership-free release path',
    );
  });
});

describe('endIdsRowFocusPresentation', () => {
  function presentation(over: Partial<IDSRowFocusPresentation> = {}): {
    state: IDSRowFocusPresentation;
    paintCalls: Map<number, [number, number, number, number]>[];
  } {
    const paintCalls: Map<number, [number, number, number, number]>[] = [];
    const state: IDSRowFocusPresentation = {
      isolatedEntities: null,
      ghostExceptEntities: null,
      clearIsolation: () => {},
      clearGhost: () => {},
      setIdsFocusVisibilityOwned: () => {},
      setPendingColorUpdates: (updates) => { paintCalls.push(updates); },
      ...over,
    };
    return { state, paintCalls };
  }

  it('strips ONLY the entries wearing the exact focus colour, leaving other painted entries untouched', () => {
    const otherRed: [number, number, number, number] = [1, 0, 0, 1];
    const painted = new Map<number, [number, number, number, number]>([
      [1, [...IDS_FOCUS_COLOR] as [number, number, number, number]],
      [2, otherRed],
    ]);
    const { state, paintCalls } = presentation({ pendingColorUpdates: painted });

    endIdsRowFocusPresentation(state);

    assert.equal(paintCalls.length, 1, 'a matching entry exists, so the map must be rewritten once');
    const next = paintCalls[0];
    assert.deepEqual([...next.keys()], [2], 'only the non-focus-colour entry survives');
    assert.deepEqual(next.get(2), otherRed, 'the surviving entry must be untouched, not re-tinted');
  });

  it('does not treat a colour that merely shares channels with the focus colour as a match', () => {
    // Same first three channels as IDS_FOCUS_COLOR, different alpha — a real
    // colour-equality bug would treat "every channel I bothered to check"
    // loosely; this pins that ALL four channels, including alpha, are compared.
    const almostFocusColor: [number, number, number, number] = [
      IDS_FOCUS_COLOR[0], IDS_FOCUS_COLOR[1], IDS_FOCUS_COLOR[2], 0.5,
    ];
    const painted = new Map<number, [number, number, number, number]>([[7, almostFocusColor]]);
    const { state, paintCalls } = presentation({ pendingColorUpdates: painted });

    endIdsRowFocusPresentation(state);

    assert.equal(paintCalls.length, 0, 'no entry matches the focus colour exactly, so nothing should be rewritten');
  });

  it('writes nothing when no painted entry wears the focus colour — the do-nothing branch', () => {
    const untouched = new Map<number, [number, number, number, number]>([[3, [1, 1, 1, 1]]]);
    const { state, paintCalls } = presentation({ pendingColorUpdates: untouched });

    const released = endIdsRowFocusPresentation(state);

    assert.equal(paintCalls.length, 0, 'an unconditional write would commit a fresh map on every call');
    assert.equal(released, false, 'no ownership record was present, so nothing was released either');
  });

  it('releases the visibility channel AND strips the paint marker together', () => {
    const painted = new Map<number, [number, number, number, number]>([
      [5, [...IDS_FOCUS_COLOR] as [number, number, number, number]],
    ]);
    const cleared: string[] = [];
    const { state, paintCalls } = presentation({
      isolatedEntities: new Set([5]),
      idsFocusVisibilityOwned: { channel: 'isolate', ids: new Set([5]) },
      clearIsolation: () => { cleared.push('isolate'); },
      pendingColorUpdates: painted,
    });

    const released = endIdsRowFocusPresentation(state);

    assert.equal(released, true, 'the row focus was still the channel owner');
    assert.deepEqual(cleared, ['isolate']);
    assert.equal(paintCalls.length, 1);
    assert.deepEqual([...paintCalls[0].keys()], [], 'the sole painted entry wore the focus colour and is dropped');
  });
});
