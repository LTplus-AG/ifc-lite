/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one header row of a docked tool panel (#8802 R3a): icon, title, an
 * optional count or status, at most two visible actions, an overflow menu
 * holding the rest, and the close control.
 *
 * Actions are data, not buttons, so the header can choose where each one
 * renders. They are listed in priority order. The first two render inline
 * as icon buttons while they fit, and everything else is a labelled row in
 * the "More actions" menu. When the dock is narrow, the inline actions move
 * into the menu first. The title truncates only when even that is not
 * enough, so the panel's name never gives way to an icon row ("BCF …").
 *
 * A `leading` control (a run slot's Re-run or Cancel) always stays visible
 * and takes one of the two inline places.
 *
 * During a guided tour, the action carrying the current step's anchor moves
 * to the front and keeps an inline place even in the narrowest dock. A closed
 * menu has no live anchor, so a tour pointing into it would skip its step.
 *
 * Dialogs opened by an action must be mounted by the panel, outside this
 * header: a dialog rendered inside a menu item would unmount with the menu.
 */

import * as React from 'react';
import { Check, MoreHorizontal, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { IconButton } from './icon-button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './dropdown-menu';
import { useTourStore } from '@/lib/tours/tour-store';
import { getTour } from '@/lib/tours/registry';

export interface PanelHeaderAction {
  /** Stable key; also `data-panel-action` on the rendered control. */
  id: string;
  /** Accessible name, tooltip and menu row text. */
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** A toggle's state: pressed inline, a checked row in the menu. */
  pressed?: boolean;
  /** Something waits for a decision (BCF outbox). The overflow trigger carries a dot while it is hidden there. */
  attention?: boolean;
  /** `data-*` attributes (tour anchors) for the control. */
  data?: { [attribute: `data-${string}`]: string };
}

/** An action, or nothing (a hook whose action does not apply right now). */
export type PanelHeaderActionSlot = PanelHeaderAction | null | false | undefined;

export interface PanelHeaderProps {
  icon?: React.ReactNode;
  title: string;
  /** A count or status beside the title. */
  meta?: React.ReactNode;
  /** In priority order; see the module comment. */
  actions?: readonly PanelHeaderActionSlot[];
  /** Always-visible control before the actions (Re-run, Cancel, a text button). */
  leading?: React.ReactNode;
  onClose?: () => void;
  /** The close control's accessible name; "Close" by default. */
  closeLabel?: string;
  /** Hide the icon and title (a host panel's header already names it). */
  untitled?: boolean;
  className?: string;
}

/** Inline places in the header, a `leading` control included. */
const MAX_INLINE = 2;
/** One 28px icon button plus the 4px gap before it. */
const SLOT_PX = 32;
/** The row's horizontal padding plus the gap between title and actions. */
const CHROME_PX = 32;

export function PanelHeader({
  icon, title, meta, actions = [], leading, onClose, closeLabel, untitled = false, className,
}: PanelHeaderProps) {
  const { t } = useTranslation();
  const tourAnchor = useTourStore((s) => (
    !s.tourId || s.status === 'idle' ? null : getTour(s.tourId)?.steps[s.stepIndex]?.anchor ?? null
  ));
  const listed = actions.filter((action): action is PanelHeaderAction => Boolean(action));
  const toured = tourAnchor ? listed.find((action) => action.data?.['data-tour'] === tourAnchor) : undefined;
  const present = toured ? [toured, ...listed.filter((action) => action !== toured)] : listed;
  const budget = Math.max(0, MAX_INLINE - (leading ? 1 : 0));
  const inlineCount = useInlineCount(budget, present.length, Boolean(onClose), title);
  const inlineShown = toured ? Math.max(inlineCount.count, Math.min(1, budget)) : inlineCount.count;
  const inline = present.slice(0, inlineShown);
  const overflow = present.slice(inlineShown);

  return (
    <div
      ref={inlineCount.rootRef}
      data-panel-header=""
      className={cn('flex h-10 shrink-0 items-center gap-2 border-b border-border px-3', className)}
    >
      {!untitled && (
        <div ref={inlineCount.titleGroupRef} className="flex min-w-0 flex-1 items-center gap-2">
          {icon && <span aria-hidden="true" className="flex shrink-0 text-muted-foreground [&>svg]:h-4 [&>svg]:w-4">{icon}</span>}
          <h2 className="min-w-0 truncate text-sm font-semibold" title={title}>{title}</h2>
          {meta && <span className="flex shrink-0 items-center">{meta}</span>}
        </div>
      )}
      <div ref={inlineCount.actionsRef} className="ml-auto flex shrink-0 items-center gap-1">
        {leading}
        {inline.map((action) => (
          <IconButton
            key={action.id}
            label={action.label}
            variant={action.pressed || action.attention ? 'secondary' : 'ghost'}
            size="icon-xs"
            aria-pressed={action.pressed}
            disabled={action.disabled}
            onClick={action.onSelect}
            data-panel-action={action.id}
            {...action.data}
          >
            {action.icon}
          </IconButton>
        ))}
        {overflow.length > 0 && <PanelHeaderOverflow actions={overflow} label={t('panelHeader.moreActions')} />}
        {onClose && (
          <IconButton label={closeLabel ?? t('panelHeader.close')} size="icon-xs" onClick={onClose} data-panel-close="">
            <X />
          </IconButton>
        )}
      </div>
    </div>
  );
}

function PanelHeaderOverflow({ actions, label }: { actions: readonly PanelHeaderAction[]; label: string }) {
  const attention = actions.some((action) => action.attention);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={label} size="icon-xs" className="relative" data-panel-overflow="">
          <MoreHorizontal />
          {attention && <span aria-hidden="true" className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />}
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.id}
            disabled={action.disabled}
            onSelect={action.onSelect}
            {...(action.pressed === undefined ? {} : { role: 'menuitemcheckbox', 'aria-checked': action.pressed })}
            className="gap-2 text-xs"
            data-panel-action={action.id}
            {...action.data}
          >
            <span aria-hidden="true" className="flex shrink-0 text-muted-foreground [&>svg]:h-4 [&>svg]:w-4">{action.icon}</span>
            <span className="min-w-0 flex-1 truncate">{action.label}</span>
            {action.attention && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-primary" />}
            {action.pressed && <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * How many actions fit inline. The title's natural width (its `scrollWidth`,
 * whether or not it is truncated right now) is reserved first, so actions
 * leave for the overflow menu before the title gives up a single character.
 * Without layout (a unit test, a hidden dock) the full budget applies.
 */
function useInlineCount(budget: number, actionCount: number, hasClose: boolean, title: string) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const titleGroupRef = React.useRef<HTMLDivElement>(null);
  const actionsRef = React.useRef<HTMLDivElement>(null);
  const wanted = Math.min(budget, actionCount);
  const [count, setCount] = React.useState(wanted);

  React.useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const width = root.clientWidth;
      if (width === 0) { setCount(wanted); return; }
      const titleGroup = titleGroupRef.current;
      let titleWidth = 0;
      if (titleGroup) {
        for (const child of Array.from(titleGroup.children) as HTMLElement[]) {
          titleWidth += Math.max(child.scrollWidth, child.offsetWidth);
        }
        titleWidth += Math.max(0, titleGroup.children.length - 1) * 8;
      }
      // Controls that never move: `leading` and close.
      let fixed = hasClose ? SLOT_PX : 0;
      const leadingEl = actionsRef.current?.firstElementChild as HTMLElement | null;
      if (leadingEl && !leadingEl.matches('[data-panel-action],[data-panel-overflow],[data-panel-close]')) {
        fixed += leadingEl.offsetWidth + 4;
      }
      let fit = 0;
      for (let k = wanted; k >= 0; k--) {
        const needsOverflow = actionCount - k > 0;
        const total = CHROME_PX + titleWidth + fixed + k * SLOT_PX + (needsOverflow ? SLOT_PX : 0);
        if (total <= width) { fit = k; break; }
      }
      setCount(fit);
    };
    measure();
    // The title group's content can widen while the root keeps its width (a
    // topic count going from 9 to 10), so a content change measures again too.
    const titleGroup = titleGroupRef.current;
    const content = titleGroup && typeof MutationObserver !== 'undefined' ? new MutationObserver(measure) : null;
    if (content && titleGroup) content.observe(titleGroup, { childList: true, subtree: true, characterData: true });
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    resize?.observe(root);
    return () => {
      content?.disconnect();
      resize?.disconnect();
    };
  }, [wanted, actionCount, hasClose, title]);

  return { count: Math.min(count, wanted), rootRef, titleGroupRef, actionsRef };
}
