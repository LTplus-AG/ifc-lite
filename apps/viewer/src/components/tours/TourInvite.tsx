/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Soft first-run invite on the empty start screen. Never a forced modal: one
 * Start link and one dismiss X. Hidden forever once dismissed or once the
 * welcome tour was completed (localStorage), and on mobile (tours are
 * desktop-only). The caller gates it on WebGPU, since the tour loads a model.
 *
 * It has no prompt of its own: it sits inside the start screen's one
 * "New here?" line (`WelcomeFooterChips`) beside the docs link, so the screen
 * asks that question once (#8802 R6). `leading` precedes it only while it is
 * shown (the line's separator), so a dismissed invite leaves no stray dot.
 */

import { useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { startTour } from '@/lib/tours/controller';
import { getTour } from '@/lib/tours/registry';
import { dismissInvite, isInviteDismissed, isTourCompleted } from '@/lib/tours/storage';
import { trackUiEvent } from '@/lib/analytics';
import { useViewerStore } from '@/store';

export function TourInvite({ leading }: { leading?: ReactNode } = {}) {
  const { t } = useTranslation();
  const isMobile = useViewerStore((s) => s.isMobile);
  const [hidden, setHidden] = useState(() => {
    const welcome = getTour('welcome');
    return isInviteDismissed() || (welcome ? isTourCompleted(welcome.id, welcome.version) : true);
  });

  if (hidden || isMobile) return null;

  return (
    <>
      {leading}
      <button
        type="button"
        // Text-line height alone is ~16px tall (width, ~143px, already
        // clears 24), under the WCAG 2.2 2.5.8 target-size minimum (#5826).
        // `inset-x-0` keeps width unchanged — the line's items sit `gap-1.5`
        // (6px) apart, and a horizontal slop would reach into that gap.
        className="relative font-medium text-primary underline-offset-2 hover:underline after:absolute after:inset-x-0 after:-top-1 after:-bottom-1 after:content-[''] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => {
          trackUiEvent('onboarding_surface', { surface: 'tour_invite', action: 'start_tour' });
          startTour('welcome', 'invite');
        }}
      >
        {t('tours.tourInvite.start')}
      </button>
      <button
        type="button"
        aria-label={t('tours.tourInvite.dismissAriaLabel')}
        // 16x16: needs 4px a side both ways to reach 24 (16 + 2*4 = 24),
        // which stays inside the line's 6px `gap-1.5` on the left (no overlap
        // with the Start link) and this is the last item on the right.
        className="relative ml-0.5 rounded p-0.5 text-muted-foreground/60 hover:bg-muted hover:text-muted-foreground after:absolute after:-inset-1 after:content-[''] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => {
          trackUiEvent('onboarding_surface', { surface: 'tour_invite', action: 'dismiss' });
          dismissInvite();
          setHidden(true);
        }}
      >
        <X className="h-3 w-3" />
      </button>
    </>
  );
}
