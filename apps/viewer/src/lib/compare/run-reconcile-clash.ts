/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clash run reconciliation across a comparison's base and head (#6921).
 *
 * Findings keep identity through `clashReviewKey` (rule + the two durable
 * element keys); each side's native `Clash.id` is kept as its occurrence.
 * A base finding missing from the head run is `resolved` only when the head
 * run demonstrably re-examined BOTH elements under the same rule, in the same
 * roles, without truncation — the same fail-safe stance as
 * `compareClashRevisions`, extended to a run that gathered both revisions at
 * once (then the GlobalId-keyed coverage cannot say which revision matched,
 * so the head element's class must satisfy the rule's own selector, and a
 * membership-scoped rule is never attributable).
 */

import { clashReviewKey, matchesSelector, ruleHadNoMatch, type Clash, type ClashRule, type ClashRuleCoverage } from '@ifc-lite/clash';
import { clashKeyGlobalId } from './impact';
import { emptyCounts, type CapturedRun, type Incompatibility, type NotEvaluatedReason, type ReconcileContext,
  type ReconciledFinding, type ReconcileOutcome } from './run-reconcile-types';

type ClashRun = Extract<CapturedRun, { kind: 'clash' }>;

/** Changes below a millimetre are float noise between two tessellations, not a native change. */
const DISTANCE_EPSILON_M = 0.001;

function ruleDigest(rule: ClashRule): string {
  return JSON.stringify([rule.id, rule.name, rule.a, rule.b ?? null, rule.mode, rule.tolerance ?? null,
    rule.clearance ?? null, rule.severity ?? null, rule.reportTouch ?? false]);
}

const keySets = new WeakMap<readonly string[], ReadonlySet<string>>();
function hasKey(keys: readonly string[], key: string): boolean {
  let set = keySets.get(keys);
  if (!set) { set = new Set(keys); keySets.set(keys, set); }
  return set.has(key);
}

function coverageOf(run: ClashRun, ruleId: string): ClashRuleCoverage | undefined {
  return run.result.ruleCoverage?.find(coverage => coverage.rule === ruleId);
}

export function clashIncompatibilities(base: ClashRun, head: ClashRun, ctx: Pick<ReconcileContext, 'baseModelId' | 'headModelId'>): Incompatibility[] {
  const out: Incompatibility[] = [];
  if (!base.modelIds || !head.modelIds) out.push({ code: 'runModelsUnknown' });
  else {
    if (!base.modelIds.includes(ctx.baseModelId)) out.push({ code: 'baseModelNotInRun' });
    if (!head.modelIds.includes(ctx.headModelId)) out.push({ code: 'headModelNotInRun' });
  }
  const baseRules = new Map(base.result.rulesRun.map(rule => [rule.id, ruleDigest(rule)]));
  const headRules = new Map(head.result.rulesRun.map(rule => [rule.id, ruleDigest(rule)]));
  const differing = [...new Set([...baseRules.keys(), ...headRules.keys()])]
    .filter(id => baseRules.get(id) !== headRules.get(id)).sort();
  if (differing.length) out.push({ code: 'rulesDiffer', detail: differing.join(', ') });
  const a = base.result.settings, b = head.result.settings;
  if (a.tolerance !== b.tolerance || a.excludeVoidsAndHosts !== b.excludeVoidsAndHosts) {
    out.push({ code: 'settingsDiffer', detail: `tolerance ${a.tolerance} / ${b.tolerance}; excludeVoidsAndHosts ${a.excludeVoidsAndHosts} / ${b.excludeVoidsAndHosts}` });
  }
  const scoped = [...baseRules.keys()].filter(id => {
    const x = coverageOf(base, id), y = coverageOf(head, id);
    return !!x?.fromMembersA !== !!y?.fromMembersA || !!x?.fromMembersB !== !!y?.fromMembersB;
  });
  if (scoped.length) out.push({ code: 'scopeDiffers', detail: scoped.sort().join(', ') });
  return out;
}

const label = (clash: Clash) =>
  `${clash.rule}: ${clash.a.tag} ${clashKeyGlobalId(clash.a.key)} × ${clash.b.tag} ${clashKeyGlobalId(clash.b.key)}`;

