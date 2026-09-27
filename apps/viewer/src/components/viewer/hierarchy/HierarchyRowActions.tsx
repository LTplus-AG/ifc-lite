/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Eye, ListFilter, MoreHorizontal, SquareStack } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export type HierarchyRowAction = 'isolate' | 'filter' | 'solo';

interface HierarchyRowActionsProps {
  name: string;
  actions: readonly HierarchyRowAction[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction: (action: HierarchyRowAction) => void;
}

const ICONS = { isolate: Eye, filter: ListFilter, solo: SquareStack } as const;

/** Row actions are explicit; a row click or Enter only selects entities. */
export function HierarchyRowActions({ name, actions, open, onOpenChange, onAction }: HierarchyRowActionsProps) {
  const { t } = useTranslation();
  if (actions.length === 0) return null;
  const label = (action: HierarchyRowAction) => t(`hierarchy.node.action.${action}`);

  return (
    <div className="absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center bg-white/95 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto dark:bg-zinc-950/95 [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto">
      {actions.map((action) => {
        const Icon = ICONS[action];
        return (
          <button
            key={action}
            type="button"
            aria-label={t('hierarchy.node.actionAriaLabel', { action: label(action), name })}
            title={label(action)}
            className="flex size-6 items-center justify-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring hover:bg-zinc-200 dark:hover:bg-zinc-700"
            onClick={() => onAction(action)}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </button>
        );
      })}
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('hierarchy.node.actionsAriaLabel', { name })}
            className="flex size-6 items-center justify-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring hover:bg-zinc-200 dark:hover:bg-zinc-700"
          >
            <MoreHorizontal className="size-3.5" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-36">
          {actions.map((action) => (
            <DropdownMenuItem key={action} onSelect={() => onAction(action)}>
              {label(action)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
