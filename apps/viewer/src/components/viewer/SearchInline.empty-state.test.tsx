/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The toolbar search box is where #4091's reporter typed a selector, and it
 * answered "No results — try a name, IFC type, or full GlobalId." That is the
 * reported shape in miniature: a valid selector, an empty list, and nothing
 * saying the box does not read that language.
 *
 * It still does not read it — routing tier-0 search through the parser would
 * change an existing surface's result set and is its own issue (#4094). What
 * it does now is NAME the syntax and point at the tab that runs it.
 */

import '@/test/setup-dom.js';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { SearchInline } from './SearchInline.js';

const MODEL_ID = 'model-a';

let initialState: ReturnType<typeof useViewerStore.getState>;

/** Seed a loaded model whose only entity matches nothing the tests type. */
function mountWithQuery(searchQuery: string): HTMLElement {
  useViewerStore.setState({
    ...fixtureModels(
      fixtureModel(MODEL_ID, {
        idOffset: 1_000_000,
        entities: [{ expressId: 42, type: 'IfcWall', name: 'Wall A' }],
      }),
    ),
    searchQuery,
    searchOpen: true,
    // Pin the search to the tier-0 scan: a 'building' record makes
    // `useSearchIndex` skip the model rather than resolve a tier-1 build
    // outside `act()`. `indexingCount` counts these, so the popover would
    // show its indexing line instead — 'ready' keeps it at zero.
    searchIndexes: new Map([[MODEL_ID, { status: 'ready', progress: 1 }]]) as never,
  });
  return render(<SearchInline />);
}

describe('SearchInline — the empty popover names selector syntax', () => {
  before(() => { initialState = useViewerStore.getState(); });
  afterEach(cleanup);
  after(() => { useViewerStore.setState(initialState, true); });

  it('a selector that finds nothing says where selectors are run', () => {
    const container = mountWithQuery('IfcWall, Pset_WallCommon.FireRating=2HR');
    const text = container.textContent ?? '';
    assert.match(text, /selector syntax/i);
    assert.match(text, /Filter tab/i);
  });

  it('plain text that finds nothing keeps the advice it always had', () => {
    const container = mountWithQuery('Zzz Nothing Here');
    const text = container.textContent ?? '';
    assert.match(text, /No results/);
    assert.doesNotMatch(text, /selector syntax/i);
  });

  it('a bare class name is a selector too, and is named as one', () => {
    // It also happens to match the seeded wall by TYPE, so this asserts the
    // hint reaches the empty state only — with rows present there is no
    // empty state to read.
    const container = mountWithQuery('IfcSlab');
    assert.match(container.textContent ?? '', /selector syntax/i);
  });
});
