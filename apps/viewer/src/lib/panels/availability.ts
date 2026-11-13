/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which workspace panels this page offers (see `lib/features`).
 *
 * `PANEL_FEATURE` is the one table that ties a panel to the catalogue feature
 * a host switches. Every surface that lists, opens or renders a panel asks
 * here: the rail and the ribbon's panel browser (`isPanelOffered`), the panel
 * commands, the Alt+digit shortcuts, the store (which refuses to hold an
 * unavailable panel open) and `renderPanelBody` (which then never requests
 * the panel's chunk).
 *
 * Hierarchy and Properties have no entry: they are the viewer's baseline.
 * The rail and the panel browser ask `isPanelOffered`, which also keeps the
 * collaboration panel's build-flag rule.
 */

import { isCollabEnabled } from '@/lib/collab/config';
import { isFeatureEnabled, type FeatureId } from '@/lib/features';
import type { WorkspacePanelId } from './registry';

/**
 * Panels not listed are not switchable yet (the editing, file, AI, extension
 * and collaboration panels join with their features).
 */
export const PANEL_FEATURE: Readonly<Partial<Record<WorkspacePanelId, FeatureId>>> = {
  measurements: 'tools.measure',
  lens: 'view.lens',
  environment: 'view.environment',
  appearance: 'view.appearance',
  drawing: 'view.drawings',
  presentation: 'view.presentation',
  pointclouds: 'view.point-clouds',
  compare: 'check.compare',
  bcf: 'check.bcf',
  validation: 'check.validation',
  idsStudio: 'check.ids-authoring',
  clash: 'check.clash',
  review: 'check.review',
  loadReport: 'check.load-report',
  lists: 'data.lists',
  charts: 'data.charts',
  gantt: 'data.schedule',
  cost: 'data.cost',
  zones: 'data.zones',
  document: 'data.documents',
  semantic: 'data.linked-records',
  layers: 'data.layers',
  influx: 'data.time-series',
  script: 'automate.scripting',
  flow: 'automate.flows',
};

/** Whether the host left this panel's feature on. A panel that is not available never opens or renders. */
export function isPanelAvailable(id: WorkspacePanelId): boolean {
  const feature = PANEL_FEATURE[id];
  return feature === undefined || isFeatureEnabled(feature);
}

/**
 * Whether the rail and the ribbon's panel browser list this panel. Beyond
 * being available, the collaboration panel is listed only in a build that
 * carries a collab server, as it always was; opening it another way in a
 * build without one still shows the panel.
 */
export function isPanelOffered(id: WorkspacePanelId): boolean {
  return isPanelAvailable(id) && (id !== 'collab' || isCollabEnabled());
}
