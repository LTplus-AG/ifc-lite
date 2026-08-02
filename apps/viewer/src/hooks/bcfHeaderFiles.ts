/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared derivation of BCF markup `<Header>` source-file references (#1591).
 *
 * A topic that spans several federated models must record one header file per
 * distinct source model so the provenance round-trips. This is the single home
 * for turning a set of modelIds into `BCFHeaderFile[]`, reused by every viewer
 * topic-creation path (BCFPanel, compare -> BCF).
 */

import type { BCFHeaderFile } from '@ifc-lite/bcf';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store/types';

/** Resolve the IfcProject GlobalId for a store (undefined when unavailable). */
function projectGlobalId(store: IfcDataStore | null | undefined): string | undefined {
  const projectExpressId = store?.spatialHierarchy?.project?.expressId;
  if (projectExpressId === undefined || !store?.entities) return undefined;
  return store.entities.getGlobalId(projectExpressId) || undefined;
}

/**
 * Build one `BCFHeaderFile` per distinct modelId.
 *
 * - `filename`/`reference` come from the model display name.
 * - `ifcProject` is resolved via the model's spatial hierarchy (may be empty,
 *   which is acceptable per the BCF schema).
 * - `'legacy'` (the single-model store, when `models` is empty) is resolved via
 *   the fallback `ifcDataStore`.
 *
 * @param date creation date stamped on each file entry (topic creationDate).
 */
export function deriveHeaderFiles(
  modelIds: Iterable<string>,
  models: ReadonlyMap<string, FederatedModel>,
  ifcDataStore: IfcDataStore | null | undefined,
  date?: string,
): BCFHeaderFile[] {
  const files: BCFHeaderFile[] = [];
  const seen = new Set<string>();

  for (const modelId of modelIds) {
    if (seen.has(modelId)) continue;
    seen.add(modelId);

    if (modelId === 'legacy') {
      if (!ifcDataStore) continue;
      const filename = 'model.ifc';
      files.push({
        ifcProject: projectGlobalId(ifcDataStore),
        isExternal: true,
        filename,
        date,
        reference: filename,
      });
      continue;
    }

    const model = models.get(modelId);
    if (!model) continue;
    files.push({
      ifcProject: projectGlobalId(model.ifcDataStore),
      isExternal: true,
      filename: model.name,
      date,
      reference: model.name,
    });
  }

  return files;
}
