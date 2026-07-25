/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One-time "the toolbar changed" line under the ribbon. Same contract as
 * `TourInvite`: never a modal, one sentence, one tour link, one way out,
 * and gone forever once dismissed, once the ribbon tour is completed, or
 * once the user has picked a toolbar style by hand (they already know).
 *
 * It also stays out of the way while a walkthrough is running - the tour
 * spotlight owns the screen at that point.
 */

import { useMemo, useState } from 'react';
import { PanelTop, X } from 'lucide-react';
import { startTour } from '@/lib/tours/controller';
import { getTour } from '@/lib/tours/registry';
import { dismissNotice, isNoticeDismissed, isTourCompleted } from '@/lib/tours/storage';
import { useTourStore } from '@/lib/tours/tour-store';
import { useViewerStore } from '@/store';
import { TOOLBAR_STYLE_STORAGE_KEY } from '@/store/constants';

const NOTICE_ID = 'ribbon-default';

/** True once the user has explicitly chosen a toolbar style on this browser. */
function hasExplicitToolbarChoice(): boolean {
  try {
    return localStorage.getItem(TOOLBAR_STYLE_STORAGE_KEY) !== null;
  } catch (err) {
    // Locked storage (Safari private mode): treat it as "no choice recorded"
    // and show the notice. Logged rather than swallowed so a real storage
    // fault is visible instead of silently re-showing the notice every load.
    console.warn('[toolbar-style] could not read the toolbar preference; showing the switch notice', err);
    return false;
  }
}

export function RibbonSwitchNotice() {
  const setToolbarStyle = useViewerStore((s) => s.setToolbarStyle);
  const tourStatus = useTourStore((s) => s.status);
  const [dismissed, setDismissed] = useState(
    () => isNoticeDismissed(NOTICE_ID) || hasExplicitToolbarChoice(),
  );
  // Re-read only when a tour ends, so finishing the ribbon tour retires the
  // notice without re-reading localStorage on every ribbon render.
  const tourDone = useMemo(() => {
    const tour = getTour('ribbon');
    return tour ? isTourCompleted(tour.id, tour.version) : false;
  }, [tourStatus]);

  if (dismissed || tourDone || tourStatus !== 'idle') return null;

  const close = () => {
    dismissNotice(NOTICE_ID);
    setDismissed(true);
  };

  return (
    <div className="flex items-center gap-2 border-t border-primary/25 bg-primary/5 px-3 py-1 text-[11px] text-muted-foreground">
      <PanelTop className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 truncate text-foreground/80">
        The tabbed ribbon is now the default toolbar. Same commands, grouped by task.
      </span>
      <button
        className="shrink-0 font-medium text-primary underline-offset-2 hover:underline"
        onClick={() => {
          close();
          startTour('ribbon', 'invite');
        }}
      >
        Show me what moved
      </button>
      <span aria-hidden="true" className="text-muted-foreground/40">|</span>
      <button
        className="shrink-0 hover:text-foreground hover:underline"
        onClick={() => {
          close();
          setToolbarStyle('classic');
        }}
      >
        Keep the classic bar
      </button>
      <div className="flex-1" />
      <button
        aria-label="Dismiss toolbar notice"
        className="shrink-0 rounded p-0.5 text-muted-foreground/60 hover:bg-muted hover:text-muted-foreground"
        onClick={close}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
