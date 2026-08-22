/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A wall split commits from TWO places, and #3023 only fixed one.
 *
 * `handleSelectionClick` (selectionHandlers.ts) is the click path, and
 * `selectionHandlers.wallSplitToast.test.ts` pins the skipped-openings notice
 * there. `SplitNumericInput.tsx` is the other one — type a distance, press
 * Enter — and it kept its own inline copy of the "(N openings reassigned)"
 * string with no reading of `openings.skipped` at all, so a skip stayed
 * exactly as silent on that path as it had been everywhere before #3023.
 *
 * These tests drive the real component's Enter-to-commit handler against a
 * stubbed `splitWallAtDistance` and assert on the toasts that reach the user,
 * both directions: a notice when `skipped > 0`, silence when it is 0.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { render } from '@/test/render';
import { SplitNumericInput } from './SplitNumericInput';

const originalInfo = toast.info;
const originalSuccess = toast.success;
let infoCalls: string[];
let successCalls: string[];

function splitResult(openings: { toLeft: number; toRight: number; skipped: number }) {
  return () => ({
    ok: true as const,
    left: { expressId: 1, globalId: 101 },
    right: { expressId: 2, globalId: 102 },
    openings,
  });
}

function seedStore(openings: { toLeft: number; toRight: number; skipped: number }) {
  useViewerStore.setState({
    activeTool: 'split',
    splitMode: 'aiming',
    splitHoverPoint: [0, 0, 0],
    splitHoverDistance: 1.5,
    splitHoverLength: 3,
    splitTargetModelId: 'm1',
    splitTargetExpressId: 42,
    cameraCallbacks: { projectToScreen: () => ({ x: 100, y: 100 }) },
    splitWallAtDistance: splitResult(openings),
    clearSplitHover: () => {},
    setSelectedEntityId: () => {},
  } as never);
}

/** Press Enter on the panel's numeric input — the commit gesture. */
function pressEnter(container: HTMLElement) {
  const input = container.querySelector('input');
  assert.ok(input, 'expected the split numeric input to render');
  act(() => {
    input!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
  });
}

describe('SplitNumericInput: the typed-distance path reports skipped openings too', () => {
  beforeEach(() => {
    infoCalls = [];
    successCalls = [];
    (toast as { info: (m: string) => void }).info = (m: string) => infoCalls.push(m);
    (toast as { success: (m: string) => void }).success = (m: string) => successCalls.push(m);
  });

  afterEach(() => {
    (toast as { info: (m: string) => void }).info = originalInfo;
    (toast as { success: (m: string) => void }).success = originalSuccess;
  });

  it('surfaces the skipped-openings notice, matching the click path word for word', () => {
    seedStore({ toLeft: 1, toRight: 0, skipped: 2 });
    const container = render(<SplitNumericInput />);
    pressEnter(container);

    assert.equal(successCalls.length, 1, 'expected the wall-split success toast');
    assert.ok(
      successCalls[0].includes('(1 opening reassigned)'),
      `expected the reassigned suffix, got: ${JSON.stringify(successCalls)}`,
    );
    assert.ok(
      infoCalls.some((m) => m.includes('2 openings could not be reassigned')),
      `expected a skipped-openings notice, got: ${JSON.stringify(infoCalls)}`,
    );
  });

  it('stays silent when nothing was skipped', () => {
    seedStore({ toLeft: 1, toRight: 1, skipped: 0 });
    const container = render(<SplitNumericInput />);
    pressEnter(container);

    assert.equal(successCalls.length, 1, 'expected the wall-split success toast');
    assert.equal(infoCalls.length, 0, 'expected no skipped-openings notice when skipped === 0');
  });
});
