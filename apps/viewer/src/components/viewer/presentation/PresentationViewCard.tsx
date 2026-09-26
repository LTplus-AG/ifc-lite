/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One saved-view card in the `PresentationPanel` filmstrip: thumbnail,
 * active badge, inline rename, and the rename/transition/delete action
 * buttons. Split out of `PresentationPanel.tsx` to keep that module under
 * its size budget (#5508).
 */
import { Pencil, Timer, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import type { BasketView } from '@/store/slices/pinboardSlice';

export interface PresentationViewCardProps {
  view: BasketView;
  isActive: boolean;
  isEditing: boolean;
  editingName: string;
  onSelect: () => void;
  onStartRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onEditingNameChange: (name: string) => void;
  onSetTransition: () => void;
  onDelete: () => void;
}

export function PresentationViewCard({
  view,
  isActive,
  isEditing,
  editingName,
  onSelect,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onEditingNameChange,
  onSetTransition,
  onDelete,
}: PresentationViewCardProps) {
  const { t } = useTranslation();
  return (
    <div className="relative w-[186px] h-full max-h-[130px] shrink-0 snap-start">
      <button
        type="button"
        onClick={() => { if (!isEditing) onSelect(); }}
        className={cn(
          'h-full w-full rounded-md border bg-card text-left overflow-hidden transition-colors',
          isActive && 'ring-2 ring-primary border-primary',
        )}
      >
        {view.thumbnailDataUrl ? (
          <img
            src={view.thumbnailDataUrl}
            alt={view.name}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 bg-muted" />
        )}

        {isActive && (
          <div className="absolute left-1 top-1 rounded bg-primary px-1.5 py-0.5 text-2xs font-semibold text-primary-foreground">
            {t('presentationPanel.activeBadge')}
          </div>
        )}
      </button>

      <div className={cn('absolute inset-x-0 bottom-0 bg-black/60 text-white px-2 py-1', !isEditing && 'pointer-events-none')}>
        {isEditing ? (
          <Input
            // The input only mounts when the user clicks Rename, so taking focus
            // is the response to their own action, not a focus jump on load.
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            value={editingName}
            onChange={(e) => onEditingNameChange(e.target.value)}
            onBlur={onCommitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onCommitRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onCancelRename();
              }
            }}
            className="h-6 bg-black/40 text-xs border-white/30 text-white placeholder:text-white/60"
          />
        ) : (
          <>
            <div className="text-[12px] font-medium truncate">{view.name}</div>
            <div className="text-2xs opacity-80">
              {t('presentationPanel.objectsCount', { count: view.entityRefs.length })}
              {view.transitionMs ? t('presentationPanel.transitionSuffix', { duration: (view.transitionMs / 1000).toFixed(1) }) : ''}
            </div>
          </>
        )}
      </div>

      <Button
        type="button"
        variant="secondary"
        size="icon-xs"
        className="absolute top-1 right-7"
        title={t('presentationPanel.renameViewTitle')}
        onClick={(e) => { e.stopPropagation(); onStartRename(); }}
      >
        <Pencil className="h-3 w-3" />
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="icon-xs"
        className="absolute top-1 right-[3.25rem]"
        title={t('presentationPanel.setTransitionTitle')}
        onClick={(e) => { e.stopPropagation(); onSetTransition(); }}
      >
        <Timer className="h-3 w-3" />
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="icon-xs"
        className="absolute top-1 right-1"
        title={t('presentationPanel.deleteViewTitle')}
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
      >
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );
}
