/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared types for the command-palette command table, split across
 * `commandPaletteCommandsCore.ts` and `commandPaletteCommandsPanels.ts`
 * (#4918 slice 3) so neither half of the table needs to import from the
 * other just to share `CommandPaletteBuildParams`.
 */

import type { CommandContribution, SlotContribution } from '@ifc-lite/extensions';
import type { ExtensionHostService } from '@/services/extensions/host.js';
import type { RecentFileEntry } from '@/lib/recent-files';
import type { BottomPanelId } from '@/lib/panels/bottom-panels';
import type { TranslationKey, TranslationParameters } from '@/i18n';
import type { PaletteExportRequest } from './usePaletteExportRunner';
import type { ExtensionExporter } from '@/components/extensions/useExtensionExporters';

export type RightPanel =
  | 'bcf' | 'validation' | 'lens' | 'clash' | 'compare' | 'cost' | 'extensions' | 'layers'
  | 'collab' | 'sources' | 'zones' | 'loadReport' | 'appearance' | 'pointclouds' | 'measurements';

export interface CommandPaletteBuildParams {
  execute: (code: string) => void;
  recentFiles: RecentFileEntry[];
  cachedNames: React.MutableRefObject<Set<string>>;
  extensionCommands: SlotContribution<CommandContribution>[];
  extensionHost: ExtensionHostService | null;
  canEditInSession: boolean;
  cesiumAvailable: boolean;
  activateRightPanel: (panel: RightPanel) => void;
  activateBottomPanel: (panel: BottomPanelId) => void;
  /** Runs an Export row through the toolbars' handlers and dialogs (`usePaletteExportRunner`). */
  runExport: (request: PaletteExportRequest) => void;
  /** Installed extension exporters, offered as Export rows (#5838). */
  extensionExporters?: readonly ExtensionExporter[];
}

/** `labelKey` shorthand: every row that shows fixed UI copy sets exactly
 *  one of these two shapes; rows built from runtime content omit it and
 *  render `label` as-is (see `commandPaletteCommandsCore.ts`'s docblock). */
export function withKey(labelKey: TranslationKey, labelKeyParams?: TranslationParameters) {
  return { labelKey, labelKeyParams };
}
