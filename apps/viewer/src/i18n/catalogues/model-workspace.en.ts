/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Model workspace's shell (charter #6232, M2): the tool rail, the storey
 * chip and its picker, the plan pane and the onboarding hint. IFC class names
 * and unit symbols stay untranslated.
 */
export const modelWorkspaceEn = {
  'modelWorkspace.rail.aria': 'Model tools',
  'modelWorkspace.tool.select': 'Select',
  'modelWorkspace.tool.wall': 'Wall',
  'modelWorkspace.tool.slab': 'Slab',
  'modelWorkspace.tool.column': 'Column',
  'modelWorkspace.tool.beam': 'Beam',
  'modelWorkspace.tool.split': 'Split',
  'modelWorkspace.tool.leave': 'Leave the Model workspace',
  'modelWorkspace.tool.shortcutHint': '· {key}',
  'modelWorkspace.blocked.noStorey': 'This model has no storey to draw on',
  'modelWorkspace.blocked.split': 'Select an element to split first',
  'modelWorkspace.storey.none': 'No storey',
  'modelWorkspace.storey.withModel': '{model} · {storey}',
  'modelWorkspace.storey.elevation': '{elevation} m',
  'modelWorkspace.storey.pick': 'Choose the storey to draw on',
  'modelWorkspace.storey.listAria': 'Storeys',
  'modelWorkspace.storey.isolate': 'Show only this storey',
  'modelWorkspace.storey.showAll': 'Show all storeys',
  'modelWorkspace.noStorey.title': 'No storey to draw on',
  'modelWorkspace.noStorey.description': 'This model has no IfcBuildingStorey, so walls have no floor to stand on.',
  'modelWorkspace.plan.title': 'Plan',
  'modelWorkspace.plan.show': 'Show the plan',
  'modelWorkspace.plan.hide': 'Hide the plan',
  'modelWorkspace.plan.noRoom': 'No room for the plan beside 3D: widen the window or close a side panel',
  'modelWorkspace.plan.noPlane': 'This storey has no plane to draw a plan on.',
  'modelWorkspace.plan.cutting': 'Cutting…',
  'modelWorkspace.plan.cutFailed': 'Cut failed',
  'modelWorkspace.plan.retry': 'Retry',
  'modelWorkspace.plan.simplified': 'Plan simplified',
  'modelWorkspace.plan.simplifiedTitle': 'This model is too large to cut on every edit, so the plan shows wall axes only',
  'modelWorkspace.plan.grid': 'Grid',
  'modelWorkspace.plan.fit': 'Fit the plan to the view',
  'modelWorkspace.layout.aria': 'Layout',
  'modelWorkspace.layout.plan': 'Plan',
  'modelWorkspace.layout.split': 'Split',
  'modelWorkspace.layout.3d': '3D',
  'modelWorkspace.hint.onboarding': 'W wall · Shift+S slab · click an element to edit it · E leaves',
} as const satisfies Record<string, TranslationValue>;
