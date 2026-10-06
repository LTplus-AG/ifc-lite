/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One chart source's dataset from a store snapshot, outside React (#6833):
 * the same builders `useChartDatasets` memoizes per source, for callers
 * that read the store once (the assistant's charts evidence).
 */

import type { ChartDataset, ChartScope, ChartSource, ElementFieldBinding } from '@ifc-lite/charts';
import type { ViewerState } from '@/store';
import { buildElementsDataset } from './elements';
import { buildClashDataset } from './clash';
import { buildBcfDataset } from './bcf';
import { buildScheduleDataset } from './schedule';
import { buildIdsDataset } from './ids';
import { buildCompareDataset } from './compare';

export function chartDatasetFromState(source: ChartSource, state: ViewerState, scope: ChartScope, fields: readonly ElementFieldBinding[]): ChartDataset {
  switch (source) {
    case 'elements': return buildElementsDataset(scope, fields, state);
    case 'clash': return buildClashDataset(state);
    case 'bcf': return buildBcfDataset(state);
    case 'schedule': return buildScheduleDataset(state);
    case 'ids': return buildIdsDataset(state);
    case 'compare': return buildCompareDataset(state);
  }
}
