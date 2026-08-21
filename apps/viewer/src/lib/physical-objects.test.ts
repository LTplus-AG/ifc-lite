/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  isPhysicalObjectType,
  collectPhysicalEntityIds,
  countPhysicalObjects,
  type EntityIdsByType,
} from './physical-objects.js';

describe('isPhysicalObjectType — what counts as a physical object', () => {
  it('counts IfcElement subtypes across the discipline range', () => {
    for (const t of [
      'IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCDOOR', 'IFCWINDOW', 'IFCSLAB',
      'IFCCOLUMN', 'IFCBEAM', 'IFCCOVERING', 'IFCBUILDINGELEMENTPROXY',
      'IFCFURNISHINGELEMENT', 'IFCFURNITURE', 'IFCDISTRIBUTIONELEMENT',
      'IFCFLOWSEGMENT', 'IFCFLOWTERMINAL', 'IFCSTAIRFLIGHT', 'IFCRAILING',
    ]) {
      assert.equal(isPhysicalObjectType(t), true, `${t} should be physical`);
    }
  });

  it('does NOT count spatial containers — they have no representation by design', () => {
    // These are the "cry wolf" cases: counting them would report objects as
    // missing that were never meant to be drawn.
    for (const t of ['IFCPROJECT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY']) {
      assert.equal(isPhysicalObjectType(t), false, `${t} should not be physical`);
    }
  });

  it('does NOT count IfcSpace (a spatial element, and hidden by default)', () => {
    // The judgement call, pinned: IfcSpace is a real object a user cares
    // about, but it descends from IfcSpatialElement rather than IfcElement and
    // the viewer ships with spaces hidden, so every model with rooms would
    // read "N not visible" permanently.
    assert.equal(isPhysicalObjectType('IFCSPACE'), false);
    assert.equal(isPhysicalObjectType('IFCSPATIALZONE'), false);
  });

  it('does NOT count feature elements — openings are voids, not objects', () => {
    // IfcOpeningElement IS an IfcElement subtype, so a naive chain test that
    // returned true on the first IFCELEMENT hit would wrongly include it.
    assert.equal(isPhysicalObjectType('IFCOPENINGELEMENT'), false);
    assert.equal(isPhysicalObjectType('IFCVOIDINGFEATURE'), false);
  });

  it('does NOT count IfcVirtualElement (non-physical clearance volume)', () => {
    assert.equal(isPhysicalObjectType('IFCVIRTUALELEMENT'), false);
  });

  it('does NOT count drafting aids or non-product records', () => {
    for (const t of [
      'IFCANNOTATION', 'IFCGRID', 'IFCPROPERTYSET', 'IFCPROPERTYSINGLEVALUE',
      'IFCRELCONTAINEDINSPATIALSTRUCTURE', 'IFCCARTESIANPOINT', 'IFCWALLTYPE',
      'IFCMATERIAL', 'IFCOWNERHISTORY',
    ]) {
      assert.equal(isPhysicalObjectType(t), false, `${t} should not be physical`);
    }
  });

  it('accepts mixed-case type names (the index is uppercase, callers may not be)', () => {
    assert.equal(isPhysicalObjectType('IfcWall'), true);
    assert.equal(isPhysicalObjectType('IfcSpace'), false);
  });

  it('is stable across repeated calls (the cache must not flip an answer)', () => {
    // A cache keyed on the raw string must still agree with itself when the
    // same type arrives in two different casings.
    assert.equal(isPhysicalObjectType('IFCWALL'), isPhysicalObjectType('ifcwall'));
    assert.equal(isPhysicalObjectType('IFCOPENINGELEMENT'), isPhysicalObjectType('ifcopeningelement'));
  });
});

/**
 * A stand-in entity index. Mirrors the real `entityIndex.byType`: uppercase
 * STEP keyword -> expressIds, holding EVERY parsed entity, not just elements.
 */
