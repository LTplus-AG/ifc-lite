/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Persistent in-viewport indicator for a non-default level display mode.
 *
 * Replaces the 1.5px toolbar dot that used to be the only signal an
 * Exploded / Solo view was active — easy to miss, and the control itself
 * has now moved into the hierarchy. A small chip in the viewport tells the
 * user at a glance "you are isolated to storey X" / "levels are exploded",
 * with a one-click return to Stacked.
 *
 * Anchored top-left so it never covers the ViewCube (top-right) or the
 * Environment panel (top-32 right).
 */

import { ChevronsUpDown, SquareStack, X } from 'lucide-react';
import { useViewerStore } from '@/store';
import { applyLevelDisplayMode } from '@/store/levelDisplay';
import { useFloorplanView } from '@/hooks/useFloorplanView';
import { useTranslation } from '@/i18n';
import { HudChip } from '@/components/viewport-ui/hud';

export function LevelDisplayIndicator() {
  const { t } = useTranslation();
  const mode = useViewerStore((s) => s.levelDisplayMode);
  const explodedGap = useViewerStore((s) => s.explodedGap);
  const activeStorey = useViewerStore((s) => s.activeStorey);
  const { availableStoreys } = useFloorplanView();

  if (mode === 'stacked') return null;

  const Icon = mode === 'exploded' ? ChevronsUpDown : SquareStack;
  const soloName = activeStorey
    ? availableStoreys.find((s) => s.modelId === activeStorey.modelId && s.expressId === activeStorey.expressId)?.name
    : undefined;
  const label =
    mode === 'exploded'
      ? t('levelDisplayIndicator.explodedLabel', { gap: explodedGap })
      : t('levelDisplayIndicator.soloLabel', { name: soloName ?? t('levelDisplayIndicator.storeyFallback') });

  // A neutral HUD chip (#5490): the mode is status, not an action or an
  // accent-worthy state, so it takes the shared surface and ink, not a hue.
  return (
    <div className="absolute top-4 left-4 z-10">
      <HudChip
        className="font-medium"
        icon={<Icon className="h-3.5 w-3.5 text-muted-foreground" />}
        dismiss={{
          onClick: () => applyLevelDisplayMode('stacked'),
          title: t('levelDisplayIndicator.backToStackedTitle'),
          'aria-label': t('levelDisplayIndicator.backToStackedAriaLabel'),
          icon: <X className="h-3 w-3" />,
        }}
      >
        {label}
      </HudChip>
    </div>
  );
}
