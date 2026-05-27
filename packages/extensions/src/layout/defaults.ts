/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WorkbenchLayoutState } from './types.js';

export const DEFAULT_WORKBENCH_LAYOUT_ID = 'ifc-lite.viewer.default.v1';

export const BUILTIN_PANEL_IDS = {
  hierarchy: 'builtin:panel:hierarchy',
  properties: 'builtin:panel:properties',
  bcf: 'builtin:panel:bcf',
  ids: 'builtin:panel:ids',
  lens: 'builtin:panel:lens',
  extensions: 'builtin:panel:extensions',
  addElement: 'builtin:panel:add-element',
  lists: 'builtin:panel:lists',
  script: 'builtin:panel:script',
  gantt: 'builtin:panel:gantt',
} as const;

export function createDefaultWorkbenchLayout(): WorkbenchLayoutState {
  return {
    schemaVersion: 1,
    baseLayoutId: DEFAULT_WORKBENCH_LAYOUT_ID,
    zones: {
      left: [BUILTIN_PANEL_IDS.hierarchy],
      right: [
        BUILTIN_PANEL_IDS.properties,
        BUILTIN_PANEL_IDS.bcf,
        BUILTIN_PANEL_IDS.ids,
        BUILTIN_PANEL_IDS.lens,
        BUILTIN_PANEL_IDS.extensions,
        BUILTIN_PANEL_IDS.addElement,
      ],
      bottom: [
        BUILTIN_PANEL_IDS.lists,
        BUILTIN_PANEL_IDS.script,
        BUILTIN_PANEL_IDS.gantt,
      ],
    },
    sizes: {
      horizontal: [20, 58, 22],
      bottomHeight: 300,
    },
    collapsed: {
      left: false,
      right: false,
      bottom: false,
    },
    activeTabs: {
      left: BUILTIN_PANEL_IDS.hierarchy,
      right: BUILTIN_PANEL_IDS.properties,
      bottom: undefined,
    },
    floating: [],
    panelChrome: {},
    personalPanels: {},
    workspaceModes: {},
    automations: [],
    history: [],
  };
}
