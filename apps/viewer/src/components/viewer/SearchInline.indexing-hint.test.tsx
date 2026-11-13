/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The popover says a model is still being indexed whenever its tier-1 index is
// not ready: while the build runs, but also before it starts. The build waits
// for a load to settle (useSearchIndex), and a model can have no record yet or
// a record reset to 'pending'. Only 'ready' and 'error' end the hint.
import '@/test/setup-dom.js';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { SearchInline } from './SearchInline.js';

const MODEL_ID = 'model-a';
let initialState: ReturnType<typeof useViewerStore.getState>;

function popoverText(record: { status: string; progress: number } | null): string {
  useViewerStore.setState({
    ...fixtureModels(fixtureModel(MODEL_ID, { idOffset: 1_000_000, entities: [{ expressId: 42, type: 'IfcWall', name: 'Wall A' }] })),
    searchQuery: 'Zzz Nothing Here',
    searchOpen: true,
    searchIndexes: new Map(record ? [[MODEL_ID, record]] : []) as never,
  });
  return render(<SearchInline />).textContent ?? '';
}

describe('SearchInline — the indexing hint covers every model whose index is not ready', () => {
  before(() => { initialState = useViewerStore.getState(); });
  afterEach(cleanup);
  after(() => { useViewerStore.setState(initialState, true); });

  for (const [label, record] of [['no record yet', null], ['a pending record', { status: 'pending', progress: 0 }], ['a building record', { status: 'building', progress: 0.3 }]] as const) {
    it(`shows it for ${label}`, () => {
      assert.match(popoverText(record), /Indexing 1 model/);
    });
  }

  for (const status of ['ready', 'error'] as const) {
    it(`does not show it for a ${status} record`, () => {
      const text = popoverText({ status, progress: 1 });
      assert.doesNotMatch(text, /Indexing/);
      assert.match(text, /No results/);
    });
  }
});
