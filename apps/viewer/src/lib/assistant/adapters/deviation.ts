/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BIM ↔ scan deviation statistics (#6833): the stored figures of the
 * current run (`pointCloudDeviationStatistics`, #6872), one row per scan
 * asset plus the pooled summary. Distances are signed (positive = outside
 * the nearest mesh surface), in metres. Histogram arrays and the raw
 * per-point readback are never included.
 */

import type { DeviationStatistics } from '@ifc-lite/renderer';
import { analysisStampOf } from '@/hooks/useAnalysisStaleness';
import { deviationAssetIdentities } from '@/lib/point-cloud/deviation-asset-identity';
import { evidenceRow, unavailableCapture, type EvidenceAdapter } from './types';

const LIMITATIONS = 'Statistics describe signed nearest-surface distances from scan points to ALL BIM meshes in the scene at run time, not to a specific element; '
  + 'they do not say which element a point belongs to. |d| is clamped at clipRange by the compute pass (clippedCount points sit at the clamp, so maxAbs and upper percentiles may be understated). '
  + 'With streamed (COPC) scans the run covers only the chunks loaded for the view at the time. Percentiles are of |d|; mean is signed. '
  + 'Pooled figures are one pass over every point, never an average of the asset rows. withinTolerance uses the tolerance set in the panel.';

function figures(s: DeviationStatistics) {
  return { sampleCount: s.count, validCount: s.validCount, clippedCount: s.clippedCount,
    mean: s.mean, meanAbs: s.meanAbs, rms: s.rms, stdDev: s.stdDev, min: s.min, max: s.max,
    p50Abs: s.p50Abs, p95Abs: s.p95Abs, p99Abs: s.p99Abs, maxAbs: s.maxAbs };
}

function share(count: number, validCount: number): number | null {
  return validCount > 0 ? count / validCount : null;
}

export const deviationAdapter: EvidenceAdapter = {
  id: 'deviation', group: 'quantities', panelIds: ['pointclouds'],
  titleKey: 'assistantSources.deviation.title', descriptionKey: 'assistantSources.deviation.description',
  rowMeaningKey: 'assistantSources.deviation.rows', unavailableKey: 'assistantSources.deviation.unavailable',
  suggestionKeys: ['assistantSources.deviation.suggestExplain', 'assistantSources.deviation.suggestTolerance'],
  readiness: s => {
    const statistics = s.pointCloudDeviationComputed ? s.pointCloudDeviationStatistics : null;
    if (statistics) return { status: { labelKey: 'assistantSources.deviation.ready', params: { count: statistics.assets.length } }, ready: true };
    return { status: { labelKey: s.pointCloudDeviationComputed ? 'assistantSources.deviation.reading' : 'assistantSources.deviation.none' }, ready: false };
  },
  identity: s => s.pointCloudDeviationStatistics,
  reportStamp: s => analysisStampOf(s.pointCloudDeviationStatistics),
  capture: (s, limit) => {
    const statistics = s.pointCloudDeviationComputed ? s.pointCloudDeviationStatistics : null;
    if (!statistics) return unavailableCapture({ kind: 'point-cloud-deviation', computed: s.pointCloudDeviationComputed });
    const within = statistics.withinTolerance;
    const included = statistics.assets.slice(0, Math.max(0, limit));
    const identities = deviationAssetIdentities(included, s);
    const rows = included.map((asset, i) => {
      const identity = identities[i];
      const count = within?.assets[i];
      return evidenceRow({ kind: 'scan-asset', modelId: identity.modelId, globalId: identity.globalId, expressId: identity.expressId, unit: 'm' }, {
        assetIndex: i, modelName: identity.modelName, name: identity.name, ifcClass: identity.ifcClass,
        ...figures(asset.statistics),
        withinTolerance: within && count !== undefined
          ? { tolerance: within.tolerance, count, share: share(count, asset.statistics.validCount) } : null,
      });
    });
    return {
      summary: {
        kind: 'point-cloud-deviation', units: 'm', sign: 'positive = outside the mesh surface',
        assetCount: statistics.assets.length, runRevision: statistics.revision, clipRange: statistics.clipRange,
        overall: figures(statistics.overall),
        withinTolerance: within
          ? { tolerance: within.tolerance, count: within.overall, share: share(within.overall, statistics.overall.validCount) }
          : 'not yet counted',
        colourRamp: { center: s.pointCloudDeviationCenterOffset, halfRange: s.pointCloudDeviationHalfRange },
        limitations: LIMITATIONS,
      },
      rows, totalRows: statistics.assets.length, availability: 'available',
    };
  },
};
