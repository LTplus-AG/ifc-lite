/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build the `ClashRunDocument` a registered host listener receives. Loaded on
 * demand by `host-run-document.ts`, only once a host has registered, so the
 * document builder adds nothing to the viewer's eager bundle.
 */

import {
  buildClashRunDocument,
  CLASH_RUN_BROWSER_SUBMITTED,
  type ClashResult,
  type ClashRunDocument,
  type ClashRunExclusionRule,
  type ClashRunSlotBinding,
} from '@ifc-lite/clash';
import { referencedModelTagIds } from './model-tag-inputs';
import type { ClashExclusionRule } from './exclusions';
import type { ClashRunHostContext } from './host-run-document';

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

/**
 * A durable membership description for each explicit-member rule: its saved
 * filter definition, plus which slots each referenced model tag covered. The
 * resolved member lists are per-load refs and cannot serve.
 */
export function ruleMemberships(result: ClashResult, context: ClashRunHostContext, slots: readonly ClashRunSlotBinding[]): Record<string, string> {
  const slotOf = new Map(slots.map((binding) => [binding.model, binding.slot]));
  // Entries, not assignment: a rule id such as `__proto__` must become an own property.
  const out: Array<[string, string]> = [];
  // The rules as given: `result.rulesRun` has lost `membersA`/`membersB`, so it would skip every member rule.
  for (const rule of context.rules.length > 0 ? context.rules : result.rulesRun) {
    if (rule.membersA === undefined && rule.membersB === undefined) continue;
    const preset = context.presets.find((p) => p.id === rule.id);
    // No saved definition to describe it: leave it out, and the package hashes the lists (fails closed).
    if (!preset) continue;
    const filters = Object.fromEntries(Object.entries(preset).filter(([field]) => !NON_MEMBERSHIP_FIELDS.has(field)));
    // Only the tags THIS preset's filters name: another rule's tag assignments do not change its membership.
    const own = referencedModelTagIds([preset]);
    const tags = context.tagInputs
      ? Object.fromEntries([...context.tagInputs].filter(([tag]) => own.has(tag))
        .map(([tag, models]) => [tag, [...models].map((m) => slotOf.get(m) ?? m).sort()]))
      : null;
    out.push([rule.id, stableJson({ filters, tags })]);
  }
  return Object.fromEntries(out);
}

/** The viewer's ENABLED exclusion rules in run-document form (a disabled rule suppresses nothing). */
export function documentExclusionRules(rules: readonly ClashExclusionRule[]): ClashRunExclusionRule[] {
  return rules.filter((rule) => rule.enabled).map((rule): ClashRunExclusionRule => (
    rule.kind === 'typeAny' ? { kind: 'type', type: rule.a }
      : rule.kind === 'typePair' ? { kind: 'typePair', a: rule.a, b: rule.b }
        : { kind: 'elementKeyPair', a: rule.a, b: rule.b }));
}

/** Freeze the whole document, so every listener sees the same object and none can change it for another. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** What a registration's options resolved to when the run published: slots and pinned revisions. */
export interface ClashRunPinnedInputs {
  slots: ClashRunSlotBinding[];
  ruleRevisions: Readonly<Record<string, string>> | undefined;
}

/** Build one frozen run document from inputs pinned at publish, so a host's later edits cannot leak in. */
export function buildRunDocument(result: ClashResult, context: ClashRunHostContext, pinned: ClashRunPinnedInputs): ClashRunDocument {
  const { slots } = pinned;
  return deepFreeze(buildClashRunDocument({
    result,
    slots,
    engine: buildInfo(),
    ruleRevisions: pinned.ruleRevisions,
    ruleMemberships: ruleMemberships(result, context, slots),
    exclusions: context.exclusions,
    exclusionRules: documentExclusionRules(context.exclusionRules),
    elementTypes: context.elementTypes,
    rules: context.rules,
    labels: [CLASH_RUN_BROWSER_SUBMITTED],
  }));
}
