/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { toast } from '@/components/ui/toast';
import { resolve as translate } from '@/i18n/registry';
import type { ViewerState } from '@/store';
import { entityName } from '@/lib/commands/modeling/authored-kinds';
import type { LayerFollow } from './material-layers';

/**
 * Say which elements kept their previous body after a typing or layer edit,
 * and why, so a dependent that could not regenerate is never silently stale
 * (#9296 lane U3). One message naming each element, which stays until
 * dismissed, and each room notice. Every path that types or re-layers through
 * the modelling backend reports here once its edit has committed: the
 * inspector, reviewed authoring rows and the drawing defaults.
 */
export function reportLayerFollow(state: ViewerState, modelId: string, follow: LayerFollow): void {
  if (follow.refused.length === 0 && follow.notices.length === 0) return;
  // Names read from the model as it now is; reporting never creates an edit target.
  const dataStore = state.models.get(modelId)?.ifcDataStore;
  const view = state.mutationViews?.get(modelId) ?? null;
  const name = (id: number) => (dataStore && entityName({ dataStore, view }, id)) || `#${id}`;
  const lines = follow.refused.map(({ id, reason }) => translate('modelInspector.layers.keptBody', { name: name(id), reason }));
  if (lines.length > 0) toast.error([translate('modelInspector.layers.notFollowed', { count: lines.length, countDisplay: String(lines.length) }), ...lines].join('\n'));
  for (const notice of follow.notices) toast.info(notice);
}
