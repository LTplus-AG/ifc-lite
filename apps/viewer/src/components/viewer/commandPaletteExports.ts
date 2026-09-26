/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The command palette's Export category, generated from the toolbar export
 * registry (`toolbar/export-commands.ts`) so the palette offers exactly the
 * formats the classic toolbar and the ribbon do, in the same order (#5601).
 * Every row only hands a request to `usePaletteExportRunner`, which runs the
 * toolbars' own handlers and dialogs — see that file's docblock.
 *
 * CSV is a sub-menu in the toolbars; the palette has no sub-menus, so it gets
 * one row per table. Row ids (`export:<id>`, `export:csv-<table>`) are what
 * the palette records as recent usage, so they stay stable.
 */

import type { TranslationKey } from '@/i18n';
import { resolveEnglish } from '@/i18n/registry';
import { EXPORT_COMMANDS, type CsvExportType, type ExportCommandId } from './toolbar/export-commands';
import { CLASSIC_EXPORT_ICONS } from './toolbar/ClassicExportMenuItems';
import type { PaletteExportRequest } from './usePaletteExportRunner';
import type { Command } from './commandPaletteSearch';
import { withKey } from './commandPaletteCommandsTypes';
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
 * The Export rows: the registry's formats, then one row per installed
 * extension exporter (#5838). An exporter's name is extension-supplied, so its
 * row renders `label` as-is (no catalogue key), like other `ext:` rows.
 */
export function buildExportCommands(
  runExport: (request: PaletteExportRequest) => void,
  extensionExporters: readonly ExtensionExporter[] = [],
): Command[] {
  const extensionRows = extensionExporters.map((exporter): Command => ({
    id: `export:ext:${exporter.key}`,
    label: exporter.name,
    keywords: `extension ${exporter.extension.slice(1)} download`,
    category: 'Export',
    icon: CLASSIC_EXPORT_ICONS.extension,
    detail: exporter.extension,
    action: () => runExport({ id: 'extension', key: exporter.key }),
  }));
  return [...registryRows(runExport), ...extensionRows];
}

function registryRows(runExport: (request: PaletteExportRequest) => void): Command[] {
  return EXPORT_COMMANDS.flatMap((command): Command[] => {
    const icon = CLASSIC_EXPORT_ICONS[command.id];
    if (command.kind === 'table-menu') {
      return command.items.map((item) => ({
        id: `export:csv-${item.type}`,
        label: resolveEnglish(CSV_LABEL_KEYS[item.type]),
        ...withKey(CSV_LABEL_KEYS[item.type]),
        keywords: `${EXPORT_KEYWORDS[command.id]} ${item.type}`,
        category: 'Export',
        icon,
        action: () => runExport({ id: command.id, table: item.type }),
      }));
    }
    return [{
      id: `export:${command.id}`,
      label: resolveEnglish(command.menuLabelKey),
      ...withKey(command.menuLabelKey),
      keywords: EXPORT_KEYWORDS[command.id],
      category: 'Export',
      icon,
      action: () => runExport({ id: command.id }),
    }];
  });
}
