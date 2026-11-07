/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Words for storey plans and refusals (#9013). `@ifc-lite/create` decides
 * every refusal with a stable `code` and the parameters a sentence needs;
 * this turns them into the viewer's language. A refusal with no catalogue
 * sentence (one an element-specific editor raised, such as a door that would
 * stand above its wall's new top) keeps the core's own words, prefixed.
 */

import type { StoreyLevelPlan, StoreyNotice, StoreyRefusal } from '@ifc-lite/create';
import type { UseTranslationResult } from '@/i18n/useTranslation';
import { formatElevation } from './storey-length.js';

type T = UseTranslationResult['t'];

const text = (value: unknown): string => (typeof value === 'string' ? value : String(value ?? ''));

export function refusalText(t: T, refusal: StoreyRefusal): string {
  const p = refusal.params ?? {};
  const count = refusal.elementIds?.length ?? 0;
  switch (refusal.code) {
    case 'spacing':
      return t('storeyManager.refusal.spacing', { storey: text(p.storey), neighbour: text(p.neighbour) });
    case 'crossing':
      return t(p.side === 'below' ? 'storeyManager.refusal.crossingBelow' : 'storeyManager.refusal.crossingAbove', {
        storey: text(p.storey), neighbour: text(p.neighbour),
        neighbourElevation: typeof p.neighbourElevation === 'number' ? formatElevation(p.neighbourElevation) : '',
      });
    case 'topStorey':
      return t('storeyManager.refusal.topStorey', { storey: text(p.storey) });
    case 'sharedPlacement':
      return t('storeyManager.refusal.shared', { count });
    case 'unplaced':
      return t('storeyManager.refusal.unplaced', { count });
    case 'unreadablePlacement':
      return t('storeyManager.refusal.unreadable', { count });
    case 'onlyStorey':
      return t('storeyManager.refusal.onlyStorey');
    case 'stale':
      return t('storeyManager.refusal.stale');
    case 'tooLarge':
      return t('storeyManager.refusal.tooLarge', { storey: text(p.storey) });
    case 'invalidValue':
      return t('storeyManager.invalid.length');
    default:
      return t('storeyManager.refusal.other', { reason: refusal.message });
  }
}

export function noticeText(t: T, notice: StoreyNotice): string {
  const count = notice.elementIds.length;
  if (notice.code === 'wallNotResized') return t('storeyManager.notice.wallNotResized', { count });
  if (notice.code === 'stairNotRefit') return t('storeyManager.notice.stairNotRefit', { count });
  if (notice.code === 'wallAttachmentUnresolved') return t('storeyManager.notice.wallAttachmentUnresolved', { count });
  if (notice.code === 'wallQuantitiesPartial') return t('storeyManager.notice.wallQuantitiesPartial', { count });
  return notice.message;
}

/** "Moves 2 storeys · moves 24 elements · resizes 8 walls · refits 1 stair". */
export function impactParts(t: T, plan: StoreyLevelPlan): string[] {
  if (plan.storeys.length === 0) return [t('storeyManager.impact.nothing')];
  const parts = [t('storeyManager.impact.storeys', { count: plan.storeys.length })];
  if (plan.movedElementCount > 0) parts.push(t('storeyManager.impact.elements', { count: plan.movedElementCount }));
  if (plan.walls.length > 0) parts.push(t('storeyManager.impact.walls', { count: plan.walls.length }));
  if (plan.stairs.length > 0) parts.push(t('storeyManager.impact.stairs', { count: plan.stairs.length }));
  if (plan.held.length > 0) parts.push(t('storeyManager.impact.held', { count: plan.held.length }));
  return parts;
}
