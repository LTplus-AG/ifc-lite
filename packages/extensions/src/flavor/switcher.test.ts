/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { switchFlavor, type FlavorSwitcherCallbacks } from './switcher.js';
import type { Flavor, FlavorExtension } from './types.js';

function flavor(id: string, extensionIds: string[]): Flavor {
  return {
    schemaVersion: 1,
    id,
    name: id,
    description: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    extensions: extensionIds.map(
      (eid): FlavorExtension => ({
        id: eid,
        version: '1.0.0',
        source: 'local',
        bundleHash: 'a'.repeat(64),
        grantedCapabilities: [],
        enabled: true,
      }),
    ),
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
  it('does not fail the switch when the refused pointer write already stored the target', async () => {
    // The pointer write is refused, but the pointer on disk already names the
    // target: that write would have changed nothing, so the extension toggles
    // that landed must stand and the switch must report success.
    const callbacks = makeCallbacks({
      setActiveFlavor: vi.fn().mockRejectedValue(new Error('pointer io')),
      readActiveFlavor: vi.fn().mockResolvedValue('flv.b'),
    });
    const result = await switchFlavor({
      target: flavor('flv.b', ['ext.b']),
      current: flavor('flv.a', []),
      installed: [{ id: 'ext.b', enabled: false }],
      callbacks,
    });
    expect(result.ok).toBe(true);
    expect(result.active.id).toBe('flv.b');
    expect(result.failures).toEqual([]);
    expect(result.enabled).toEqual(['ext.b']);
    // No rollback: ext.b stays enabled.
    const calls = (callbacks.setEnabled as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toEqual([['ext.b', true]]);
  });

  it('still fails when the refused pointer write would have stored a different id', async () => {
    const callbacks = makeCallbacks({
      setActiveFlavor: vi.fn().mockRejectedValue(new Error('pointer io')),
      readActiveFlavor: vi.fn().mockResolvedValue('flv.a'),
    });
    const result = await switchFlavor({
      target: flavor('flv.b', ['ext.b']),
      current: flavor('flv.a', []),
      installed: [{ id: 'ext.b', enabled: false }],
      callbacks,
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('<pointer>');
    const calls = (callbacks.setEnabled as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toContainEqual(['ext.b', false]);
  });

  it('still fails when the pointer is unreadable', async () => {
    // One-directional: anything not provably identical is a refusal, which is
    // the behaviour a host without the callback already had.
    const callbacks = makeCallbacks({
      setActiveFlavor: vi.fn().mockRejectedValue(new Error('pointer io')),
      readActiveFlavor: vi.fn().mockRejectedValue(new Error('read io')),
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

  it('still fails when the host cannot read the pointer back at all', async () => {
    const callbacks = makeCallbacks({
      setActiveFlavor: vi.fn().mockRejectedValue(new Error('pointer io')),
    });
    expect(callbacks.readActiveFlavor).toBeUndefined();
    const result = await switchFlavor({
      target: flavor('flv.b', ['ext.b']),
      current: flavor('flv.a', []),
      installed: [{ id: 'ext.b', enabled: false }],
      callbacks,
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('<pointer>');
  });

  it('compares the pointer against the id it hands setActiveFlavor, not the current flavor', async () => {
    // Guards the compare-the-wrong-pair mutant: reading back `current.id` and
    // calling that a no-op would pass the stored pointer off as the target.
    const seen: string[] = [];
    const callbacks = makeCallbacks({
      setActiveFlavor: vi.fn(async (id: string) => {
        seen.push(id);
        throw new Error('pointer io');
      }),
      readActiveFlavor: vi.fn().mockResolvedValue('flv.a'),
    });
    const result = await switchFlavor({
      target: flavor('flv.b', []),
      current: flavor('flv.a', []),
      installed: [],
      callbacks,
    });
    expect(seen).toEqual(['flv.b']);
    expect(result.ok).toBe(false);
  });
});
