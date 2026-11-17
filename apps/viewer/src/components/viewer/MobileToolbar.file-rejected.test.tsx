/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The mobile Open and Add model pickers report an unsupported pick like the
 * desktop paths do: the "why" toast and a `file_open_rejected` event (#5618).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { render, cleanup } from '@/test/render';
import { toast } from '@/components/ui/toast';
import { posthog } from '@/lib/analytics';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { MobileToolbar } from './MobileToolbar';

const original = useViewerStore.getState();
let captured: unknown[][] = [];
let toasts: unknown[] = [];
beforeEach(() => {
  captured = [];
  toasts = [];
  mock.method(posthog, 'capture', (...args: unknown[]) => { captured.push(args); });
  mock.method(toast, 'error', (message: unknown) => { toasts.push(message); });
});
afterEach(() => { cleanup(); mock.restoreAll(); useViewerStore.setState(original); });

it('explains and reports an unsupported pick from both mobile file inputs', () => {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('model', { idOffset: 0 })), loading: false });
  const toolbar = render(
    <BimReactContext.Provider value={{} as BimContext}>
      <MobileToolbar />
    </BimReactContext.Provider>,
  );
  // Federation owns additional file inputs; target the model pickers explicitly (#8947).
  const inputs = ['#file-input-open', '#file-input-add'].map(selector => {
    const input = toolbar.querySelector<HTMLInputElement>(selector);
    assert.ok(input, selector); assert.equal(input.type, 'file'); return input;
  });
  for (const input of inputs) {
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([''], 'Scene.blend')] });
    act(() => input.dispatchEvent(new window.Event('change', { bubbles: true })));
  }
  assert.deepEqual(captured.filter(([name]) => name === 'file_open_rejected'), [
    ['file_open_rejected', { reason: 'unsupported_format' }],
    ['file_open_rejected', { reason: 'unsupported_format' }],
  ]);
  assert.equal(toasts.length, 2);
  for (const message of toasts) assert.match(String(message), /^Scene\.blend: Blender scene/);
});
