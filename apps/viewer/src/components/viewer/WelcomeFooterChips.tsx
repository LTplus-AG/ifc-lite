/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two chips under the empty-state welcome card: a discovery link to the
 * marketing site for first-time visitors, and the keyboard-shortcuts cue for
 * power users. Both desktop-only.
 *
 * IN FLOW, not absolute: the welcome column scrolls on short viewports, and
 * absolutely-anchored chips ride the scroll and land on top of the content
 * (#1736 follow-up). The shortcuts chip is a real button that opens the Info
 * dialog on its Shortcuts tab (#5871); it used to be a `<div>` that looked
 * clickable and did nothing.
 */

import { Command } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { EVENT_SHOW_SHORTCUTS } from '@/lib/tours/events';

const CHIP = 'text-xs font-mono px-3 py-1.5 bg-zinc-100 dark:bg-[#1f2335] border border-zinc-300 dark:border-[#3b4261] text-zinc-500 dark:text-[#565f89] hover:border-primary hover:text-primary transition-colors';

export function WelcomeFooterChips() {
  const { t } = useTranslation();
  return (
    <div className="mt-10 hidden w-full max-w-3xl items-center justify-between gap-4 md:flex">
      <a href="https://ifclite.dev" target="_blank" rel="noopener noreferrer" className={`group inline-flex items-center gap-2 ${CHIP}`}>
        <span>{t('viewportLighting.container.emptyState.footer.discoverPrompt')}</span>
        <span className="font-bold text-primary group-hover:translate-x-0.5 transition-transform">{t('viewportLighting.container.emptyState.footer.discoverLink')}</span>
      </a>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent(EVENT_SHOW_SHORTCUTS, { detail: { tab: 'shortcuts' } }))}
        className={`flex items-center gap-2 cursor-pointer ${CHIP}`}
      >
        <Command className="h-3 w-3" aria-hidden="true" />
        <span>{t('viewportLighting.container.emptyState.footer.shortcutsLabel')}</span>
        <span className="px-1.5 ml-1 font-bold text-primary bg-primary/20" aria-hidden="true">?</span>
      </button>
    </div>
  );
}
