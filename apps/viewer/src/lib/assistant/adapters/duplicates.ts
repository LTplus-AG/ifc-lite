/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DUPLICATES_RULE, groupDuplicateSets, type Clash, type ClashElementRef, type ClashResult } from '@ifc-lite/clash';
import { analysisStampOf } from '@/hooks/useAnalysisStaleness';
import { duplicateSetSections, type DuplicateSetSection } from '@/lib/clash/duplicate-set-sections';
import type { ViewerState } from '@/store';
import { entityRefInModel } from './checks-entity-ref';
import { evidenceRow, unavailableCapture, type EvidenceAdapter } from './types';

const MEMBER_SAMPLE = 10;

/** The clash result on screen is a duplicate scan (the only run whose sole rule is `duplicates`). */
export function isDuplicateScan(result: ClashResult | null): boolean {
  return result !== null && result.rulesRun.length === 1 && result.rulesRun[0].id === DUPLICATES_RULE.id;
}

const elementKey = (ref: ClashElementRef): string => `${ref.model}\u0000${ref.key}\u0000${ref.ref}`;

/**
 * The panel's own coincident-set sections over every non-excluded pair. A
 * missing or stale stored grouping falls back to the package's canonical
 * set partition of the same result rather than to pairs.
 */
function sectionsOf(result: ClashResult, s: ViewerState): DuplicateSetSection[] {
  return duplicateSetSections(result, s.clashGroups, result.clashes)
    ?? groupDuplicateSets(result).map(group => ({ key: group.id, label: group.title, severity: group.severity, items: group.members }));
}

function membersOf(items: readonly Clash[]): ClashElementRef[] {
  const members = new Map<string, ClashElementRef>();
  for (const clash of items) for (const ref of [clash.a, clash.b]) members.set(elementKey(ref), ref);
  return [...members.values()];
}

/** Coincident duplicate sets from the Clash panel's duplicate scan, one row per set, never per pair. */
export const duplicatesAdapter: EvidenceAdapter = {
  id: 'duplicates', group: 'checks', panelIds: ['clash'],
  panelSubject: s => isDuplicateScan(s.clashResult),
  titleKey: 'assistantSources.duplicates.title', descriptionKey: 'assistantSources.duplicates.description',
  rowMeaningKey: 'assistantSources.duplicates.rows', unavailableKey: 'assistantSources.duplicates.unavailable',
  suggestionKeys: ['assistantSources.duplicates.suggestSummary', 'assistantSources.duplicates.suggestCleanup'],
  readiness: s => s.clashRunning ? { status: { labelKey: 'assistant.pickRunning' }, ready: false, running: true }
    : isDuplicateScan(s.clashResult)
      ? { status: { labelKey: 'assistantSources.duplicates.pickSets', params: { count: s.clashGroups?.length ?? 0 } }, ready: true }
      : { status: { labelKey: 'assistant.pickNotRun' }, ready: false },
  identity: s => [s.clashResult, s.clashGroups],
  reportStamp: s => analysisStampOf(s.clashRawResult ?? s.clashResult),
  capture: (s, limit) => {
    const result = s.clashResult;
    if (!result || !isDuplicateScan(result)) return unavailableCapture();
    const sections = sectionsOf(result, s);
    const allElements = new Set<string>();
    const setsBySeverity: Record<string, number> = {};
    const rows: unknown[] = [];
    for (const section of sections) {
      const members = membersOf(section.items);
      for (const ref of members) allElements.add(elementKey(ref));
      setsBySeverity[section.severity] = (setsBySeverity[section.severity] ?? 0) + 1;
      if (rows.length >= limit) continue;
      rows.push(evidenceRow({ kind: 'duplicateSet', status: section.severity, unit: 'elements' }, {
        setKey: section.key, title: section.label, memberCount: members.length, pairCount: section.items.length,
        members: members.slice(0, MEMBER_SAMPLE).map(ref => {
          const resolved = entityRefInModel(s, ref.model, ref.ref);
          return { modelId: ref.model, globalId: ref.key, expressId: resolved.expressId, type: ref.tag };
        }),
        membersSampled: members.length > MEMBER_SAMPLE,
      }));
    }
    const raw = s.clashRawResult ?? result;
    return {
      summary: {
        kind: 'duplicate-scan', setCount: sections.length, elementCount: allElements.size,
        pairCount: result.clashes.length, rawPairCount: raw.clashes.length,
        excludedPairCount: raw.clashes.length - result.clashes.length,
        elementsScanned: result.ruleCoverage?.find(entry => entry.rule === DUPLICATES_RULE.id)?.matchedA ?? null,
        setsBySeverity, severityMeaning: { major: 'exact duplicate: coincident boxes and matching mesh area and volume', minor: 'near-coincident overlap within the position tolerance' },
        positionTolerance: result.settings.tolerance, units: { positionTolerance: 'm', memberCount: 'elements', pairCount: 'pairs' },
        truncated: result.truncated ?? null,
        limitations: 'Sets are connected components of the reported coincident pairs, so a chain of near-coincident objects forms one set even when its ends are not themselves coincident. The scan compares bounding boxes (plus mesh area and volume for major); it does not establish which copy is correct or should be deleted. Exclusion rules are applied; the panel\'s touch and review-status filters are not. Member lists are a sample of at most 10 per set.',
      },
      rows, totalRows: sections.length, availability: 'available',
    };
  },
};
