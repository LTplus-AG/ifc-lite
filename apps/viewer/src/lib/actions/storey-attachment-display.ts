/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parsePropertyValue } from '@ifc-lite/encoding';
import { NEXT_STOREY_ABOVE, readStoreyInventory } from '@ifc-lite/create';
import type { ViewerState } from '@/store';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { authoredKindOf } from '@/lib/commands/modeling/authored-kinds';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { effectiveStoreyId } from '@/lib/effective-storey';
import { formatStoreyElevation } from '@/components/viewer/model/StoreyPicker';
import { resolve } from '@/i18n/registry';

/** #9296: unknown binding kinds and stale GUIDs remain visible verbatim. */
export function storeyAttachmentDisplay(s: ViewerState, modelId: string, entityId: number, value: unknown, t: typeof resolve = resolve, propertyName = 'TopConstraint'): { text: string; raw: string; from?: string } | null {
  const raw = parsePropertyValue(value).displayValue;
  if (raw === 'Fixed' || (propertyName.endsWith('Binding') && (raw === 'Relative' || raw === 'Explicit'))) return { text: t(raw === 'Relative' ? 'storeyManager.binding.relative' : raw === 'Explicit' ? 'storeyManager.binding.explicit' : 'storeyManager.binding.fixed'), raw };
  const target = modelEditTarget(s, modelId);
  if (!target) return raw === NEXT_STOREY_ABOVE ? { text: t('storeyManager.binding.relative'), raw } : null;
  const inventory = readStoreyInventory(target.dataStore, target.view);
  const levels = modelStoreys(s, modelId);
  let level = inventory.storeys.find(storey => storey.GlobalId === raw);
  const relative = !!level && propertyName === 'TopConstraint' && parsePropertyValue(target.view.getPropertyValue(entityId, 'IfcLite_StoreyAttachment', 'TopBinding')).displayValue === 'Relative';
  if (raw === NEXT_STOREY_ABOVE || (raw && relative)) {
    const base = effectiveStoreyId(target.dataStore, target.view, entityId);
    const home = inventory.storeys.find(storey => storey.expressId === base);
    const siblings = !home ? [] : home.parentId === null ? [home] : inventory.storeys.filter(storey => storey.parentId === home.parentId);
    const index = siblings.findIndex(storey => storey.expressId === base);
    level = index >= 0 ? siblings[index + 1] : undefined;
  }
  const elevation = level ? levels.find(storey => storey.expressId === level.expressId)?.elevation : undefined;
  if (!level || elevation === undefined) {
    if (raw !== NEXT_STOREY_ABOVE && !relative) return null;
    const height = authoredKindOf(target, entityId) === 'wall' ? s.readWallEndpoints(modelId, entityId)?.height : undefined;
    return { text: height === undefined ? t('storeyManager.wallNextMissing') : t('storeyManager.wallNextFixed', { height: height.toFixed(2) }), raw };
  }
  return { text: t('storeyManager.wallTarget', { storey: level.Name, elevation: formatStoreyElevation(elevation) }), raw, from: level.Name };
}
