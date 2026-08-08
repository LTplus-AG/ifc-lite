/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression tests for #2385 — a hidden tab never delivers an animation frame,
 * so an unbounded `await new Promise(r => requestAnimationFrame(r))` inside the
 * load pipeline parked the whole completion path (finalize, WASM handle
 * release, `setLoading(false)`) until the user came back to the tab.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { nextFrameOrTimeout } from './frameWait.js';

/**
 * Drain the microtask queue. Used instead of `await promise` so that a broken
 * implementation fails the assertion instead of hanging the runner forever —
 * a hang is indistinguishable from a stuck CI job, and these tests exist
 * precisely to be mutation-checked by breaking the implementation.
 */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

type RafHost = typeof globalThis & {
  requestAnimationFrame?: (cb: FrameRequestCallback) => number;
};

/** Install a fake rAF for the duration of `fn`, restoring whatever was there. */
async function withRaf(
  raf: ((cb: FrameRequestCallback) => number) | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const host = globalThis as RafHost;
  const had = Object.prototype.hasOwnProperty.call(host, 'requestAnimationFrame');
  const prev = host.requestAnimationFrame;
  // Reflect.deleteProperty, not `delete`: the DOM lib types rAF as a required
  // member of globalThis, so `delete` is a type error even though the property
  // genuinely is absent under node.
  if (raf) host.requestAnimationFrame = raf;
  else Reflect.deleteProperty(host, 'requestAnimationFrame');
  try {
    await fn();
  } finally {
    if (had) host.requestAnimationFrame = prev;
    else Reflect.deleteProperty(host, 'requestAnimationFrame');
  }
}

test('#2385 hidden tab: resolves off the timer when no frame ever arrives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let registered = 0;
  // A hidden tab: the callback IS accepted and simply never invoked.
  await withRaf(() => { registered += 1; return 1; }, async () => {
    let settled = false;
    void nextFrameOrTimeout(1000).then(() => { settled = true; });

    // Without the timer fallback there is nothing that could ever settle this.
    await drainMicrotasks();
    assert.equal(registered, 1, 'a frame was requested');
    assert.equal(settled, false, 'must not resolve before the bound elapses');

    t.mock.timers.tick(1000);
    await drainMicrotasks();
    assert.equal(settled, true, 'the timer bound must complete the wait');
  });
});

test('#2385 visible tab: a delivered frame resolves the wait without the timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Timers are mocked and never ticked below, so only the frame can settle this.
  await withRaf((cb) => { cb(0); return 1; }, async () => {
    let settled = false;
    void nextFrameOrTimeout(1000).then(() => { settled = true; });
    await drainMicrotasks();
    assert.equal(settled, true, 'a delivered frame must resolve the wait');
  });
});

test('#2385 a delivered frame clears the pending fallback timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cleared: unknown[] = [];
  const realClear = globalThis.clearTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    cleared.push(id);
    return (realClear as (id: unknown) => void)(id);
  }) as typeof globalThis.clearTimeout;
  try {
    await withRaf((cb) => { cb(0); return 1; }, async () => {
      let settled = false;
      void nextFrameOrTimeout(60_000).then(() => { settled = true; });
      await drainMicrotasks();
      assert.equal(settled, true, 'the frame must resolve the wait');
    });
  } finally {
    globalThis.clearTimeout = realClear;
  }
  assert.equal(cleared.length, 1, 'the fallback timer must be cleared, not left pending');
});

test('#2385 a non-positive bound is rejected rather than silently degrading', () => {
  // 0 is the valid-but-falsy boundary: it would turn every call site into a
  // bare "yield once" and quietly delete the frame wait.
  assert.throws(() => nextFrameOrTimeout(0), RangeError);
  assert.throws(() => nextFrameOrTimeout(-1), RangeError);
});

test('#2385 no unbounded frame wait is reintroduced in the load or clash pipelines', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [
    resolve(here, '../hooks/useIfcLoader.ts'),
    resolve(here, '../hooks/useClash.ts'),
  ];

  const violations: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('await new Promise') || !line.includes('requestAnimationFrame')) return;
      // A deliberate unbounded wait declares itself in the preceding comment.
      const preamble = lines.slice(Math.max(0, i - 6), i).join('\n');
      if (preamble.includes('FRAME-WAIT-ALLOW')) return;
      violations.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(
    violations,
    [],
    'use nextFrameOrTimeout(); an unbounded frame wait parks forever in a hidden tab (#2385). ' +
      'If the wait genuinely must be unbounded, mark it with a FRAME-WAIT-ALLOW comment and say why.',
  );
});
