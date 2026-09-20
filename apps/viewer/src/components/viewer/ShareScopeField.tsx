/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Share dialog's scope field (#4444): with several models loaded, what
 * the room carries — the active model only, or every loaded model, each in
 * its own room slot. Rendered only when there is a choice to make.
 *
 * The choice is live until the room exists (`editable`): a room's scope is
 * fixed by its seed, so the dialog creates the room only on "Create link".
 * Once the room exists the radios stay visible but disabled and the caption
 * reports how many models the room actually carries, which is what the seed
 * put there rather than the radio's current value.
 */

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n';
import type { ShareScope } from '@/lib/collab/share-scope';

interface ShareScopeFieldProps {
  scope: ShareScope;
  onScopeChange: (scope: ShareScope) => void;
  /** True until the room exists: the radios and "Create link" are live. */
  editable: boolean;
  onConfirm: () => void;
  /** Number of models loaded in the workspace. */
  loadedCount: number;
  /**
   * How many of them a share of every model would carry: a GLB, a point cloud
   * or a model still loading has no parsed store and nothing to seed, so the
   * option must not promise more models than the room will hold.
   */
  seedableCount: number;
  /** Name of the active model (the "active only" option's subject). */
  activeModelName: string;
  /** Number of models the room carries once it exists, else `null`. */
  roomModelCount: number | null;
}

export function ShareScopeField({
  scope,
  onScopeChange,
  editable,
  onConfirm,
  loadedCount,
  seedableCount,
  activeModelName,
  roomModelCount,
}: ShareScopeFieldProps) {
  const { t } = useTranslation();
  const partial = seedableCount !== loadedCount;
  const allLabel = partial
    ? t('shareScopeField.allPartial', { seedable: seedableCount, loaded: loadedCount })
    : t('shareScopeField.allFull', { loaded: loadedCount });
  const caption =
    roomModelCount !== null
      ? t('shareScopeField.roomCarries', { count: roomModelCount })
      : scope === 'all'
        ? partial
          ? t('shareScopeField.partialCanBeShared', { seedable: seedableCount, loaded: loadedCount })
          : t('shareScopeField.allShared')
        : t('shareScopeField.onlyActiveShared', { model: activeModelName });
  return (
    <div className="flex flex-col gap-2">
      <Label>{t('shareScopeField.shareLabel')}</Label>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('shareScopeField.scopeAriaLabel')}>
        <Button
          type="button"
          role="radio"
          aria-checked={scope === 'active'}
          variant={scope === 'active' ? 'default' : 'outline'}
          size="sm"
          className="truncate"
          disabled={!editable}
          onClick={() => onScopeChange('active')}
        >
          {t('shareScopeField.activeOnly')}
        </Button>
        <Button
          type="button"
          role="radio"
          aria-checked={scope === 'all'}
          variant={scope === 'all' ? 'default' : 'outline'}
          size="sm"
          disabled={!editable}
          onClick={() => onScopeChange('all')}
        >
          {allLabel}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{caption}</p>
      {editable && (
        <Button type="button" size="sm" className="self-start" onClick={onConfirm}>
          {t('shareScopeField.createLink')}
        </Button>
      )}
    </div>
  );
}
