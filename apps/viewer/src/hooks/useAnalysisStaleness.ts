/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state';
import { equalTranslation, type Translation } from '@/lib/model-placement/translation';

interface PlacementStamp {
  name?: string;
  sourceFingerprint?: string;
  sourceContentHash?: string;
  translation: Translation;
  angle: number;
  pivot: Translation;
}

export interface AnalysisStamp {
  mutationVersion: number;
  geometryContentVersion: number;
  placement?: ReadonlyMap<string, PlacementStamp>;
  realignedFrameKey?: string | null;
}

// Reports stay in the viewer store across panel remounts. Keep their run
// versions with the report object rather than in a panel-local ref; a derived
// Clash view can use its original raw report as the key.
const reportStamps = new WeakMap<object, AnalysisStamp>();

export function captureAnalysisStamp(includePlacement = false): AnalysisStamp {
  const state = useViewerStore.getState();
  return {
    mutationVersion: state.mutationVersion,
    geometryContentVersion: state.geometryContentVersion,
    ...(includePlacement ? {
      placement: new Map([...state.models].map(([id, model]) => {
        const rotation = placementFor(state.modelPlacement, id).rotation;
        return [id, { name: model.name, sourceFingerprint: model.sourceFingerprint, sourceContentHash: model.sourceContentHash,
          translation: [...displayedTranslation(state.modelPlacement, id)] as Translation,
          angle: rotation.angle, pivot: [...rotation.pivot] as Translation }] as const;
      })),
      realignedFrameKey: state.modelPlacement.realignedFrameKey,
    } : {}),
  };
}

export function stampAnalysisReport<T extends object>(report: T, stamp: AnalysisStamp): T {
  reportStamps.set(report, stamp);
  return report;
}

export function analysisStampOf(report: object | null | undefined): AnalysisStamp | null {
  return report ? reportStamps.get(report) ?? null : null;
}

export function useAnalysisStaleness(stamp: AnalysisStamp | null): boolean {
  const mutationVersion = useViewerStore((state) => state.mutationVersion);
  const geometryContentVersion = useViewerStore((state) => state.geometryContentVersion);
  const placement = useViewerStore((state) => stamp?.placement ? state.modelPlacement : null);
  const models = useViewerStore((state) => stamp?.placement ? state.models : null);
  return isAnalysisStale(stamp, { mutationVersion, geometryContentVersion, modelPlacement: placement, models });
}

/** Shared native freshness check for both UI and commit/request boundaries. */
export function isAnalysisStale(stamp: AnalysisStamp | null, state: {
  mutationVersion: number;
  geometryContentVersion: number;
  modelPlacement: ReturnType<typeof useViewerStore.getState>['modelPlacement'] | null;
  models: ReturnType<typeof useViewerStore.getState>['models'] | null;
}): boolean {
  const { mutationVersion, geometryContentVersion, modelPlacement: placement, models } = state;
  return stamp !== null && (
    stamp.mutationVersion !== mutationVersion ||
    stamp.geometryContentVersion !== geometryContentVersion ||
    (stamp.placement !== undefined && placement !== null && models !== null && (
      stamp.placement.size !== models.size ||
      stamp.realignedFrameKey !== placement.realignedFrameKey ||
      [...stamp.placement].some(([id, saved]) => {
        if (!models.has(id)) return true;
        const rotation = placementFor(placement, id).rotation;
        return !equalTranslation(saved.translation, displayedTranslation(placement, id)) ||
          saved.angle !== rotation.angle || !equalTranslation(saved.pivot, rotation.pivot);
      })
    ))
  );
}
