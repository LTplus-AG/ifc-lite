/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7955 M11-F: the retained panel lists the selected product's persistent faces. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { RetainedFaceTable } from './RetainedFaceTable';

const faces = { 30: [{ key: '#26:side(0,0)', triangles: 6, areaM2: 10.56 }, { key: '#46>#50:cap(start)', triangles: 4, areaM2: 0.2667 }] };
const keys = () => [...document.querySelectorAll<HTMLElement>('[data-retained-face]')].map((row) => row.dataset.retainedFace);

afterEach(() => {
  cleanup();
  act(() => useViewerStore.setState({ selectedEntity: null }));
});

describe('#7955 M11-F retained face table', () => {
  it('lists the selected product rows in source order', () => {
    act(() => useViewerStore.setState({ selectedEntity: { modelId: 'm', expressId: 30 } }));
    render(<RetainedFaceTable modelId="m" faces={faces} />);
    assert.deepEqual(keys(), ['#26:side(0,0)', '#46>#50:cap(start)']);
    assert.match(document.querySelector('[data-retained-faces]')?.textContent ?? '', /Persistent faces of #30 \(2\).*10\.560.*0\.267/);
  });

  it('asks for a selection otherwise, and stays absent without tables', () => {
    act(() => useViewerStore.setState({ selectedEntity: { modelId: 'other', expressId: 30 } }));
    render(<RetainedFaceTable modelId="m" faces={faces} />);
    assert.deepEqual(keys(), []);
    assert.match(document.querySelector('[data-retained-faces]')?.textContent ?? '', /Select a published product/);
    cleanup();
    render(<RetainedFaceTable modelId="m" />);
    assert.equal(document.querySelector('[data-retained-faces]'), null);
  });
});
