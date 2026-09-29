/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `space.place`'s bar controls (charter #6232, M2), after its typed fields:
 * the outline mode. It writes the defaults slice so the next space starts in
 * the same mode. Interim until the M4 Room tool.
 */

import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { updateCommandGesture } from '@/lib/commands/modeling/runtime';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import { initSlabGesture, type SlabPlaceGesture } from '@/lib/commands/modeling/commands/slab-place-geometry';
import type { SlabDrawMode } from '@/store/slices/authoringDefaultsSlice';
import { HudDivider, HudSegmented } from '../../../viewport-ui/hud';

export function SpacePlaceBar({ gesture }: CommandHudProps<SlabPlaceGesture>) {
  const { t } = useTranslation();
  const setDefaults = useViewerStore((s) => s.setAuthoringDefaults);
  const setMode = (spaceMode: SlabDrawMode) => {
    setDefaults({ spaceMode });
    // A half-drawn outline of the other kind means nothing in this one.
    updateCommandGesture(() => initSlabGesture(spaceMode));
  };
  return (
    <>
      <HudDivider />
      <HudSegmented
        aria-label={t('modelingCommand.slab.mode')}
        options={[
          { value: 'rectangle' as const, label: t('modelingCommand.slab.rectangle') },
          { value: 'polygon' as const, label: t('modelingCommand.slab.polygon') },
        ]}
        value={gesture.mode}
        onChange={setMode}
      />
    </>
  );
}
