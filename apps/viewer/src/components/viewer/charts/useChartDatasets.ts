/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The dashboard's datasets, one per chart source, each rebuilt only when
 * the store fields its adapter reads change: the federation for
 * `elements` (plus the basket for `basket` scope, plus every visibility
 * channel for `visible`), the clash run + reviews for `clash`, the BCF
 * project for `bcf`, the schedule + playback cursor for `schedule`, the
 * validation report for `ids`, the comparison for `compare`.
 */
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ChartDataset, ChartScope, ChartSource } from '@ifc-lite/charts';
import { useViewerStore } from '@/store';
import { buildElementsDataset } from '@/lib/charts/datasets/elements';
import { buildClashDataset } from '@/lib/charts/datasets/clash';
import { buildBcfDataset } from '@/lib/charts/datasets/bcf';
import { buildScheduleDataset } from '@/lib/charts/datasets/schedule';
import { buildIdsDataset } from '@/lib/charts/datasets/ids';
import { buildCompareDataset } from '@/lib/charts/datasets/compare';

export type ChartDatasets = Record<ChartSource, ChartDataset>;

export function useChartDatasets(scope: ChartScope): ChartDatasets {
  const models = useViewerStore((s) => s.models);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const ifcDataStore = useViewerStore((s) => s.ifcDataStore);
  const pinboardEntities = useViewerStore((s) => s.pinboardEntities);
  const visible = scope.kind === 'visible';
  // Only a `visible` scope pays for these subscriptions; the selector returns
  // a constant otherwise so a hide/isolate does not rebuild an `all` dataset.
  const visibility = useViewerStore(useShallow((s) => (visible
    ? { hidden: s.hiddenEntities, isolated: s.isolatedEntities, classFilter: s.classFilter, lensHidden: s.lensHiddenIds, storeys: s.selectedStoreys, types: s.typeVisibility }
    : null)));
  const elements = useMemo(
    () => buildElementsDataset(scope, { models, activeModelId, pinboardEntities }),
    // `visibility` is read inside the builder through the store; it is a dep so the memo invalidates.
    [scope, models, activeModelId, pinboardEntities, visibility],
  );

  const clashInputs = useViewerStore(useShallow((s) => ({ clashResult: s.clashResult, clashReviews: s.clashReviews, clashGroups: s.clashGroups, clashRunSeq: s.clashRunSeq, resolveGlobalIdInModel: s.resolveGlobalIdInModel })));
  const clash = useMemo(() => buildClashDataset({ ...clashInputs, models }), [clashInputs, models]);

  const bcfProject = useViewerStore((s) => s.bcfProject);
  const bcf = useMemo(() => buildBcfDataset({ bcfProject, models, ifcDataStore }), [bcfProject, models, ifcDataStore]);

  const scheduleInputs = useViewerStore(useShallow((s) => ({ scheduleData: s.scheduleData, scheduleSourceModelId: s.scheduleSourceModelId, playbackTime: s.playbackTime, animationEnabled: s.animationEnabled })));
  const schedule = useMemo(() => buildScheduleDataset({ ...scheduleInputs, activeModelId, models }), [scheduleInputs, activeModelId, models]);

  const idsValidationReport = useViewerStore((s) => s.idsValidationReport);
  const ids = useMemo(() => buildIdsDataset({ idsValidationReport, models, activeModelId }), [idsValidationReport, models, activeModelId]);

  const compareInputs = useViewerStore(useShallow((s) => ({ compareResult: s.compareResult, compareRunSeq: s.compareRunSeq })));
  const compare = useMemo(() => buildCompareDataset(compareInputs), [compareInputs]);

  return useMemo(() => ({ elements, clash, bcf, schedule, ids, compare }), [elements, clash, bcf, schedule, ids, compare]);
}
