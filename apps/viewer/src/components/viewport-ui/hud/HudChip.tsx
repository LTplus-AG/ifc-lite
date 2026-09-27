/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { HudSurface } from './HudSurface';

export interface HudChipAction {
  onClick: () => void;
  /** Translated accessible name — required since the button is icon-only. */
  'aria-label': string;
  /** Optional hover tooltip, when the action wants more than its accessible name. */
  title?: string;
  icon: ReactNode;
}

export interface HudChipProps {
  children: ReactNode;
  icon?: ReactNode;
  /** e.g. a section/measurements chip's eye toggle (#5893). Rendered first
   *  among the actions, since it flips the chip's own on-screen state
   *  rather than acting on what it names. */
  toggle?: HudChipAction;
  /** e.g. the parked-section chip's "resume" arrow (#5478 §6, item 18). */
  resume?: HudChipAction;
  /** e.g. dismiss for a chip the user can permanently clear. */
  dismiss?: HudChipAction;
  /** e.g. `status` for a warning chip a screen reader should announce. */
  role?: string;
  /** Paired with `role`; defaults follow from `role` when omitted. */
  'aria-live'?: 'polite' | 'assertive' | 'off';
  className?: string;
}

/**
 * A short status chip — "Section parked · Resume", a solo/storey pill, a
 * Cesium status flag — on the shared `HudSurface`, with an optional toggle,
 * resume and/or dismiss action. None of the actions render text of their
 * own; the caller supplies the translated `aria-label`.
 */
export function HudChip({ children, icon, toggle, resume, dismiss, role, 'aria-live': ariaLive, className }: HudChipProps) {
  return (
    <HudSurface
      className={cn('flex max-w-[13rem] items-center gap-1.5 px-2 py-1 text-xs', className)}
      role={role}
      aria-live={ariaLive ?? (role === 'status' ? 'polite' : role === 'alert' ? 'assertive' : undefined)}
    >
      {icon}
      {/* Bounded so a chip can never outgrow the HUD's side lane (`ViewportHud`). */}
      <span className="min-w-0 truncate tabular-nums">{children}</span>
      {toggle && (
        <button
          type="button"
          onClick={toggle.onClick}
          aria-label={toggle['aria-label']}
          title={toggle.title}
          className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent"
        >
          {toggle.icon}
        </button>
      )}
      {resume && (
        <button
          type="button"
          onClick={resume.onClick}
          aria-label={resume['aria-label']}
          title={resume.title}
          className="rounded-sm p-0.5 text-overlay-accent hover:bg-overlay-accent-soft"
        >
          {resume.icon}
        </button>
      )}
      {dismiss && (
        <button
          type="button"
          onClick={dismiss.onClick}
          aria-label={dismiss['aria-label']}
          title={dismiss.title}
          className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent"
        >
          {dismiss.icon}
        </button>
      )}
    </HudSurface>
  );
}
