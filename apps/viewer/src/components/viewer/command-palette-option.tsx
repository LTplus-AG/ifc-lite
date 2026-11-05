/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Palette command controls: registered rows take an id; runtime rows carry their own content. */
import { useId } from 'react';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { shortcutLabel, type KeyCommandId } from '@/lib/commands/shortcut-label';
import { SURFACE_COMMANDS, type SurfaceCommandDefinition, type SurfaceCommandIdFor } from './surface-commands';
import { EXPORT_SURFACE_COMMANDS } from './commandPaletteExports';
import type { Command } from './commandPaletteSearch';
import type { CsvExportType, ExportCommandId } from './toolbar/export-commands';

type ExportPaletteId = `export:${Exclude<ExportCommandId, 'csv'>}` | `export:csv-${CsvExportType}`;
type PaletteSurfaceId = SurfaceCommandIdFor<'palette'>;
/** Only ids whose definition declares the palette surface: a context-only id is a type error. */
export type RegisteredPaletteId = PaletteSurfaceId | ExportPaletteId;
type RuntimeCommand = Extract<Command, { runtimeSource: string }>;

function declaresPalette<Definition extends SurfaceCommandDefinition>(
  command: Definition,
): command is Definition & { id: PaletteSurfaceId } {
  return command.surfaces.some((surface) => surface === 'palette');
}

function isExportPaletteId(id: string): id is ExportPaletteId {
  return EXPORT_SURFACE_COMMANDS.some((command) => command.id === id);
}

function paletteDefinition(id: RegisteredPaletteId): SurfaceCommandDefinition {
  const command = SURFACE_COMMANDS.find((entry) => entry.id === id)
    ?? EXPORT_SURFACE_COMMANDS.find((entry) => entry.id === id);
  if (!command || !declaresPalette(command)) throw new Error(`${id} is not registered for palette`);
  return command;
}

interface OptionPlacement {
  id?: string;
  index: number;
  selected: boolean;
  onActivate: () => void;
  onHover: () => void;
  categoryLabel?: string;
}

interface OptionChromeProps extends OptionPlacement {
  owner: { commandId: RegisteredPaletteId } | { runtimeSource: RuntimeCommand['runtimeSource']; runtimeCommandId: string };
  icon: Command['icon'];
  label: string;
  detail?: string;
  shortcut?: KeyCommandId;
}

function OptionChrome({ owner, icon: Icon, label, detail, shortcut, categoryLabel, id, index, selected, onActivate, onHover }: OptionChromeProps) {
  const fallbackId = useId();
  const registered = 'commandId' in owner;
  return (
    // Focus stays on the combobox; pointer activation still uses the native click.
    // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
    <button id={id ?? fallbackId} type="button" role="option" tabIndex={-1} data-index={index}
      data-command-id={registered ? owner.commandId : undefined}
      data-runtime-source={registered ? undefined : owner.runtimeSource}
      data-runtime-command-id={registered ? undefined : owner.runtimeCommandId}
      aria-label={registered ? label : undefined}
      aria-selected={selected}
      className={cn('flex items-center gap-3 w-full px-3 py-2 text-left text-sm',
        selected ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/50')}
      onMouseDown={event => event.preventDefault()}
      onClick={onActivate} onMouseMove={onHover}>
      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {categoryLabel && <span className="block truncate text-xs text-muted-foreground">{categoryLabel}</span>}
      </span>
      {detail && <span title={detail} className="max-w-[30%] truncate text-xs text-muted-foreground">{detail}</span>}
      {shortcut && <kbd className="ml-auto hidden sm:inline-flex h-5 min-w-[20px] items-center justify-center rounded border bg-muted px-1.5 text-xs font-medium text-muted-foreground shrink-0">
        {shortcutLabel(shortcut)}
      </kbd>}
    </button>
  );
}

export type RegisteredPaletteOptionProps = OptionPlacement & { commandId: RegisteredPaletteId };

/** A registry command's name, icon and shortcut come from its definition, never the row. */
export function RegisteredPaletteOption({ commandId, ...placement }: RegisteredPaletteOptionProps) {
  const { t } = useTranslation();
  const command = paletteDefinition(commandId);
  return <OptionChrome {...placement} owner={{ commandId }} icon={command.icon}
    label={t(command.labelKey)} shortcut={command.shortcut} />;
}

export type DynamicPaletteOptionProps = OptionPlacement & { command: RuntimeCommand };

/** Recent files, tours, scripts, and extension contributions have runtime titles. */
export function DynamicPaletteOption({ command, ...placement }: DynamicPaletteOptionProps) {
  const { t } = useTranslation();
  if (SURFACE_COMMANDS.some((entry) => entry.id === command.id) || isExportPaletteId(command.id)) {
    throw new Error(`${command.id} must render as a registered palette option`);
  }
  return <OptionChrome {...placement}
    owner={{ runtimeSource: command.runtimeSource, runtimeCommandId: command.id }} icon={command.icon}
    label={command.labelKey ? t(command.labelKey, command.labelKeyParams) : command.label}
    detail={command.detail ? (command.detailKey ? t(command.detailKey, command.detailKeyParams) : command.detail) : undefined}
    shortcut={command.shortcut} />;
}

/** Resolve a registry-owned row to its literal typed id; a fabricated one throws. */
export function registeredPaletteId(command: Extract<Command, { registryOwned: true }>): RegisteredPaletteId {
  const definition = SURFACE_COMMANDS.find((entry) => entry.id === command.id);
  if (definition && declaresPalette(definition)) return definition.id;
  if (isExportPaletteId(command.id)) return command.id;
  throw new Error(`Unknown registered palette command: ${command.id}`);
}
