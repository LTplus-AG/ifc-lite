/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where the engine reports what it worked around: a datum shift approximated
 * because a grid was unavailable, a WKT it could not read, a position it
 * refused. Silent unless the host installs a handler.
 */

/** `message` is a readable sentence; `cause` is the error behind it, when there is one. */
export type CrsDiagnosticHandler = (message: string, cause?: unknown) => void;

let handler: CrsDiagnosticHandler | null = null;

/**
 * Install the handler that receives the engine's diagnostics, or `null` to
 * silence them (the default). Returns the previous handler. One handler per
 * process: it serves every engine.
 */
export function configureCrsDiagnostics(next: CrsDiagnosticHandler | null): CrsDiagnosticHandler | null {
  const previous = handler;
  handler = next;
  return previous;
}

/** Internal to the engine. */
export function reportCrsDiagnostic(message: string, cause?: unknown): void {
  if (!handler) return;
  if (cause === undefined) handler(message);
  else handler(message, cause);
}
