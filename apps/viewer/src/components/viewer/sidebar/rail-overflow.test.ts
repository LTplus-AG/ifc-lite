/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fitRail, foldModelPanels, layoutRail, railHeight, RAIL_DIVIDER_PX, RAIL_ITEM_PX, RAIL_PADDING_PX, type RailEntry } from './rail-overflow.js';

const entries: RailEntry<string>[] = [
  { id: 'a', group: 'one' }, { id: 'b', group: 'one' }, { id: 'c', group: 'one' },
  { id: 'd', group: 'two' }, { id: 'e', group: 'two' },
  { id: 'f', group: 'three' },
];

describe('activity rail overflow (#8802 R1)', () => {
  it('counts icon rows, padding, and one divider per group change', () => {
    assert.equal(railHeight(entries), RAIL_PADDING_PX + 6 * RAIL_ITEM_PX + 2 * RAIL_DIVIDER_PX);
    assert.equal(railHeight([]), RAIL_PADDING_PX);
  });

  it('keeps every icon when they fit, or when the height is unknown', () => {
    assert.deepEqual(fitRail(entries, railHeight(entries)), { visible: ['a', 'b', 'c', 'd', 'e', 'f'], overflow: [] });
    assert.deepEqual(fitRail(entries, 0).overflow, []);
  });

  it('moves the icons past the fold into the overflow, reserving a row for its button', () => {
    // Room for padding + 4 rows: three icons plus the overflow button.
    const fit = fitRail(entries, RAIL_PADDING_PX + 4 * RAIL_ITEM_PX);
    assert.deepEqual(fit.visible, ['a', 'b', 'c']);
    assert.deepEqual(fit.overflow, ['d', 'e', 'f']);
  });

  it('never hides the active panel: it takes the last visible slot', () => {
    const fit = fitRail(entries, RAIL_PADDING_PX + 4 * RAIL_ITEM_PX + RAIL_DIVIDER_PX, ['f']);
    assert.ok(fit.visible.includes('f'), 'the active icon stays on the rail');
    assert.deepEqual([...fit.visible, ...fit.overflow].sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.ok(railHeight(entries.filter((e) => fit.visible.includes(e.id))) <= RAIL_PADDING_PX + 3 * RAIL_ITEM_PX + RAIL_DIVIDER_PX);
  });

  it('keeps several pinned icons (active panel and a tour anchor) in rail order', () => {
    const fit = fitRail(entries, RAIL_PADDING_PX + 5 * RAIL_ITEM_PX + 2 * RAIL_DIVIDER_PX, ['f', 'd', null]);
    assert.ok(fit.visible.includes('f') && fit.visible.includes('d'), 'both pinned icons stay');
    assert.deepEqual(fit.visible, [...fit.visible].sort(), 'the rail keeps its own order');
    assert.ok(railHeight(entries.filter((e) => fit.visible.includes(e.id))) <= RAIL_PADDING_PX + 4 * RAIL_ITEM_PX + 2 * RAIL_DIVIDER_PX);
  });

  const shortEntries = [
    { id: 'properties', group: 'inspect' },
    { id: 'compare', group: 'review' },
    { id: 'lists', group: 'data' },
  ];

  it('keeps tour-pinned Compare before active Properties beside More at 90px (#8802)', () => {
    // ActivityBar passes the tour anchor first, then the active panel.
    const fit = fitRail(shortEntries, 90, ['compare', 'properties']);
    assert.deepEqual(fit.visible, ['compare']);
    assert.deepEqual(fit.overflow, ['properties', 'lists']);
    assert.equal(railHeight(shortEntries.filter((e) => fit.visible.includes(e.id))) + RAIL_ITEM_PX, 90);
  });

  it('shows only More at 67px with active Properties and tour-pinned Compare (#8802)', () => {
    const fit = fitRail(shortEntries, 67, ['compare', 'properties']);
    assert.deepEqual(fit.visible, []);
    assert.deepEqual(fit.overflow, ['properties', 'compare', 'lists']);
    assert.ok(RAIL_PADDING_PX + RAIL_ITEM_PX <= 67);
  });

  it('keeps active Properties over unpinned Compare without a tour at 90px (#8802)', () => {
    const fit = fitRail([...shortEntries].reverse(), 90, [null, 'properties']);
    assert.deepEqual(fit.visible, ['properties']);
    assert.deepEqual(fit.overflow, ['lists', 'compare']);
  });

  it('shows More alone when only its row fits (#8802)', () => {
    assert.deepEqual(fitRail(shortEntries, RAIL_PADDING_PX + RAIL_ITEM_PX, ['properties', 'compare']), {
      visible: [], overflow: ['properties', 'compare', 'lists'],
    });
  });

  it('preserves the normal-height pinned layout (#8802)', () => {
    assert.deepEqual(fitRail(entries, RAIL_PADDING_PX + 5 * RAIL_ITEM_PX + 2 * RAIL_DIVIDER_PX, ['f', 'd']), {
      visible: ['a', 'b', 'd', 'f'], overflow: ['c', 'e'],
    });
  });
});

describe('empty start screen rail (#8802 R6)', () => {
  const waits = (id: string) => ['b', 'd', 'e'].includes(id);

  it('moves the panels that need a model off the rail, keeping rail order in both halves', () => {
    const { rail, waiting } = foldModelPanels(entries, waits);
    assert.deepEqual(rail.map((e) => e.id), ['a', 'c', 'f']);
    assert.deepEqual(waiting, ['b', 'd', 'e']);
  });

  it('keeps a pinned panel on the rail: the tour anchor and the open panel', () => {
    const { rail, waiting } = foldModelPanels(entries, waits, ['d', null, undefined]);
    assert.deepEqual(rail.map((e) => e.id), ['a', 'c', 'd', 'f']);
    assert.deepEqual(waiting, ['b', 'e']);
  });

  // The review's case (#9236): a height that fits the folded rail exactly, so
  // it fits WITHOUT More, but not with More's row too. More must still end
  // inside the rail, or the waiting panels sit past its clipped bottom edge.
  it('reserves More\'s row when the folded rail alone would just fit', () => {
    const rail = entries.filter((e) => !waits(e.id));
    const exact = railHeight(rail);
    const laid = layoutRail(entries, exact, [], waits);
    assert.ok(laid.overflow.length > 0, 'More is shown: panels wait in it');
    const shown = entries.filter((e) => laid.visible.includes(e.id));
    assert.ok(railHeight(shown) + RAIL_ITEM_PX <= exact,
      `icons ${railHeight(shown)}px + More ${RAIL_ITEM_PX}px must fit the ${exact}px rail`);
    // Nothing is lost: what left the rail is in More, in rail order.
    assert.deepEqual([...laid.visible, ...laid.overflow].sort(), entries.map((e) => e.id).sort());
    assert.deepEqual(laid.overflow, entries.map((e) => e.id).filter((id) => laid.overflow.includes(id)));
    assert.deepEqual(laid.waiting, ['b', 'd', 'e']);
  });

  it('keeps every folded-rail icon once the rail has room for More as well', () => {
    const rail = entries.filter((e) => !waits(e.id));
    const laid = layoutRail(entries, railHeight(rail) + RAIL_ITEM_PX, [], waits);
    assert.deepEqual(laid.visible, ['a', 'c', 'f']);
    assert.deepEqual(laid.overflow, ['b', 'd', 'e']);
  });

  it('fitRail reserves the row only when told More is required', () => {
    const exact = railHeight(entries);
    assert.deepEqual(fitRail(entries, exact).overflow, [], 'unchanged without moreRequired');
    const fit = fitRail(entries, exact, [], { moreRequired: true });
    assert.ok(fit.overflow.length > 0);
    assert.ok(railHeight(entries.filter((e) => fit.visible.includes(e.id))) + RAIL_ITEM_PX <= exact);
  });

  it('folds nothing when no panel waits (a loaded model)', () => {
    assert.deepEqual(layoutRail(entries, 0, [], null), { visible: entries.map((e) => e.id), overflow: [], waiting: [] });
  });
});
