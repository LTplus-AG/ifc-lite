/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store';
import { isModelStreaming } from '@/lib/streaming-refresh';

/** No store means unknown only during an active metadata load. Completed
 * geometry-only formats and failed loads have no layer assignments to await. */
export function presentationMetadataReady(
  models: ReadonlyMap<string, FederatedModel>,
  legacyStore: IfcDataStore | null | undefined,
  legacyLoading: boolean,
): boolean {
  if (models.size === 0) return !!legacyStore || !legacyLoading;
  for (const model of models.values()) {
    if (model.ifcDataStore || model.loadState === 'error' || model.metadataLoadState === 'error') continue;
    if (isModelStreaming(model) || model.loadState === 'hydrating-metadata'
      || model.metadataLoadState === 'bootstrapping' || model.metadataLoadState === 'querying') return false;
  }
  return true;
}
