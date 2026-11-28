/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hand a published clash result to the host listeners registered through
 * `ViewerHandle.onClashRunComplete` (see `host-run-listeners.ts`).
 *
 * Nothing happens unless a listener is registered. When one is, the run
 * document is built OFF the publish path: the builder is a separately loaded
 * chunk (`host-run-build.ts`, so it adds nothing to the eager bundle) and runs
 * after the publishing task. It is built once per completed run for each
 * distinct options object, deeply frozen, and the same object goes to every
 * listener registered with those options. A build failure reaches the
 * listeners as `{ ok: false, error }`; a listener that throws or rejects is
 * logged and never affects the viewer or the other listeners.
 *
 * Only types are imported from `@ifc-lite/clash` here.
 */

import type { ClashResult, ClashRunDocument, ExclusionSet } from '@ifc-lite/clash';
import type { ClashExclusionRule } from './exclusions';
import type { ClashModelTagInputs } from './model-tag-inputs';
import type { ClashSetFilters } from './set-filter';
import { clashRunRegistrations, type ClashRunCompleteEvent, type ClashRunListenerOptions } from './host-run-listeners';

export interface ModelLike { id: string; name: string }

/** What the run was given, beyond the result itself, captured when it published. */
export interface ClashRunHostContext {
  models: ReadonlyMap<string, ModelLike>;
  /** The saved rules (presets) as the run started; explicit-member rules take their revision from these. */
  presets: ReadonlyArray<ClashSetFilters & { id: string }>;
  /** The engine's exclusion set (voids/hosts, aggregates). */
  exclusions: ExclusionSet;
  /** The user's exclusion rules; enabled ones are recorded and their findings left out. */
  exclusionRules: readonly ClashExclusionRule[];
  tagInputs: ClashModelTagInputs | null;
}

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

/**
 * Schedule delivery of a published result. Returns at once (nothing is built
 * on the caller's tick); the promise settles once every listener was called,
 * which tests await and the viewer ignores.
 */
export function notifyClashRunComplete(result: ClashResult, context: ClashRunHostContext): Promise<void> {
  const registrations = clashRunRegistrations();
  if (registrations.length === 0) return Promise.resolve();
  const captured: ClashRunHostContext = { ...context, presets: [...context.presets], exclusionRules: [...context.exclusionRules] };
  return import('./host-run-build').then(
    ({ buildRunDocument }) => {
      const built = new Map<ClashRunListenerOptions, ClashRunCompleteEvent>();
      for (const { listener, options } of registrations) {
        let event = built.get(options);
        if (!event) {
          try {
            event = { ok: true, document: buildRunDocument(result, captured, options) satisfies ClashRunDocument };
          } catch (err) {
            console.error('[clash] host run document could not be built', err);
            event = { ok: false, error: asError(err) };
          }
          built.set(options, event);
        }
        deliver(listener, event);
      }
    },
    (err: unknown) => {
      console.error('[clash] host run document builder failed to load', err);
      const event: ClashRunCompleteEvent = { ok: false, error: asError(err) };
      for (const { listener } of registrations) deliver(listener, event);
    },
  );
}
