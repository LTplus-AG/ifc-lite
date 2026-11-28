/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Turn a published clash result into the `ClashRunDocument` a registered host
 * listener receives (see `host-run-listeners.ts`). Runs only when a listener
 * is registered; a listener that throws is logged and never affects the
 * viewer or the other listeners.
 */

import {
  buildClashRunDocument,
  CLASH_RUN_BROWSER_SUBMITTED,
  type ClashResult,
  type ClashRunSlotBinding,
  type ExclusionSet,
} from '@ifc-lite/clash';
import { gatheredModelIds } from './federation-identity';
import type { ClashModelTagInputs } from './model-tag-inputs';
import { clashRunRegistrations, type ClashRunListenerOptions } from './host-run-listeners';

interface ModelLike { id: string; name: string }

/** What the run was given, beyond the result itself. */
export interface ClashRunHostContext {
  models: ReadonlyMap<string, ModelLike>;
  /** The saved rules (presets) by id; explicit-member rules take their revision from these. */
  presets: ReadonlyArray<{ id: string }>;
  exclusions: ExclusionSet;
  tagInputs: ClashModelTagInputs | null;
}

const buildInfo = () => ({
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null,
  build: typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : null,
  backend: 'ts',
});

/** Fields of a preset that are presentation or bookkeeping, not membership. */
const NON_MEMBERSHIP_FIELDS = new Set(['id', 'name', 'description', 'severity', 'enabled', 'builtin', 'selectorA', 'selectorB']);

/** JSON with sorted object keys, so a reordered saved preset keeps its revision. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Slot bindings for every model the run took elements from or a finding names. */
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

/**
 * A durable membership description for each explicit-member rule: its saved
 * filter definition, plus which slots each referenced model tag covered. The
 * resolved member lists are per-load refs and cannot serve.
 */
export function ruleMemberships(result: ClashResult, context: ClashRunHostContext, slots: readonly ClashRunSlotBinding[]): Record<string, string> {
  const slotOf = new Map(slots.map((binding) => [binding.model, binding.slot]));
  const tags = context.tagInputs
    ? Object.fromEntries([...context.tagInputs].map(([tag, models]) => [tag, [...models].map((m) => slotOf.get(m) ?? m).sort()]))
    : null;
  const out: Record<string, string> = {};
  for (const rule of result.rulesRun) {
    if (rule.membersA === undefined && rule.membersB === undefined) continue;
    const preset = context.presets.find((p) => p.id === rule.id);
    // No saved definition to describe it: leave it out, and the package hashes the lists (fails closed).
    if (!preset) continue;
    const filters = Object.fromEntries(Object.entries(preset).filter(([field]) => !NON_MEMBERSHIP_FIELDS.has(field)));
    out[rule.id] = stableJson({ filters, tags });
  }
  return out;
}

/** Deliver a published result to every registered host listener. */
export function notifyClashRunComplete(result: ClashResult, context: ClashRunHostContext): void {
  for (const { listener, options } of clashRunRegistrations()) {
    try {
      const slots = slotBindings(result, context.models, options);
      const document = buildClashRunDocument({
        result,
        slots,
        engine: buildInfo(),
        ruleRevisions: options.ruleRevisions,
        ruleMemberships: ruleMemberships(result, context, slots),
        exclusions: context.exclusions,
        labels: [CLASH_RUN_BROWSER_SUBMITTED],
      });
      listener({ document });
    } catch (err) {
      console.error('[clash] host run listener failed', err);
    }
  }
}
