/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model workspace's storey chip (charter #6232, M2 §1.4), top-left on
 * the HUD: "L1 · +3.00 m ▾" names the storey new elements land on. The
 * chevron opens the storey list; picking a storey moves the session (a
 * running command relaunches on the new plane). The eye isolates that
 * storey through the one storey-isolation channel (`applyLevelDisplayMode`)
 * and follows the session when the storey changes.
 *
 * With more than one editable model the chip names the model too, and
 * picking another model's storey leaves and re-enters the workspace on it,
 * keeping the running command. A model without a storey reads "No storey"
 * and raises a notice: nothing can be drawn until it has one.
 */

import { useMemo } from 'react';
import { ChevronDown, Eye, EyeOff, Layers, TriangleAlert } from 'lucide-react';
import { useViewerStore, type ViewerState } from '@/store';
import { applyLevelDisplayMode } from '@/store/levelDisplay';
import { toGlobalIdFromModels } from '@/store/globalId';
import { useTranslation } from '@/i18n';
import { editableModels, modelStoreys, type WorkspaceStorey } from '@/lib/commands/modeling/workspace-storeys';
import { HudChip, HudItem, HudNotice, HudPopover, HudPopoverContent, HudPopoverTrigger } from '../../viewport-ui/hud';
import { StoreyPicker, formatStoreyElevation, type StoreyPickerGroup } from './StoreyPicker';

function isIsolated(s: ViewerState, modelId: string, storeyId: number): boolean {
  return s.levelDisplayMode === 'solo' && s.selectedStoreys.has(toGlobalIdFromModels(s.models, modelId, storeyId));
}

/** Move the session to `storey`, keeping the command and the isolation (the chip and the plan header). */
export function pickWorkspaceStorey(storey: WorkspaceStorey): void {
  const s = useViewerStore.getState();
  const session = s.session;
  if (!session) return;
  const isolated = session.storeyId !== null && isIsolated(s, session.modelId, session.storeyId);
  if (storey.modelId === session.modelId) {
    if (storey.expressId !== session.storeyId) s.setSessionStorey(storey.expressId);
  } else {
    const command = session.activeCommandId ?? undefined;
    s.exitModelWorkspace();
    useViewerStore.getState().enterModelWorkspace({ modelId: storey.modelId, storeyId: storey.expressId, command });
  }
  if (isolated) applyLevelDisplayMode('solo', [{ modelId: storey.modelId, expressId: storey.expressId }]);
}

/** The storey list per editable model, while a session is open (the chip and the plan header). */
export function useWorkspaceStoreyGroups(): StoreyPickerGroup[] {
  const open = useViewerStore((s) => s.session !== null);
  const models = useViewerStore((s) => s.models);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  return useMemo<StoreyPickerGroup[]>(() => {
    void mutationVersion; // an authored storey or elevation edit
    if (!open) return [];
    const s = useViewerStore.getState();
    return editableModels(s).map((model) => ({ modelId: model.id, modelName: model.name, storeys: modelStoreys(s, model.id) }));
  }, [open, models, mutationVersion]);
}

export function WorkspaceStoreyChip() {
  const { t } = useTranslation();
  const session = useViewerStore((s) => s.session);
  const isolated = useViewerStore((s) => (s.session?.storeyId != null ? isIsolated(s, s.session.modelId, s.session.storeyId) : false));
  const groups = useWorkspaceStoreyGroups();

  if (!session) return null;
  const group = groups.find((g) => g.modelId === session.modelId);
  const current = group?.storeys.find((storey) => storey.expressId === session.storeyId) ?? null;
  // The name truncates; the elevation always shows.
  const name = !current
    ? t('modelWorkspace.storey.none')
    : groups.length > 1
      ? t('modelWorkspace.storey.withModel', { model: group?.modelName ?? '', storey: current.name })
      : current.name;
  const elevation = current ? t('modelWorkspace.storey.elevation', { elevation: formatStoreyElevation(current.elevation) }) : null;

  const toggleIsolation = () => {
    if (!current) return;
    if (isolated) applyLevelDisplayMode('stacked');
    else applyLevelDisplayMode('solo', [{ modelId: current.modelId, expressId: current.expressId }]);
  };

  return (
    <>
      <HudItem region="top-left" order={0}>
        <HudPopover>
          <HudChip
            icon={<Layers aria-hidden className="h-3.5 w-3.5 shrink-0 text-overlay-accent" />}
            toggle={current ? {
              onClick: toggleIsolation,
              'aria-label': t(isolated ? 'modelWorkspace.storey.showAll' : 'modelWorkspace.storey.isolate'),
              title: t(isolated ? 'modelWorkspace.storey.showAll' : 'modelWorkspace.storey.isolate'),
              icon: isolated
                ? <EyeOff aria-hidden className="h-3.5 w-3.5 text-overlay-accent" />
                : <Eye aria-hidden className="h-3.5 w-3.5" />,
            } : undefined}
          >
            <HudPopoverTrigger asChild>
              <button
                type="button"
                data-workspace-storey-chip
                title={t('modelWorkspace.storey.pick')}
                className="inline-flex max-w-full items-center gap-1.5 rounded-sm hover:text-foreground"
              >
                <span className="min-w-0 truncate">{name}</span>
                {elevation && <span className="shrink-0 tabular-nums text-muted-foreground">{elevation}</span>}
                <ChevronDown aria-hidden className="h-3 w-3 shrink-0 opacity-70" />
              </button>
            </HudPopoverTrigger>
          </HudChip>
          <HudPopoverContent align="start" className="p-1">
            <StoreyPicker groups={groups} current={{ modelId: session.modelId, storeyId: session.storeyId }} onPick={pickWorkspaceStorey} />
          </HudPopoverContent>
        </HudPopover>
      </HudItem>
      {!current && (
        <HudItem region="top-center" order={1}>
          <HudNotice
            tone="warn"
            icon={<TriangleAlert aria-hidden className="h-3.5 w-3.5" />}
            title={t('modelWorkspace.noStorey.title')}
            description={t('modelWorkspace.noStorey.description')}
          />
        </HudItem>
      )}
    </>
  );
}
