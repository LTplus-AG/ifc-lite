/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Stop ends a run at once, and a stopped run never publishes over, or releases, a run started after it. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { playNativePresentation, presentationPlaybackState, stopPresentationPlayback } from './playback';

const view = (id: string) => ({ id, name: id, transitionMs: 150 }) as never;

let savedViews: unknown;
beforeEach(() => { savedViews = useViewerStore.getState().basketViews; });
afterEach(() => { stopPresentationPlayback(); useViewerStore.setState({ basketViews: savedViews } as never); });

it('#8947 Stop publishes cancelled at once, and Play right after owns the playback', async () => {
  useViewerStore.setState({ basketViews: [view('a'), view('b')] } as never);
  const noop = () => undefined; // keep the store's camera untouched
  const first = playNativePresentation(['a', 'b'], { repetitions: 1, beforeActivate: noop });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(presentationPlaybackState().state, 'running');

  stopPresentationPlayback();
  assert.equal(presentationPlaybackState().state, 'cancelled', 'Stop is visible synchronously');

  const second = playNativePresentation(['a'], { repetitions: 0, beforeActivate: noop });
  // Awaiting the stopped run guarantees its catch and finally have run: nothing of it can publish later.
  assert.equal((await first).state, 'cancelled', 'the stopped run reports its own end');
  assert.equal(presentationPlaybackState().state, 'running', 'the stopped run did not publish over the new one');

  stopPresentationPlayback();
  assert.equal((await second).state, 'cancelled', 'Stop still reaches the new run: its controller was not released by the old one');
});
