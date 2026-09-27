/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { cleanup, render } from '@/test/render';
import { useThemeDocumentClass } from './useThemeDocumentClass';

function Probe() {
  useThemeDocumentClass();
  return null;
}

describe('useThemeDocumentClass', () => {
  const initial = useViewerStore.getState().theme;
  afterEach(() => {
    cleanup();
    useViewerStore.setState({ theme: initial });
  });

  it('follows the store theme on the document element', () => {
    useViewerStore.setState({ theme: 'dark' });
    render(<Probe />);
    const root = document.documentElement.classList;
    assert.equal(root.contains('dark'), true);
    assert.equal(root.contains('colorful'), false);

    act(() => useViewerStore.setState({ theme: 'colorful' }));
    assert.equal(root.contains('dark'), false);
    assert.equal(root.contains('colorful'), true);

    act(() => useViewerStore.setState({ theme: 'light' }));
    assert.equal(root.contains('dark'), false);
    assert.equal(root.contains('colorful'), false);
  });
});
