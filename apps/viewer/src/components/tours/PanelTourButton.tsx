/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-panel tour launcher for the panel chrome bar. Renders nothing unless a
 * registered tour teaches this panel AND the user has not completed it at
 * its current version - invisible chrome for finished users, resurfacing
 * only when a tour's content version bumps. Styled to the chrome-bar button
 * vocabulary (h-5, data-chrome-btn / data-no-drag).
 */

import { GraduationCap } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { startTour } from '@/lib/tours/controller';
import { getToursForPanel } from '@/lib/tours/registry';
import { isTourCompleted } from '@/lib/tours/storage';
import type { WorkspacePanelId } from '@/lib/panels/registry';

export function PanelTourButton({ panelId }: { panelId: WorkspacePanelId }) {
  const tour = getToursForPanel(panelId)[0];
  if (!tour || isTourCompleted(tour.id, tour.version)) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-chrome-btn
          data-no-drag
          aria-label={`Start tour: ${tour.title}`}
          onClick={() => startTour(tour.id, 'panel')}
          className="h-5 w-5 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <GraduationCap className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tour.title} ({tour.minutes} min tour)</TooltipContent>
    </Tooltip>
  );
}