const byType: EntityIdsByType = new Map<string, number[]>([
  ['IFCWALL', [101, 102, 103]],
  ['IFCDOOR', [104, 105]],
  ['IFCSLAB', [106]],
  // Non-physical noise that must not reach the denominator:
  ['IFCSPACE', [201, 202]],
  ['IFCBUILDINGSTOREY', [301]],
  ['IFCBUILDING', [302]],
  ['IFCSITE', [303]],
  ['IFCOPENINGELEMENT', [401, 402, 403, 404]],
  ['IFCVIRTUALELEMENT', [405]],
  ['IFCPROPERTYSET', [501, 502]],
  ['IFCCARTESIANPOINT', [601, 602, 603, 604, 605]],
]);

const NO_FILTERS = {
  hiddenEntities: new Set<number>(),
  isolatedEntities: null,
  classFilter: null,
  ghostExceptEntities: null,
};

describe('collectPhysicalEntityIds — the denominator', () => {
  it('keeps only the physical objects out of a mixed index', () => {
    const ids = collectPhysicalEntityIds(byType);
    assert.deepEqual([...ids].sort((a, b) => a - b), [101, 102, 103, 104, 105, 106]);
  });

  it('excludes the 17 non-physical entities a naive count would include', () => {
    // Guards the headline claim: the denominator is 6, not the 23 records in
    // the index. If this ever became 23 the badge would cry wolf on every
    // model, since spaces/openings are hidden by default.
    const totalRecords = [...byType.values()].reduce((n, ids) => n + ids.length, 0);
    assert.equal(totalRecords, 23);
    assert.equal(collectPhysicalEntityIds(byType).size, 6);
    assert.equal(totalRecords - collectPhysicalEntityIds(byType).size, 17);
  });

  it('dedupes an id listed under two type keys', () => {
    // `byType` can list the same expressId under two keys; a plain length sum
    // would double-count it.
    const dupes: EntityIdsByType = new Map([['IFCWALL', [7, 8]], ['IFCWALLSTANDARDCASE', [8, 9]]]);
    assert.equal(collectPhysicalEntityIds(dupes).size, 3);
  });

  it('returns an empty set when no model is loaded', () => {
    assert.equal(collectPhysicalEntityIds(null).size, 0);
    assert.equal(collectPhysicalEntityIds(undefined).size, 0);
  });
});

