/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { cloneElement, isValidElement, useState, type ReactNode } from 'react';

import { cleanup, click, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { renderPanelBody } from './renderPanelBody';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup();
  useViewerStore.setState(initial, true);
});

function FailedChunk(): never {
  throw new Error('Failed to fetch dynamically imported module: https://example.invalid/panel.js');
}

// Control the chunk's success/failure without loading its unrelated application
// dependencies. The real host boundary, key and outer context remain untouched.
function chunkBody(id: 'assistant' | 'compare', children: ReactNode): ReactNode {
  const host = renderPanelBody(id, () => undefined);
  assert.ok(isValidElement<{ children: ReactNode }>(host));
  const boundary = host.props.children;
  assert.ok(isValidElement<{ children: ReactNode }>(boundary));
  return cloneElement(host, {}, cloneElement(boundary, {}, children));
}

function SwitchingHost({ from, to }: { from: 'assistant' | 'compare'; to: 'assistant' | 'compare' }) {
  const [switched, setSwitched] = useState(false);
  const [used, setUsed] = useState(false);
  return <>
    <button onClick={() => setSwitched(true)}>Switch panel</button>
    {switched
      ? chunkBody(to, <button onClick={() => setUsed(true)}>{used ? 'Panel used' : 'Use healthy panel'}</button>)
      : chunkBody(from, <FailedChunk />)}
  </>;
}

for (const [from, to] of [['assistant', 'compare'], ['compare', 'assistant']] as const) {
  it(`a failed ${from} chunk does not poison healthy ${to} in the same host (#8017)`, () => {
    useViewerStore.setState({ models: new Map(), activeModelId: null, compareResult: null });
    const ui = render(<SwitchingHost from={from} to={to} />);
    assert.ok(ui.querySelector('[role="alert"]'), 'the original chunk really failed');
    click(ui.querySelector('button')!);
    assert.match(ui.textContent ?? '', /Use healthy panel/, `healthy ${to} mounts after failed ${from}`);
    assert.equal(ui.querySelector('[role="alert"]'), null, 'the old error is not relabelled as the new panel');
    click([...ui.querySelectorAll('button')].find(button => button.textContent === 'Use healthy panel')!);
    assert.match(ui.textContent ?? '', /Panel used/, 'the destination subtree remains interactive');
  });
}
