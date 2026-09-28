/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The status bar's Model workspace chip (charter #6232, WP2): names the
 * storey new geometry lands on while the workspace is open, and enters or
 * leaves it on click — the same toggle as the ribbon's Model button and E.
 * Hidden when no model is loaded, and for roles that cannot edit.
 */

import { PenLine } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Separator } from '@/components/ui/separator';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';

export function StatusBarWorkspaceChip() {
  const { t } = useTranslation();
  const hasModel = useViewerStore((s) => s.models.size > 0);
  const canEdit = useViewerStore((s) => s.canCollabEdit());
  const active = useViewerStore((s) => s.workspaceMode === 'model');
  const storeyName = useViewerStore((s) => {
    const session = s.session;
    if (!session || session.storeyId === null) return null;
    const store = s.models.get(session.modelId)?.ifcDataStore;
    return store?.entities.getName(session.storeyId) || null;
  });
  const toggleEditEnabled = useViewerStore((s) => s.toggleEditEnabled);
  if (!hasModel || !canEdit) return null;

  const label = active && storeyName
    ? t('shellChrome.statusBar.modelWorkspaceStorey', { storey: storeyName })
    : t('shellChrome.statusBar.modelWorkspace');
  const title = active ? t('shellChrome.statusBar.leaveModelWorkspace') : t('shellChrome.statusBar.enterModelWorkspace');
  return (
    <>
      <button
        type="button"
        onClick={toggleEditEnabled}
        aria-pressed={active}
        title={title}
        data-workspace-chip
        className={cn(
          // Same hit-slop idiom as the Presentation button beside it (#5826).
          'relative flex items-center gap-1.5 rounded px-1 -mx-1 transition-colors hover:text-foreground after:absolute after:inset-x-0 after:-top-1 after:-bottom-1 after:content-[\'\'] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          active && 'text-foreground',
        )}
      >
        <PenLine className={cn('h-3.5 w-3.5', active && 'text-overlay-accent')} />
        <span>{label}</span>
      </button>
      <Separator orientation="vertical" className="h-3.5" />
    </>
  );
}
