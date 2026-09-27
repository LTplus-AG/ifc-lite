/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The command palette's Export category, generated from the toolbar export
 * registry (`toolbar/export-commands.ts`) so the palette offers exactly the
 * formats the ribbon does, in the same order (#5601, #5874).
 * Every row only hands a request to `useExportRunner`, which runs the
 * toolbars' own handlers and dialogs — see that file's docblock.
 *
 * CSV is a sub-menu in the toolbars; the palette has no sub-menus, so it gets
 * one row per table. Row ids (`export:<id>`, `export:csv-<table>`) are what
 * the palette records as recent usage, so they stay stable.
 */

import type { TranslationKey } from '@/i18n';
import { EXPORT_COMMANDS, type CsvExportType, type ExportCommandId } from './toolbar/export-commands';
import { RIBBON_EXPORT_ICONS } from './ribbon/tabs/ribbon-export-icons';
import type { ExportRequest } from './useExportRunner';
import type { Command } from './commandPaletteSearch';
import {
  commandRowFromDefinition, type CommandSurface, type SurfaceCommandContext, type SurfaceCommandDefinition,
} from './surface-commands';
import type { ExtensionExporter } from '@/components/extensions/useExtensionExporters';

/** Extra search tokens per format — exhaustive, so a new registry entry must say how it is found. */
const EXPORT_KEYWORDS: Record<ExportCommandId, string> = {
  ifc: 'ifc step spf save changes edited model download',
  anonymized: 'anonymize obfuscate isolate scrub redact bug report reproduction privacy scrub-safe',
  'modified-ifc': 'ifc changes edits edited modified pending unexported save review download',
  glb: '3d model gltf download',
  kmz: 'google earth kml georeferenced download',
  usd: '3d model usd usda openusd omniverse blender usdview download',
  energy: 'energy honeybee hbjson dragonfly dfjson simulation download',
  csv: 'spreadsheet table download',
  json: 'data entities all download',
  screenshot: 'capture png image viewport',
  pdf: 'pdf print drawing scale view download',
};

/** The palette's flat "Export CSV: <table>" labels, one per CSV table. */
const CSV_LABEL_KEYS: Record<CsvExportType, TranslationKey> = {
  entities: 'commandPalette.export.csvEntities.label',
  properties: 'commandPalette.export.csvProperties.label',
  quantities: 'commandPalette.export.csvQuantities.label',
  spatial: 'commandPalette.export.csvSpatial.label',
};

/**
 * Register the toolbar's existing export definitions for shared command
 * surfaces. The toolbar registry remains the source of formats, order,
 * labels and CSV tables; no second export catalogue is maintained here.
 * Dialogs and downloads continue through useExportRunner.
 */
export const EXPORT_SURFACE_COMMANDS: readonly SurfaceCommandDefinition[] = EXPORT_COMMANDS.flatMap((command) => {
  const shared = {
    keywords: EXPORT_KEYWORDS[command.id],
    category: 'Export' as const,
    icon: RIBBON_EXPORT_ICONS[command.id],
    surfaces: ['palette', 'mobile'] as const,
    enabled: () => true,
  };
  if (command.kind === 'table-menu') {
    return command.items.map((item) => ({
      ...shared,
      id: `export:csv-${item.type}`,
      labelKey: CSV_LABEL_KEYS[item.type],
      keywords: `${shared.keywords} ${item.type}`,
      run: ({ runExport }: SurfaceCommandContext) => {
        if (!runExport) throw new Error('Export command requires an export runner');
        runExport({ id: command.id, table: item.type });
      },
    }));
  }
  return [{
    ...shared,
    id: `export:${command.id}`,
    labelKey: command.menuLabelKey,
    run: ({ runExport }: SurfaceCommandContext) => {
      if (!runExport) throw new Error('Export command requires an export runner');
      runExport({ id: command.id });
    },
  }];
});

/**
 * The Export rows: the registry's formats, then one row per installed
 * extension exporter (#5838). An exporter's name is extension-supplied, so its
 * row renders `label` as-is (no catalogue key), like other `ext:` rows.
 */
export function buildExportCommands(
  runExport: (request: ExportRequest) => void,
  extensionExporters: readonly ExtensionExporter[] = [],
  surface: Extract<CommandSurface, 'palette' | 'mobile'> = 'palette',
): Command[] {
  const extensionRows = extensionExporters.map((exporter): Command => ({
    id: `export:ext:${exporter.key}`,
    label: exporter.name,
    keywords: `extension ${exporter.extension.slice(1)} download`,
    category: 'Export',
    icon: RIBBON_EXPORT_ICONS.extension,
    detail: exporter.extension,
    action: () => runExport({ id: 'extension', key: exporter.key }),
  }));
  const registryRows = EXPORT_SURFACE_COMMANDS.map((command) =>
    commandRowFromDefinition(command, { surface, runExport }));
  return [...registryRows, ...extensionRows];
}
