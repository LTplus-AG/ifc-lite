/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Deleting a storey that holds elements (#9013): never orphan them. Inline
 * under the row (no modal): move them, same identity and world position, to
 * another storey, or delete them with it. Both counts are shown.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { StoreySummary } from '@ifc-lite/create';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatElevation } from '@/lib/storeys/storey-length';

interface StoreyDeletePanelProps {
  row: StoreySummary;
  /** The other storeys, highest first. */
  others: readonly StoreySummary[];
  /** The storey moved contents go to by default (the one below, else above). */
  defaultTargetId: number | null;
  error: string | null;
  onMove: (targetStoreyId: number) => void;
  onDeleteContents: () => void;
  onCancel: () => void;
}

export function StoreyDeletePanel({ row, others, defaultTargetId, error, onMove, onDeleteContents, onCancel }: StoreyDeletePanelProps) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<string>(defaultTargetId === null ? '' : String(defaultTargetId));
  const titleId = useId();
  const moveId = useId();
  const firstAction = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLFieldSetElement | null>(null);
  useEffect(() => { firstAction.current?.focus(); }, []);
  // Escape anywhere in the choices keeps the storey; keys never reach the workspace.
  useEffect(() => {
    const element = panel.current;
    if (!element) return undefined;
    const onKey = (event: KeyboardEvent) => { event.stopPropagation(); if (event.key === 'Escape') onCancel(); };
    element.addEventListener('keydown', onKey);
    return () => element.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <fieldset
      ref={panel}
      aria-labelledby={titleId}
      data-storey-delete-panel
      data-storey-row-ignore
      className="mt-1.5 min-w-0 space-y-2 rounded-md border border-warn-border bg-warn-surface p-2"
    >
      <legend id={titleId} className="float-left w-full text-xs font-medium text-warn">
        {t('storeyManager.delete.title', { storey: row.Name, count: row.elementCount })}
      </legend>
      {others.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <label htmlFor={moveId} className="text-2xs text-muted-foreground">{t('storeyManager.delete.moveTo')}</label>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger id={moveId} className="h-7 min-w-0 flex-1 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {others.map((other) => (
                <SelectItem key={other.expressId} value={String(other.expressId)} className="text-xs">
                  {other.Name} · {formatElevation(other.elevation)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button ref={firstAction} size="sm" variant="outline" className="h-7" disabled={!target} onClick={() => onMove(Number(target))}>
            {t('storeyManager.delete.move')}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <Button size="sm" variant="destructive" className="h-7" onClick={onDeleteContents}>
          {t('storeyManager.delete.withContents', { count: row.elementCount })}
        </Button>
        <Button size="sm" variant="ghost" className="h-7" onClick={onCancel}>{t('storeyManager.delete.cancel')}</Button>
      </div>
      {error && <p role="alert" className="text-2xs text-danger">{error}</p>}
    </fieldset>
  );
}
