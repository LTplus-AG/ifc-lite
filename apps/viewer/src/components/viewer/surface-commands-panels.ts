/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Static panel palette entries. Dynamic extension and export rows stay with their providers. */
import {
  BarChart3, Box, CalendarClock, ClipboardCheck, ClipboardPen, Cloud, Coins, Crosshair,
  FileCode2, FileSpreadsheet, FileText, FileWarning, GitBranch, GitCompareArrows,
  History, Layout, Layers, Link2, ListChecks, MessageSquare, Palette, PencilLine, PencilRuler, Puzzle,
  Ruler, Scan, Sparkles, TreeDeciduous, Users, Workflow,
} from 'lucide-react';
import type { TranslationKey } from '@/i18n';
import type { WorkspacePanelId } from '@/lib/panels/registry';
import { closeActiveAnalysisExtension } from '@/services/analysis-extensions';
import type { BottomPanelId } from '@/lib/panels/bottom-panels';
import { panelGroupFor, panelTitleKey } from '@/lib/panels/registry';
import { useViewerStore } from '@/store';
import { liftStartFold } from './welcome/useEmptyStartFold';
import type { RightPanel } from './commandPaletteCommandsTypes';
import type { Command } from './commandPaletteSearch';
import type {
  SurfaceCommandContext, SurfaceCommandDefinition, SurfaceCommandState,
} from './surface-commands';

const paletteOnly = ['palette'] as const;
const paletteAndRibbon = ['palette', 'ribbon'] as const;
const alwaysEnabled = (_state: SurfaceCommandState): boolean => true;

const CHILD_PATH_KEYS: Partial<Record<WorkspacePanelId, TranslationKey>> = {
  bcf: 'commandPalette.paths.panels.bcf', validation: 'commandPalette.paths.panels.ids',
  idsStudio: 'commandPalette.paths.panels.ids', clash: 'commandPalette.paths.panels.clash',
  compare: 'commandPalette.paths.panels.compare', lists: 'commandPalette.paths.panels.quantify',
  gantt: 'commandPalette.paths.panels.quantify', cost: 'commandPalette.paths.panels.quantify',
  drawing: 'commandPalette.paths.panels.drawing', appearance: 'commandPalette.paths.panels.appearance',
  pointclouds: 'commandPalette.paths.panels.clouds',
};

function bottomCommand<const Id extends BottomPanelId>(
  panel: Id, keywords: string, icon: Command['icon'], ribbon = true,
): SurfaceCommandDefinition & { id: `panel:${Id}` } {
  return {
    id: `panel:${panel}`, panelId: panel, panelGroup: panelGroupFor(panel),
    labelKey: panelTitleKey(panel), keywords, keywordsKey: CHILD_PATH_KEYS[panel], detailKey: CHILD_PATH_KEYS[panel],
    category: 'Panels', icon, surfaces: ribbon ? paletteAndRibbon : paletteOnly, enabled: alwaysEnabled,
    run: (context) => {
      if (!context.activateBottomPanel) throw new Error(`Cannot open ${panel} without a panel host`);
      context.activateBottomPanel(panel);
    },
  };
}

function rightCommand<const Id extends string>(
  id: Id, panel: RightPanel, keywords: string, icon: Command['icon'],
  ribbon = false,
  enabled: (state: SurfaceCommandState) => boolean = alwaysEnabled,
): SurfaceCommandDefinition & { id: Id } {
  return {
    id, panelId: panel, panelGroup: panelGroupFor(panel),
    labelKey: panelTitleKey(panel), keywords, keywordsKey: CHILD_PATH_KEYS[panel], detailKey: CHILD_PATH_KEYS[panel],
    category: 'Panels', icon, surfaces: ribbon ? paletteAndRibbon : paletteOnly, enabled,
    run: (context) => {
      if (!context.activateRightPanel) throw new Error(`Cannot open ${panel} without a panel host`);
      context.activateRightPanel(panel);
    },
  };
}

