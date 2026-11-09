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
 * Beside the name, the context control picks what 3D does with the storeys
 * above: hidden by default, ghosted, or shown (#6232 D9).
 *
 * With more than one editable model the chip names the model too, and
 * picking another model's storey leaves and re-enters the workspace on it,
 * keeping the running command. A model without a storey reads "No storey"
 * and raises a notice: nothing can be drawn until it has one.
 */

import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { ChevronDown, Eye, EyeOff, Layers, TriangleAlert } from 'lucide-react';
import { useViewerStore } from '@/store';
import { mutationDenial } from '@/store/mutation-permission';
import { applyLevelDisplayMode } from '@/store/levelDisplay';
import { activateStorey, isStoreyIsolated } from '@/lib/storeys/storey-session';
import { useTranslation } from '@/i18n';
import { editableModels, modelStoreys, type WorkspaceStorey } from '@/lib/commands/modeling/workspace-storeys';
import { HudChip, HudItem, HudNotice, HudPopover, HudPopoverContent, HudPopoverTrigger } from '../../viewport-ui/hud';
import { StoreyPickerActions } from './storeys/StoreyPickerActions';
import { StoreyPicker, formatStoreyElevation, type StoreyPickerGroup } from './StoreyPicker';
import { COPY_TO_STOREYS_EVENT } from '@/lib/actions/copy-to-storeys-open';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { StoreyContextControl } from './StoreyContextControl';

const CopyToStoreys = lazy(() => import('./storeys/CopyToStoreys').then(module => ({ default: module.CopyToStoreys })));

/** Move the session to `storey`, keeping the command and the isolation (the chip and the plan header). */
export function pickWorkspaceStorey(storey: WorkspaceStorey): void {
  activateStorey(useViewerStore.getState(), storey.modelId, storey.expressId);
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
  const [copyOpen, setCopyOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const session = useViewerStore((s) => s.session);
  const isolated = useViewerStore((s) => (s.session?.storeyId != null ? isStoreyIsolated(s, s.session.modelId, s.session.storeyId) : false));
  const groups = useWorkspaceStoreyGroups();
  const copyDenial = useViewerStore((s) => s.session ? mutationDenial(s, s.session.modelId) : null);
  useEffect(() => {
    const show = () => { setCopyOpen(true); setOpen(true); };
    window.addEventListener(COPY_TO_STOREYS_EVENT, show);
    return () => window.removeEventListener(COPY_TO_STOREYS_EVENT, show);
  }, []);

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
        <HudPopover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setCopyOpen(false); }}>
          {/* Half a rem inside the 13rem chip cap, so even a long storey name
              (truncated, full name in its tooltip) keeps an 8px gap to the
              top-center lane that starts at 14rem (#6315). */}
          <HudChip
            className="max-w-[12.5rem]"
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
            <span className="flex min-w-0 items-center gap-1">
              <HudPopoverTrigger asChild>
                <button
                  type="button"
                  data-workspace-storey-chip
                  title={t('modelWorkspace.storey.pick')}
                  className="inline-flex min-w-0 items-center gap-1.5 rounded-sm hover:text-foreground"
                >
                  <span className="min-w-0 truncate" title={name}>{name}</span>
                  {elevation && <span className="shrink-0 tabular-nums text-muted-foreground">{elevation}</span>}
                  <ChevronDown aria-hidden className="h-3 w-3 shrink-0 opacity-70" />
                </button>
              </HudPopoverTrigger>
              {current && <StoreyContextControl />}
            </span>
          </HudChip>
          <HudPopoverContent onCloseAutoFocus={(event) => { event.preventDefault(); document.querySelector<HTMLElement>('[data-testid="model-3d-panel"] canvas')?.focus(); }} align="start" className="p-1">
            {copyOpen ? <Suspense fallback={<div className="flex h-64 w-64 items-center justify-center p-2"><Spinner label={t('storeyManager.copy.title')} /></div>}><CopyToStoreys onDone={() => { setOpen(false); setCopyOpen(false); }} /></Suspense> : <StoreyPicker groups={groups} current={{ modelId: session.modelId, storeyId: session.storeyId }} onPick={pickWorkspaceStorey} />}
            {!copyOpen && <Button size="sm" variant="ghost" disabled={copyDenial !== null} title={copyDenial ? t('storeyManager.copy.readOnly', { reason: copyDenial }) : undefined} onClick={() => setCopyOpen(!copyOpen)}>{t('storeyManager.copy.title')}</Button>}
            {!copyOpen && <StoreyPickerActions />}
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
