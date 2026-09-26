/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SourceContainer, SourceProject } from '@ifc-lite/plugin-api';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { ChevronLeft, RefreshCw } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { useTranslation } from '@/i18n';

type Step = 'projects' | 'file-areas' | 'folders';
type Translate = ReturnType<typeof useTranslation>['t'];

interface SourceBrowserHeaderProps {
  step: Step;
  providerTitle: string;
  selectedProject: SourceProject | null;
  selectedFileArea: SourceContainer | null;
  catalogUpdatedAt: number | null;
  syncing: boolean;
  busy: boolean;
  onBack: () => void;
  onSync: () => void;
}

function formatSyncTime(t: Translate, timestamp: number): string {
  const deltaMs = Math.max(0, Date.now() - timestamp);
  if (deltaMs < 60_000) return t('sources.sourceBrowserHeader.syncedJustNow');
  if (deltaMs < 3_600_000) {
    return t('sources.sourceBrowserHeader.syncedMinutesAgo', {
      count: Math.floor(deltaMs / 60_000),
    });
  }
  return t('sources.sourceBrowserHeader.syncedHoursAgo', {
    count: Math.floor(deltaMs / 3_600_000),
  });
}

export function SourceBrowserHeader({
  step,
  providerTitle,
  selectedProject,
  selectedFileArea,
  catalogUpdatedAt,
  syncing,
  busy,
  onBack,
  onSync,
}: SourceBrowserHeaderProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 border-b px-3 py-2">
      <IconButton
        label={t('sources.sourceBrowserHeader.backAria')}
        className="h-7 w-7"
        onClick={onBack}
      >
        <ChevronLeft className="h-4 w-4" />
      </IconButton>
      <span className="truncate text-sm font-medium">
        {step === 'projects' && providerTitle}
        {step === 'file-areas' && selectedProject?.name}
        {step === 'folders' && `${selectedProject?.name} / ${selectedFileArea?.name}`}
      </span>
      {step === 'folders' && selectedProject && selectedFileArea && (
        <div className="ml-auto flex items-center gap-2">
          {catalogUpdatedAt != null && (
            <span className="text-xs text-muted-foreground">
              {t('sources.sourceBrowserHeader.syncedAt', { time: formatSyncTime(t, catalogUpdatedAt) })}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={onSync}
            disabled={syncing || busy}
          >
            {syncing ? (
              <Spinner size="sm" className="mr-1.5" />
            ) : (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t('sources.sourceBrowserHeader.sync')}
          </Button>
        </div>
      )}
    </div>
  );
}
