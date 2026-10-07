/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review notice for a migrated or imported sidebar layout (#6927). Shows what
 * changed and offers Keep or Reset. Neither deletes data: the original layout
 * stays in its backup key, preserved placements stay stored, and Reset is the
 * one workspace `resetLayout()`.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { resetLayout } from '@/store/layoutReset';
import { LayoutChangeList } from './LayoutChangeList';

export function LayoutMigrationNotice() {
  const { t } = useTranslation();
  const changes = useViewerStore((s) => s.layoutMigrationChanges);
  const acknowledge = useViewerStore((s) => s.acknowledgeLayoutMigration);
  const [open, setOpen] = useState(false);
  if (changes.length === 0) return null;
  return <section role="status" aria-label={t('workspaceMigration.layout.title')}
    className="shrink-0 border-b border-border bg-muted/40 px-3 py-2 text-xs space-y-2">
    <p className="font-medium">{t('workspaceMigration.layout.title')}</p>
    <p className="text-muted-foreground">{t('workspaceMigration.layout.summary', { count: changes.length })}</p>
    {open && <LayoutChangeList changes={changes} />}
    <div className="flex flex-wrap gap-1">
      <Button size="sm" variant="ghost" className="h-7" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? t('workspaceMigration.layout.hideChanges') : t('workspaceMigration.layout.showChanges')}
      </Button>
      <Button size="sm" variant="outline" className="h-7" onClick={acknowledge}>{t('workspaceMigration.layout.keep')}</Button>
      <Button size="sm" variant="outline" className="h-7" onClick={() => resetLayout()}>{t('workspaceMigration.layout.reset')}</Button>
    </div>
  </section>;
}
