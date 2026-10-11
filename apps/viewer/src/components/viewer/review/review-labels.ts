/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationKey } from '@/i18n';
import type { CoordinationCard } from '@/lib/review/cards';
import type { FacetKey } from '@/lib/review/facets';
import type { FindingLifecycle, FindingSourceKind, ReviewFinding, RunGap, RunGapCode } from '@/lib/review/types';
import type { HumanStatus } from '@/lib/review/workspace';

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

export const SOURCE_KEY: Record<FindingSourceKind, TranslationKey> = {
  clash: 'reviewWorkspace.sourceKind.clash', validation: 'reviewWorkspace.sourceKind.validation',
  comparison: 'reviewWorkspace.sourceKind.comparison', bcf: 'reviewWorkspace.sourceKind.bcf', linked: 'reviewWorkspace.sourceKind.linked',
};
export const STATE_KEY: Record<CoordinationCard['state'], TranslationKey> = {
  current: 'reviewWorkspace.state.current', 'not-evaluated': 'reviewWorkspace.state.not-evaluated',
  'resolution-candidate': 'reviewWorkspace.state.resolution-candidate', record: 'reviewWorkspace.state.record',
};
export const STATE_HELP_KEY: Record<CoordinationCard['state'], TranslationKey> = {
  current: 'reviewWorkspace.stateHelp.current', 'not-evaluated': 'reviewWorkspace.stateHelp.not-evaluated',
  'resolution-candidate': 'reviewWorkspace.stateHelp.resolution-candidate', record: 'reviewWorkspace.stateHelp.record',
};
const LIFECYCLE_KEY: Record<FindingLifecycle, TranslationKey> = {
  observed: 'reviewWorkspace.lifecycle.observed', new: 'reviewWorkspace.lifecycle.new', persistent: 'reviewWorkspace.lifecycle.persistent',
  changed: 'reviewWorkspace.lifecycle.changed',
  'no-longer-observed': 'reviewWorkspace.lifecycle.no-longer-observed', 'not-evaluated': 'reviewWorkspace.lifecycle.not-evaluated',
  record: 'reviewWorkspace.lifecycle.record',
};
/** A historical finding IS the earlier run, so its counterpart is the current one (#7371 follow-up). */
const HISTORICAL_LIFECYCLE_KEY: Partial<Record<FindingLifecycle, TranslationKey>> = {
  persistent: 'reviewWorkspace.lifecycle.persistent-historical', changed: 'reviewWorkspace.lifecycle.changed-historical',
};
export function lifecycleKey(finding: Pick<ReviewFinding, 'lifecycle' | 'run'>): TranslationKey {
  return (finding.run.temporal === 'historical' ? HISTORICAL_LIFECYCLE_KEY[finding.lifecycle] : undefined) ?? LIFECYCLE_KEY[finding.lifecycle];
}
const GAP_KEY: Record<RunGapCode, TranslationKey> = {
  truncated: 'reviewWorkspace.gap.truncated', stale: 'reviewWorkspace.gap.stale', 'check-error': 'reviewWorkspace.gap.check-error',
  'sets-truncated': 'reviewWorkspace.gap.sets-truncated', 'partial-source': 'reviewWorkspace.gap.partial-source',
  'geometry-unavailable': 'reviewWorkspace.gap.geometry-unavailable', 'placement-only': 'reviewWorkspace.gap.placement-only',
  'excluded-classes': 'reviewWorkspace.gap.excluded-classes',
};
export const FACET_KEY: Record<FacetKey, TranslationKey> = {
  source: 'reviewWorkspace.facet.source', run: 'reviewWorkspace.facet.run', model: 'reviewWorkspace.facet.model',
  state: 'reviewWorkspace.facet.state', decision: 'reviewWorkspace.facet.decision', discipline: 'reviewWorkspace.facet.discipline',
  storey: 'reviewWorkspace.facet.storey',
};
export const HUMAN_STATUS_KEY: Record<HumanStatus, TranslationKey> = {
  open: 'reviewWorkspace.humanStatus.open', 'in-progress': 'reviewWorkspace.humanStatus.in-progress',
  resolved: 'reviewWorkspace.humanStatus.resolved', accepted: 'reviewWorkspace.humanStatus.accepted', dismissed: 'reviewWorkspace.humanStatus.dismissed',
};

/** Native detail (a truncation reason, a failed check's name) follows the translated reason verbatim; a catalogued message is translated. */
export function gapText(t: Translate, gaps: readonly RunGap[]): string {
  return gaps.map(gap => {
    const detail = gap.message ? t(gap.message.labelKey, gap.message.params) : gap.detail;
    return detail ? `${t(GAP_KEY[gap.code])} (${detail})` : t(GAP_KEY[gap.code]);
  }).join('; ');
}

/** Display text for one facet value; native names (models, runs, storeys, disciplines) stay as given. */
export function facetValueLabel(t: Translate, facet: FacetKey, value: string, fallback: string): string {
  if (facet === 'source') return t(SOURCE_KEY[value as FindingSourceKind] ?? 'reviewWorkspace.sourceKind.linked');
  if (facet === 'state') return t(STATE_KEY[value as CoordinationCard['state']] ?? 'reviewWorkspace.state.current');
  if (facet === 'decision') return value === 'none' ? t('reviewWorkspace.decision.none') : t(HUMAN_STATUS_KEY[value as HumanStatus] ?? 'reviewWorkspace.decision.none');
  return fallback;
}
