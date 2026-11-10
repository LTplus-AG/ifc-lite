/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared Model workspace bar: one storey picker and workplane height,
 * plan actions, layout control and Leave across both panes. PlanView portals
 * it into the workspace host so plan state survives layout changes.
 */

import { Grid3x3, Maximize } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { primaryShortcutLabel } from '@/lib/commands/shortcut-label';
import type { ModelLayout } from '@/store/slices/authoringSessionSidebar';
import { HudSegmented } from '../../viewport-ui/hud';
import { WorkspaceStoreyControl } from '../model/WorkspaceStoreyChip';
import { PlanWorkplaneHeight } from '../model/WorkplaneHeightControl';
import { leaveModelWorkspace } from '../model/rail-tools';

export interface PlanHeaderProps {
  grid: boolean;
  onToggleGrid: () => void;
  onFit: () => void;
  /** The cut is being (re)generated. */
  loading: boolean;
  /** The model is over the cut's mesh limit: only wall axes are drawn. */
  simplified: boolean;
  /** The cut threw: say so (an empty plan would read as an empty storey) and offer a retry. */
  failed: boolean;
  onRetry: () => void;
  /** The layout on screen (the user's pick, as `model-layout.ts` resolves it). */
  layout: ModelLayout;
}

const iconButton = 'inline-flex h-5 w-5 items-center justify-center rounded-sm transition-colors';

export function PlanHeader({ grid, onToggleGrid, onFit, loading, simplified, failed, onRetry, layout }: PlanHeaderProps) {
  const { t } = useTranslation();
  const setModelLayout = useViewerStore((s) => s.setModelLayout);
  const leaveKey = primaryShortcutLabel('edit.toggleEditMode');

  return (
    <div data-plan-header data-workspace-bar className="flex h-7 shrink-0 items-center gap-1 border-b border-border/60 bg-muted/20 px-1.5 text-xs">
      <WorkspaceStoreyControl />
      <PlanWorkplaneHeight />
      {loading && <span data-plan-status="loading" className="shrink-0 text-2xs text-muted-foreground">{t('modelWorkspace.plan.cutting')}</span>}
      {simplified && (
        <span data-plan-status="simplified" title={t('modelWorkspace.plan.simplifiedTitle')} className="shrink-0 rounded-sm bg-muted px-1 text-2xs text-muted-foreground">
          {t('modelWorkspace.plan.simplified')}
        </span>
      )}
      {failed && (
        <span data-plan-status="failed" className="flex shrink-0 items-center gap-1 text-2xs text-status-danger">
          {t('modelWorkspace.plan.cutFailed')}
          <button type="button" onClick={onRetry} className="rounded-sm px-1 underline hover:bg-accent">
            {t('modelWorkspace.plan.retry')}
          </button>
        </span>
      )}
      <span className="flex-1" />
      <button
        type="button"
        aria-pressed={grid}
        aria-label={t('modelWorkspace.plan.grid')}
        title={t('modelWorkspace.plan.grid')}
        onClick={onToggleGrid}
        className={cn(iconButton, grid ? 'bg-overlay-accent-soft text-overlay-accent' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground')}
      >
        <Grid3x3 aria-hidden className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label={t('modelWorkspace.plan.fit')}
        title={t('modelWorkspace.plan.fit')}
        onClick={onFit}
        className={cn(iconButton, 'text-muted-foreground hover:bg-accent hover:text-accent-foreground')}
      >
        <Maximize aria-hidden className="h-3.5 w-3.5" />
      </button>
      <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
      <HudSegmented<ModelLayout>
        aria-label={t('modelWorkspace.layout.aria')}
        value={layout}
        onChange={setModelLayout}
        options={[
          { value: 'plan', ariaLabel: t('modelWorkspace.layout.plan'), label: <>{t('modelWorkspace.layout.plan')} <kbd aria-hidden className="ml-1 rounded-sm border border-current/30 px-1 font-sans text-2xs">1</kbd></> },
          { value: 'split', ariaLabel: t('modelWorkspace.layout.split'), label: <>{t('modelWorkspace.layout.split')} <kbd aria-hidden className="ml-1 rounded-sm border border-current/30 px-1 font-sans text-2xs">2</kbd></> },
          { value: '3d', ariaLabel: t('modelWorkspace.layout.3d'), label: <>{t('modelWorkspace.layout.3d')} <kbd aria-hidden className="ml-1 rounded-sm border border-current/30 px-1 font-sans text-2xs">3</kbd></> },
        ]}
      />
      <button type="button" data-workspace-leave onClick={leaveModelWorkspace} aria-keyshortcuts={leaveKey}
        className="shrink-0 rounded-sm px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
        {t('modelWorkspace.leave')}
        <span aria-hidden className="ml-1 opacity-60">{t('modelWorkspace.tool.shortcutHint', { key: leaveKey })}</span>
      </button>
    </div>
  );
}
