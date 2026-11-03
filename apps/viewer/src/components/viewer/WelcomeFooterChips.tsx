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

const CHIP = 'text-xs text-zinc-500 dark:text-[#9aa3c7] hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded';

export function WelcomeFooterChips() {
  const { t } = useTranslation();
  return (
    <div className="mt-12 hidden w-full items-center justify-between gap-4 md:flex">
      <a href="https://ifclite.dev" target="_blank" rel="noopener noreferrer" className={`group inline-flex items-center gap-2 ${CHIP}`}>
        <span>{t('viewportLighting.container.emptyState.footer.discoverPrompt')}</span>
        <span className="font-semibold text-primary">{t('viewportLighting.container.emptyState.footer.discoverLink')}</span>
      </a>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent(EVENT_SHOW_SHORTCUTS, { detail: { tab: 'shortcuts' } }))}
        className={`flex items-center gap-2 cursor-pointer ${CHIP}`}
      >
        <Command className="h-3 w-3" aria-hidden="true" />
        <span>{t('viewportLighting.container.emptyState.footer.shortcutsLabel')}</span>
        <kbd className="ml-1 rounded border border-zinc-300 px-1 font-mono text-2xs text-zinc-600 dark:border-[#3b4261] dark:text-[#a9b1d6]" aria-hidden="true">?</kbd>
      </button>
    </div>
  );
}
