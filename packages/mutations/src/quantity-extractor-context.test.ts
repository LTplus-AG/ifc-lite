/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { QuantityType } from '@ifc-lite/data';
import { MutablePropertyView } from './mutable-property-view.js';

/** A base that reports which view asked, and for whom, as quantities of a set. */
function counting(view: MutablePropertyView, seen: Array<[number, MutablePropertyView, number]>): void {
  view.setQuantityExtractor((id, asking, occurrence) => {
    seen.push([id, asking, occurrence]);
    return [{ name: 'Qto', quantities: [{ name: 'Q', type: QuantityType.Length, value: id }] }];
  });
}

describe('a quantity extractor is told who is asking (#9026 item 20)', () => {
  it('receives the entity id, and the occurrence behind an alias', () => {
    const view = new MutablePropertyView(null, 'm');
    const seen: Array<[number, MutablePropertyView, number]> = [];
    counting(view, seen);
    view.setExpressIdWatermark(10);
    const copy = view.createEntity('IfcWall', []).expressId;
    view.setEntityAlias(copy, 5);
    view.getQuantitiesForEntity(copy);
    expect(seen.at(-1)).toEqual([5, view, copy]);
  });

  it('receives the draft inside a transaction, so the base can read the draft\'s own edits', () => {
    const view = new MutablePropertyView(null, 'm');
    const seen: Array<[number, MutablePropertyView, number]> = [];
    counting(view, seen);
    view.runAtomic((draft) => {
      draft.getQuantitiesForEntity(3);
      expect(seen.at(-1)?.[1]).toBe(draft);
    });
    view.getQuantitiesForEntity(3);
    expect(seen.at(-1)?.[1]).toBe(view);
  });
});
