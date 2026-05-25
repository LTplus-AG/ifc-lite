/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { switchFlavor, type FlavorSwitcherCallbacks } from './switcher.js';
import type { Flavor } from './types.js';

function flavor(id: string, extensionIds: string[]): Flavor {
  return {
    schemaVersion: 1,
    id,
    name: id,
    description: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    extensions: extensionIds.map((eid) => ({ id: eid, version: '1.0.0', grantedCapabilities: [] })),
    lenses: [],
    savedQueries: [],
    keybindings: [],
    layout: { state: {} },
    settings: {},
  };
}

function makeCallbacks(overrides: Partial<FlavorSwitcherCallbacks> = {}): FlavorSwitcherCallbacks {
  return {
    setEnabled: vi.fn().mockResolvedValue(undefined),
    deactivate: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(true),
    setActiveFlavor: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('switchFlavor', () => {
  it('enables wanted extensions and disables non-wanted', async () => {
    const callbacks = makeCallbacks();
    const result = await switchFlavor({
      target: flavor('flv.b', ['ext.b']),
      current: flavor('flv.a', ['ext.a']),
      installed: [
        { id: 'ext.a', enabled: true },
        { id: 'ext.b', enabled: false },
      ],
      callbacks,
    });
    expect(result.ok).toBe(true);
    expect(result.enabled).toContain('ext.b');
    expect(result.disabled).toContain('ext.a');
    expect(callbacks.setActiveFlavor).toHaveBeenCalledWith('flv.b');
  });

  it('skips already-correct extensions', async () => {
    const callbacks = makeCallbacks();
    const result = await switchFlavor({
      target: flavor('flv.a', ['ext.a']),
      installed: [{ id: 'ext.a', enabled: true }],
      callbacks,
    });
    expect(result.ok).toBe(true);
    expect(callbacks.setEnabled).not.toHaveBeenCalled();
  });

  it('rolls back on reload failure', async () => {
    const callbacks = makeCallbacks({
      reload: vi.fn().mockResolvedValue(false),
    });
    const result = await switchFlavor({
      target: flavor('flv.b', ['ext.b']),
      current: flavor('flv.a', []),
      installed: [{ id: 'ext.b', enabled: false }],
      callbacks,
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['ext.b']);
    // Rollback: setEnabled invoked with the prior state (false) too.
    const calls = (callbacks.setEnabled as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toContainEqual(['ext.b', false]);
    expect(callbacks.setActiveFlavor).not.toHaveBeenCalled();
  });

  it('rolls back on deactivate failure', async () => {
    const callbacks = makeCallbacks({
      deactivate: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const result = await switchFlavor({
      target: flavor('flv.b', []),
      current: flavor('flv.a', ['ext.a']),
      installed: [{ id: 'ext.a', enabled: true }],
      callbacks,
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['ext.a']);
  });

  it('rolls back on setActiveFlavor failure', async () => {
    const callbacks = makeCallbacks({
      setActiveFlavor: vi.fn().mockRejectedValue(new Error('pointer io')),
    });
    const result = await switchFlavor({
      target: flavor('flv.b', ['ext.b']),
      current: flavor('flv.a', []),
      installed: [{ id: 'ext.b', enabled: false }],
      callbacks,
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('<pointer>');
  });
});
