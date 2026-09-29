/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The plan pane's header bar (charter #6232, M2 §1.5), in the sidebar
 * chrome bar's style: the storey (the shared `StoreyPicker`, so it moves
 * the session exactly like the HUD chip), the grid toggle, Fit, the cut's
 * state, and the Plan | Split | 3D layout.
 */

import { ChevronDown, Grid3x3, Layers, Maximize } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ModelLayout } from '@/store/slices/authoringSessionSidebar';
import { HudPopover, HudPopoverContent, HudPopoverTrigger, HudSegmented } from '../../viewport-ui/hud';
import { StoreyPicker, formatStoreyElevation } from '../model/StoreyPicker';
import { pickWorkspaceStorey, useWorkspaceStoreyGroups } from '../model/WorkspaceStoreyChip';

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
  const session = useViewerStore((s) => s.session);
  const setModelLayout = useViewerStore((s) => s.setModelLayout);
  const groups = useWorkspaceStoreyGroups();
  const current = groups.find((g) => g.modelId === session?.modelId)?.storeys.find((s) => s.expressId === session?.storeyId) ?? null;

  return (
    <div data-plan-header className="flex h-7 shrink-0 items-center gap-1 border-b border-border/60 bg-muted/20 px-1.5 text-xs">
      <HudPopover>
        <HudPopoverTrigger asChild>
          <button
            type="button"
            data-plan-storey
            title={t('modelWorkspace.storey.pick')}
            className="inline-flex min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 hover:bg-accent hover:text-accent-foreground"
          >
            <Layers aria-hidden className="h-3.5 w-3.5 shrink-0 text-overlay-accent" />
            <span className="min-w-0 truncate">{current?.name ?? t('modelWorkspace.storey.none')}</span>
            {current && (
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {t('modelWorkspace.storey.elevation', { elevation: formatStoreyElevation(current.elevation) })}
              </span>
            )}
            <ChevronDown aria-hidden className="h-3 w-3 shrink-0 opacity-70" />
          </button>
        </HudPopoverTrigger>
        <HudPopoverContent align="start" className="p-1">
          <StoreyPicker
            groups={groups}
            current={session ? { modelId: session.modelId, storeyId: session.storeyId } : null}
            onPick={pickWorkspaceStorey}
          />
        </HudPopoverContent>
      </HudPopover>
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
          { value: 'plan', label: t('modelWorkspace.layout.plan') },
          { value: 'split', label: t('modelWorkspace.layout.split') },
          { value: '3d', label: t('modelWorkspace.layout.3d') },
        ]}
      />
    </div>
  );
}