describe('countPhysicalObjects — reacting to the visibility filters', () => {
  const physicalIds = collectPhysicalEntityIds(byType);

  it('full model: everything visible, nothing hidden, nothing ghosted', () => {
    const c = countPhysicalObjects(physicalIds, NO_FILTERS);
    assert.deepEqual(c, { total: 6, visible: 6, hidden: 0, ghosted: 0 });
  });

  it('no model loaded: 0 of 0, and nothing reported as hidden', () => {
    const c = countPhysicalObjects(new Set(), NO_FILTERS);
    assert.deepEqual(c, { total: 0, visible: 0, hidden: 0, ghosted: 0 });
  });

  it('hidden set: subtracts exactly the hidden physical objects', () => {
    const c = countPhysicalObjects(physicalIds, {
      ...NO_FILTERS,
      hiddenEntities: new Set([101, 104]),
    });
    assert.deepEqual(c, { total: 6, visible: 4, hidden: 2, ghosted: 0 });
  });

  it('hidden set: ignores hidden ids that are not physical objects', () => {
    // Hiding two spaces and an opening must not change a count OF ELEMENTS.
    // A `total - hiddenEntities.size` shortcut would report 3 of 6 here.
    const c = countPhysicalObjects(physicalIds, {
      ...NO_FILTERS,
      hiddenEntities: new Set([201, 202, 401]),
    });
    assert.deepEqual(c, { total: 6, visible: 6, hidden: 0, ghosted: 0 });
  });

  it('isolation: counts the intersection with the physical set, not its size', () => {
    // The isolation set carries the storey's non-physical children too, so
    // `isolatedEntities.size` (the old dead code's answer) would say 5.
    const c = countPhysicalObjects(physicalIds, {
      ...NO_FILTERS,
      isolatedEntities: new Set([101, 102, 201, 301, 401]),
    });
    assert.deepEqual(c, { total: 6, visible: 2, hidden: 4, ghosted: 0 });
  });

  it('isolation of an empty set hides everything', () => {
    const c = countPhysicalObjects(physicalIds, { ...NO_FILTERS, isolatedEntities: new Set() });
    assert.deepEqual(c, { total: 6, visible: 0, hidden: 6, ghosted: 0 });
  });

  it('isolation is distinct from no isolation (null is not an empty set)', () => {
    const none = countPhysicalObjects(physicalIds, { ...NO_FILTERS, isolatedEntities: null });
    const empty = countPhysicalObjects(physicalIds, { ...NO_FILTERS, isolatedEntities: new Set() });
    assert.equal(none.visible, 6);
    assert.equal(empty.visible, 0);
  });

  it('class filter: restricts the visible count independently of isolation', () => {
    const c = countPhysicalObjects(physicalIds, {
      ...NO_FILTERS,
      classFilter: { ids: new Set([104, 105]) },
    });
    assert.deepEqual(c, { total: 6, visible: 2, hidden: 4, ghosted: 0 });
  });

  it('isolation and hidden set compose — hidden still wins inside isolation', () => {
    const c = countPhysicalObjects(physicalIds, {
      ...NO_FILTERS,
      isolatedEntities: new Set([101, 102, 103]),
      hiddenEntities: new Set([103]),
    });
    assert.deepEqual(c, { total: 6, visible: 2, hidden: 4, ghosted: 0 });
  });

  it('isolation and class filter compose as an intersection', () => {
    const c = countPhysicalObjects(physicalIds, {
      ...NO_FILTERS,
      isolatedEntities: new Set([101, 102, 104]),
      classFilter: { ids: new Set([102, 104, 105]) },
    });
    assert.deepEqual(c, { total: 6, visible: 2, hidden: 4, ghosted: 0 });
  });

  it('ghost: ghosted objects stay VISIBLE and are reported separately', () => {
    // X-Ray renders the rest translucent, not hidden. Counting ghosted as
    // hidden would report "2 of 6 visible" for a view that draws all six.
    const c = countPhysicalObjects(physicalIds, {
      ...NO_FILTERS,
      ghostExceptEntities: new Set([101, 102]),
    });
    assert.deepEqual(c, { total: 6, visible: 6, hidden: 0, ghosted: 4 });
  });

  it('ghost: a hidden object is not also counted as ghosted', () => {
    const c = countPhysicalObjects(physicalIds, {
      ...NO_FILTERS,
      hiddenEntities: new Set([106]),
      ghostExceptEntities: new Set([101]),
    });
    assert.deepEqual(c, { total: 6, visible: 5, hidden: 1, ghosted: 4 });
  });

  it('clearing every filter returns to the full count', () => {
    const filtered = countPhysicalObjects(physicalIds, {
      ...NO_FILTERS,
      isolatedEntities: new Set([101]),
      hiddenEntities: new Set([102]),
      classFilter: { ids: new Set([101]) },
      ghostExceptEntities: new Set([101]),
    });
    assert.equal(filtered.visible, 1);

    const cleared = countPhysicalObjects(physicalIds, NO_FILTERS);
    assert.deepEqual(cleared, { total: 6, visible: 6, hidden: 0, ghosted: 0 });
  });

  it('visible + hidden always equals total', () => {
    for (const filters of [
      NO_FILTERS,
      { ...NO_FILTERS, hiddenEntities: new Set([101, 102]) },
      { ...NO_FILTERS, isolatedEntities: new Set([104]) },
      { ...NO_FILTERS, classFilter: { ids: new Set([106]) } },
    ]) {
      const c = countPhysicalObjects(physicalIds, filters);
      assert.equal(c.visible + c.hidden, c.total);
    }
  });
});
