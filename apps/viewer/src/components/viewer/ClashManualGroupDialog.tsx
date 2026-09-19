/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from '@/i18n';

interface ClashManualGroupDialogProps {
  open: boolean;
  initialName: string;
  memberCount: number;
  mode: 'create' | 'rename';
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string) => void;
}

export function ClashManualGroupDialog({
  open,
  initialName,
  memberCount,
  mode,
  onOpenChange,
  onSubmit,
}: ClashManualGroupDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  useEffect(() => {
    if (open) setName(initialName);
  }, [open, initialName]);

  const submit = (): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t(mode === 'create' ? 'clashGroups.createTitle' : 'clashGroups.renameTitle')}</DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? t('clashGroups.createDescription', { count: memberCount })
              : t('clashGroups.renameDescription')}
          </DialogDescription>
        </DialogHeader>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">{t('clashGroups.name')}</span>
          <input
            autoFocus
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-foreground"
          />
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('clashGroups.cancel')}</Button>
          <Button disabled={!name.trim()} onClick={submit}>{t(mode === 'create' ? 'clashGroups.create' : 'clashGroups.saveName')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
