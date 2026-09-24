/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { HudSurface } from './HudSurface';

export type HudNoticeTone = 'info' | 'warn' | 'danger';

const TONE_CLASS: Record<HudNoticeTone, string> = {
  info: 'text-status-info',
  warn: 'text-status-warn',
  danger: 'text-status-danger',
};

export interface HudNoticeAction {
  label: ReactNode;
  onClick: () => void;
}

export interface HudNoticeDismiss {
  onClick: () => void;
  /** Translated accessible name — required since the button is icon-only. */
  'aria-label': string;
  icon: ReactNode;
}

export interface HudNoticeProps {
  tone?: HudNoticeTone;
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: HudNoticeAction;
  dismiss?: HudNoticeDismiss;
  className?: string;
}

/**
 * A banner-style notice — the merge-layers reload reminder, the geometry
 * mode banner, the LandXML units refusal prompt (#5478 §7) — stacked in the
 * HUD's top-center region on the shared `HudSurface`, replacing three
 * differently-styled floating banners with one.
 */
export function HudNotice({ tone = 'info', icon, title, description, action, dismiss, className }: HudNoticeProps) {
  return (
    <HudSurface className={cn('flex items-start gap-2 px-3 py-2 text-xs', className)} role="status">
      {icon && <span className={cn('mt-0.5', TONE_CLASS[tone])}>{icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        {description && <div className="mt-0.5 text-overlay-ink-muted">{description}</div>}
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="mt-1 font-medium text-overlay-accent hover:underline"
          >
            {action.label}
          </button>
        )}
      </div>
      {dismiss && (
        <button
          type="button"
          onClick={dismiss.onClick}
          aria-label={dismiss['aria-label']}
          className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent"
        >
          {dismiss.icon}
        </button>
      )}
    </HudSurface>
  );
}
