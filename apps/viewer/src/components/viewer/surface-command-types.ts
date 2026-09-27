/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Type-only command contract shared by the catalogue and its surface adapters (#5870). */

import type { TranslationKey, TranslationParameters } from '@/i18n';
import type { BottomPanelId } from '@/lib/panels/bottom-panels';
import type { PanelGroup, WorkspacePanelId } from '@/lib/panels/registry';
import type { ThemeMode } from '@/store/slices/uiSlice';
import type { ProjectionMode } from '@/store/types';
import type { Command } from './commandPaletteSearch';
import type { RightPanel } from './commandPaletteCommandsTypes';
import type { ExportRequest } from './useExportRunner';

export type CommandSurface = 'palette' | 'ribbon' | 'context' | 'mobile';

export interface SurfaceCommandContext {
  surface: CommandSurface;
  execute?: (code: string) => void;
  resetColors?: () => void;
  activateRightPanel?: (panel: RightPanel) => void;
  activateBottomPanel?: (panel: BottomPanelId) => void;
  runExport?: (request: ExportRequest) => void;
  openFiles?: () => void;
  addModel?: () => void;
  refreshModels?: () => Promise<void>;
  openShareDialog?: () => void;
  /** The context menu owns the current entity and supplies its target-specific action. */
  contextAction?: () => void;
}

export interface SurfaceCommandState {
  canEditInSession: boolean;
  cesiumAvailable?: boolean;
  collabEnabled?: boolean;
  projectionMode?: ProjectionMode;
  theme?: ThemeMode;
  contextEntityType?: string;
}

export interface SurfaceCommandDefinition {
  id: string;
  /** Panel commands project this metadata from the workspace-panel registry. */
  panelId?: WorkspacePanelId;
  panelGroup?: PanelGroup;
  labelKey: TranslationKey;
  /** Legacy English search text; display always uses labelKey. */
  searchLabel?: string;
  keywords: string;
  category: Command['category'];
  icon: Command['icon'];
  /** State-dependent mobile text/icon live here, alongside the action. */
  mobileLabelKey?: (state: SurfaceCommandState) => TranslationKey;
  mobileIcon?: (state: SurfaceCommandState) => Command['icon'];
  ribbonLabelKey?: TranslationKey;
  ribbonTooltipKey?: TranslationKey;
  contextLabelKey?: TranslationKey;
  contextLabelParams?: (state: SurfaceCommandState) => TranslationParameters;
  contextIcon?: Command['icon'];
  contextShortcut?: Command['shortcut'];
  surfaces: readonly CommandSurface[];
  enabled: (state: SurfaceCommandState) => boolean;
  run: (context: SurfaceCommandContext) => void;
  shortcut?: Command['shortcut'];
  immediate?: boolean;
}
