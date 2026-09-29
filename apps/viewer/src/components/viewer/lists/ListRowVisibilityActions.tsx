/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Isolate / X-ray context buttons of a group or schedule row (#6368).
 * Revealed on row hover or keyboard focus (always shown on touch, and while
 * one is active), as in the Hierarchy panel; `aria-pressed` says which one the
 * list is showing. They sit at the right edge of the row's FIRST column rather
 * than the row's end, which can be scrolled out of a wide table's view. The
 * parent row must carry Tailwind's `group` class.
 */

import { Focus, ScanEye } from 'lucide-react';
import type { VisibilityChannel } from '@/lib/visibility/ownership';
import { useTranslation } from '@/i18n/useTranslation';
import { cn } from '@/lib/utils';

interface ListRowVisibilityActionsProps {
  /** The row's name, for the accessible labels. */
  name: string;
  active: VisibilityChannel | null;
  onAction: (channel: VisibilityChannel) => void;
  /** Width of the row's first column, in px. */
  firstColumnWidth: number;
}

/** Two 24px buttons plus a 4px inset. */
const ACTIONS_WIDTH_PX = 52;

const ACTIONS = [
  { channel: 'isolate', Icon: Focus, labelKey: 'lists.rowActions.isolate' },
  { channel: 'ghost', Icon: ScanEye, labelKey: 'lists.rowActions.xray' },
] as const;

export function ListRowVisibilityActions({ name, active, onAction, firstColumnWidth }: ListRowVisibilityActionsProps) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'absolute top-1/2 z-[1] flex -translate-y-1/2 items-center rounded-sm bg-background/95',
        'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto',
        'focus-within:opacity-100 focus-within:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto',
        active !== null && 'opacity-100 pointer-events-auto',
      )}
      style={{ left: Math.max(0, firstColumnWidth - ACTIONS_WIDTH_PX) }}
    >
      {ACTIONS.map(({ channel, Icon, labelKey }) => {
        const label = t(labelKey);
        const pressed = active === channel;
        return (
          <button
            key={channel}
            type="button"
            aria-pressed={pressed}
            aria-label={t('lists.rowActions.actionAriaLabel', { action: label, name })}
            title={label}
            className={cn(
              'flex size-6 items-center justify-center rounded-sm hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              pressed && 'bg-primary/15 text-primary',
            )}
            onClick={() => onAction(channel)}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
