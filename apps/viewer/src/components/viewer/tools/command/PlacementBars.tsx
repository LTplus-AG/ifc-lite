/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The placing commands' own bar controls (charter #6232, M2 §1.6), after
 * their typed fields: Wall's Align and Chain, Slab's draw mode and class,
 * Beam's class and Chain. Every toggle writes the defaults slice, so the
 * next element, the inspector and the bar agree.
 */

import { Link2 } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { updateCommandGesture } from '@/lib/commands/modeling/runtime';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import { initSlabGesture, type SlabPlaceGesture } from '@/lib/commands/modeling/commands/slab-place-geometry';
import type { BeamClass, SlabClass, SlabDrawMode, WallAlign } from '@/store/slices/authoringDefaultsSlice';
import { HudDivider, HudSegmented, HudToggle } from '../../../viewport-ui/hud';

function options<T extends string>(values: readonly T[], keys: Record<T, TranslationKey>, t: (key: TranslationKey) => string) {
  return values.map((value) => ({ value, label: t(keys[value]) }));
}

function ChainToggle() {
  const { t } = useTranslation();
  const chain = useViewerStore((s) => s.authoringDefaults.chain);
  const setDefaults = useViewerStore((s) => s.setAuthoringDefaults);
  return (
    <HudToggle
      pressed={chain}
      onPressedChange={() => setDefaults({ chain: !chain })}
      icon={<Link2 aria-hidden className="h-3.5 w-3.5" />}
      title={t('modelingCommand.chain.title')}
    >
      {t('modelingCommand.chain.label')}
    </HudToggle>
  );
}

const ALIGN_KEYS: Record<WallAlign, TranslationKey> = {
  left: 'modelingCommand.wall.alignLeft',
  centre: 'modelingCommand.wall.alignCentre',
  right: 'modelingCommand.wall.alignRight',
};

export function WallPlaceBar() {
  const { t } = useTranslation();
  const align = useViewerStore((s) => s.authoringDefaults.wallAlign);
  const setDefaults = useViewerStore((s) => s.setAuthoringDefaults);
  return (
    <>
      <HudDivider />
      <HudSegmented
        aria-label={t('modelingCommand.wall.align')}
        options={options(['left', 'centre', 'right'] as const, ALIGN_KEYS, t)}
        value={align}
        onChange={(wallAlign) => setDefaults({ wallAlign })}
      />
      <HudDivider />
      <ChainToggle />
    </>
  );
}

const MODE_KEYS: Record<SlabDrawMode, TranslationKey> = {
  rectangle: 'modelingCommand.slab.rectangle',
  polygon: 'modelingCommand.slab.polygon',
};
// IFC class names stay untranslated (M2 §2.5), but still route through the catalogue.
const SLAB_CLASS_KEYS: Record<SlabClass, TranslationKey> = {
  slab: 'modelingCommand.class.slab',
  roof: 'modelingCommand.class.roof',
  plate: 'modelingCommand.class.plate',
};

export function SlabPlaceBar({ gesture }: CommandHudProps<SlabPlaceGesture>) {
  const { t } = useTranslation();
  const slabClass = useViewerStore((s) => s.authoringDefaults.slabClass);
  const setDefaults = useViewerStore((s) => s.setAuthoringDefaults);
  const setMode = (slabMode: SlabDrawMode) => {
    setDefaults({ slabMode });
    // A half-drawn outline of the other kind means nothing in this one.
    updateCommandGesture(() => initSlabGesture(slabMode));
  };
  return (
    <>
      <HudDivider />
      <HudSegmented
        aria-label={t('modelingCommand.slab.mode')}
        options={options(['rectangle', 'polygon'] as const, MODE_KEYS, t)}
        value={gesture.mode}
        onChange={setMode}
      />
      <HudDivider />
      <HudSegmented
        aria-label={t('modelingCommand.class.label')}
        options={options(['slab', 'roof', 'plate'] as const, SLAB_CLASS_KEYS, t)}
        value={slabClass}
        onChange={(next) => setDefaults({ slabClass: next })}
      />
    </>
  );
}

const BEAM_CLASS_KEYS: Record<BeamClass, TranslationKey> = {
  beam: 'modelingCommand.class.beam',
  member: 'modelingCommand.class.member',
};

export function BeamPlaceBar() {
  const { t } = useTranslation();
  const beamClass = useViewerStore((s) => s.authoringDefaults.beamClass);
  const setDefaults = useViewerStore((s) => s.setAuthoringDefaults);
  return (
    <>
      <HudDivider />
      <HudSegmented
        aria-label={t('modelingCommand.class.label')}
        options={options(['beam', 'member'] as const, BEAM_CLASS_KEYS, t)}
        value={beamClass}
        onChange={(next) => setDefaults({ beamClass: next })}
      />
      <HudDivider />
      <ChainToggle />
    </>
  );
}
