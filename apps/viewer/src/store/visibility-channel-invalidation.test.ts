/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * EVERY write of `isolatedEntities` / `ghostExceptEntities` invalidates the
 * ownership records it makes stale — whichever slice performs it.
 *
 * Review of #2867 answered the stale-record question in `visibilitySlice`'s
 * named setters. That is a LIST, and the list was already incomplete when it
 * was written: `showAllInAllModels` in the same file wrote both channels
 * through a bare `set()`, and `pinboardSlice` — a different slice entirely —
 * writes `isolatedEntities` from ten of its actions. Every one of them stranded a
 * record, and a stranded record is not inert: ownership is tested by VALUE, so
 * it goes matching → cleared → MATCHING AGAIN the moment another owner
 * installs a set with equal content, at which point that owner's presentation
 * is what the stale release destroys (#2654 fourth review).
 *
 * The invariant is therefore enforced at the store's `set` itself
 * (`withVisibilityOwnershipInvalidation`, store/visibility-invalidation.ts) —
 * there is no way to reach these two fields that does not go through it. This
 * file pins that for the writers that used to bypass it, and pins the
 * over-firing side too: a write that leaves a record's content intact must NOT
 * invalidate it, or the content-preserving replays lose their claim (#2662 P2).
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from './index.js';
import type { FederatedModel } from './types.js';

function model(id: string, idOffset: number, maxExpressId: number): FederatedModel {
  return { id, name: id, visible: true, idOffset, maxExpressId } as unknown as FederatedModel;
}

const store = () => useViewerStore.getState();
const isolated = () => {
  const s = store().isolatedEntities;
  return s ? [...s].sort((a, b) => a - b) : null;
};
const ghosted = () => {
  const s = store().ghostExceptEntities;
  return s ? [...s].sort((a, b) => a - b) : null;
};

beforeEach(() => {
  useViewerStore.setState({
    // Two models with `idOffset` 0 / 1000 — A's global ids equal its expressIds.
    models: new Map([['A', model('A', 0, 100)], ['B', model('B', 1000, 1100)]]),
    activeModelId: 'A',
    hiddenEntities: new Set(),
    isolatedEntities: null,
    ghostExceptEntities: null,
    classFilter: null,
    hiddenEntitiesByModel: new Map(),
    isolatedEntitiesByModel: new Map(),
    pinboardEntities: new Set(),
    activeBasketViewId: null,
    idsFocusVisibilityOwned: null,
    clashVisibilityOwned: null,
    idsValidationReport: null,
  });
});

/** Put `ids` on the named channel and record IDS as its owner, the way
 *  `useIDS.installFocusIsolation` / `installFocusGhost` do: channel first,
 *  record second. */
function idsOwns(channel: 'isolate' | 'ghost', ids: number[]): void {
  if (channel === 'isolate') store().setIsolatedEntities(new Set(ids));
  else store().setGhostExceptEntities(new Set(ids));
  store().setIdsFocusVisibilityOwned({ channel, ids: new Set(ids) });
}

function clashOwns(channel: 'isolate' | 'ghost', ids: number[]): void {
  if (channel === 'isolate') store().setIsolatedEntities(new Set(ids));
  else store().setGhostExceptEntities(new Set(ids));
  store().setClashVisibilityOwned({ channel, ids: new Set(ids) });
}

// ─── D1: `showAllInAllModels` — the eighth writer in the same file ──────────

describe('showAllInAllModels ends every claim on the channels it clears', () => {
  it('drops an IDS ghost record when it nulls the ghost channel', () => {
    idsOwns('ghost', [7]);
    assert.deepEqual(ghosted(), [7], 'setup: IDS owns the ghost channel');

    store().showAllInAllModels();

    assert.equal(ghosted(), null, 'setup: "show all" really does clear the ghost');
    assert.equal(
      store().idsFocusVisibilityOwned,
      null,
      'the IDS claim ended with its presentation — a record that outlives it re-matches later',
    );
  });

  it('drops a clash isolate record when it nulls the isolate channel', () => {
    clashOwns('isolate', [4, 5]);
    assert.deepEqual(isolated(), [4, 5], 'setup: clash owns the isolate channel');

    store().showAllInAllModels();

    assert.equal(isolated(), null, 'setup: "show all" really does clear the isolation');
    assert.equal(store().clashVisibilityOwned, null, 'the rule is symmetric or it is not a rule');
  });

  it('the destruction chain: a stranded IDS ghost destroys the NEXT owner of the same content', () => {
    idsOwns('ghost', [7]);
    // 1. "Show all across all models" wipes the IDS ghost off the screen.
    store().showAllInAllModels();
    // 2. Clash installs a ghost that happens to hold the SAME element.
    clashOwns('ghost', [7]);
    assert.deepEqual(ghosted(), [7], 'setup: the clash ghost is on screen');
    // 3. The user clears the IDS report. Its teardown releases "its" ghost —
    //    which, by value, is now clash's.
    store().clearIdsValidationReport();

    assert.deepEqual(
      ghosted(),
      [7],
      "clash's ghost must survive a teardown of a presentation that ended two steps ago",
    );
  });
});

// ─── D2: `pinboardSlice` — a different slice, ten bare writers ──────────────

describe('every pinboard write of the isolate channel ends the claims it invalidates', () => {
  const REFS = [{ modelId: 'A', expressId: 3 }];

  it('clearPinboard', () => {
    idsOwns('isolate', [9]);
    store().clearPinboard();
    assert.equal(isolated(), null, 'setup: the basket clear nulls the isolation');
    assert.equal(store().idsFocusVisibilityOwned, null);
  });

  it('clearBasket', () => {
    idsOwns('isolate', [9]);
    store().clearBasket();
    assert.equal(isolated(), null, 'setup');
    assert.equal(store().idsFocusVisibilityOwned, null);
  });

  it('addToPinboard', () => {
    idsOwns('isolate', [9]);
    store().addToPinboard(REFS);
    assert.deepEqual(isolated(), [3], 'setup: the basket now owns the channel');
    assert.equal(store().idsFocusVisibilityOwned, null);
  });

  it('setPinboard', () => {
    idsOwns('isolate', [9]);
    store().setPinboard(REFS);
    assert.deepEqual(isolated(), [3], 'setup');
    assert.equal(store().idsFocusVisibilityOwned, null);
  });

  it('showPinboard', () => {
    store().setPinboard(REFS);
    idsOwns('isolate', [9]);
    store().showPinboard();
    assert.deepEqual(isolated(), [3], 'setup: re-isolating the basket replaced the IDS isolation');
    assert.equal(store().idsFocusVisibilityOwned, null);
  });

  it('setBasket (non-empty)', () => {
    idsOwns('isolate', [9]);
    store().setBasket(REFS);
    assert.deepEqual(isolated(), [3], 'setup');
    assert.equal(store().idsFocusVisibilityOwned, null);
  });

  it('setBasket (empty — the early-return branch)', () => {
    idsOwns('isolate', [9]);
    store().setBasket([]);
    assert.equal(isolated(), null, 'setup');
    assert.equal(store().idsFocusVisibilityOwned, null);
  });

  it('addToBasket', () => {
    idsOwns('isolate', [9]);
    store().addToBasket(REFS);
    assert.deepEqual(isolated(), [3, 9], 'setup: the incremental add keeps the prior set and extends it');
    assert.equal(
      store().idsFocusVisibilityOwned,
      null,
      'the channel no longer holds exactly {9} — the IDS record no longer describes what is on screen',
    );
  });

  it('removeFromBasket (down to empty)', () => {
    store().setBasket(REFS);
    idsOwns('isolate', [9]);
    store().removeFromBasket(REFS);
    assert.equal(isolated(), null, 'setup');
    assert.equal(store().idsFocusVisibilityOwned, null);
  });

  it('removeFromBasket (still non-empty)', () => {
    store().setBasket([{ modelId: 'A', expressId: 3 }, { modelId: 'A', expressId: 4 }]);
    idsOwns('isolate', [9, 4]);
    store().removeFromBasket([{ modelId: 'A', expressId: 4 }]);
    assert.deepEqual(isolated(), [9], 'setup: the incremental remove worked off the current isolation set');
    assert.equal(store().idsFocusVisibilityOwned, null);
  });

  it('removeFromPinboard (down to empty)', () => {
    store().setPinboard(REFS);
    idsOwns('isolate', [9]);
    store().removeFromPinboard(REFS);
    assert.equal(isolated(), null, 'setup');
    assert.equal(store().idsFocusVisibilityOwned, null);
  });

  it('removeFromPinboard (still non-empty)', () => {
    store().setPinboard([{ modelId: 'A', expressId: 3 }, { modelId: 'A', expressId: 4 }]);
    idsOwns('isolate', [9]);
    store().removeFromPinboard([{ modelId: 'A', expressId: 4 }]);
    assert.deepEqual(isolated(), [3], 'setup');
    assert.equal(store().idsFocusVisibilityOwned, null);
  });

  it('restoreBasketEntities', () => {
    idsOwns('isolate', [9]);
    store().restoreBasketEntities(['A:3'], 'view-1');
    assert.deepEqual(isolated(), [3], 'setup');
    assert.equal(store().idsFocusVisibilityOwned, null);
  });

  it('a direct `useViewerStore.setState` of the channel is covered too, not just slice actions', () => {
    // `setState` IS the store's wrapped setter. Real callers reach the channels
    // this way — the BCF snapshot loops in `useClash` / `useIDS` restore the
    // saved isolation with it, and so does the collab room.
    idsOwns('isolate', [9]);
    useViewerStore.setState({ isolatedEntities: new Set([2]) });
    assert.deepEqual(isolated(), [2], 'setup');
    assert.equal(
      store().idsFocusVisibilityOwned,
      null,
      'a setter that skipped `setState` would leave the largest bypass of all open',
    );
  });

  it("the destruction chain: a stranded record wipes the user's own hand-made isolation", () => {
    // 1. An IDS row focus isolates element 3 and records `{isolate, {3}}`.
    idsOwns('isolate', [3]);
    // 2. The user clears the basket. `clearPinboard` nulls the isolate channel,
    //    so the IDS presentation is gone from the screen.
    store().clearPinboard();
    assert.equal(isolated(), null, 'setup: the IDS isolation is off screen');
    // 3. The user isolates element 3 BY HAND ("Isolate in 3D" / the model tree).
    //    Equal content to what IDS once installed — and IDS installed none of it.
    store().setIsolatedEntities(new Set([3]));
    // 4. Anything that tears the IDS report down releases "its" isolation.
    store().clearIdsValidationReport();

    assert.deepEqual(
      isolated(),
      [3],
      "the user's own isolation must survive — a stale record matching it by value is #2654 reopened",
    );
  });
});

// ─── The other direction: invalidation must not OVER-fire ──────────────────

describe('a write that leaves a record\'s content intact does not invalidate it', () => {
  it('showPinboard re-installing exactly what is already isolated keeps the basket owner\'s claim', () => {
    store().setPinboard([{ modelId: 'A', expressId: 3 }]);
    // Pretend the basket's isolation is a feature-owned presentation with a
    // record — the same content-preserving replay Space Sketch's view capture
    // and `syncSourceModel`'s rebuild perform (#2662 P2).
    store().setClashVisibilityOwned({ channel: 'isolate', ids: new Set([3]) });

    store().showPinboard();

    assert.deepEqual(isolated(), [3], 'setup: the channel content is unchanged');
    assert.deepEqual(
      store().clashVisibilityOwned,
      { channel: 'isolate', ids: new Set([3]) },
      'a content-preserving rewrite must not convert a feature-owned focus into "user" state',
    );
  });

  it('a basket edit that happens to leave the channel content unchanged keeps the record', () => {
    // `removeFromBasket` works incrementally off whatever is currently
    // isolated, so removing a ref that is not in it rewrites the channel to an
    // EQUAL set. Value identity's one false positive, and it is harmless by
    // construction: the channel still shows exactly what the record describes,
    // so releasing it renders precisely what discarding that presentation
    // should render.
    store().setBasket([{ modelId: 'A', expressId: 3 }]);
    idsOwns('isolate', [9]);
    store().removeFromBasket([{ modelId: 'A', expressId: 4 }]);
    assert.deepEqual(isolated(), [9], 'setup: the content is unchanged');
    assert.deepEqual(store().idsFocusVisibilityOwned, { channel: 'isolate', ids: new Set([9]) });
  });

  it('a write of ONE channel leaves a record on the OTHER one alone', () => {
    // `setBasket` writes `isolatedEntities` and never mentions the ghost
    // channel, which therefore still shows exactly what its owner installed.
    // Reading the untouched channel as "null" instead of "unchanged" would
    // invalidate a presentation that is still on screen.
    store().setGhostExceptEntities(new Set([7]));
    store().setClashVisibilityOwned({ channel: 'ghost', ids: new Set([7]) });

    store().setBasket([{ modelId: 'A', expressId: 3 }]);

    assert.deepEqual(isolated(), [3], 'setup: the basket took the isolate channel');
    assert.deepEqual(ghosted(), [7], 'setup: the ghost channel is untouched');
    assert.deepEqual(
      store().clashVisibilityOwned,
      { channel: 'ghost', ids: new Set([7]) },
      'the clash ghost is still exactly what clash installed — its claim stands',
    );
  });

  it('and the mirror: a ghost-only write leaves an ISOLATE record alone', () => {
    // No slice action writes the ghost channel without also writing isolate,
    // but `setState` can and does — this pins the other half of "unchanged
    // means unchanged" rather than leaving it to the writers that exist today.
    store().setIsolatedEntities(new Set([4]));
    store().setClashVisibilityOwned({ channel: 'isolate', ids: new Set([4]) });

    useViewerStore.setState({ ghostExceptEntities: new Set([7]) });

    assert.deepEqual(isolated(), [4], 'setup: the isolate channel is untouched');
    assert.deepEqual(store().clashVisibilityOwned, { channel: 'isolate', ids: new Set([4]) });
  });

  it('a write that touches NEITHER channel leaves both records alone', () => {
    idsOwns('ghost', [7]);
    store().setClashVisibilityOwned({ channel: 'ghost', ids: new Set([7]) });

    store().hideEntities([42]);
    store().setBasketPresentationVisible(true);

    assert.deepEqual(store().idsFocusVisibilityOwned, { channel: 'ghost', ids: new Set([7]) });
    assert.deepEqual(store().clashVisibilityOwned, { channel: 'ghost', ids: new Set([7]) });
  });

  it('an installer that writes the channel and its record in ONE set() keeps the record', () => {
    // Not how the current installers are written (channel first, record
    // second), but the choke point must not eat a record that arrives in the
    // same patch as the channel it describes. The previous claim IS stale here
    // — {9} is not what the write leaves behind — so without the exception the
    // invalidation would null the brand-new record along with it.
    store().setIsolatedEntities(new Set([9]));
    store().setClashVisibilityOwned({ channel: 'isolate', ids: new Set([9]) });

    useViewerStore.setState({
      isolatedEntities: new Set([11]),
      clashVisibilityOwned: { channel: 'isolate', ids: new Set([11]) },
    });

    assert.deepEqual(isolated(), [11], 'setup');
    assert.deepEqual(
      store().clashVisibilityOwned,
      { channel: 'isolate', ids: new Set([11]) },
      'a record can never be invalidated by the very write that installed it',
    );
  });
});

// ─── D4: what the atomic restore changed, besides the laundering ───────────

describe('restoreVisibilityState diverges from the three-call replay it replaced', () => {
  /** The replay `useSpaceSceneFraming.restore` used before this action existed. */
  function oldReplay(prior: { isolated: Set<number> | null; ghostExcept: Set<number> | null; hidden: Set<number> }): void {
    store().setIsolatedEntities(prior.isolated);
    if (prior.hidden.size > 0) store().setHiddenEntities(prior.hidden);
    if (prior.ghostExcept) store().setGhostExceptEntities(prior.ghostExcept);
  }

  const PRIOR = { isolated: new Set([3]), ghostExcept: null, hidden: new Set([8]) };

  it('keeps a captured isolation that the replay destroyed on its way past hidden', () => {
    store().setClassFilter([1, 2], 'IfcWall');
    oldReplay({ isolated: new Set(PRIOR.isolated), ghostExcept: null, hidden: new Set(PRIOR.hidden) });
    assert.equal(
      isolated(),
      null,
      'the replay restored the isolation and then `setHiddenEntities` nulled it again',
    );

    store().setClassFilter([1, 2], 'IfcWall');
    store().restoreVisibilityState({
      isolated: new Set(PRIOR.isolated),
      ghostExcept: null,
      hidden: new Set(PRIOR.hidden),
    });
    assert.deepEqual(isolated(), [3], 'the atomic restore puts back what was captured');
    assert.deepEqual([...store().hiddenEntities], [8], 'both, together — that is the point');
  });

  it('leaves classFilter alone, where the replay cleared it', () => {
    store().setClassFilter([1, 2], 'IfcWall');
    oldReplay({ isolated: null, ghostExcept: null, hidden: new Set([8]) });
    assert.equal(
      store().classFilter,
      null,
      '`setHiddenEntities` nulls the class filter, so the replay cleared it whenever anything was hidden',
    );

    store().setClassFilter([1, 2], 'IfcWall');
    store().restoreVisibilityState({ isolated: null, ghostExcept: null, hidden: new Set([8]) });
    assert.equal(
      store().classFilter?.label,
      'IfcWall',
      'the atomic restore writes the three fields it captured and nothing else',
    );
  });
});

// ─── D3: a both-non-null channel pair is reachable, and is restored as-is ──

describe('both channels can legitimately be non-null at once', () => {
  it('the actions that preserve the other channel reach it', () => {
    store().setGhostExceptEntities(new Set([9]));
    store().isolateEntity(5);
    assert.deepEqual(isolated(), [5]);
    assert.deepEqual(ghosted(), [9], '`isolateEntity` deliberately preserves the ghost channel');
  });

  it('and restoreVisibilityState puts that pair back verbatim rather than normalising it', () => {
    store().restoreVisibilityState({
      isolated: new Set([5]),
      ghostExcept: new Set([9]),
      hidden: new Set(),
    });
    assert.deepEqual(isolated(), [5]);
    assert.deepEqual(ghosted(), [9], 'a captured view the user actually had must come back as that view');
  });
});
