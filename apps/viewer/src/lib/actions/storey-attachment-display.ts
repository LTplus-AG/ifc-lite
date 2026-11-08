/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parsePropertyValue } from '@ifc-lite/encoding';
import { NEXT_STOREY_ABOVE, readStoreyInventory } from '@ifc-lite/create';
import type { ViewerState } from '@/store';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { effectiveStoreyId } from '@/lib/effective-storey';
import { formatStoreyElevation } from '@/components/viewer/model/StoreyPicker';
import { resolve } from '@/i18n/registry';

/** #9296: unknown binding kinds and stale GUIDs remain visible verbatim. */
export function storeyAttachmentDisplay(s: ViewerState, modelId: string, entityId: number, value: unknown, t: typeof resolve = resolve): { text: string; raw: string } | null {
  const raw = parsePropertyValue(value).displayValue;
  const target = modelEditTarget(s, modelId);
  if (!target) return null;
  const inventory = readStoreyInventory(target.dataStore, target.view);
  const levels = modelStoreys(s, modelId);
  let level = inventory.storeys.find(storey => storey.GlobalId === raw);
  if (raw === NEXT_STOREY_ABOVE) {
    const base = effectiveStoreyId(target.dataStore, target.view, entityId);
    const index = levels.findIndex(storey => storey.expressId === base);
    const next = index >= 0 ? levels[index + 1] : undefined;
    level = next ? inventory.storeys.find(storey => storey.expressId === next.expressId) : undefined;
  }
  const elevation = level ? levels.find(storey => storey.expressId === level.expressId)?.elevation : undefined;
  if (!level || elevation === undefined) return null;
  return { text: t('storeyManager.wallTarget', { storey: level.Name, elevation: formatStoreyElevation(elevation) }), raw };
}
