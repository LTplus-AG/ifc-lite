/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useState, type MouseEvent, type ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { collectChangedModels } from '@/lib/export/model-changes';

interface PendingRemoval {
  modelId: string;
  name: string;
  count: number;
}

/**
 * The hierarchy's "Remove model" handler, guarded (#5604): a model with
 * unexported changes (the same per-model count the Export modified IFC… badge sums)
 * is only removed after the user confirms discarding them; a model without
 * any is removed straight away, as before.
 */
export function useConfirmRemoveModel(removeModel: (modelId: string) => void): {
  handleRemoveModel: (modelId: string, e: MouseEvent) => void;
  removeModelDialog: ReactNode;
} {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingRemoval | null>(null);

  const handleRemoveModel = useCallback((modelId: string, e: MouseEvent) => {
    e.stopPropagation();
    // Read at click time, so an edit made a moment ago is always counted.
    const changed = collectChangedModels(useViewerStore.getState()).models.find((m) => m.id === modelId);
    if (!changed) {
      removeModel(modelId);
      return;
    }
    setPending({ modelId, name: changed.name, count: changed.changeCount });
  }, [removeModel]);

  const confirmRemove = useCallback(() => {
    if (pending) removeModel(pending.modelId);
    setPending(null);
  }, [pending, removeModel]);

  const removeModelDialog = (
    <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('hierarchy.removeModelConfirm.title')}</DialogTitle>
          <DialogDescription>
            {pending && t('hierarchy.removeModelConfirm.description', { name: pending.name, count: pending.count })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setPending(null)}>
            {t('hierarchy.removeModelConfirm.cancel')}
          </Button>
          <Button variant="destructive" onClick={confirmRemove}>
            {t('hierarchy.removeModelConfirm.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { handleRemoveModel, removeModelDialog };
}
