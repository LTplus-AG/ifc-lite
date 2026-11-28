/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The publish-time half of the host hook (`ViewerHandle.onClashRunComplete`),
 * deliberately tiny because the clash detection that calls it is eager.
 *
 * Nothing happens unless a listener is registered. When one is, only what
 * must be read AT publish is done here: each registration's slots (the host's
 * `resolveSlot` may read an active round that moves on) and a copy of its
 * `ruleRevisions`. Building and delivering the document happen in lazily
 * loaded chunks (`host-run-document.ts`, `host-run-build.ts`) after this tick.
 *
 * Only types are imported from `@ifc-lite/clash` here.
 */

import type { ClashResult, ClashRule, ClashRunSlotBinding, ExclusionSet } from '@ifc-lite/clash';
import { gatheredModelIds } from './federation-identity';
import type { ClashExclusionRule } from './exclusions';
import type { ClashModelTagInputs } from './model-tag-inputs';
import type { ClashSetFilters } from './set-filter';
import { clashRunRegistrations, deliverClashRunEvent, type ClashRunCompleteEvent, type ClashRunListenerOptions } from './host-run-listeners';
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

/** Per distinct options object: what it resolved to at publish, or why it could not. */
export type ClashRunPinned = Map<ClashRunListenerOptions, ClashRunPinnedInputs | { error: Error }>;

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

/**
 * Schedule delivery of a published result. Returns at once (nothing is built
 * on the caller's tick); the promise settles once every listener was called,
 * which tests await and the viewer ignores.
 */
export function notifyClashRunComplete(result: ClashResult, context: ClashRunHostContext): Promise<void> {
  const registrations = clashRunRegistrations();
  if (registrations.length === 0) return Promise.resolve();
  const captured: ClashRunHostContext = { ...context, presets: [...context.presets], exclusionRules: [...context.exclusionRules] };
  const pinned: ClashRunPinned = new Map();
  for (const { options } of registrations) {
    if (pinned.has(options)) continue;
    try {
      // Copied now: a host that edits the record behind `ruleRevisions` meanwhile must not relabel this run.
      const ruleRevisions = options.ruleRevisions ? Object.fromEntries(Object.entries(options.ruleRevisions)) : undefined;
      pinned.set(options, { slots: slotBindings(result, captured.models, options), ruleRevisions });
    } catch (err) {
      console.error('[clash] host slot resolver failed', err);
      pinned.set(options, { error: asError(err) });
    }
  }
  return import('./host-run-document').then(
    ({ deliverClashRun }) => deliverClashRun(result, captured, registrations, pinned),
    (err: unknown) => {
      console.error('[clash] host run document builder failed to load', err);
      const event: ClashRunCompleteEvent = Object.freeze({ ok: false, error: asError(err) });
      for (const { listener } of registrations) deliverClashRunEvent(listener, event);
    },
  );
}
