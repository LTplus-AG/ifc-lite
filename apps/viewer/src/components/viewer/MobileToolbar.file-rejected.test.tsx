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
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { render, cleanup } from '@/test/render';
import { toast } from '@/components/ui/toast';
import { posthog } from '@/lib/analytics';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { MobileToolbar } from './MobileToolbar';

let captured: unknown[][] = [];
let toasts: unknown[] = [];
beforeEach(() => {
  captured = [];
  toasts = [];
  mock.method(posthog, 'capture', (...args: unknown[]) => { captured.push(args); });
  mock.method(toast, 'error', (message: unknown) => { toasts.push(message); });
});
afterEach(() => { cleanup(); mock.restoreAll(); });

it('explains and reports an unsupported pick from both mobile file inputs', () => {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('model', { idOffset: 0 })), loading: false });
  const toolbar = render(
    <BimReactContext.Provider value={{} as BimContext}>
      <MobileToolbar />
    </BimReactContext.Provider>,
  );
  const inputs = [...toolbar.querySelectorAll<HTMLInputElement>('input[type="file"]')];
  assert.equal(inputs.length, 2, 'the Open and Add model pickers');
  for (const input of inputs) {
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([''], 'Scene.blend')] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  assert.deepEqual(captured.filter(([name]) => name === 'file_open_rejected'), [
    ['file_open_rejected', { reason: 'unsupported_format' }],
    ['file_open_rejected', { reason: 'unsupported_format' }],
  ]);
  assert.equal(toasts.length, 2);
  assert.match(String(toasts[0]), /^Scene\.blend: Blender scene/);
});
