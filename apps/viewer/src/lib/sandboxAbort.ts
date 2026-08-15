/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Turns the QuickJS teardown abort (`@ifc-lite/sandbox`'s `SandboxAbortError`,
 * ifc-lite#1922) into a user-facing message.
 *
 * The abort itself is upstream: a script that exhausts the heap inside a
 * drained promise job leaves objects orphaned on `rt->gc_obj_list`, and
 * `JS_FreeRuntime` asserts that list is empty. Two things make it hard to
 * report well, and this is where both are handled:
 *
 * - It surfaces at **teardown**, long after the `eval()` that caused it
 *   resolved normally — so without a message here the user sees a clean result
 *   for a script that actually died.
 * - It used to be terminal for the document, because every sandbox shared one
 *   WASM module. It no longer is: the package retires the aborted module and
 *   builds the next sandbox on a fresh one, so the honest advice is "run
 *   again", not "reload the page".
 */

import { SandboxAbortError, type Sandbox } from '@ifc-lite/sandbox';

export const SANDBOX_ABORT_MESSAGE =
  'The script crashed the QuickJS runtime while it was being torn down, usually a ' +
  'script that exhausts the sandbox memory limit inside an async function ' +
  '(quickjs-emscripten teardown abort, ifc-lite#1922). Any result shown for this ' +
  'run is incomplete. A fresh runtime is created automatically, so run again; ' +
  'no reload needed.';

export const SANDBOX_MODULE_RETIRED_MESSAGE =
  'This sandbox was running on a QuickJS module that crashed (ifc-lite#1922), so it ' +
  'could no longer be torn down safely. It has been discarded. Run again and the ' +
  'runtime will reactivate on a fresh module; no reload needed.';

/**
 * Decide whether a failure caught from a sandbox operation is the #1922
 * teardown abort rather than an ordinary script error.
 *
 * @param err The error caught from `eval()` or from `dispose()`.
 * @returns The abort message, or `null` if this is an ordinary failure.
 */
export function describeSandboxAbort(err: unknown): string | null {
  return err instanceof SandboxAbortError ? SANDBOX_ABORT_MESSAGE : null;
}

/**
 * Tear a sandbox down, reporting a #1922 teardown abort as a message for the
 * user rather than only to the console.
 *
 * This is the *only* place the viewer can learn that a script exhausted the
 * sandbox heap inside a drained job: that `eval()` resolves normally — the
 * issue's reproducer returns `"started"` — so the run has already reported
 * success by the time `dispose()` fails.
 *
 * Never throws: teardown runs in a `finally` and on unmount, where a throw
 * would replace the real outcome or break a React cleanup. Any other teardown
 * failure is logged and returns `null`, exactly as before.
 */
export function disposeSandboxReportingAbort(sandbox: Sandbox): string | null {
  try {
    sandbox.dispose();
    return null;
  } catch (err) {
    console.error('[ifc-lite] sandbox teardown failed', err);
    return describeSandboxAbort(err);
  }
}
