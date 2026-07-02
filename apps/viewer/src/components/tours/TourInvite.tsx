/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Soft first-run invite on the empty-state "Load IFC" card. Never a forced
 * modal: one line, one Start button, one dismiss X. Hidden forever once
 * dismissed or once the welcome tour was completed (localStorage), and on
 * mobile (tours are desktop-only). The parent card is WebGPU-gated, which
 * this inherits by placement.
 */

import { useState } from 'react';
import { X } from 'lucide-react';
import { startTour } from '@/lib/tours/controller';
import { getTour } from '@/lib/tours/registry';
import { dismissInvite, isInviteDismissed, isTourCompleted } from '@/lib/tours/storage';
import { useViewerStore } from '@/store';

export function TourInvite() {
  const isMobile = useViewerStore((s) => s.isMobile);
  const [hidden, setHidden] = useState(() => {
    const welcome = getTour('welcome');
    return isInviteDismissed() || (welcome ? isTourCompleted(welcome.id, welcome.version) : true);
  });

  if (hidden || isMobile) return null;

  return (
    <div className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
      <span>New here?</span>
      <button
        className="font-medium text-primary underline-offset-2 hover:underline"
        onClick={() => startTour('welcome', 'invite')}
      >
        Take the two minute tour
      </button>
      <button
        aria-label="Dismiss tour invite"
        className="ml-0.5 rounded p-0.5 text-muted-foreground/60 hover:bg-muted hover:text-muted-foreground"
        onClick={() => {
          dismissInvite();
          setHidden(true);
        }}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
