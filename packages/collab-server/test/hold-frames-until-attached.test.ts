/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Boundaries of the pre-ready frame buffer (#6965), against a fake socket so
 * the exact frame and byte caps can be hit. The behaviour through a real
 * server and a real y-websocket client is in
 * `first-frame-during-hydration.test.ts`.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  holdFramesUntilAttached,
  MAX_PENDING_BYTES,
  MAX_PENDING_FRAMES,
} from '../src/connection.js';

describe('holdFramesUntilAttached', () => {
  function fakeSocket() {
    const ee = new EventEmitter() as EventEmitter & { close: (code: number, reason: string) => void };
    const closed: Array<[number, string]> = [];
    ee.close = (code, reason) => { closed.push([code, reason]); };
    return { ws: ee as unknown as WebSocket, ee, closed };
  }
  const frame = (n: number, size = 1) => new Uint8Array(size).fill(n).buffer;

  it('replays held frames in arrival order, then delivers later ones directly', () => {
    const { ws, ee } = fakeSocket();
    const inbox = holdFramesUntilAttached(ws, () => { throw new Error('unexpected overflow'); });
    ee.emit('message', frame(1));
    ee.emit('message', frame(2));
    const seen: number[] = [];
    inbox.attach((b) => seen.push(b[0]));
    ee.emit('message', frame(3));
    expect(seen).toEqual([1, 2, 3]);
  });

  it('closes 1009 and counts once when the frame cap is exceeded', () => {
    const { ws, ee, closed } = fakeSocket();
    let overflows = 0;
    const inbox = holdFramesUntilAttached(ws, () => { overflows++; });
    for (let i = 0; i <= MAX_PENDING_FRAMES + 3; i++) ee.emit('message', frame(i));
    expect(overflows).toBe(1);
    expect(closed).toEqual([[1009, 'hydration-buffer-overflow']]);
    const seen: number[] = [];
    inbox.attach((b) => seen.push(b[0]));
    expect(seen).toEqual([]);
  });

  it('closes 1009 when the byte cap is exceeded', () => {
    const { ws, ee, closed } = fakeSocket();
    let overflows = 0;
    holdFramesUntilAttached(ws, () => { overflows++; });
    ee.emit('message', frame(1, MAX_PENDING_BYTES));
    expect(overflows).toBe(0);
    ee.emit('message', frame(2));
    expect(overflows).toBe(1);
    expect(closed).toHaveLength(1);
  });

  it('holds exactly MAX_PENDING_FRAMES frames and refuses the next', () => {
    const { ws, ee, closed } = fakeSocket();
    const inbox = holdFramesUntilAttached(ws, () => {});
    for (let i = 0; i < MAX_PENDING_FRAMES; i++) ee.emit('message', frame(i));
    expect(closed).toEqual([]);
    const seen: number[] = [];
    inbox.attach((b) => seen.push(b[0]));
    expect(seen).toHaveLength(MAX_PENDING_FRAMES);

    const second = fakeSocket();
    holdFramesUntilAttached(second.ws, () => {});
    for (let i = 0; i <= MAX_PENDING_FRAMES; i++) second.ee.emit('message', frame(i));
    expect(second.closed).toHaveLength(1);
  });
});
