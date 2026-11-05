/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The Drawing toolbar's controls (#5494, #8802 R3b). Three kinds, three
 *  looks, each with one unmistakable state:
 *  - a markup tool is one option of a radio group: the active tool is a
 *    solid primary fill (exactly one is ever on);
 *  - a display toggle is on/off: a checkbox mark beside its label, filled
 *    with a primary-tinted face when on (`aria-pressed`); icon-only at
 *    compact widths, where the tinted face and a primary icon carry it;
 *  - a settings drawer or an icon action is a plain ghost button; an open
 *    drawer reads as pressed (`aria-pressed`, accent face).
 *  Labels collapse to icons when the host is narrow; every control keeps an
 *  accessible name and a tooltip either way. */

import type { ComponentType, ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type IconType = ComponentType<{ className?: string }>;

/** Shared geometry: 24 px tall, 12 px text, 14 px icons. */
const CONTROL = 'h-6 gap-1 rounded-md px-1.5 text-xs font-normal [&_svg]:size-3.5';

function Tipped({ tip, children }: { tip: ReactNode; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{tip}</TooltipContent>
    </Tooltip>
  );
}

/** One option of the markup tool radio group. `tip` may say more than the label (Select's pan/zoom hint). */
export function ToolSegment({ icon: Icon, label, tip, active, showLabel, onSelect }: {
  icon: IconType; label: string; tip?: string; active: boolean; showLabel: boolean; onSelect: () => void;
}) {
  return (
    <Tipped tip={tip ?? label}>
      <Button
        type="button"
        variant="ghost"
        role="radio"
        aria-checked={active}
        aria-label={label}
        onClick={onSelect}
        className={cn(
          CONTROL,
          active
            ? 'bg-primary font-medium text-primary-foreground shadow-sm hover:bg-primary hover:text-primary-foreground'
            : 'text-muted-foreground hover:bg-background hover:text-foreground',
        )}
      >
        <Icon className="shrink-0" />
        {showLabel && <span>{label}</span>}
      </Button>
    </Tipped>
  );
}

/** A display toggle. Wide: a checkbox mark and its label. Compact: its icon. */
export function ToggleChip({ icon: Icon, label, tip, on, disabled, showLabel, onToggle }: {
  icon: IconType; label: string; tip: string; on: boolean; disabled?: boolean; showLabel: boolean; onToggle: () => void;
}) {
  return (
    <Tipped tip={tip}>
      <Button
        type="button"
        variant="ghost"
        aria-pressed={on}
        aria-label={label}
        disabled={disabled}
        onClick={onToggle}
        data-state={on ? 'on' : 'off'}
        className={cn(
          CONTROL,
          'border',
          on
            ? 'border-primary/60 bg-primary/15 text-foreground hover:bg-primary/25'
            : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        {showLabel ? (
          <span
            aria-hidden="true"
            className={cn(
              'inline-flex size-3 shrink-0 items-center justify-center rounded-sm border',
              on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/60',
            )}
          >
            {on && <Check className="!size-2.5" strokeWidth={3.5} />}
          </span>
        ) : (
          <Icon className={cn('shrink-0', on && 'text-primary')} />
        )}
        {showLabel && <span>{label}</span>}
      </Button>
    </Tipped>
  );
}

/** A settings drawer's button; open = pressed. `active` (the drawer's feature
 *  is in use while it is closed) tints the icon and is said in the tooltip. */
export function DrawerToggle({ icon: Icon, label, tip, open, active, showLabel, onToggle }: {
  icon: IconType; label: string; tip: string; open: boolean; active: boolean; showLabel: boolean; onToggle: () => void;
}) {
  return (
    <Tipped tip={tip}>
      <Button
        type="button"
        variant="ghost"
        aria-pressed={open}
        aria-label={label}
        onClick={onToggle}
        className={cn(
          CONTROL,
          open ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <Icon className={cn('shrink-0', active && 'text-primary')} />
        {showLabel && <span>{label}</span>}
      </Button>
    </Tipped>
  );
}

/** A small tooltipped icon button (zoom, fit, pin, clear); `text` shows a label beside the icon. */
export function IconAction({ icon: Icon, label, text, onClick, pressed, disabled, className }: {
  icon: IconType; label: string; text?: string; onClick: () => void; pressed?: boolean; disabled?: boolean; className?: string;
}) {
  return (
    <Tipped tip={label}>
      <Button
        type="button"
        variant="ghost"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          CONTROL,
          !text && 'w-6 px-0',
          'text-muted-foreground hover:bg-accent hover:text-foreground',
          pressed && 'bg-primary/15 text-foreground',
          className,
        )}
      >
        <Icon className={cn('shrink-0', pressed && 'text-primary')} />
        {text && <span>{text}</span>}
      </Button>
    </Tipped>
  );
}

export function ToolbarDivider() {
  return <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />;
}
