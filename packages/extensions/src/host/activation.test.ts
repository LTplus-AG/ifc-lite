/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { ActivationDispatcher } from './activation.js';

describe('ActivationDispatcher — registration', () => {
  it('registers and lists extensions', () => {
    const d = new ActivationDispatcher();
    d.register('ext-a', ['onStartup']);
    expect(d.listExtensions()).toEqual(['ext-a']);
    expect(d.listEvents()).toEqual(['onStartup']);
  });

  it('replacing a registration drops the old events', () => {
    const d = new ActivationDispatcher();
    d.register('ext-a', ['onStartup', 'onModelLoad']);
    d.register('ext-a', ['onCommand:foo']);
    expect(d.listEvents()).toEqual(['onCommand:foo']);
  });

  it('unregister removes everything', () => {
    const d = new ActivationDispatcher();
    d.register('ext-a', ['onStartup']);
    d.register('ext-b', ['onStartup']);
    d.unregister('ext-a');
    expect(d.listExtensions()).toEqual(['ext-b']);
  });

  it('unregister of unknown is a no-op', () => {
    const d = new ActivationDispatcher();
    expect(() => d.unregister('nope')).not.toThrow();
  });

  it('register with empty events is a no-op', () => {
    const d = new ActivationDispatcher();
    d.register('ext-a', []);
    expect(d.listExtensions()).toEqual([]);
  });
});

describe('ActivationDispatcher — fire', () => {
  it('activates each subscribed extension exactly once per session', async () => {
    const d = new ActivationDispatcher();
    d.register('ext-a', ['onStartup']);
    d.register('ext-b', ['onStartup']);
    const first = await d.fire('onStartup');
    expect(first.sort()).toEqual(['ext-a', 'ext-b']);
    const second = await d.fire('onStartup');
    expect(second).toEqual([]);
  });

  it('returns deterministic order across calls', async () => {
    const d = new ActivationDispatcher();
    d.register('ext-c', ['onStartup']);
    d.register('ext-a', ['onStartup']);
    d.register('ext-b', ['onStartup']);
    expect((await d.fire('onStartup'))).toEqual(['ext-a', 'ext-b', 'ext-c']);
  });

  it('invokes listeners with (extId, event)', async () => {
    const d = new ActivationDispatcher();
    const listener = vi.fn();
    d.onActivate(listener);
    d.register('ext-a', ['onCommand:foo']);
    await d.fire('onCommand:foo');
    expect(listener).toHaveBeenCalledWith('ext-a', 'onCommand:foo');
  });

  it('awaits listeners sequentially per extension', async () => {
    const d = new ActivationDispatcher();
    const order: string[] = [];
    d.onActivate(async (id) => {
      order.push(`start ${id}`);
      await new Promise((r) => setTimeout(r, 1));
      order.push(`end ${id}`);
    });
    d.register('ext-a', ['onStartup']);
    d.register('ext-b', ['onStartup']);
    await d.fire('onStartup');
    expect(order).toEqual(['start ext-a', 'end ext-a', 'start ext-b', 'end ext-b']);
  });

  it('listener unsubscribe stops further calls', async () => {
    const d = new ActivationDispatcher();
    const listener = vi.fn();
    const unsubscribe = d.onActivate(listener);
    unsubscribe();
    d.register('ext-a', ['onStartup']);
    await d.fire('onStartup');
    expect(listener).not.toHaveBeenCalled();
  });

  it('fire of unknown event returns empty', async () => {
    const d = new ActivationDispatcher();
    expect(await d.fire('onStartup')).toEqual([]);
  });
});

describe('ActivationDispatcher — listener failure does not mark activated', () => {
  it('keeps the extension activatable when a listener throws', async () => {
    const d = new ActivationDispatcher();
    let attempts = 0;
    d.onActivate(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('first attempt fails');
    });
    d.register('ext-a', ['onStartup']);
    await expect(d.fire('onStartup')).rejects.toThrow('first attempt fails');
    expect(d.isActivated('ext-a')).toBe(false);
    // Second fire should succeed because activated wasn't marked.
    const result = await d.fire('onStartup');
    expect(result).toEqual(['ext-a']);
    expect(d.isActivated('ext-a')).toBe(true);
  });
});

describe('ActivationDispatcher — reset', () => {
  it('resetActivation allows re-firing per-extension', async () => {
    const d = new ActivationDispatcher();
    d.register('ext-a', ['onStartup']);
    await d.fire('onStartup');
    expect(d.isActivated('ext-a')).toBe(true);
    d.resetActivation('ext-a');
    expect(d.isActivated('ext-a')).toBe(false);
    expect(await d.fire('onStartup')).toEqual(['ext-a']);
  });

  it('resetActivation with no arg resets all', async () => {
    const d = new ActivationDispatcher();
    d.register('ext-a', ['onStartup']);
    d.register('ext-b', ['onStartup']);
    await d.fire('onStartup');
    d.resetActivation();
    expect(d.isActivated('ext-a')).toBe(false);
    expect(d.isActivated('ext-b')).toBe(false);
  });
});
