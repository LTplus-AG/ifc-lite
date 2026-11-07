/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The storey picker's own actions (#9013), under its list in the storey chip
 * and the plan header: add a storey above the one being drawn on (it becomes
 * active at once, ready to draw on), or open the storey manager.
 */

import { Plus, SlidersHorizontal } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { mutationDenial } from '@/store/mutation-permission';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { openStoreyManager } from '@/lib/storeys/storey-manager-open';
import { HudPopoverClose } from '../../../viewport-ui/hud';

export function StoreyPickerActions() {
  const { t } = useTranslation();
  const session = useViewerStore((s) => s.session);
  const denied = useViewerStore((s) => (s.session ? mutationDenial(s, s.session.modelId) !== null : true));
  if (!session) return null;

  const addAbove = () => {
    const state = useViewerStore.getState();
    const storeys = modelStoreys(state, session.modelId);
    const reference = session.storeyId ?? storeys[storeys.length - 1]?.expressId;
    if (reference === undefined) { openStoreyManager(state); return; }
    // The storey write path loads on first use, so the picker costs the boot bundle nothing.
    void import('@/lib/storeys/storey-actions').then(({ addStoreyNextTo }) => {
      // The session may have moved while the module loaded: add nothing to a model left behind.
      if (useViewerStore.getState().session?.modelId !== session.modelId) return;
      const outcome = addStoreyNextTo(useViewerStore, session.modelId, reference, 'above', (index) => t('storeyManager.fallbackName', { index }));
      if (!outcome.ok) toast.error(t('storeyManager.refusal.other', { reason: outcome.reason }));
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
