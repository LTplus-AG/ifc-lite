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

import type { ClashResult, ClashRule, ClashRunDocument, ClashRunSlotBinding, ExclusionSet } from '@ifc-lite/clash';
import { gatheredModelIds } from './federation-identity';
import type { ClashExclusionRule } from './exclusions';
import type { ClashModelTagInputs } from './model-tag-inputs';
import type { ClashSetFilters } from './set-filter';
import { clashRunRegistrations, type ClashRunCompleteEvent, type ClashRunListenerOptions } from './host-run-listeners';
import type { ClashRunPinnedInputs } from './host-run-build';

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
  /** The rules exactly as handed to the engine (its `rulesRun` drops explicit membership). */
  rules: readonly ClashRule[];
  /** The elements the run was given, so a document can record the types its type exclusions judge. */
  elementTypes: ReadonlyArray<{ model: string; key: string; tag: string }>;
}

/**
 * Slot bindings for every model the run took elements from or a finding names.
 * Resolved when the run PUBLISHES, not when the builder chunk has loaded: a
 * host's resolver may read its active round, which can move on meanwhile.
 */
export function slotBindings(result: ClashResult, models: ReadonlyMap<string, ModelLike>, options: ClashRunListenerOptions): ClashRunSlotBinding[] {
  // The gathered models, not just the ones that produced a finding: a clean run must
  // still say which slots it examined, or the next comparison sees them as missing.
  const ids = new Set<string>(gatheredModelIds(result) ?? []);
  for (const clash of result.clashes) { ids.add(clash.a.model); ids.add(clash.b.model); }
  for (const coverage of result.ruleCoverage ?? []) for (const element of coverage.matchedElements ?? []) ids.add(element.model);
  return [...ids].sort().map((id) => {
    const name = models.get(id)?.name ?? id;
    const pinned = options.resolveSlot?.({ id, name }) ?? null;
    return pinned
      ? { model: id, slot: pinned.slot, sha256: pinned.sha256, name, ...(pinned.label !== undefined ? { label: pinned.label } : {}) }
      : { model: id, slot: id, sha256: null, name };
  });
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
  // Per distinct options object: the slots now (or the resolver's failure), the document later.
  const resolved = new Map<ClashRunListenerOptions, ClashRunPinnedInputs | { error: Error }>();
  for (const { options } of registrations) {
    if (resolved.has(options)) continue;
    try {
      // Copied now: a host that edits the record behind `ruleRevisions` meanwhile must not relabel this run.
      const ruleRevisions = options.ruleRevisions ? Object.fromEntries(Object.entries(options.ruleRevisions)) : undefined;
      resolved.set(options, { slots: slotBindings(result, captured.models, options), ruleRevisions });
    } catch (err) {
      console.error('[clash] host slot resolver failed', err);
      resolved.set(options, { error: asError(err) });
    }
  }
  return import('./host-run-build').then(
    ({ buildRunDocument }) => {
      const built = new Map<ClashRunListenerOptions, ClashRunCompleteEvent>();
      for (const { listener, options } of registrations) {
        let event = built.get(options);
        if (!event) {
          const pinned = resolved.get(options)!;
          if ('error' in pinned) event = { ok: false, error: pinned.error };
          else {
            try {
              event = { ok: true, document: buildRunDocument(result, captured, pinned) satisfies ClashRunDocument };
            } catch (err) {
              console.error('[clash] host run document could not be built', err);
              event = { ok: false, error: asError(err) };
            }
          }
          built.set(options, Object.freeze(event)); // shared: no listener may swap the document for another
          event = built.get(options)!;
        }
        deliver(listener, event);
      }
    },
    (err: unknown) => {
      console.error('[clash] host run document builder failed to load', err);
      const event: ClashRunCompleteEvent = Object.freeze({ ok: false, error: asError(err) });
      for (const { listener } of registrations) deliver(listener, event);
    },
  );
}
