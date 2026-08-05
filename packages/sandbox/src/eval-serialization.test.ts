/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Sandbox.eval` serializes per sandbox (#2110).
 *
 * The bridge's capture state — the `logs` array, the byte total and the
 * `truncated` flag — is created once per *sandbox* in `buildBridge` and closed
 * over by the console functions, so it is shared by every run. `eval()` clears
 * it at the start of each run. Two overlapping `eval()` calls therefore fought
 * over one buffer: the second call's reset wiped state the first was still
 * filling, and entries produced by one run surfaced in the other's
 * `ScriptResult.logs`.
 *
 * Overlap is reachable because `eval()` awaits the TypeScript transpile before
 * touching the VM, which yields to the microtask queue with the reset already
 * applied. The fix queues each run behind the previous one on a per-sandbox
 * promise chain, so capture state is only ever owned by one run at a time.
 */

import { describe, expect, it } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import { createSandbox, type Sandbox } from './sandbox.js';

const EMPTY_SDK = {} as unknown as BimContext;

/** Collects the string arguments of every captured entry, in order. */
function messages(logs: { args: unknown[] }[]): string[] {
  return logs.map((entry) => String(entry.args[0]));
}

describe('Sandbox.eval serialization (#2110)', () => {
  it('keeps each run\'s logs to itself when two evals overlap', async () => {
    const sandbox = await createSandbox(EMPTY_SDK);
    try {
      // Started without awaiting, so both runs are in flight at once. The
      // transpile await inside eval() is what lets the second one interleave.
      const first = sandbox.eval('console.log("first");');
      const second = sandbox.eval('console.log("second");');
      const [a, b] = await Promise.all([first, second]);

      expect(messages(a.logs)).toEqual(['first']);
      expect(messages(b.logs)).toEqual(['second']);
    } finally {
      sandbox.dispose();
    }
  }, 60000);

  it('keeps every run\'s logs to itself across a wider fan-out', async () => {
    const sandbox = await createSandbox(EMPTY_SDK);
    try {
      // Six submitted without awaiting. Under serialization each result holds
      // exactly its own line; without it the shared buffer accumulates and the
      // later results carry the earlier runs' output.
      const tags = ['a', 'b', 'c', 'd', 'e', 'f'];
      const results = await Promise.all(
        tags.map((tag) => sandbox.eval(`console.log("${tag}"); "${tag}"`)),
      );

      expect(results.map((r) => r.value)).toEqual(tags);
      expect(results.map((r) => messages(r.logs))).toEqual(tags.map((tag) => [tag]));
    } finally {
      sandbox.dispose();
    }
  }, 60000);

  it('does not let one run\'s exhausted log budget silence the next', async () => {
    const sandbox = await createSandbox(EMPTY_SDK);
    try {
      // The 4 MB byte budget is sandbox state too, and `truncated` latches for
      // the run that trips it. A run submitted alongside a budget-exhausting
      // one must still capture its own output.
      const hog =
        '(() => { const p = "x".repeat(1048576); for (let i = 0; i < 6; i++) console.log(p); })(); 1';
      const [, quiet] = await Promise.all([
        sandbox.eval(hog),
        sandbox.eval('console.log("quiet"); 1'),
      ]);

      expect(messages(quiet.logs)).toEqual(['quiet']);
    } finally {
      sandbox.dispose();
    }
  }, 60000);

  it('reports a dispose that lands mid-run as a disposed sandbox, not a null deref', async () => {
    // The disposal guard runs once, before `runEval`'s only await (the
    // TypeScript transpile), and `this.vm` is dereferenced after it. A
    // `dispose()` arriving in that window surfaced as a raw
    // `TypeError: Cannot read properties of null (reading 'evalCode')` —
    // precisely the React-cleanup case the `disposed` getter documents.
    //
    // The offset is swept rather than guessed: the window is only a couple of
    // microtasks wide and its width depends on the transpiler, so a single
    // offset would pin nothing. Every offset must yield either a clean result
    // or the documented error — never a TypeError.
    for (let slack = 0; slack <= 5; slack += 1) {
      const sandbox = await createSandbox(EMPTY_SDK);
      const run = sandbox.eval('console.log("mid-run"); 1');
      for (let tick = 0; tick < slack; tick += 1) await Promise.resolve();
      sandbox.dispose();
      const failure = await run.then(
        () => undefined,
        (err: unknown) => err,
      );
      if (failure !== undefined) {
        expect(String(failure), `slack=${slack}`).toMatch(/Sandbox disposed/);
      }
    }
  }, 120000);

  it('settles every queued caller when dispose lands mid-queue', async () => {
    // Serialization must not turn a mid-queue dispose into a hang: the runs
    // behind the one that was cut off still have to settle, and settle with
    // the documented error rather than a null dereference.
    const sandbox = await createSandbox(EMPTY_SDK);
    const tags = ['a', 'b', 'c', 'd'];
    const runs = tags.map((tag) => sandbox.eval(`console.log("${tag}"); "${tag}"`));
    await Promise.resolve();
    await Promise.resolve();
    sandbox.dispose();

    const outcomes = await Promise.all(
      runs.map((run) => run.then(() => 'ok', (err: unknown) => String(err))),
    );
    expect(outcomes).toHaveLength(tags.length);
    for (const [i, outcome] of outcomes.entries()) {
      if (outcome !== 'ok') expect(outcome, `run ${tags[i]}`).toMatch(/Sandbox disposed/);
    }
  }, 120000);

  it('lets a queued eval run after the one ahead of it throws', async () => {
    const sandbox: Sandbox = await createSandbox(EMPTY_SDK);
    try {
      const failing = sandbox.eval('console.log("before-boom"); throw new Error("boom");');
      const following = sandbox.eval('console.log("after"); 42');

      await expect(failing).rejects.toThrow('boom');
      const after = await following;
      expect(after.value).toBe(42);
      expect(messages(after.logs)).toEqual(['after']);
    } finally {
      sandbox.dispose();
    }
  }, 60000);
});
