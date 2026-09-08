/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `useSandbox().execute()` must settle a run's outcome at TEARDOWN, not before
 * it (#1922, PR #2509 review).
 *
 * The #1922 shape is that the failure is invisible to the run that caused it:
 * a script exhausting the sandbox heap inside a drained promise job leaves the
 * `eval()` resolving normally — the issue's reproducer returns `"started"` —
 * and only `dispose()` reports the damage. Reporting that abort from a
 * `finally` reaches the store but NOT the return value, because a `finally`
 * runs after the return expression has already been evaluated. Every caller
 * reads success off exactly that value: `ExecutableCodeBlock.handleRun` treats
 * any non-null result as success and ChatPanel's auto-execute path only
 * handles failure when the result is null, so a crashed run was still
 * announced as a good one while the panel showed an error next to it. The
 * same ordering let `bumpScriptRunSeq()` — the scripting tour's run gate —
 * count a run that died.
 *
 * These tests drive the REAL QuickJS runtime with the real reproducer, because
 * the abort is an upstream emscripten assertion that no fake can stand in for
 * honestly. Only the SDK is stubbed (through `BimReactContext`); the script
 * below never touches `bim`.
 *
 * ORDER IS LOAD-BEARING. Emscripten latches `ABORT` per module instance, so
 * the healthy-path test runs first, before any abort has fired.
 */

import '@/test/setup-dom.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BimContext } from '@ifc-lite/sdk';
import type { ScriptResult, SandboxConfig } from '@ifc-lite/sandbox';
import { BimReactContext } from '@/sdk/BimProvider.js';
import { useViewerStore } from '@/store';
import { SANDBOX_ABORT_MESSAGE } from '@/lib/sandboxAbort.js';
import { useSandbox } from './useSandbox.js';

/** The #1922 reproducer verbatim: OOM inside the post-await body of a job. */
const OOM_IN_JOB =
  'async function run() { await 0; const a = []; for (;;) { a.push({ k: "v" }); } } run(); "started"';

/** Small heap so the reproducer trips in tens of milliseconds, not seconds. */
const CONFIG: SandboxConfig = { limits: { memoryBytes: 4 * 1024 * 1024, timeoutMs: 10_000 } };

let execute: ((code: string) => Promise<ScriptResult | null>) | null = null;

function Probe() {
  ({ execute } = useSandbox(CONFIG));
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

before(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <BimReactContext.Provider value={{} as BimContext}>
        <Probe />
      </BimReactContext.Provider>,
    );
  });
  assert.ok(execute, 'the probe must have mounted and exposed execute()');
});

after(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('useSandbox().execute() — teardown decides the outcome (#1922)', () => {
  it('reports a healthy run as a success and counts it', async () => {
    // Runs FIRST, before any abort has latched on the WASM module.
    const before = useViewerStore.getState().scriptRunSeq;
    let result: ScriptResult | null = null;
    await act(async () => {
      result = await execute!('1 + 1');
    });

    assert.ok(result, 'a healthy run must resolve with a result');
    assert.equal((result as ScriptResult).value, 2);
    assert.equal(useViewerStore.getState().scriptLastError, null);
    assert.equal(
      useViewerStore.getState().scriptRunSeq,
      before + 1,
      'a healthy run must advance the run gate',
    );
  });

  it('returns null for a run the teardown abort proves died, and does not count it', async () => {
    const before = useViewerStore.getState().scriptRunSeq;
    let result: ScriptResult | null = null;
    await act(async () => {
      result = await execute!(OOM_IN_JOB);
    });

    // The store half — this already worked; it is here to prove the run really
    // was the #1922 one and not some ordinary failure that never reached
    // teardown at all. Without it the assertions below could pass vacuously.
    assert.equal(
      useViewerStore.getState().scriptLastError,
      SANDBOX_ABORT_MESSAGE,
      'the reproducer must actually produce a teardown abort',
    );

    // The two halves of the defect.
    assert.equal(
      result,
      null,
      'execute() must not hand a truthy ScriptResult back for a run that died at teardown',
    );
    assert.equal(
      useViewerStore.getState().scriptRunSeq,
      before,
      'a crashed run must not advance the scripting tour run gate',
    );
  });
});
