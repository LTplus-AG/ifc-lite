/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The storey picker's own actions (#9013), under its list in the storey chip
 * and the plan header: add above the topmost storey without changing planes
 * (the toast offers Draw on), or open the storey manager.
 */

import { activateStorey } from '@/lib/storeys/storey-session';
import { Plus, SlidersHorizontal } from 'lucide-react';
import { useViewerStore, type ViewerState } from '@/store';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { mutationDenial } from '@/store/mutation-permission';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { openStoreyManager } from '@/lib/storeys/storey-manager-open';
import { HudPopoverClose } from '../../../viewport-ui/hud';

/** A header add always appends above the live topmost storey. */
function topReference(s: ViewerState, modelId: string): number | undefined {
  const storeys = modelStoreys(s, modelId);
  return storeys[storeys.length - 1]?.expressId;
}

export function StoreyPickerActions() {
  const { t } = useTranslation();
  const session = useViewerStore((s) => s.session);
  const denied = useViewerStore((s) => (s.session ? mutationDenial(s, s.session.modelId) !== null : true));
  if (!session) return null;

  const addAbove = () => {
    const { modelId, entry } = session;
    const state = useViewerStore.getState();
    if (topReference(state, modelId) === undefined) { openStoreyManager(state); return; }
    // The storey write path loads on first use, so the picker costs the boot bundle nothing.
    void import('./add-storey').then(({ addStoreyKeepingSession }) => {
      // The model may have changed while the module loaded: re-read its live topmost storey,
      // and nothing at all once the session that was clicked in has ended, even if a new
      // one has since opened on the same model.
      const now = useViewerStore.getState();
      if (now.session?.entry !== entry || now.session.modelId !== modelId) return;
      const reference = topReference(now, modelId);
      if (reference === undefined) return;
      const outcome = addStoreyKeepingSession(modelId, reference, 'above', (index) => t('storeyManager.fallbackName', { index }));
      if (!outcome.ok) toast.error(t('storeyManager.refusal.other', { reason: outcome.reason }));
      else if (outcome.storeyId !== null) {
        const createdId = outcome.storeyId;
        const level = modelStoreys(useViewerStore.getState(), modelId).find(s => s.expressId === createdId);
        toast.success(t('storeyManager.added', { storey: level?.name ?? '', elevation: String(level?.elevation ?? '') }), {
          label: t('storeyManager.drawOn'), onClick: () => activateStorey(useViewerStore.getState(), modelId, createdId),
        }, `storey-added:${modelId}`);
      }
    }, (error: unknown) => {
      toast.error(t('storeyManager.refusal.other', { reason: error instanceof Error ? error.message : String(error) }));
    });
  };

  return (
    <div data-storey-picker-actions className="mt-1 flex flex-col border-t border-border pt-1">
      {!denied && (
        <HudPopoverClose asChild>
          <Button variant="ghost" size="sm" className="h-7 justify-start gap-1.5 px-2 text-xs font-normal" onClick={addAbove}>
            <Plus aria-hidden className="h-3 w-3" />
            {t('storeyManager.addAbove')}
          </Button>
        </HudPopoverClose>
      )}
      <HudPopoverClose asChild>
        <Button variant="ghost" size="sm" className="h-7 justify-start gap-1.5 px-2 text-xs font-normal" onClick={() => openStoreyManager(useViewerStore.getState())}>
          <SlidersHorizontal aria-hidden className="h-3 w-3" />
          {t('storeyManager.open')}
        </Button>
      </HudPopoverClose>
    </div>
  );
}
