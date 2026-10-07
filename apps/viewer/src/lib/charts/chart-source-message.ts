/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a chart surface says about a resolved source (`chart-source`): which
 * saved content it shows, what limits that content as evidence, or why it is
 * unavailable. One wording for the card, the chart editor, the report export,
 * the document caption and the saved clash reports dialog.
 *
 * Kept apart from the resolver on purpose. The resolver is part of the boot
 * bundle, because the assistant's evidence imports it; these texts are only
 * read by panels and dialogs that load on demand, so nothing the boot bundle
 * imports may import this module.
 */

import type { UseTranslationResult } from '@/i18n/useTranslation';
import type { ClashReportRevision } from '@/lib/clash/saved-report-revision';
import type { SavedClashReport } from '@/lib/clash/saved-report-schema';
import type { ResolvedChartSource } from './chart-source';
import { comparisonChartMessage } from './comparison-source';

type Translate = UseTranslationResult['t'];

/** What limits a saved report as evidence: a partial run, models that changed before saving,
 * clashes the exclusion rules were hiding, another model revision.
 * One list for every chart surface and the Clash panel's saved-report list. */
export function clashReportLimitBadges(report: SavedClashReport, revision: ClashReportRevision, t: Translate): string[] {
  return [
    ...(report.completeness.truncated ? [t('clashChart.badgePartial')] : []),
    ...(report.completeness.stale ? [t('clashChart.badgeStale')] : []),
    ...(report.completeness.excluded > 0 ? [t('clashChart.badgeExcluded', { count: report.completeness.excluded })] : []),
    ...(revision === 'same' ? [] : [t(`clashChart.badgeRevision.${revision}`)]),
  ];
}

/**
 * Provenance of a recorded source, or why a bound source is unavailable;
 * undefined for a live chart. For a saved clash report it is the one-line
 * statement that leads a card's subtitle, captions a document chart and is
 * the note in the chart editor. Limits come before the name because a card
 * and a document both cut a long line off at its end, and a cut-off line must
 * lose the report's name before it loses the warning.
 */
export function chartSourceMessage(source: ResolvedChartSource, t: Translate): string | undefined {
  if (source.saved !== 'clashReport') return comparisonChartMessage(source, t);
  if (source.status === 'live') return undefined;
  if (source.status === 'missing') return t('clashChart.missing');
  const { report } = source;
  return [...clashReportLimitBadges(report, source.revision, t),
    t('clashChart.caption', { name: report.name, date: new Date(report.savedAt).toLocaleDateString() })].join(' · ');
}

/** The short "source unavailable" label of a bound chart whose saved content is gone. */
export function chartSourceUnavailable(source: ResolvedChartSource, t: Translate): string {
  return t(source.saved === 'clashReport' ? 'clashChart.unavailable' : 'chartComparison.unavailable');
}