export const PANEL_SURFACE_COMMANDS = [
  bottomCommand('presentation', 'presentation slides saved views viewpoints slideshow play baskets', Layout, false),
  bottomCommand('script', 'code automation console', FileCode2),
  bottomCommand('lists', 'entity lists table spreadsheet columns sort filter selection CSV export templates', FileSpreadsheet),
  bottomCommand('gantt', 'construction schedule (gantt) 4d timeline tasks ifctask sequence playback animation', CalendarClock),
  bottomCommand('charts', 'dashboard chart graph bar pie statistics analytics report', BarChart3),
  bottomCommand('flow', 'flow graph node dynamo grasshopper automation workflow script', Workflow),
  bottomCommand('document', 'document page report template cover sheet label binding pdf print logo', FileText),
  bottomCommand('drawing', 'drawing (2d) section cut plan floor plan elevation sheet dxf svg pdf markup', PencilRuler),
  {
    id: 'panel:properties', panelId: 'properties', panelGroup: panelGroupFor('properties'),
    labelKey: panelTitleKey('properties'),
    keywords: 'properties attributes material classification schedule task panel right inspector information',
    category: 'Panels', icon: Layout, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => {
      closeActiveAnalysisExtension();
      liftStartFold('right'); // folded for the start screen, Properties must still appear
      useViewerStore.getState().showWorkspacePanel('properties', 'palette');
    },
  },
  {
    id: 'panel:tree', panelId: 'hierarchy', panelGroup: panelGroupFor('hierarchy'),
    labelKey: panelTitleKey('hierarchy'),
    keywords: 'spatial tree hierarchy left panel', category: 'Panels', icon: TreeDeciduous,
    surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => {
      closeActiveAnalysisExtension();
      const state = useViewerStore.getState();
      liftStartFold('left');
      state.showWorkspacePanel('hierarchy', 'palette');
    },
  },
  rightCommand('panel:assistant', 'assistant', 'assistant analysis ai evidence discussion report', MessageSquare),
  rightCommand('panel:bcf', 'bcf', 'collaboration topics comments viewpoint BCF server connect review import export issues snapshots', MessageSquare, true),
  rightCommand('panel:ids', 'validation', 'ids validation information delivery specification check', ClipboardCheck, true),
  rightCommand('panel:idsStudio', 'idsStudio', 'ids studio author edit write information delivery specification requirements facets', ClipboardPen),
  rightCommand('panel:influx', 'influx', 'influxdb time series iot sensor telemetry monitoring digital twin experimental', BarChart3),
  rightCommand('panel:clash', 'clash', 'collision interference clearance coordination clash matrix mep saved reports rules run results', Crosshair, true),
  rightCommand('panel:compare', 'compare', 'diff revision version change added deleted modified geometry data', GitCompareArrows, true),
  rightCommand('panel:changes', 'changes', 'authored edits modifications properties history review', History),
  rightCommand('panel:model', 'model', 'model inspector author defaults wall type dimensions edit workspace', PencilLine),
  rightCommand('panel:review', 'review', 'review coordination cards findings clash validation comparison bcf linked records decisions workspace', ListChecks),
  rightCommand('panel:semantic', 'semantic', 'linked records semantic sparql json rdf dbl dpp passport profile validation', Link2, true),
  rightCommand('panel:changeSets', 'changeSets', 'change set changeset edits group active export import share discard', GitBranch, true),
  rightCommand('panel:cost', 'cost', '5d cost schedule item quantity budget estimate rates currency subtotal assignments', Coins, true),
  {
    id: 'panel:chat', panelId: 'script', panelGroup: panelGroupFor('script'),
    labelKey: 'commandPalette.panel.chat.label', searchLabel: 'AI Chat',
    keywords: 'ai assistant script chat ask model', category: 'Panels', icon: Sparkles,
    surfaces: paletteOnly, enabled: alwaysEnabled,
    run: (context: SurfaceCommandContext) => {
      if (!context.activateBottomPanel) throw new Error('Cannot open chat without a panel host');
      context.activateBottomPanel('script');
      useViewerStore.getState().setChatPanelVisible(true);
    },
  },
  rightCommand('panel:lens', 'lens', 'lens rules color filter highlight', Palette, true),
  rightCommand('panel:layers', 'layers', 'ifcx layers federation draft publish merge review provenance registry version overlay', Layers, true),
  rightCommand('panel:sources', 'sources', 'cde common data environment connect provider bim360 acc trimble dalux integration remote', Cloud, true),
  rightCommand('panel:zones', 'zones', 'zone section takt area construction location apportionment storey', Box, true),
  rightCommand('panel:loadReport', 'loadReport', 'geometry diagnostics warnings dropped items csg openings unsupported load report', FileWarning, true),
  rightCommand('panel:pointclouds', 'pointclouds', 'point clouds scan las laz e57 splat classification deviation registration alignment', Scan),
  rightCommand('panel:measurements', 'measurements', 'measure distance polyline angle radius coordinates point quantities area volume list', Ruler),
  rightCommand('panel:appearance', 'appearance', 'image texture upload UV planar box projection surfaces', Palette, true),
  rightCommand('panel:collab', 'collab', 'collaboration session share invite live multiplayer presence room realtime sync', Users,
    true, (state) => state.collabEnabled === true),
  rightCommand('panel:extensions', 'extensions', 'extension plugin install manage iflx permissions grants revoke audit log repair queue', Puzzle, true),
] as const satisfies readonly SurfaceCommandDefinition[];
