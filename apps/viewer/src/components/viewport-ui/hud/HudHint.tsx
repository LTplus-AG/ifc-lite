/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A single passive hint line — e.g. "Hover a surface to preview · click to
 * cut · Esc to finish" (#5478 §6) — for the HUD's bottom-center region.
 * Plain ink text, no card: the roadmap's "at most … one hint" is
 * deliberately the one HUD element that carries no surface, matching the
 * existing bottom-edge scale/axis readouts' bare-text treatment. Nothing
 * here is interactive, so unlike `HudSurface` this does NOT opt back into
 * pointer events.
 */
export function HudHint({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('pointer-events-none text-xs text-overlay-ink-muted', className)} role="status">
      {children}
    </div>
  );
}
