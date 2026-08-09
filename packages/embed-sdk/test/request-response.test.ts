/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { EMBED_SOURCE, PROTOCOL_VERSION } from '@ifc-lite/embed-protocol';
import { mount, type Harness } from './harness.js';
import type { IFCLiteEmbed } from '../src/index.js';

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
  vi.useRealTimers();
});

async function ready(opts: Parameters<typeof mount>[0] = {}): Promise<{ embed: IFCLiteEmbed; h: Harness }> {
  const harness = mount(opts);
  h = harness;
  const embed = await harness.handshake();
  harness.posted.length = 0; // drop the INIT so `last()` is the command under test
  return { embed, h: harness };
}

/** Reply to the most recent outbound command. */
function reply(harness: Harness, data?: unknown, error?: { code: string; message: string }) {
  const requestId = harness.last().msg.requestId as string;
  harness.inbound({
    source: EMBED_SOURCE,
    version: PROTOCOL_VERSION,
    type: 'RESPONSE',
    responseId: requestId,
    data,
    error,
  });
}

describe('request correlation', () => {
  it('stamps a unique requestId on every command', async () => {
    const { embed, h: harness } = await ready();
    void embed.showAll();
    void embed.showAll();
    const ids = harness.posted.map(p => p.msg.requestId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeTypeOf('string');
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('resolves the matching promise with the response data', async () => {
    const { embed, h: harness } = await ready();
    const p = embed.getModelInfo();
    reply(harness, { models: [], totalEntities: 3, totalTriangles: 9 });
    await expect(p).resolves.toEqual({ models: [], totalEntities: 3, totalTriangles: 9 });
  });

  it('rejects with "code: message" when the response carries an error', async () => {
    const { embed, h: harness } = await ready();
    const p = embed.loadModel('https://cdn.example.test/a.ifc');
    reply(harness, undefined, { code: 'LOAD_FAILED', message: 'bad IFC' });
    await expect(p).rejects.toThrow('LOAD_FAILED: bad IFC');
  });

  it('prefers the error branch even when data is also present', async () => {
    const { embed, h: harness } = await ready();
    const p = embed.getModelInfo();
    reply(harness, { models: [] }, { code: 'E', message: 'm' });
    await expect(p).rejects.toThrow('E: m');
  });

  it('resolves only the request whose id matches, leaving the others pending', async () => {
    const { embed, h: harness } = await ready();
    const first = embed.getModelInfo();
    const firstId = harness.last().msg.requestId;
    const second = embed.getModelInfo();
    reply(harness, { tag: 'second' });

    await expect(second).resolves.toEqual({ tag: 'second' });
    const firstSettled = await Promise.race([
      first.then(() => 'settled', () => 'settled'),
      Promise.resolve('pending'),
    ]);
    expect(firstSettled).toBe('pending');
    expect(firstId).not.toBe(harness.last().msg.requestId);
  });

  it('ignores a response whose responseId matches nothing', async () => {
    const { embed, h: harness } = await ready();
    const p = embed.getModelInfo();
    harness.inbound({
      source: EMBED_SOURCE,
      version: PROTOCOL_VERSION,
      type: 'RESPONSE',
      responseId: 'not-a-real-request-id',
      data: { models: [] },
    });
    const settled = await Promise.race([
      p.then(() => 'settled', () => 'settled'),
      Promise.resolve('pending'),
    ]);
    expect(settled).toBe('pending');
  });

  it('does not resolve a request twice from a duplicated response', async () => {
    const { embed, h: harness } = await ready();
    const p = embed.getModelInfo();
    const seen: string[] = [];
    embed.on('ready', () => seen.push('ready-listener-fired'));
    reply(harness, { models: [] });
    await expect(p).resolves.toEqual({ models: [] });
    // Replaying the same envelope must not re-enter the pending path; it now
    // falls through to the event broadcast, which has no 'response' listener.
    reply(harness, { models: [] });
    expect(seen).toEqual([]);
  });

  it('clears the per-request timer when the response arrives', async () => {
    // Resolving without clearing leaves a live 30s timer per answered request:
    // invisible to the promise (it is already settled) but a real leak in a
    // long-lived page, and it keeps the Node event loop alive under test.
    vi.useFakeTimers();
    const harness = mount({});
    h = harness;
    harness.emit('READY', { version: PROTOCOL_VERSION });
    harness.emit('INIT_ACK');
    const embed = await harness.created;
    harness.posted.length = 0;

    const before = vi.getTimerCount();
    const p = embed.getModelInfo();
    expect(vi.getTimerCount()).toBe(before + 1);
    reply(harness, { models: [] });
    await expect(p).resolves.toEqual({ models: [] });
    expect(vi.getTimerCount()).toBe(before);
  });

  it('clears the per-request timer when the response is an error', async () => {
    vi.useFakeTimers();
    const harness = mount({});
    h = harness;
    harness.emit('READY', { version: PROTOCOL_VERSION });
    harness.emit('INIT_ACK');
    const embed = await harness.created;
    harness.posted.length = 0;

    const before = vi.getTimerCount();
    const p = embed.getModelInfo();
    expect(vi.getTimerCount()).toBe(before + 1);
    reply(harness, undefined, { code: 'E', message: 'm' });
    await expect(p).rejects.toThrow('E: m');
    expect(vi.getTimerCount()).toBe(before);
  });

  it('does not also broadcast a matched response as a public event', async () => {
    const { embed, h: harness } = await ready();
    const seen: unknown[] = [];
    embed.on('response' as never, (d) => seen.push(d));
    const p = embed.getModelInfo();
    reply(harness, { models: [] });
    await expect(p).resolves.toEqual({ models: [] });
    expect(seen).toEqual([]);
  });

  it('rejects with a per-command timeout message after 30s', async () => {
    vi.useFakeTimers();
    const harness = mount({});
    h = harness;
    harness.emit('READY', { version: PROTOCOL_VERSION });
    harness.emit('INIT_ACK');
    const embed = await harness.created;
    const p = embed.getScreenshot();
    const assertion = expect(p).rejects.toThrow('GET_SCREENSHOT timed out (30s)');
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it('does not time out a request that was already answered', async () => {
    vi.useFakeTimers();
    const harness = mount({});
    h = harness;
    harness.emit('READY', { version: PROTOCOL_VERSION });
    harness.emit('INIT_ACK');
    const embed = await harness.created;
    harness.posted.length = 0;
    const p = embed.getModelInfo();
    reply(harness, { models: [] });
    await expect(p).resolves.toEqual({ models: [] });
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(p).resolves.toEqual({ models: [] });
  });
});

describe('command payloads', () => {
  it('sends the documented type and payload for each command', async () => {
    const { embed, h: harness } = await ready();
    const cases: Array<[() => unknown, string, unknown]> = [
      [() => embed.loadModel('u'), 'LOAD_MODEL', { url: 'u' }],
      [() => embed.addModel('u', 'n'), 'ADD_MODEL', { url: 'u', name: 'n' }],
      [() => embed.removeModel('m1'), 'REMOVE_MODEL', { modelId: 'm1' }],
      [() => embed.select([1, 2]), 'SELECT', { ids: [1, 2] }],
      [() => embed.selectByGuid(['g']), 'SELECT_BY_GUID', { guids: ['g'] }],
      [() => embed.clearSelection(), 'CLEAR_SELECTION', undefined],
      [() => embed.isolate([3]), 'ISOLATE', { ids: [3] }],
      [() => embed.hide([4]), 'HIDE', { ids: [4] }],
      [() => embed.show([5]), 'SHOW', { ids: [5] }],
      [() => embed.showAll(), 'SHOW_ALL', undefined],
      [() => embed.resetColors(), 'RESET_COLORS', undefined],
      [() => embed.fitToView([6]), 'FIT_TO_VIEW', { ids: [6] }],
      [() => embed.setCamera(1, 2, 3), 'SET_CAMERA', { azimuth: 1, elevation: 2, zoom: 3 }],
      [() => embed.setView('left'), 'SET_VIEW', { preset: 'left' }],
      [() => embed.setSection({ axis: 'down', enabled: true }), 'SET_SECTION', { axis: 'down', enabled: true }],
      [() => embed.setTheme('dark', '000000'), 'SET_THEME', { theme: 'dark', bg: '000000' }],
      [() => embed.setTypeVisibility({ spaces: false }), 'SET_TYPE_VISIBILITY', { spaces: false }],
      [() => embed.getProperties(9), 'GET_PROPERTIES', { id: 9 }],
      [() => embed.getScreenshot(800, 600), 'GET_SCREENSHOT', { width: 800, height: 600 }],
      [() => embed.getModelInfo(), 'GET_MODEL_INFO', undefined],
    ];
    for (const [call, type, data] of cases) {
      const before = harness.posted.length;
      void (call() as Promise<unknown>).catch(() => {});
      expect(harness.posted.length, `${type} posted nothing`).toBe(before + 1);
      const sent = harness.last().msg;
      expect(sent.type, `${type} sent the wrong type`).toBe(type);
      expect(sent.data, `${type} sent the wrong payload`).toEqual(data);
      expect(sent.source).toBe(EMBED_SOURCE);
      expect(sent.version).toBe(PROTOCOL_VERSION);
    }
  });

  it('stringifies numeric colour-map keys', async () => {
    const { embed, h: harness } = await ready();
    void embed.setColors({ 12: [1, 0, 0, 1], 7: [0, 1, 0, 0.5] });
    const data = harness.last().msg.data as { colorMap: Record<string, number[]> };
    expect(Object.keys(data.colorMap).sort()).toEqual(['12', '7']);
    expect(data.colorMap['12']).toEqual([1, 0, 0, 1]);
    expect(data.colorMap['7']).toEqual([0, 1, 0, 0.5]);
  });

  it('sends an empty colour map rather than dropping the command', async () => {
    const { embed, h: harness } = await ready();
    void embed.setColors({});
    expect(harness.last().msg.type).toBe('SET_COLORS');
    expect(harness.last().msg.data).toEqual({ colorMap: {} });
  });

  it('transfers the ArrayBuffer for LOAD_MODEL_BUFFER', async () => {
    const { embed, h: harness } = await ready();
    const buf = new ArrayBuffer(8);
    void embed.loadModelBuffer(buf);
    expect(harness.last().msg.type).toBe('LOAD_MODEL_BUFFER');
    expect(harness.last().msg.data).toBe(buf);
    expect(harness.last().transfer).toEqual([buf]);
  });

  it('sends an empty transfer list for ordinary commands', async () => {
    const { embed, h: harness } = await ready();
    void embed.showAll();
    expect(harness.last().transfer).toEqual([]);
  });
});
