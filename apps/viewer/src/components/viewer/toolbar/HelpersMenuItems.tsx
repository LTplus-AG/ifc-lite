/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The "Helpers" group of the classic toolbar's View-options dropdown: hover
 * tooltips and the hover pre-highlight outline (#5390). Extracted from
 * `MainToolbar.tsx`, which sits at its module-size budget — a self-contained
 * menu body, the same pattern `CameraCommandMenuItems` already uses there.
 */

import { DropdownMenuCheckboxItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu';
import { Crosshair, Info } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';

export function HelpersMenuItems() {
  const { t } = useTranslation();
  const hoverTooltipsEnabled = useViewerStore((state) => state.hoverTooltipsEnabled);
  const toggleHoverTooltips = useViewerStore((state) => state.toggleHoverTooltips);
  const hoverHighlightEnabled = useViewerStore((state) => state.hoverHighlightEnabled);
  const toggleHoverHighlight = useViewerStore((state) => state.toggleHoverHighlight);

  return (
    <>
      <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {t('mainToolbar.helpers')}
      </DropdownMenuLabel>
      <DropdownMenuCheckboxItem checked={hoverTooltipsEnabled} onCheckedChange={() => toggleHoverTooltips()}>
        <Info className="h-4 w-4 mr-2" />
        {t('mainToolbar.hoverTooltips')}
      </DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem checked={hoverHighlightEnabled} onCheckedChange={() => toggleHoverHighlight()}>
        <Crosshair className="h-4 w-4 mr-2" />
        {t('mainToolbar.hoverHighlight')}
      </DropdownMenuCheckboxItem>
    </>
  );
}
