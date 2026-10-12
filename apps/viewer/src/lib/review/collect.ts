/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One review snapshot: every registered source's runs and findings, grouped into cards. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { effectiveStoreyId } from '../effective-storey';
import { snapshotFrom as collectSnapshot, type ReviewSnapshot as SharedReviewSnapshot } from '@ifc-lite/sdk/review';
import type { TranslatableMessage } from '@/i18n';
import { FINDING_SOURCES } from './sources';
import type { FindingSource, ReviewModel } from './types';

export type ReviewSnapshot = SharedReviewSnapshot<TranslatableMessage>;

export function reviewModel(id: string, name: string, store: IfcDataStore, view?: MutablePropertyView | null): ReviewModel {
  return {
    id, name,
    expressIdOf: globalId => store.entities.getExpressIdByGlobalId(globalId),
    globalIdOf: expressId => store.entities.getGlobalId(expressId) ?? '',
    storeyOf: expressId => {
      const storey = effectiveStoreyId(store, view, expressId);
      // A resolved storey with a blank Name still facets, under the label the rest of the viewer uses.
      return storey ? store.entities.getName(storey) || `Storey #${storey}` : null;
    },
  };
}

export function liveReviewModels(): ReviewModel[] {
  const state = useViewerStore.getState();
  return [...state.models.values()].flatMap(model => model.ifcDataStore
    ? [reviewModel(model.id, model.name, model.ifcDataStore, state.mutationViews.get(model.id))] : []);
}

export function snapshotFrom(sources: readonly FindingSource[], models: readonly ReviewModel[]): ReviewSnapshot {
  return collectSnapshot(sources, models, (source, error) => console.warn(`[Review] ${source} findings unavailable`, error));
}
export function captureReviewSnapshot(): ReviewSnapshot {
  return snapshotFrom(FINDING_SOURCES, liveReviewModels());
}
