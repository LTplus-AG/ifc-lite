/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The whole-set entry point for volume apportionment (issue #2508): clip every
 * straddler of one zone set, once, on an explicit click.
 *
 * This is what fills the cache the `Zone > Volume` list columns read, so the
 * Lists table and the properties panel are never two computations that can
 * disagree — they are two readers of one result, keyed by the zone-set revision
 * that produced it.
 *
 * It also answers #2508's "elements with no geometry are silently unclassified"
 * note in the only place a total is stated: a count that quietly omits elements
 * is worse than one that says how many it omitted, and WHY — the two refusal
 * reasons are different modelling problems with different fixes.
 */

import { Scissors } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { useZoneApportionment, straddlerIdsFor } from '@/hooks/useZoneApportionment';
import { coverageOf, validEntry, type ZoneSet } from '@/lib/zones';
import { isAnalysisStale } from '@/hooks/useAnalysisStaleness';
import { zoneResultSource } from '@/lib/zones/result-source';
import { ResultCoverage, ResultSource, ResultView } from './result/ResultView';
import { ResultState } from './result/ResultState';

const EVIDENCE_SAMPLE_SIZE = 20;

export function ZoneApportionSummary({ zoneSet }: { zoneSet: ZoneSet }) {
  const { t } = useTranslation();
  const cache = useViewerStore((s) => s.zoneApportionment);
  const assignments = useViewerStore((s) => s.zoneAssignments);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const geometryContentVersion = useViewerStore((s) => s.geometryContentVersion);
  const models = useViewerStore((s) => s.models);
  const modelPlacement = useViewerStore((s) => s.modelPlacement);
  const { computeSet } = useZoneApportionment();

  const entry = validEntry(cache, zoneSet);
  const coverage = coverageOf(entry);
  const source = entry ? zoneResultSource(entry) : null;
  const rows = source ? [...source.rows] : [];
  const processed = entry ? entry.byElement.size + entry.refused.size : 0;
  const unknownRows = rows.filter(([, row]) => !row || !row.legacy && !row.modelName).length;
  const missingIdentity = rows.filter(([, row]) => row && (row.legacy || row.modelName) && !row.GlobalId).length;
  const staleState = { mutationVersion, geometryContentVersion, models, modelPlacement };
  const stale = Boolean(source && (isAnalysisStale(source.stamp, staleState)
    || rows.some(([, row]) => row && isAnalysisStale(row.stamp, staleState))));
  const sourceModels = [...new Map<string, { id: string; name: string }>(rows.flatMap(([, row]) => row?.legacy
    ? [['legacy', { id: 'legacy', name: t('zonesPanel.apportionSummary.singleModel') }] as const]
    : row?.modelId && row.modelName
      ? [[JSON.stringify([row.modelId, row.modelName]), { id: JSON.stringify([row.modelId, row.modelName]), name: row.modelName }] as const] : [])).values()];
  const sourceName = t('zonesPanel.apportionSummary.source', { name: source?.zoneSetName ?? zoneSet.name });
  const unknownSource = !source || unknownRows > 0;
  const incomplete = [
    ...(!entry ? [t('zonesPanel.apportionSummary.notComputed')] : []),
    ...(entry && unknownSource ? [t('zonesPanel.apportionSummary.sourceUnknown')] : []),
    ...(stale ? [t('zonesPanel.apportionSummary.staleEvidence')] : []),
    ...(source?.incremental ? [t('zonesPanel.apportionSummary.incremental')] : []),
    ...(missingIdentity ? [t('zonesPanel.apportionSummary.identityUnknown', { count: missingIdentity })] : []),
    ...(coverage.noGeometry ? [t('zonesPanel.apportionSummary.noGeometryClause', { count: coverage.noGeometry })] : []),
    ...(coverage.unprovedSolid ? [t('zonesPanel.apportionSummary.unprovedSolidClause', { count: coverage.unprovedSolid })] : []),
    ...(coverage.rescaledByAlignment ? [t('zonesPanel.apportionSummary.rescaledClause', { count: coverage.rescaledByAlignment })] : []),
  ];
  // Recomputed off `assignments` so the count tracks v1's classification rather
  // than a stale snapshot — the same map the straddle flag itself comes from.
  void assignments;
  const straddlers = straddlerIdsFor(zoneSet.id).length;

  return (
    <ResultView source={sourceName} className="space-y-1 rounded border-t pt-1.5"
      header={<ResultSource source={sourceName} models={sourceModels}
        population={entry ? t('zonesPanel.apportionSummary.cachedPopulation', { count: processed }) : undefined} />}
      coverage={<ResultCoverage status={unknownSource ? 'uncertain' : stale ? 'stale'
        : source?.incremental || missingIdentity || entry?.refused.size ? 'partial' : 'complete'}
        counts={entry ? t('zonesPanel.apportionSummary.coverage', { apportioned: coverage.apportioned, processed })
          : t('zonesPanel.apportionSummary.notComputed')} incomplete={incomplete} />}
      actions={
      <Button
        variant="outline"
        size="sm"
        className="h-6 w-full text-xs"
        disabled={straddlers === 0}
        title={straddlers === 0
          ? t('zonesPanel.apportionSummary.noStraddlersTitle')
          : t('zonesPanel.apportionSummary.splitTitle', { count: straddlers })}
        // One SYNCHRONOUS pass (~50 us per element, ~11 ms over 241 straddlers).
        // There was a `running` flag with a spinner here; it could never be
        // seen. React batches the set-true and set-false inside one handler, so
        // the browser never painted between them — and because the handler
        // blocks, there is no window for a second click to land in either. A
        // control that shows progress it cannot have is worse than one that
        // simply completes.
        onClick={() => computeSet(zoneSet)}
      >
        <Scissors className="h-3 w-3 mr-1" />
        {t('zonesPanel.apportionSummary.splitVolumesButton', { count: straddlers })}
      </Button>}
      summary={entry && (
        <p className="text-xs text-muted-foreground leading-snug">
          {t('zonesPanel.apportionSummary.splitSummary', {
            count: coverage.apportioned.toLocaleString(),
            ms: entry.elapsedMs.toFixed(0),
          })}
          {coverage.unprovedSolid > 0 && (
            <> · {t('zonesPanel.apportionSummary.unprovedSolidClause', { count: coverage.unprovedSolid })}</>
          )}
          {coverage.noGeometry > 0 && (
            <> · {t('zonesPanel.apportionSummary.noGeometryClause', { count: coverage.noGeometry })}</>
          )}
          {/* Its own clause, not folded into "not a proven closed solid": the
              kernel DID prove these, and the fix is to re-anchor the federation
              rather than to look at the element's geometry. */}
          {coverage.rescaledByAlignment > 0 && (
            <> · {t('zonesPanel.apportionSummary.rescaledClause', { count: coverage.rescaledByAlignment })}</>
          )}
        </p>
      )}
      rows={entry && source && !source.incremental && processed === 0
        ? <ResultState kind="no-population" title={t('zonesPanel.apportionSummary.noEvaluatedStraddlers')} />
        : entry && processed > 0 && coverage.apportioned === 0
          ? <ResultState kind="partial" title={t('zonesPanel.apportionSummary.noProvedSplits')} /> : undefined}
      evidence={rows.length > 0 ? <div className="space-y-1 text-2xs">
        {rows.length > EVIDENCE_SAMPLE_SIZE && <p>{t('zonesPanel.apportionSummary.evidenceSample', {
          shown: EVIDENCE_SAMPLE_SIZE, total: rows.length,
        })}</p>}
        <ul aria-label={t('zonesPanel.apportionSummary.evidence')} className="space-y-1">
        {rows.slice(0, EVIDENCE_SAMPLE_SIZE).map(([id, row]) => <li key={id}>
          {row?.legacy ? t('zonesPanel.apportionSummary.singleModel') : row?.modelName ?? t('zonesPanel.apportionSummary.unknownModel')}
          {' · GlobalId: '}{row?.GlobalId ?? t('zonesPanel.apportionSummary.notAvailable')}
          {row?.IfcClass ? ` · ${row.IfcClass}` : ''}{row?.Name ? ` · ${row.Name}` : ''}
        </li>)}
        </ul>
      </div> : undefined} />
  );
}
