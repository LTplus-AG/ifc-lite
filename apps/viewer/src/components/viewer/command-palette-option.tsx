/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Palette command controls: registered rows take an id; runtime rows carry their own content. */
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { shortcutLabel, type KeyCommandId } from '@/lib/commands/shortcut-label';
import { SURFACE_COMMANDS, type SurfaceCommandDefinition, type SurfaceCommandId } from './surface-commands';
import { EXPORT_SURFACE_COMMANDS } from './commandPaletteExports';
import type { Command } from './commandPaletteSearch';
import type { CsvExportType, ExportCommandId } from './toolbar/export-commands';

type ExportPaletteId = `export:${Exclude<ExportCommandId, 'csv'>}` | `export:csv-${CsvExportType}`;
export type RegisteredPaletteId = SurfaceCommandId | ExportPaletteId;

function isExportPaletteId(id: string): id is ExportPaletteId {
  return EXPORT_SURFACE_COMMANDS.some((command) => command.id === id);
}

function paletteDefinition(id: RegisteredPaletteId): SurfaceCommandDefinition {
  const command = SURFACE_COMMANDS.find((entry) => entry.id === id)
    ?? EXPORT_SURFACE_COMMANDS.find((entry) => entry.id === id);
  if (!command || !command.surfaces.some((surface) => surface === 'palette')) throw new Error(`${id} is not registered for palette`);
  return command;
}

interface OptionPlacement {
  index: number;
  selected: boolean;
  onActivate: () => void;
  onHover: () => void;
}

interface OptionChromeProps extends OptionPlacement {
  commandId?: RegisteredPaletteId;
  icon: Command['icon'];
  label: string;
  detail?: string;
  shortcut?: KeyCommandId;
}

function OptionChrome({ commandId, icon: Icon, label, detail, shortcut, index, selected, onActivate, onHover }: OptionChromeProps) {
  return (
    // The option remains a button so Enter and click use the same command action.
    // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
    <button type="button" role="option" data-command-id={commandId} data-index={index} aria-label={label}
      aria-selected={selected}
      className={cn('flex items-center gap-3 w-full px-3 py-2 text-left text-sm',
        selected ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/50')}
      onClick={onActivate} onMouseMove={onHover}>
      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
      <span className="flex-1 truncate">{label}</span>
      {detail && <span className="text-xs text-muted-foreground shrink-0">{detail}</span>}
      {shortcut && <kbd className="ml-auto hidden sm:inline-flex h-5 min-w-[20px] items-center justify-center rounded border bg-muted px-1.5 text-xs font-medium text-muted-foreground shrink-0">
        {shortcutLabel(shortcut)}
      </kbd>}
    </button>
  );
}

export type RegisteredPaletteOptionProps = OptionPlacement & { commandId: RegisteredPaletteId };

export function RegisteredPaletteOption({ commandId, ...placement }: RegisteredPaletteOptionProps) {
  const { t } = useTranslation();
  const command = paletteDefinition(commandId);
  return <OptionChrome {...placement} commandId={commandId} icon={command.icon}
    label={t(command.labelKey)} shortcut={command.shortcut} />;
}

/** Recent files, tours, scripts, and extension contributions have runtime titles. */
export function DynamicPaletteOption({ command, ...placement }: OptionPlacement & { command: Command }) {
  const { t } = useTranslation();
  if (registeredPaletteId(command)) throw new Error(`${command.id} must render as a registered palette option`);
  return <OptionChrome {...placement} icon={command.icon}
    label={command.labelKey ? t(command.labelKey, command.labelKeyParams) : command.label}
    detail={command.detail ? (command.detailKey ? t(command.detailKey, command.detailKeyParams) : command.detail) : undefined}
    shortcut={command.shortcut} />;
}

/** The row adapter marks registry ownership; resolve its literal typed id before rendering. */
export function registeredPaletteId(command: Command): RegisteredPaletteId | null {
  const definition = SURFACE_COMMANDS.find((entry) => entry.id === command.id);
  const exportId = isExportPaletteId(command.id);
  if (!command.registryOwned) {
    if (definition || exportId) throw new Error(`${command.id} must be registry-owned in the palette`);
    return null;
  }
  if (definition?.surfaces.some((surface) => surface === 'palette')) return definition.id;
  if (exportId) return command.id;
  throw new Error(`Unknown registered palette command: ${command.id}`);
}
