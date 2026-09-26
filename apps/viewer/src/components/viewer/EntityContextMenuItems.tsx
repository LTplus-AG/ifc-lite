/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ComponentType } from 'react';
import { ChevronRight, CopyPlus } from 'lucide-react';
import type { DuplicateDirection } from '@/store/slices/mutationSlice';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import {
  ContextMenuItem, ContextMenuSeparator, ContextMenuSub,
  ContextMenuSubContent, ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import { useSlotContributions } from '@/hooks/useSlotContributions';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import { evaluateWhen, parseWhen, type CommandContribution, type ResolvedContextMenuContribution } from '@ifc-lite/extensions';
import { resolveExtensionIcon } from '@/components/extensions/icon-registry';
import { describeRunCommandError } from '@/services/extensions/runtime-errors';
import { useTranslation } from '@/i18n';

type MenuItemTone = 'default' | 'destructive';

interface MenuItemProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  shortcut?: string;
  title?: string;
  tone?: MenuItemTone;
}

export function MenuItem({ icon: Icon, label, onClick, disabled, shortcut, title, tone = 'default' }: MenuItemProps) {
  const iconClass = tone === 'destructive'
    ? 'h-4 w-4 text-red-500 dark:text-red-400'
    : 'h-4 w-4 text-muted-foreground';
  const focusClass = tone === 'destructive'
    ? 'focus:bg-red-50 focus:text-red-700 dark:focus:bg-red-950/40 dark:focus:text-red-300'
    : 'focus:bg-muted';
  return (
    <ContextMenuItem asChild disabled={disabled}>
      <button
        type="button"
        aria-label={label}
        title={title}
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm outline-none ${focusClass}`}
        onClick={onClick}
      >
        <Icon className={iconClass} />
        <span className="min-w-0 flex-1">{label}</span>
        {shortcut && <span className="shrink-0 font-mono text-2xs text-muted-foreground">{shortcut}</span>}
      </button>
    </ContextMenuItem>
  );
}

const DIRECTIONS: ReadonlyArray<{ direction: DuplicateDirection; label: string }> = [
  { direction: '+X', label: 'Duplicate +X (east)' },
  { direction: '-X', label: 'Duplicate −X (west)' },
  { direction: '+Y', label: 'Duplicate +Y (north)' },
  { direction: '-Y', label: 'Duplicate −Y (south)' },
  { direction: '+Z', label: 'Duplicate +Z (up)' },
  { direction: '-Z', label: 'Duplicate −Z (down)' },
];

/** Default duplicate remains one action; directional copies are keyboard-reachable submenu items. */
export function DuplicateItems({ onDuplicate }: { onDuplicate: (dir: DuplicateDirection) => void }) {
  const { t } = useTranslation();
  return (
    <>
      <MenuItem
        icon={CopyPlus}
        label={t('entityContextMenu.duplicateLabel')}
        title={t('entityContextMenu.duplicateDefaultTitle')}
        shortcut="⌘D"
        onClick={() => onDuplicate('+X')}
      />
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <CopyPlus className="mr-2 h-4 w-4 text-muted-foreground" />
          <span className="flex-1">{t('entityContextMenu.duplicateLabel')}</span>
          <ChevronRight className="h-4 w-4" />
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {DIRECTIONS.map(({ direction, label }) => (
            <MenuItem key={direction} icon={CopyPlus} label={label} onClick={() => onDuplicate(direction)} />
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
    </>
  );
}

/** Extension commands use the same menu roles and keyboard navigation as built-in actions. */
export function ExtensionContextItems({
  slot,
  hasEntity,
}: {
  slot: 'contextMenu.entity' | 'contextMenu.canvas';
  hasEntity: boolean;
}) {
  const contributions = useSlotContributions<ResolvedContextMenuContribution>(slot);
  const commandPalette = useSlotContributions<CommandContribution>('commandPalette');
  const host = useOptionalExtensionHost();
  const closeContextMenu = useViewerStore((s) => s.closeContextMenu);
  if (contributions.length === 0) return null;
  const whenContext = { 'selection.count': hasEntity ? 1 : 0, 'model.loaded': true };
  const visible = contributions.filter((c) => {
    if (!c.payload.when) return true;
    const parsed = parseWhen(c.payload.when);
    return parsed.ok && evaluateWhen(parsed.value, whenContext);
  });
  if (visible.length === 0) return null;
  return (
    <>
      <ContextMenuSeparator />
      {visible.map((c) => {
        const Icon = resolveExtensionIcon(c.payload.icon);
        const label = c.payload.title
          ?? commandPalette.find((entry) => entry.payload.id === c.payload.command)?.payload.title
          ?? c.payload.command;
        return (
          <MenuItem
            key={`${c.extensionId}:${c.payload.command}`}
            icon={Icon}
            label={label}
            onClick={() => {
              closeContextMenu();
              host?.runCommand(c.payload.command, c.extensionId).catch((err) => {
                toast.error(describeRunCommandError(c.payload.command, err));
              });
            }}
          />
        );
      })}
    </>
  );
}
