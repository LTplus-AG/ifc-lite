/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { act } from 'react';
import { advance, cleanup, click, press, type as enterText } from '@/test/render';
import { destinationOption, mountDestinations } from '@/test/palette-destinations';
import { useViewerStore } from '@/store';
import { SearchInline } from './SearchInline';
import { MobileSearchInline } from './MobileSearchInline';

const initial = useViewerStore.getState();
let host: ReturnType<typeof mountDestinations> | undefined;
afterEach(async () => {
  cleanup(); mock.restoreAll(); await host?.dispose(); host = undefined;
  act(() => useViewerStore.setState(initial, true));
});
for (const mobile of [false, true]) for (const framesFirst of [false, true]) {
  test(`#8947 inline focus survives real palette close (${mobile ? 'mobile' : 'desktop'}, frames ${framesFirst ? 'before' : 'after'} timers)`, async () => {
    const frames: FrameRequestCallback[] = [];
    mock.method(globalThis, 'requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    const flushFrames = () => act(() => { for (const callback of frames.splice(0)) callback(0); });
    act(() => useViewerStore.setState({ searchQuery: '', searchOpen: false, searchVimCycle: null }));
    host = mountDestinations(mobile ? <MobileSearchInline /> : <SearchInline />);
    const launcher = document.querySelector<HTMLButtonElement>('[data-palette-launcher]')!;
    launcher.focus(); click(launcher);
    click(destinationOption('search:inline'));
    if (framesFirst) flushFrames();
    await advance(20);
    flushFrames(); await advance(20);
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search entities"]')!;
    assert.ok(input); assert.equal(input.closest('[hidden]'), null);
    assert.equal(document.activeElement, input, 'close restoration must not steal destination focus');
    enterText(input, 'wall'); assert.equal(useViewerStore.getState().searchQuery, 'wall');
    // Ordinary Escape still restores the connected launcher, with no pending handoff.
    act(() => useViewerStore.getState().setSearchOpen(false));
    launcher.focus(); click(launcher);
    const paletteInput = document.querySelector<HTMLInputElement>('[role="dialog"][aria-label="Command palette"] input')!;
    press(paletteInput, 'Escape'); await advance(20); flushFrames(); await advance(20);
    assert.equal(document.activeElement, launcher);
  });
}
