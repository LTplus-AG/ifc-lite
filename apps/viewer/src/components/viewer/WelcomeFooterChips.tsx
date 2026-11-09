/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The quiet line under the empty-state welcome card: everything that is not
 * a way to open a model.
 *
 * - One "New here?" that answers it twice: the two-minute tour (while its
 *   invite stands) and the docs site. The tour invite used to ask the same
 *   question in the column above, with a different answer (#8802 R6).
 * - The agent route (`/mcp`), which used to sit in the sample-model list as if
 *   it were a model. It works without WebGPU, so it is never gated.
 * - The keyboard-shortcuts cue, desktop only: a phone has no keyboard.
 *
 * IN FLOW, not absolute: the welcome column scrolls on short viewports, and
 * absolutely-anchored chips ride the scroll and land on top of the content
 * (#1736 follow-up). The shortcuts chip is a real button that opens the Info
 * dialog on its Shortcuts tab (#5871); it used to be a `<div>` that looked
 * clickable and did nothing.
 */

import { ArrowUpRight, Command, Sparkles } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { EVENT_SHOW_SHORTCUTS } from '@/lib/tours/events';
import { TourInvite } from '@/components/tours/TourInvite';

const FOCUS = 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded';
const LINK = `inline-flex min-h-6 items-center gap-1.5 hover:text-primary transition-colors ${FOCUS}`;

export function WelcomeFooterChips({ tourAvailable }: {
  /** The tour loads a model, so it shares the WebGPU gate of the actions. */
  tourAvailable: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-12 flex w-full flex-wrap items-center justify-between gap-x-6 gap-y-2 text-xs text-muted-foreground">
      <p data-welcome-learn-line="" className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span>{t('viewportLighting.container.emptyState.footer.discoverPrompt')}</span>
        <a href="https://ifclite.dev" target="_blank" rel="noopener noreferrer" className={`font-medium text-primary hover:underline underline-offset-2 ${FOCUS}`}>
          {t('viewportLighting.container.emptyState.footer.discoverLink')}
        </a>
        {/* Last, so its dismiss X ends the line and plainly belongs to it. */}
        {tourAvailable && <TourInvite leading={<span aria-hidden="true">·</span>} />}
      </p>
      <div className="flex items-center gap-5">
        {/* Works without WebGPU: the MCP route drives the toolkit headless. */}
        <a href="/mcp" title={t('viewportLighting.container.emptyState.noModel.llmHint')} className={LINK}>
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{t('viewportLighting.container.emptyState.driveWithLlm')}</span>
          <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
        </a>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent(EVENT_SHOW_SHORTCUTS, { detail: { tab: 'shortcuts' } }))}
          className={`hidden cursor-pointer md:inline-flex ${LINK}`}
        >
          <Command className="h-3 w-3" aria-hidden="true" />
          <span>{t('viewportLighting.container.emptyState.footer.shortcutsLabel')}</span>
          <kbd className="ml-0.5 rounded border border-border px-1 font-mono text-2xs" aria-hidden="true">?</kbd>
        </button>
      </div>
    </div>
  );
}
