/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Recovery from the upstream teardown abort (#1922).
 *
 * `oom-job-dispose.test.ts` pins the *containment* — the abort arrives as a
 * named error and the sandbox reads as disposed. This file pins the thing that
 * makes the failure survivable: the poisoned WASM module is retired, so the
 * next sandbox is created on a fresh instance and scripting keeps working
 * without a page reload.
 *
 * Everything here drives the real quickjs-emscripten module. A stub cannot
 * prove any of it: the assertion, the `ABORT` latch and the module identity
 * all live in the WASM glue.
 *
 * IMPORTANT — test order in this file is load-bearing, for the reason the fix
 * exists. Emscripten latches `ABORT` **per module instance**, so a module that
 * has already aborted once reports every later abort as a false clean. The
 * healthy-path tests therefore run before the first poisoning, and each
 * poisoning test must be the first one on its own module. The file is kept
 * separate so vitest gives it a dedicated process.
 */

import { describe, expect, it } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import { createSandbox, Sandbox, SandboxAbortError } from './sandbox.js';
import {
  acquireQuickJSModule,
  isQuickJSModuleRetired,
  isSandboxRuntimeAborted,
  retireQuickJSModule,
} from './quickjs-module.js';

/** The #1922 reproducer verbatim: OOM inside the post-await body of a job. */
const OOM_IN_JOB =
  'async function run() { await 0; const a = []; for (;;) { a.push({ k: "v" }); } } run(); "started"';

/** Small enough that the reproducer reaches the ceiling in well under a second. */
const SMALL_HEAP = { limits: { memoryBytes: 8 * 1024 * 1024 } };

describe('QuickJS module cache (#1922)', () => {
  it('hands every sandbox the same module until one is retired', async () => {
    const first = await acquireQuickJSModule();
    expect(await acquireQuickJSModule()).toBe(first);
    expect(isQuickJSModuleRetired(first)).toBe(false);

    retireQuickJSModule(first);

    expect(isQuickJSModuleRetired(first)).toBe(true);
    const replacement = await acquireQuickJSModule();
    expect(replacement).not.toBe(first);
    expect(isQuickJSModuleRetired(replacement)).toBe(false);
  }, 60000);

  it('retires nothing for a sandbox that never reached a module', () => {
    // A `dispose()` before `init()` resolved passes null through; it must not
    // throw and must not retire whatever happens to be cached.
    expect(() => retireQuickJSModule(null)).not.toThrow();
    expect(isQuickJSModuleRetired(null)).toBe(false);
  });
});

describe('sandbox recovery after a teardown abort (#1922)', () => {
  it('tells a sandbox still running on the aborted module that it was retired', async () => {
    // Created first, so it shares the module the doomed sandbox is about to
    // poison — the extension host's long-lived sandbox, in miniature.
    const survivor: Sandbox = await createSandbox({} as BimContext);
    expect(survivor.moduleRetired).toBe(false);
    expect(isSandboxRuntimeAborted()).toBe(false);

    const doomed = await createSandbox({} as BimContext, SMALL_HEAP);
    expect(doomed.moduleRetired).toBe(false);
    // The defect in one line: the run that breaks teardown resolves normally.
    expect((await doomed.eval(OOM_IN_JOB, { typescript: false })).value).toBe('started');

    let caught: unknown;
    try {
      doomed.dispose();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SandboxAbortError);
    expect(isSandboxRuntimeAborted()).toBe(true);

    // The survivor still executes — the module was measured to keep running
    // scripts correctly — but it can no longer report its own teardown, and
    // this is the flag that says so.
    expect(survivor.moduleRetired).toBe(true);
    expect((await survivor.eval('1 + 1', { typescript: false })).value).toBe(2);
    survivor.dispose();

    // The aborted sandbox released its module reference, so it reports false
    // rather than pinning the retired instance.
    expect(doomed.moduleRetired).toBe(false);
  }, 60000);

  it('creates the next sandbox on a fresh module, which still runs scripts', async () => {
    const recovered = await createSandbox({} as BimContext);
    expect(recovered.moduleRetired).toBe(false);
    expect((await recovered.eval('1 + 1', { typescript: false })).value).toBe(2);
    expect(() => recovered.dispose()).not.toThrow();
  }, 60000);

  it('reports a second abort instead of swallowing it, because the new module has its own latch', async () => {
    // The load-bearing assertion of the whole fix. On the shared singleton the
    // second sandbox broken exactly like the first tears down *silently* —
    // emscripten only reports the first abort per module — so `caught` comes
    // back undefined and the host is told nothing while `JS_FreeRuntime`
    // half-finishes. On a fresh module the latch has not fired, so the failure
    // reports itself again.
    const second = await createSandbox({} as BimContext, SMALL_HEAP);
    expect(second.moduleRetired).toBe(false);
    await second.eval(OOM_IN_JOB, { typescript: false });

    let caught: unknown;
    try {
      second.dispose();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SandboxAbortError);
  }, 60000);

  it('is still recoverable after the second abort', async () => {
    const third = await createSandbox({} as BimContext);
    expect(third.moduleRetired).toBe(false);
    expect((await third.eval('"ok"', { typescript: false })).value).toBe('ok');
    expect(() => third.dispose()).not.toThrow();
  }, 60000);
});
