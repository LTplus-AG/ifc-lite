/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { resolve } from '@/i18n/registry';
import { authoredKindOf } from '@/lib/commands/modeling/authored-kinds';
import type { AuthoredElementKind } from '@/store/slices/authoringDefaultsSlice';
import { KIND_LABEL } from '../../model-inspector/inspector-fields';

/** Count selected products by kind, not the STEP records each copy creates. */
export function copySourceSummary(modelId: string, ids: readonly number[], t: typeof resolve): string {
  const s = useViewerStore.getState();
  const dataStore = s.models.get(modelId)?.ifcDataStore;
  if (!dataStore) return t('storeyManager.elements', { count: ids.length });
  const view = s.mutationViews.get(modelId);
  const groups = new Map<AuthoredElementKind | null, number>();
  for (const id of ids) {
    const kind = authoredKindOf({ dataStore, view }, id);
    groups.set(kind, (groups.get(kind) ?? 0) + 1);
  }
  const parts = [...groups].map(([kind, count]) => kind === 'wall'
    ? t('storeyManager.copy.walls', { count })
    : kind ? `${count} × ${t(KIND_LABEL[kind])}` : t('storeyManager.elements', { count }));
  return parts.length > 1 ? `(${parts.join(' + ')})` : parts[0] ?? t('storeyManager.elements', { count: 0 });
}
