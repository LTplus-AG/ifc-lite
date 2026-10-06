/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isGhostColor, type Lens } from '@ifc-lite/lens';
import type { ViewerState } from '@/store';
import { entityRefOf } from './checks-entity-ref';
import { evidenceRow, unavailableCapture, type EvidenceAdapter } from './types';

const SAMPLE_REFS = 5;

const activeLensOf = (s: ViewerState): Lens | null =>
  s.activeLensId ? s.savedLenses.find(lens => lens.id === s.activeLensId) ?? null : null;

/**
 * Whether `useLens` has published counts for the active lens. Rules mode
 * seeds a count for every enabled rule, so an empty map with enabled rules is
 * an evaluation still pending; a lens with no enabled rules evaluates to
 * nothing by design. Auto-colour has no rules to seed, so its published
 * overlay (`lensAppliedColors`) is what says it ran.
 */
function evaluated(s: ViewerState, lens: Lens): boolean {
  if (s.lensRuleCounts.size > 0 || s.lensAppliedColors !== null) return true;
  return !lens.autoColor && !lens.rules.some(rule => rule.enabled);
}

/** Entities the evaluation coloured as context-only ghosts: exactly the unmatched ones. Null when no overlay was published. */
function unmatchedCount(s: ViewerState): number | null {
  if (!s.lensAppliedColors) return null;
  let count = 0;
  for (const rgba of s.lensAppliedColors.values()) if (isGhostColor(rgba)) count++;
  return count;
}

/** The active Lens: per-rule (or per auto-colour value) native match counts with sample elements. */
export const lensAdapter: EvidenceAdapter = {
  id: 'lens', group: 'checks', panelIds: ['lens'],
  titleKey: 'lensPanel.title', descriptionKey: 'assistantSources.lens.description',
  rowMeaningKey: 'assistantSources.lens.rows', unavailableKey: 'assistantSources.lens.unavailable',
  suggestionKeys: ['assistantSources.lens.suggestSummary'],
  readiness: s => {
    const lens = activeLensOf(s);
    if (!lens) return { status: { labelKey: 'assistantSources.lens.pickNone' }, ready: false };
    if (!evaluated(s, lens)) return { status: { labelKey: 'assistantSources.lens.pickPending' }, ready: false };
    return { status: { labelKey: 'assistantSources.lens.pickRules', params: { name: lens.name, count: s.lensRuleCounts.size } }, ready: true };
  },
  identity: s => [activeLensOf(s), s.lensRuleCounts, s.lensRuleEntityIds, s.lensAutoColorLegend, s.lensAppliedColors],
  capture: (s, limit) => {
    const lens = activeLensOf(s);
    if (!lens || !evaluated(s, lens)) return unavailableCapture();
    const sample = (ruleId: string) => (s.lensRuleEntityIds.get(ruleId) ?? []).slice(0, SAMPLE_REFS).map(id => {
      const ref = entityRefOf(s, id);
      return { modelId: ref.modelId, globalId: ref.globalId, expressId: ref.expressId, type: ref.type };
    });
    const autoColor = lens.autoColor;
    const population = autoColor
      ? s.lensAutoColorLegend.map(entry => ({ id: entry.id, row: () => evidenceRow({ kind: 'lensLegendEntry', unit: 'elements' }, {
        ruleId: entry.id, name: entry.name, color: entry.color, count: entry.count, absenceBucket: entry.isAbsent === true, sampleRefs: sample(entry.id) }) }))
      : lens.rules.filter(rule => s.lensRuleCounts.has(rule.id)).map(rule => ({ id: rule.id, row: () => evidenceRow({ kind: 'lensRule', unit: 'elements' }, {
        ruleId: rule.id, name: rule.name, action: rule.action, color: rule.color, count: s.lensRuleCounts.get(rule.id) ?? 0,
        unreadableLegacyRule: rule.unreadableLegacy !== undefined, sampleRefs: sample(rule.id) }) }));
    let totalMatched = 0;
    for (const count of s.lensRuleCounts.values()) totalMatched += count;
    return {
      summary: {
        kind: 'lens', lensId: lens.id, lensName: lens.name, builtin: lens.builtin === true,
        mode: autoColor ? 'autoColor' : 'rules',
        autoColor: autoColor ? { source: autoColor.source, psetName: autoColor.psetName ?? null, propertyName: autoColor.propertyName ?? null } : null,
        ruleCount: lens.rules.length, enabledRuleCount: lens.rules.filter(rule => rule.enabled).length,
        evaluatedBucketCount: s.lensRuleCounts.size, totalMatched, unmatchedCount: unmatchedCount(s),
        hiddenCount: s.lensHiddenIds.size, units: { counts: 'elements' },
        limitations: 'Counts are the live Lens evaluation of the loaded models. Each element is counted under the first enabled rule it matches, so rule counts do not overlap; disabled rules are not evaluated. unmatchedCount counts elements the Lens shows as ghosted context and is null when no colour overlay was published. sampleRefs lists at most 5 elements per row. A Lens colours and hides elements; it is not a pass/fail check.',
      },
      rows: population.slice(0, limit).map(entry => entry.row()),
      totalRows: population.length, availability: 'available',
    };
  },
};
