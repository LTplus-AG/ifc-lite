/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A `globalThis.fetch` stub that records the headers each request went out with.
 *
 * Three test files grew their own copy of this, all carrying the same fiddly
 * line — a request's headers live on `init.headers` when the caller passes an
 * init object and on `input.headers` when it passes a `Request`, and reading
 * only the first silently records nothing for the second. Getting that wrong
 * makes a header assertion pass vacuously, which is the opposite of what a
 * header assertion is for.
 */
export interface CapturedFetch {
  /** One entry per attempt, in order. Retries repeat the same headers. */
  sent: Headers[];
  restore(): void;
}

export function captureFetch(respond: () => Response | Promise<Response>): CapturedFetch {
  const sent: Headers[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
    return respond();
  }) as typeof globalThis.fetch;
  return { sent, restore: () => { globalThis.fetch = original; } };
}

/** A JSON `Response`, the shape every Anthropic error body arrives in. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
