/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Manifest-test regex evaluation worker.
 *
 * Runs a single `expect.regex` matcher (`new RegExp(pattern).test(text)`)
 * from `@ifc-lite/extensions`' bundle test runner off the main thread.
 * `runBundleTests` already applies a length cap and a catastrophic-
 * backtracking shape heuristic before any pattern reaches here (see
 * `packages/extensions/src/testing/runner.ts`) — those checks catch the
 * obvious cases. This worker exists for the rest: a short pattern the
 * shape heuristic doesn't recognise, or simply a slow match against a
 * long `text`. Running it here bounds worst-case wall time (the caller
 * terminates the worker on a timeout) and keeps the check off the main
 * UI thread; it does not make the regex itself any faster.
 */

export interface ManifestRegexWorkerRequest {
  id: number;
  pattern: string;
  text: string;
}

export type ManifestRegexWorkerResponse =
  | { id: number; matched: boolean }
  // `invalidPattern` distinguishes a genuine `new RegExp(...)` syntax
  // error (author's pattern is malformed) from every other failure
  // this worker can report. `postMessage` structured-clones the
  // response, which drops the thrown value's prototype chain (a
  // `SyntaxError` arrives at the client as a plain object), so the
  // client can't recover that distinction from the error alone — it
  // has to be carried explicitly (#4505 finding A: a caller that
  // can't tell the two apart reports every rejection, timeouts
  // included, as "invalid pattern").
  | { id: number; error: string; invalidPattern: boolean };

self.onmessage = (event: MessageEvent<ManifestRegexWorkerRequest>) => {
  const req = event.data;
  if (!req) return;
  try {
    const matched = new RegExp(req.pattern).test(req.text);
    (self as unknown as Worker).postMessage({ id: req.id, matched } satisfies ManifestRegexWorkerResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
      invalidPattern: err instanceof SyntaxError,
    } satisfies ManifestRegexWorkerResponse);
  }
};
