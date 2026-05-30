/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BUILTIN_PANEL_IDS, type WorkbenchLayoutState, type WorkbenchPanelId, type WorkbenchZoneId } from '@ifc-lite/extensions';

export interface WorkbenchPanelSummary {
  id: WorkbenchPanelId;
  title: string;
  kind: 'built-in' | 'personal' | 'extension' | 'missing';
  zone?: WorkbenchZoneId;
  hidden: boolean;
}

export function extensionPanelWorkbenchId(extensionId: string, panelId: string): string {
  return `extension:${extensionId}:panel:${panelId}`;
}

export function parseExtensionPanelWorkbenchId(panelId: string): { extensionId: string; panelId: string } | undefined {
  const match = /^extension:([^:]+):panel:(.+)$/.exec(panelId);
  if (!match) return undefined;
  return { extensionId: match[1], panelId: match[2] };
}

export const BUILTIN_TITLES: Record<string, string> = {
  [BUILTIN_PANEL_IDS.hierarchy]: 'Hierarchy',
  [BUILTIN_PANEL_IDS.properties]: 'Properties',
  [BUILTIN_PANEL_IDS.bcf]: 'BCF',
  [BUILTIN_PANEL_IDS.ids]: 'IDS',
  [BUILTIN_PANEL_IDS.lens]: 'Lens',
  [BUILTIN_PANEL_IDS.extensions]: 'Extensions',
  [BUILTIN_PANEL_IDS.addElement]: 'Add element',
  [BUILTIN_PANEL_IDS.lists]: 'Lists',
  [BUILTIN_PANEL_IDS.script]: 'Script',
  [BUILTIN_PANEL_IDS.gantt]: 'Schedule',
};

export const BUILTIN_PANEL_ORDER: string[] = [
  BUILTIN_PANEL_IDS.hierarchy,
  BUILTIN_PANEL_IDS.properties,
  BUILTIN_PANEL_IDS.bcf,
  BUILTIN_PANEL_IDS.ids,
  BUILTIN_PANEL_IDS.lens,
  BUILTIN_PANEL_IDS.extensions,
  BUILTIN_PANEL_IDS.addElement,
  BUILTIN_PANEL_IDS.lists,
  BUILTIN_PANEL_IDS.script,
  BUILTIN_PANEL_IDS.gantt,
];

export const ZONE_LABEL: Record<WorkbenchZoneId, string> = {
  left: 'Left dock',
  right: 'Right dock',
  bottom: 'Bottom dock',
};

export function getWorkbenchPanelTitle(layout: WorkbenchLayoutState, panelId: string): string {
  const chromeTitle = layout.panelChrome[panelId]?.title;
  if (chromeTitle) return chromeTitle;
  const personal = layout.personalPanels[panelId];
  if (personal) return personal.title;
  return BUILTIN_TITLES[panelId] ?? panelId;
}

export function findWorkbenchPanelZone(layout: WorkbenchLayoutState, panelId: string): WorkbenchZoneId | undefined {
  if (layout.zones.left.includes(panelId)) return 'left';
  if (layout.zones.right.includes(panelId)) return 'right';
  if (layout.zones.bottom.includes(panelId)) return 'bottom';
  return undefined;
}

export function listWorkbenchPanels(layout: WorkbenchLayoutState): WorkbenchPanelSummary[] {
  const ids = new Set<string>([
    ...BUILTIN_PANEL_ORDER,
    ...Object.keys(layout.personalPanels),
    ...layout.zones.left,
    ...layout.zones.right,
    ...layout.zones.bottom,
  ]);
  return Array.from(ids).map((id) => ({
    id,
    title: getWorkbenchPanelTitle(layout, id),
    kind: id in layout.personalPanels ? 'personal' : id in BUILTIN_TITLES ? 'built-in' : 'missing',
    zone: findWorkbenchPanelZone(layout, id),
    hidden: layout.panelChrome[id]?.hidden === true,
  }));
}
