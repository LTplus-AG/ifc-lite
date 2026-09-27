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
 *
 * "The toolbar changed" only means something to someone who saw the old
 * one, so a first-time visitor never gets it (#5840): the first-run card is
 * the one message on their first screen. See `isReturningVisitor`.
 */

import { useMemo, useState } from 'react';
import { PanelTop, X } from 'lucide-react';
import { startTour } from '@/lib/tours/controller';
import { getTour } from '@/lib/tours/registry';
import { dismissNotice, isNoticeDismissed, isTourCompleted } from '@/lib/tours/storage';
import { trackUiEvent } from '@/lib/analytics';
import type { OnboardingAction } from '@/lib/analytics-ui-events';
import { useTourStore } from '@/lib/tours/tour-store';
import { useViewerStore } from '@/store';
import { TOOLBAR_STYLE_STORAGE_KEY } from '@/store/constants';
import { getRecentFiles } from '@/lib/recent-files';
import { useTranslation } from '@/i18n';

const NOTICE_ID = 'ribbon-default';

/** Whether this browser was already using the viewer when it first rendered
 *  the ribbon: `returning` or `new`, decided once and then remembered. */
export const RIBBON_NOTICE_AUDIENCE_KEY = 'ifc-lite:ribbon-notice-audience';

/**
 * True for a visitor who used the viewer before the ribbon became the
 * default. The evidence is recent-file history that already exists the first
 * time the ribbon renders here; the verdict is stored at that moment, so a
 * brand-new visitor who then opens files does not turn into a "returning"
 * one on the next visit and get told about a toolbar they never saw.
 */
function isReturningVisitor(): boolean {
  try {
    const stored = localStorage.getItem(RIBBON_NOTICE_AUDIENCE_KEY);
    if (stored !== null) return stored === 'returning';
    const returning = getRecentFiles().length > 0;
    localStorage.setItem(RIBBON_NOTICE_AUDIENCE_KEY, returning ? 'returning' : 'new');
    return returning;
  } catch (err) {
    // Locked storage: no history can be read, so this is indistinguishable
    // from a first visit and the notice stays hidden.
    console.warn('[toolbar-style] could not read visit history; hiding the switch notice', err);
    return false;
  }
}

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
  const { t } = useTranslation();
  const setToolbarStyle = useViewerStore((s) => s.setToolbarStyle);
  // `startTour` refuses to run on mobile. Offering "Show me what moved" there
  // would retire the notice on click and then show nothing, so the invitation
  // is only rendered where it can be honoured.
  const isMobile = useViewerStore((s) => s.isMobile);
  const tourStatus = useTourStore((s) => s.status);
  const [dismissed, setDismissed] = useState(
    () => isNoticeDismissed(NOTICE_ID) || hasExplicitToolbarChoice() || !isReturningVisitor(),
  );
  // Re-read only when a tour ends, so finishing the ribbon tour retires the
  // notice without re-reading localStorage on every ribbon render.
  const tourDone = useMemo(() => {
    const tour = getTour('ribbon');
    return tour ? isTourCompleted(tour.id, tour.version) : false;
  }, [tourStatus]);

  if (dismissed || tourDone || tourStatus !== 'idle') return null;

  const close = (action: OnboardingAction) => {
    trackUiEvent('onboarding_surface', { surface: 'ribbon_notice', action });
    dismissNotice(NOTICE_ID);
    setDismissed(true);
  };

  return (
    <div className="flex items-center gap-2 border-t border-primary/25 bg-primary/5 px-3 py-1 text-[11px] text-muted-foreground">
      <PanelTop className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 truncate text-foreground/80">
        {t('ribbon.notice.message')}
      </span>
      {!isMobile && (
        <>
          <button
            className="shrink-0 font-medium text-primary underline-offset-2 hover:underline"
            onClick={() => {
              close('start_tour');
              startTour('ribbon', 'invite');
            }}
          >
            {t('ribbon.notice.showTour')}
          </button>
          <span aria-hidden="true" className="text-muted-foreground/40">|</span>
        </>
      )}
      <button
        className="shrink-0 hover:text-foreground hover:underline"
        onClick={() => {
          close('keep_classic');
          setToolbarStyle('classic');
        }}
      >
        {t('ribbon.notice.keepClassic')}
      </button>
      <div className="flex-1" />
      <button
        aria-label={t('ribbon.notice.dismissAriaLabel')}
        className="shrink-0 rounded p-0.5 text-muted-foreground/60 hover:bg-muted hover:text-muted-foreground"
        onClick={() => close('dismiss')}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
