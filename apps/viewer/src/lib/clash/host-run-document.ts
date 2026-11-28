/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The deferred half of the host hook: build the run document from what
 * `host-run-publish.ts` pinned at publish, and deliver it. Loaded on demand,
 * only once a host has registered, so none of it is in the eager bundle.
 *
 * The document is built once per completed run for each distinct options
 * object, deeply frozen, and the same frozen event goes to every listener
 * registered with those options. A build failure reaches the listeners as
 * `{ ok: false, error }`; a listener that throws or rejects is logged and never
 * affects the viewer or the other listeners.
 */

import type { ClashResult, ClashRunDocument } from '@ifc-lite/clash';
import { buildRunDocument } from './host-run-build';
import type { ClashRunCompleteEvent, ClashRunListenerOptions, clashRunRegistrations } from './host-run-listeners';
import type { ClashRunHostContext, ClashRunPinned } from './host-run-publish';

export { notifyClashRunComplete, slotBindings, type ClashRunHostContext, type ModelLike } from './host-run-publish';

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === 'object' || typeof value === 'function') && value !== null
  && typeof (value as { then?: unknown }).then === 'function';

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

function deliver(listener: (event: ClashRunCompleteEvent) => unknown, event: ClashRunCompleteEvent): void {
  try {
    const delivered = listener(event);
    if (isThenable(delivered)) {
      Promise.resolve(delivered).catch((err: unknown) => { console.error('[clash] host run listener failed', err); });
    }
  } catch (err) {
    console.error('[clash] host run listener failed', err);
  }
}

/** Build each pinned registration's document once, freeze it, and deliver it. */
export function deliverClashRun(
  result: ClashResult,
  context: ClashRunHostContext,
  registrations: ReturnType<typeof clashRunRegistrations>,
  pinned: ClashRunPinned,
): void {
  const built = new Map<ClashRunListenerOptions, ClashRunCompleteEvent>();
  for (const { listener, options } of registrations) {
    let event = built.get(options);
    if (!event) {
      const inputs = pinned.get(options)!;
      if ('error' in inputs) event = { ok: false, error: inputs.error };
      else {
        try {
          event = { ok: true, document: buildRunDocument(result, context, inputs) satisfies ClashRunDocument };
        } catch (err) {
          console.error('[clash] host run document could not be built', err);
          event = { ok: false, error: asError(err) };
        }
      }
      // Shared: freeze the envelope too, so no listener can swap the document for another.
      event = Object.freeze(event);
      built.set(options, event);
    }
    deliver(listener, event);
  }
}
