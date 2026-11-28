/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rule revisions for run documents: a rule's id says nothing about what it
 * means, so a run records a revision of its semantics, and a key carries it.
 */

import { uuidFromSeed } from './deterministic-uuid.js';
import type { ClashRunRule } from './run-document.js';
import type { ClashResult, ClashRule, ClashRuleCoverage } from './types.js';

/** The semantic fields of a rule as it ran: what decides which pairs it reports. */
export function ruleSemantics(rule: ClashRule, settings: ClashResult['settings']) {
  return {
    a: rule.a,
    b: rule.b ?? null,
    mode: rule.mode,
    tolerance: rule.tolerance ?? settings.tolerance,
    clearance: rule.mode === 'clearance' ? rule.clearance ?? null : null,
    reportTouch: rule.reportTouch === true,
    explicitMembers: { a: rule.membersA !== undefined, b: rule.membersB !== undefined },
    excludeVoidsAndHosts: settings.excludeVoidsAndHosts,
  };
}

/**
 * The semantic revision of a rule: changes when anything that decides which
 * pairs it reports changes (selectors, mode, tolerance, clearance, touch
 * reporting, void/host exclusion, explicit membership), and not for its name
 * or severity.
 *
 * Explicit member lists (`membersA`/`membersB`) are per-load refs, so a rule
 * that uses them should pass `membership`, a durable description of how its
 * members were chosen (the saved filter definition). Without it the lists
 * themselves are hashed: any membership change, and any reload, yields a new
 * revision, which fails closed (not comparable) instead of carrying a decision
 * across a membership change.
 */
export function clashRuleRevision(rule: ClashRule, settings: ClashResult['settings'], membership?: string): string {
  const explicit = rule.membersA !== undefined || rule.membersB !== undefined;
  const members = !explicit ? null : membership !== undefined ? { membership }
    : { a: rule.membersA ? [...rule.membersA].sort() : null, b: rule.membersB ? [...rule.membersB].sort() : null };
  return uuidFromSeed(`clash-rule/1 ${JSON.stringify({ ...ruleSemantics(rule, settings), members })}`);
}

/** The revision of a whole rule set: changes when any rule is added, removed or changes revision. */
export function clashRuleSetRevision(rules: ReadonlyArray<Pick<ClashRunRule, 'id' | 'revision'>>): string {
  return uuidFromSeed(`clash-rule-set/1 ${JSON.stringify(rules.map((r) => [r.id, r.revision]).sort())}`);
}

/**
 * The rule as it ran, membership included. The engine's `rulesRun` drops
 * `membersA`/`membersB`; without the rules as given, a side its coverage says
 * came from explicit members (`fromMembersA`/`fromMembersB`) is described by
 * the durable keys that side matched, so a membership change still changes
 * the revision (as does a model change in what the members match: fail closed).
 */
export function effectiveRule(ran: ClashRule, given: ClashRule | undefined, coverage: ClashRuleCoverage | undefined): ClashRule {
  if (given) return given;
  if (!coverage?.fromMembersA && !coverage?.fromMembersB) return ran;
  const keysA = coverage.fromMembersA ? coverage.matchedKeysA : undefined;
  const keysB = coverage.fromMembersB ? coverage.matchedKeysB ?? undefined : undefined;
  if ((coverage.fromMembersA && !keysA) || (coverage.fromMembersB && !keysB)) {
    throw new Error(`rule ${ran.id} used explicit members, which neither the given rules nor its coverage record`);
  }
  return { ...ran, ...(keysA ? { membersA: [...keysA] } : {}), ...(keysB ? { membersB: [...keysB] } : {}) };
}
