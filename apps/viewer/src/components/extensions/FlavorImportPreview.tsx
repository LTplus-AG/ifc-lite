/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `FlavorImportPreview` — render an unpacked .iflv preview and offer
 * the three import strategies (merge / save as new / replace).
 *
 * Sits inside `FlavorDialog` when a preview is pending. Pure
 * presentational component; the dialog owns the busy state and the
 * outgoing actions.
 */

import { FilePlus, GitMerge } from 'lucide-react';
import type { UnpackedFlavor } from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';

interface FlavorImportPreviewProps {
  unpacked: UnpackedFlavor;
  busy: boolean;
  onCancel(): void;
  onMerge(): void;
  onSaveAsNew(): void;
  onReplace(): void;
}

export function FlavorImportPreview({
  unpacked,
  busy,
  onCancel,
  onMerge,
  onSaveAsNew,
  onReplace,
}: FlavorImportPreviewProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="text-sm font-medium">{t('extensionsFlavors.flavorImportPreview.title')}</div>
      <div className="rounded border bg-muted/30 p-3 text-xs space-y-1">
        <div>
          <span className="text-muted-foreground">{t('extensionsFlavors.flavorImportPreview.nameLabel')}</span>{' '}
          <span className="font-medium">{unpacked.flavor.name}</span>
        </div>
        <div>
          <span className="text-muted-foreground">{t('extensionsFlavors.flavorImportPreview.idLabel')}</span>{' '}
          <code className="font-mono">{unpacked.flavor.id}</code>
        </div>
        {unpacked.flavor.description && (
          <div className="text-muted-foreground">{unpacked.flavor.description}</div>
        )}
        <div className="text-muted-foreground">
          {t('extensionsFlavors.flavorImportPreview.statsLine', {
            extensions: unpacked.flavor.extensions.length,
            lenses: unpacked.flavor.lenses.length,
            queries: unpacked.flavor.savedQueries.length,
          })}
        </div>
        {unpacked.summary && (
          <div className="italic text-muted-foreground border-l-2 border-muted pl-2 mt-1">
            {unpacked.summary}
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {t('extensionsFlavors.flavorImportPreview.cancelButton')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onMerge} disabled={busy}>
          <GitMerge className="mr-1 h-3.5 w-3.5" />
          {t('extensionsFlavors.flavorImportPreview.mergeButton')}
        </Button>
        <Button variant="outline" size="sm" onClick={onSaveAsNew} disabled={busy}>
          <FilePlus className="mr-1 h-3.5 w-3.5" />
          {t('extensionsFlavors.flavorImportPreview.saveAsNewButton')}
        </Button>
        <Button size="sm" onClick={onReplace} disabled={busy}>
          {t('extensionsFlavors.flavorImportPreview.replaceButton')}
        </Button>
      </div>
    </div>
  );
}
