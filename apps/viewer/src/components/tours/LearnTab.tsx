/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Learn hub: the tour catalog inside the Info dialog. One row per
 * registered tour with duration, a completed check, and Start/Replay.
 */

import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TOUR_REGISTRY } from '@/lib/tours/registry';
import { isTourCompleted } from '@/lib/tours/storage';
import { startTour } from '@/lib/tours/controller';
import type { TourId } from '@/lib/tours/types';

export function LearnTab({ onClose }: { onClose: () => void }) {
  const begin = (id: TourId) => {
    onClose();
    // Let the dialog unmount before the tour resolves its first anchor.
    requestAnimationFrame(() => startTour(id, 'learn'));
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Interactive walkthroughs run on your model or the bundled demo project. Every step can be skipped.
      </p>
      <div className="divide-y divide-border rounded-md border">
        {TOUR_REGISTRY.map((tour) => {
          const done = isTourCompleted(tour.id, tour.version);
          return (
            <div key={tour.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  {tour.title}
                  {done && <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-500" aria-label="Completed" />}
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">{tour.description}</div>
              </div>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
                {tour.minutes} min
              </span>
              <Button variant={done ? 'ghost' : 'outline'} size="sm" className="shrink-0" onClick={() => begin(tour.id)}>
                {done ? 'Replay' : 'Start'}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
