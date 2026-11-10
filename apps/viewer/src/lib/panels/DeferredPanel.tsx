/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Suspense, type ReactNode } from 'react';
import { ChunkErrorBoundary } from '@/components/ChunkErrorBoundary';
import { PanelHeader } from '@/components/ui/panel-header';
import { Spinner } from '@/components/ui/spinner';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { panelTitleKey } from './registry';

type DeferredPanelId = 'bcf' | 'validation' | 'lens';
const labels = { bcf: 'BCF panel', validation: 'Validation panel', lens: 'Lens panel' } as const;

/** Keep a cold panel visible and dismissible while its module arrives. */
export function DeferredPanel({ id, onClose, children }: {
  id: DeferredPanelId; onClose: () => void; children: ReactNode;
}) {
  const { t } = useTranslation();
  const mobile = useViewerStore(s => s.isMobile);
  const shell = (content: ReactNode) => <div className="flex h-full flex-col">
    {!mobile && <PanelHeader title={t(panelTitleKey(id))} onClose={onClose} />}
    <div className="min-h-0 flex-1 p-4">{content}</div>
  </div>;
  return <ChunkErrorBoundary key={id} label={labels[id]} renderFallback={shell}>
    <Suspense fallback={shell(<div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner className="h-4 w-4" />{t('shellChrome.statusBar.loadingFallback')}
    </div>)}>{children}</Suspense>
  </ChunkErrorBoundary>;
}
