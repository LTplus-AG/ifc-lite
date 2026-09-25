/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared export-dialog close guard (#5605): closing is refused while
 * busy, opening is never gated, and `onOpen` runs only on open.
 */

import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup } from '@/test/render.js';
import { useExportDialogOpenGuard } from './useExportDialogOpenGuard.js';

function mountGuard(busy: boolean) {
  const calls: { setOpen: boolean[]; onOpen: number } = { setOpen: [], onOpen: 0 };
  let handler: ((open: boolean) => void) | null = null;
  function Harness() {
    handler = useExportDialogOpenGuard({
      busy,
      setOpen: (open) => calls.setOpen.push(open),
      onOpen: () => { calls.onOpen += 1; },
    });
    return null;
  }
  render(<Harness />);
  return {
    calls,
    change(open: boolean) {
      assert.ok(handler, 'the harness must have rendered');
      const h = handler;
      act(() => h(open));
    },
  };
}

describe('useExportDialogOpenGuard (#5605)', () => {
  afterEach(cleanup);

  it('refuses to close while an export is in flight', () => {
    const g = mountGuard(true);
    g.change(false);
    assert.deepEqual(g.calls.setOpen, []);
  });

  it('closes when idle', () => {
    const g = mountGuard(false);
    g.change(false);
    assert.deepEqual(g.calls.setOpen, [false]);
    assert.equal(g.calls.onOpen, 0, 'closing must not run the open reset');
  });

  it('opens even while busy and runs onOpen', () => {
    const g = mountGuard(true);
    g.change(true);
    assert.deepEqual(g.calls.setOpen, [true]);
    assert.equal(g.calls.onOpen, 1);
  });
});
