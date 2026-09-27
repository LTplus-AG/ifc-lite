/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model inspector side panel (charter #6232, M2). The Model workspace
 * shows it on entry and puts the previous panel back on exit. This is its
 * shell: the empty states that tell the user how to get started. The Type,
 * Dimensions, Material layers and Hosting sections land with the inspector
 * work (M2.5) inside the same body.
 */

import { X } from 'lucide-react';
import { EditElement } from '@/icons';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';

export function ModelInspectorPanel({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const hasModel = useViewerStore((s) => s.models.size > 0);
  const inSession = useViewerStore((s) => s.session !== null);
  const canEdit = useViewerStore((s) => s.canCollabEdit());
  const enter = useViewerStore((s) => s.enterModelWorkspace);

  return (
    <div data-model-inspector className="flex h-full min-h-0 flex-col" aria-label={t('modelInspector.panel.title')}>
      <div className="flex items-center gap-2 border-b border-border p-3">
        <EditElement aria-hidden className="h-4 w-4 text-muted-foreground" />
        <h2 className="flex-1 truncate text-xs font-medium">{t('modelInspector.panel.title')}</h2>
        {onClose && (
          <IconButton label={t('modelInspector.close')} className="h-6 w-6" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        {!hasModel ? (
          <p className="max-w-[16rem] text-xs text-muted-foreground">{t('modelInspector.empty.noModel')}</p>
        ) : !inSession ? (
          <>
            <p className="max-w-[16rem] text-xs text-muted-foreground">{t('modelInspector.empty.noSession')}</p>
            <Button size="sm" variant="outline" disabled={!canEdit} onClick={() => enter()}>
              <EditElement aria-hidden className="h-3.5 w-3.5" />
              {t('modelInspector.empty.enter')}
            </Button>
          </>
        ) : (
          <p data-model-inspector-idle className="max-w-[16rem] text-xs text-muted-foreground">{t('modelInspector.empty.idle')}</p>
        )}
      </div>
    </div>
  );
}
