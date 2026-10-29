/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Keep process stdout for JSON-RPC alone.
 *
 * Over stdio, stdout carries one JSON-RPC message per line and nothing else; a
 * client that parses it strictly fails on any other line. The geometry engine
 * (wasm) reports through `console.log` ("[IFC-LITE] Opening classifier: ..."),
 * and Node's `console.log`, `console.info` and `console.debug` all write to
 * stdout. The writers are in the engine and its dependencies, so removing the
 * lines one by one cannot hold; the console methods that target stdout are
 * pointed at stderr instead. The text is kept, on the channel meant for it.
 *
 * Called by `StdioTransport.connect` when it owns the real `process.stdout`,
 * and by `cli.ts` before the first model loads (loading also runs the engine).
 * HTTP transports never call it: there stdout is just a log.
 */

const INSTALLED = Symbol.for('ifc-lite.mcp.console-to-stderr');

type Patched = Console & { [INSTALLED]?: true };

/** Point `console.log`, `console.info` and `console.debug` at stderr. Idempotent. */
export function routeConsoleToStderr(target: Console = console): void {
  const c = target as Patched;
  if (c[INSTALLED]) return;
  c[INSTALLED] = true;
  for (const method of ['log', 'info', 'debug'] as const) {
    c[method] = (...args: unknown[]): void => c.error(...args);
  }
}
