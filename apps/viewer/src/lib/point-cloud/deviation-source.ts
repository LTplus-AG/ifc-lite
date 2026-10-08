/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import type { AnalysisStamp } from '@/hooks/useAnalysisStaleness';
import { deviationAssetIdentities, type DeviationAssetIdentity } from './deviation-asset-identity';
import type { PointCloudDeviationStatistics } from './deviation-run-statistics';

const sources = new WeakMap<PointCloudDeviationStatistics, readonly DeviationAssetIdentity[]>();

/** Capture readback asset ownership before asynchronous statistics work (#7197). */
export function captureDeviationSource(assets: readonly { expressId: number }[], stamp: AnalysisStamp | null): readonly DeviationAssetIdentity[] | null {
  if (!stamp) return null;
  return deviationAssetIdentities(assets, useViewerStore.getState()).map(identity => ({ ...identity,
    modelName: identity.modelId ? stamp.placement?.get(identity.modelId)?.name ?? identity.modelName : null,
  }));
}

/** The stored summary retains its readback's source across tolerance passes and panel remounts. */
export function recordDeviationSource(report: PointCloudDeviationStatistics, source: readonly DeviationAssetIdentity[] | null): PointCloudDeviationStatistics {
  if (source) sources.set(report, source);
  return report;
}

/** Missing provenance stays unknown rather than borrowing today's model picker. */
export function deviationSourceOf(report: PointCloudDeviationStatistics): readonly DeviationAssetIdentity[] | null {
  return sources.get(report) ?? null;
}