function changedFields(before: Clash, after: Clash): string[] {
  const fields: string[] = [];
  if (before.status !== after.status) fields.push('status');
  if (before.severity !== after.severity) fields.push('severity');
  if ((before.distanceKind ?? null) !== (after.distanceKind ?? null)) fields.push('distanceKind');
  if (Math.abs(before.distance - after.distance) >= DISTANCE_EPSILON_M) fields.push('distance');
  return fields;
}

/** Why a base clash absent from head cannot be called resolved; null when it can. */
function notResolvedReason(clash: Clash, head: ClashRun, ctx: ReconcileContext): NotEvaluatedReason | null {
  if (head.result.truncated) return 'headRunTruncated';
  const rule = head.result.rulesRun.find(r => r.id === clash.rule);
  if (!rule) return 'ruleNotRun';
  const coverage = coverageOf(head, rule.id);
  if (!coverage || coverage.matchedKeysA === undefined) return 'elementNotReexamined';
  if (ruleHadNoMatch(coverage)) return 'ruleMatchedNothing';
  const spansBoth = head.modelIds?.includes(ctx.baseModelId) ?? true;
  const selfRule = coverage.matchedKeysB === null || coverage.matchedKeysB === undefined;
  const sides = [
    { key: clash.a.key, keys: coverage.matchedKeysA, selector: rule.a, members: !!coverage.fromMembersA },
    selfRule
      ? { key: clash.b.key, keys: coverage.matchedKeysA, selector: rule.a, members: !!coverage.fromMembersA }
      : { key: clash.b.key, keys: coverage.matchedKeysB ?? [], selector: rule.b ?? rule.a, members: !!coverage.fromMembersB },
  ];
  for (const side of sides) {
    const type = ctx.headTypeOf(clashKeyGlobalId(side.key));
    if (!type || !hasKey(side.keys, side.key)) return 'elementNotReexamined';
    if (spansBoth && side.members) return 'coverageNotAttributable';
    if (spansBoth && !matchesSelector(type, side.selector)) return 'elementNotReexamined';
  }
  return null;
}

function groupByReviewKey(clashes: readonly Clash[]): Map<string, Clash[]> {
  const groups = new Map<string, Clash[]>();
  for (const clash of clashes) {
    const key = clashReviewKey(clash);
    const group = groups.get(key);
    if (group) group.push(clash); else groups.set(key, [clash]);
  }
  for (const group of groups.values()) group.sort((x, y) => x.id.localeCompare(y.id));
  return groups;
}

export function reconcileClashRuns(base: ClashRun, head: ClashRun, ctx: ReconcileContext): ReconcileOutcome {
  const within = (model: string) => (c: Clash) => c.a.model === model && c.b.model === model;
  const crossRevision = (c: Clash) => (c.a.model === ctx.baseModelId && c.b.model === ctx.headModelId)
    || (c.a.model === ctx.headModelId && c.b.model === ctx.baseModelId);
  const runs = base === head ? [base] : [base, head];
  const excluded = runs.reduce((sum, run) => sum + run.result.clashes.filter(crossRevision).length, 0);
  const before = groupByReviewKey(base.result.clashes.filter(within(ctx.baseModelId)));
  const after = groupByReviewKey(head.result.clashes.filter(within(ctx.headModelId)));
  const findings: ReconciledFinding[] = [];
  const counts = emptyCounts();
  const push = (finding: ReconciledFinding) => { counts[finding.state]++; findings.push(finding); };
  for (const identity of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const b = before.get(identity) ?? [], h = after.get(identity) ?? [];
    for (let i = 0; i < Math.max(b.length, h.length); i++) {
      const prev = b[i], next = h[i];
      if (prev && next) {
        const changes = changedFields(prev, next);
        push({ state: changes.length ? 'changed' : 'persisting', identity, baseOccurrence: prev.id, headOccurrence: next.id,
          label: label(next), ...(changes.length ? { changes } : {}) });
      } else if (next) {
        push({ state: 'new', identity, headOccurrence: next.id, label: label(next) });
      } else if (prev) {
        const reason = notResolvedReason(prev, head, ctx);
        push(reason
          ? { state: 'notEvaluated', identity, baseOccurrence: prev.id, label: label(prev), reason }
          : { state: 'resolved', identity, baseOccurrence: prev.id, label: label(prev) });
      }
    }
  }
  return { ok: true, kind: 'clash', baseRunId: base.id, headRunId: head.id, counts, findings,
    partial: counts.notEvaluated > 0 || !!head.result.truncated || !!base.result.truncated, excluded };
}
