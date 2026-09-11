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
  | { id: number; error: string };

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
    } satisfies ManifestRegexWorkerResponse);
  }
};
