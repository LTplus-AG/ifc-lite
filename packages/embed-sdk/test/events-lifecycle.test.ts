/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, type Harness } from './harness.js';
import type { IFCLiteEmbed } from '../src/index.js';

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function ready(): Promise<{ embed: IFCLiteEmbed; h: Harness }> {
  const harness = mount({});
  h = harness;
  const embed = await harness.handshake();
  harness.posted.length = 0;
  return { embed, h: harness };
}

describe('event name mapping', () => {
  it('maps SCREAMING_SNAKE event types to kebab-case', async () => {
    const { embed, h: harness } = await ready();
    const cases: Array<[string, string]> = [
      ['MODEL_LOADING', 'model-loading'],
      ['MODEL_LOADED', 'model-loaded'],
      ['MODEL_ERROR', 'model-error'],
      ['ENTITY_SELECTED', 'entity-selected'],
      ['ENTITY_DESELECTED', 'entity-deselected'],
      ['ENTITY_HOVERED', 'entity-hovered'],
      ['CAMERA_CHANGED', 'camera-changed'],
      ['SECTION_CHANGED', 'section-changed'],
    ];
    for (const [wire, subscribed] of cases) {
      const seen: unknown[] = [];
      const off = embed.on(subscribed as never, (d) => seen.push(d));
      harness.emit(wire, { tag: wire });
      expect(seen, `${wire} did not reach '${subscribed}'`).toEqual([{ tag: wire }]);
      off();
    }
  });

  it('maps a single-word type by lower-casing it', async () => {
    const { embed, h: harness } = await ready();
    const seen: unknown[] = [];
    embed.on('ready', (d) => seen.push(d));
    harness.emit('READY', { version: '1.0' });
    expect(seen).toEqual([{ version: '1.0' }]);
  });

  it('replaces every underscore, not just the first', async () => {
    const { embed, h: harness } = await ready();
    const seen: unknown[] = [];
    embed.on('a-b-c' as never, (d) => seen.push(d));
    harness.emit('A_B_C', { ok: true });
    expect(seen).toEqual([{ ok: true }]);
  });

  it('does not deliver a wire type to the un-mapped listener name', async () => {
    const { embed, h: harness } = await ready();
    const seen: unknown[] = [];
    embed.on('ENTITY_SELECTED' as never, (d) => seen.push(d));
    harness.emit('ENTITY_SELECTED', { id: 1 });
    expect(seen).toEqual([]);
  });
});

describe('listener registry', () => {
  it('fans out to every listener on the same event', async () => {
    const { embed, h: harness } = await ready();
    const a: unknown[] = [];
    const b: unknown[] = [];
    embed.on('entity-hovered', (d) => a.push(d));
    embed.on('entity-hovered', (d) => b.push(d));
    harness.emit('ENTITY_HOVERED', { id: 3 });
    expect(a).toEqual([{ id: 3 }]);
    expect(b).toEqual([{ id: 3 }]);
  });

  it('unsubscribes exactly the callback returned by on()', async () => {
    const { embed, h: harness } = await ready();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const offA = embed.on('entity-hovered', (d) => a.push(d));
    embed.on('entity-hovered', (d) => b.push(d));
    offA();
    harness.emit('ENTITY_HOVERED', { id: 3 });
    expect(a).toEqual([]);
    expect(b).toEqual([{ id: 3 }]);
  });

  it('survives a throwing listener and still runs the next one', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { embed, h: harness } = await ready();
    const seen: unknown[] = [];
    embed.on('camera-changed', () => { throw new Error('listener blew up'); });
    embed.on('camera-changed', (d) => seen.push(d));
    expect(() => harness.emit('CAMERA_CHANGED', { azimuth: 1, elevation: 2 })).not.toThrow();
    expect(seen).toEqual([{ azimuth: 1, elevation: 2 }]);
    expect(errSpy).toHaveBeenCalled();
  });

  it('delivers the envelope data, not the envelope itself', async () => {
    const { embed, h: harness } = await ready();
    const seen: unknown[] = [];
    embed.on('model-loaded', (d) => seen.push(d));
    harness.emit('MODEL_LOADED', { entities: 1, triangles: 2, vertices: 3 });
    expect(seen).toEqual([{ entities: 1, triangles: 2, vertices: 3 }]);
  });
});

describe('destroy', () => {
  it('rejects every in-flight request', async () => {
    const { embed, h: harness } = await ready();
    const a = embed.getModelInfo();
    const b = embed.getScreenshot();
    void harness;
    embed.destroy();
    await expect(a).rejects.toThrow('Embed destroyed');
    await expect(b).rejects.toThrow('Embed destroyed');
  });

  it('rejects new requests instead of posting them', async () => {
    const { embed, h: harness } = await ready();
    embed.destroy();
    await expect(embed.getModelInfo()).rejects.toThrow('Embed destroyed');
    expect(harness.posted).toEqual([]);
  });

  it('removes the iframe from the DOM', async () => {
    const { embed, h: harness } = await ready();
    expect(harness.container.querySelector('iframe')).toBe(harness.iframe);
    embed.destroy();
    expect(harness.container.querySelector('iframe')).toBeNull();
  });

  it('stops delivering events after destroy', async () => {
    const { embed, h: harness } = await ready();
    const seen: unknown[] = [];
    embed.on('entity-selected', (d) => seen.push(d));
    harness.emit('ENTITY_SELECTED', { id: 1 });
    expect(seen).toHaveLength(1);
    embed.destroy();
    harness.emit('ENTITY_SELECTED', { id: 2 });
    expect(seen).toHaveLength(1);
  });

  it('does not leave a pending-request timer that fires after destroy', async () => {
    vi.useFakeTimers();
    const harness = mount({});
    h = harness;
    harness.emit('READY', { version: '1.0' });
    harness.emit('INIT_ACK');
    const embed = await harness.created;
    const p = embed.getModelInfo();
    const assertion = expect(p).rejects.toThrow('Embed destroyed');
    embed.destroy();
    await assertion;
    // If the 30s timer had survived, this would produce a second rejection.
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(p).rejects.toThrow('Embed destroyed');
  });

  it('is idempotent', async () => {
    const { embed } = await ready();
    embed.destroy();
    expect(() => embed.destroy()).not.toThrow();
  });
});
