/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { PenLine } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { HudChip, HudItem } from '../viewport-ui/hud';

/**
 * The persistent "Editing · <model>" status chip (#5489, charter #5478
 * decision 1). Edit mode used to announce itself with a purple family that
 * no other state shared; it now uses the one interaction accent, and this
 * chip is what tells you, at a glance over the model, that you are editing
 * and which model the edits land in.
 *
 * Placed in the HUD's top-left region like every other status chip, so it
 * stacks with them instead of choosing its own coordinates.
 *
 * The model named is the active model; with no active model but exactly one
 * loaded it is that one. With several loaded and none active the chip says
 * only "Editing" rather than guess.
 */
export function EditModeHudChip() {
  const { t } = useTranslation();
  const editEnabled = useViewerStore((s) => s.editEnabled);
  const modelName = useViewerStore((s) => {
    const active = s.activeModelId ? s.models.get(s.activeModelId) : undefined;
    if (active) return active.name;
    if (s.models.size === 1) return s.models.values().next().value?.name;
    return undefined;
  });

  if (!editEnabled) return null;
  return (
    <HudItem region="top-left" order={0}>
      <HudChip icon={<PenLine aria-hidden className="h-3.5 w-3.5 text-overlay-accent" />}>
        {modelName
          ? t('viewportLighting.overlays.editingChipWithModel', { model: modelName })
          : t('viewportLighting.overlays.editingChip')}
      </HudChip>
    </HudItem>
  );
}
