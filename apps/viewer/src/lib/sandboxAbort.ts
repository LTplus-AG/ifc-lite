/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Turns the process-wide QuickJS teardown abort (`@ifc-lite/sandbox`'s
 * `isSandboxRuntimeAborted()` / `SandboxAbortError`, ifc-lite#1922) into a
 * user-facing message.
 *
 * Containment in `@ifc-lite/sandbox` names the failure and latches it so it
 * is observable after the first occurrence, but nothing that latch is
 * connected to anything: every sandbox call site (`useSandbox.ts`, the
 * extension host's `sandbox-factory.ts`) either attempted an eval that could
 * not succeed, or reported the crash as a generic script error with no
 * mention that a reload is the only way out. This is the piece that reads
 * the flag.
 *
 * `aborted` is a plain boolean, not read from `isSandboxRuntimeAborted()` in
 * here, so callers set it up directly (real latch or a fabricated `true`)
 * without needing to reproduce the upstream OOM to exercise this logic.
 */

import { SandboxAbortError } from '@ifc-lite/sandbox';

export const SANDBOX_ABORT_RELOAD_MESSAGE =
  'The script sandbox has crashed and can no longer run scripts (quickjs-emscripten ' +
  'teardown abort, ifc-lite#1922). Reload the page to restore it.';

/**
 * Decide whether a sandbox failure — or an attempt about to be made — should
 * be reported as "reload the page" rather than as an ordinary script error.
 *
 * @param aborted Whether the shared QuickJS runtime is already known to be
 *   aborted, checked *before* attempting the operation so a doomed attempt
 *   is never made.
 * @param err The error caught from the attempt, if any. Recognised even when
 *   `aborted` was false going in, since `dispose()` throws `SandboxAbortError`
 *   at the moment the abort is discovered.
 * @returns The reload message, or `null` if this is an ordinary failure.
 */
export function describeSandboxAbort(aborted: boolean, err?: unknown): string | null {
  if (aborted || err instanceof SandboxAbortError) {
    return SANDBOX_ABORT_RELOAD_MESSAGE;
  }
  return null;
}
