/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The spare parser worker: prepared at idle, handed out only once its warm
 * parse has finished, at most one at a time, and released on request.
 */

import { afterEach, describe, expect, it } from 'vitest';

// Loaded at runtime: the changed-test oracle removes new production files, and
// a missing module must fail an assertion rather than the whole file's import.
const modulePath = './spare-parser-worker.js';
const mod: typeof import('./spare-parser-worker.js') | null = await import(/* @vite-ignore */ modulePath).catch(() => null);
function spareModule() {
  expect(mod, 'the spare parser worker exists (spare-parser-worker.ts)').not.toBeNull();
  return mod!;
}
const WARM_PARSE_ID = 'spare-warm-parse';
const hasSpareParserWorker = () => spareModule().hasSpareParserWorker();
const prepareSpareParserWorker: typeof import('./spare-parser-worker.js')['prepareSpareParserWorker'] = (o) => spareModule().prepareSpareParserWorker(o);
const releaseSpareParserWorker = () => mod?.releaseSpareParserWorker();
const takeSpareParserWorker = () => spareModule().takeSpareParserWorker();

class FakeWorker {
  posted: Array<Record<string, unknown>> = [];
  terminated = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage(message: Record<string, unknown>): void { this.posted.push(message); }
  terminate(): void { this.terminated = true; }
  reply(data: unknown): void { this.onmessage?.({ data } as MessageEvent); }
}

let spawned: FakeWorker[] = [];
const spawn = () => { const w = new FakeWorker(); spawned.push(w); return w as unknown as Worker; };

afterEach(() => { releaseSpareParserWorker(); spawned = []; });

describe('spare parser worker', () => {
  it('uses the documented warm-parse id', () => {
    expect(spareModule().WARM_PARSE_ID).toBe(WARM_PARSE_ID);
  });

  it('is ready at once without a warm source, and posts nothing to the worker', async () => {
    expect(await prepareSpareParserWorker({ spawn })).toBe(true);
    expect(spawned[0].posted).toEqual([]);
    expect(takeSpareParserWorker()).toBe(spawned[0]);
    expect(takeSpareParserWorker()).toBeNull();
  });

  it('is not handed out while its warm parse runs, and is after it completes', async () => {
    const warmSource = new SharedArrayBuffer(8);
    const ready = prepareSpareParserWorker({ spawn, warmSource });
    const w = spawned[0];
    expect(w.posted[0]).toMatchObject({ type: 'parse', id: WARM_PARSE_ID, source: warmSource });
    expect(hasSpareParserWorker()).toBe(true);
    expect(takeSpareParserWorker()).toBeNull();
    w.reply({ type: 'progress', id: WARM_PARSE_ID });
    w.reply({ type: 'complete', id: 'someone-else' });
    expect(takeSpareParserWorker()).toBeNull();
    w.reply({ type: 'complete', id: WARM_PARSE_ID });
    expect(await ready).toBe(true);
    expect(w.onmessage).toBeNull();
    expect(takeSpareParserWorker()).toBe(w);
  });

  it('drops a spare whose warm parse fails', async () => {
    const ready = prepareSpareParserWorker({ spawn, warmSource: new SharedArrayBuffer(8) });
    spawned[0].reply({ type: 'error', id: WARM_PARSE_ID, message: 'bad' });
    expect(await ready).toBe(false);
    expect(spawned[0].terminated).toBe(true);
    expect(hasSpareParserWorker()).toBe(false);
  });

  it('keeps at most one spare', async () => {
    expect(await prepareSpareParserWorker({ spawn })).toBe(true);
    expect(await prepareSpareParserWorker({ spawn })).toBe(false);
    expect(spawned).toHaveLength(1);
  });

  it('release terminates the spare mid-warm-up and settles the warm-up (a terminated worker never answers)', async () => {
    const ready = prepareSpareParserWorker({ spawn, warmSource: new SharedArrayBuffer(8) });
    releaseSpareParserWorker();
    expect(spawned[0].terminated).toBe(true);
    // No reply after terminate(): a real worker never sends one.
    expect(await ready).toBe(false);
    expect(takeSpareParserWorker()).toBeNull();
    // The next preparation is not blocked by the released one.
    expect(await prepareSpareParserWorker({ spawn })).toBe(true);
  });
});
