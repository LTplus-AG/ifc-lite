/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { SlotRegistry } from './slot-registry.js';

interface ToolbarPayload {
  command: string;
  slot: 'toolbar.left' | 'toolbar.right' | 'toolbar.center';
  order?: number;
}

function tb(extId: string, slot: ToolbarPayload['slot'], command: string, order?: number) {
  return {
    extensionId: extId,
    slot,
    payload: { command, slot, order },
  };
}

describe('SlotRegistry — registration', () => {
  it('returns empty list for unknown slot', () => {
    const reg = new SlotRegistry();
    expect(reg.getAll('foo')).toEqual([]);
  });

  it('registers and reads back contributions', () => {
    const reg = new SlotRegistry();
    reg.register('ext-a', [tb('ext-a', 'toolbar.right', 'ext.a.cmd1')]);
    expect(reg.getAll('toolbar.right')).toHaveLength(1);
  });

  it('preserves registration order across extensions', () => {
    const reg = new SlotRegistry();
    reg.register('ext-a', [tb('ext-a', 'toolbar.right', 'a')]);
    reg.register('ext-b', [tb('ext-b', 'toolbar.right', 'b')]);
    reg.register('ext-c', [tb('ext-c', 'toolbar.right', 'c')]);
    const all = reg.getAll<ToolbarPayload>('toolbar.right');
    expect(all.map((c) => c.payload.command)).toEqual(['a', 'b', 'c']);
  });

  it('listSlots reflects active slots', () => {
    const reg = new SlotRegistry();
    reg.register('ext-a', [tb('ext-a', 'toolbar.left', 'a')]);
    reg.register('ext-b', [tb('ext-b', 'toolbar.right', 'b')]);
    expect(reg.listSlots().sort()).toEqual(['toolbar.left', 'toolbar.right']);
  });

  it('rejects mismatched extensionId in payload', () => {
    const reg = new SlotRegistry();
    expect(() =>
      reg.register('ext-a', [tb('ext-b', 'toolbar.left', 'x')]),
    ).toThrow(/does not match/);
  });
});

describe('SlotRegistry — unregister', () => {
  it('removes contributions for the given extension', () => {
    const reg = new SlotRegistry();
    reg.register('ext-a', [tb('ext-a', 'toolbar.right', 'a')]);
    reg.register('ext-b', [tb('ext-b', 'toolbar.right', 'b')]);
    reg.unregister('ext-a');
    expect(reg.getAll<ToolbarPayload>('toolbar.right').map((c) => c.payload.command)).toEqual(['b']);
  });

  it('removes the slot entry when last contribution leaves', () => {
    const reg = new SlotRegistry();
    reg.register('ext-a', [tb('ext-a', 'toolbar.right', 'a')]);
    reg.unregister('ext-a');
    expect(reg.listSlots()).toEqual([]);
  });

  it('is a no-op for unknown extension', () => {
    const reg = new SlotRegistry();
    expect(() => reg.unregister('ext-x')).not.toThrow();
  });
});

describe('SlotRegistry — listeners', () => {
  it('emits initial snapshot on subscribe', () => {
    const reg = new SlotRegistry();
    reg.register('ext-a', [tb('ext-a', 'toolbar.right', 'a')]);
    const listener = vi.fn();
    reg.subscribe('toolbar.right', listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toHaveLength(1);
  });

  it('emits on register', () => {
    const reg = new SlotRegistry();
    const listener = vi.fn();
    reg.subscribe('toolbar.right', listener);
    reg.register('ext-a', [tb('ext-a', 'toolbar.right', 'a')]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('emits on unregister', () => {
    const reg = new SlotRegistry();
    reg.register('ext-a', [tb('ext-a', 'toolbar.right', 'a')]);
    const listener = vi.fn();
    reg.subscribe('toolbar.right', listener);
    listener.mockClear();
    reg.unregister('ext-a');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toHaveLength(0);
  });

  it('unsubscribe stops further notifications', () => {
    const reg = new SlotRegistry();
    const listener = vi.fn();
    const unsubscribe = reg.subscribe('toolbar.right', listener);
    unsubscribe();
    reg.register('ext-a', [tb('ext-a', 'toolbar.right', 'a')]);
    // Initial emit counts as 1; no further calls after unsubscribe.
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('SlotRegistry — atomic multi-slot register', () => {
  it('notifies each affected slot exactly once per call', () => {
    const reg = new SlotRegistry();
    const left = vi.fn();
    const right = vi.fn();
    reg.subscribe('toolbar.left', left);
    reg.subscribe('toolbar.right', right);
    left.mockClear();
    right.mockClear();

    reg.register('ext-a', [
      tb('ext-a', 'toolbar.left', 'a'),
      tb('ext-a', 'toolbar.right', 'b'),
      tb('ext-a', 'toolbar.left', 'c'),
    ]);

    expect(left).toHaveBeenCalledTimes(1);
    expect(right).toHaveBeenCalledTimes(1);
    expect(left.mock.calls[0][0]).toHaveLength(2);
    expect(right.mock.calls[0][0]).toHaveLength(1);
  });
});

describe('SlotRegistry — clear', () => {
  it('removes all contributions', () => {
    const reg = new SlotRegistry();
    reg.register('ext-a', [tb('ext-a', 'toolbar.left', 'a')]);
    reg.register('ext-b', [tb('ext-b', 'toolbar.right', 'b')]);
    reg.clear();
    expect(reg.listSlots()).toEqual([]);
    expect(reg.hasExtension('ext-a')).toBe(false);
  });
});
