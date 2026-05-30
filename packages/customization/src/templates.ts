/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BUILTIN_PANEL_IDS, type WorkbenchPatch } from '@ifc-lite/extensions';
import type { CustomizationTemplate } from './types.js';

export function createReviewWorkspaceTemplate(now = new Date().toISOString()): CustomizationTemplate {
  const patch: WorkbenchPatch = {
    id: `template.review.${Date.now().toString(36)}`,
    author: 'system',
    createdAt: now,
    operations: [
      { op: 'movePanel', panelId: BUILTIN_PANEL_IDS.bcf, toZone: 'right', toIndex: 1 },
      { op: 'movePanel', panelId: BUILTIN_PANEL_IDS.ids, toZone: 'bottom', toIndex: 0 },
      { op: 'setBottomHeight', height: 360 },
      { op: 'setPanelChrome', panelId: BUILTIN_PANEL_IDS.bcf, chrome: { title: 'Issues' } },
      { op: 'setPanelChrome', panelId: BUILTIN_PANEL_IDS.ids, chrome: { title: 'IDS QA' } },
      {
        op: 'appendHistory',
        entry: {
          id: `history.review.${Date.now().toString(36)}`,
          label: 'Applied Review workspace template',
          patchId: `template.review.${Date.now().toString(36)}`,
          createdAt: now,
        },
      },
    ],
  };
  return {
    id: 'template.review-workspace',
    name: 'Review workspace',
    description: 'Moves issue and IDS review surfaces into a focused QA workspace.',
    plan: {
      schemaVersion: 1,
      id: 'plan.review-workspace',
      intent: 'morph-layout',
      summary: 'Create a review-focused workspace with issues and IDS visible.',
      risks: [{ tier: 'info', message: 'Only layout and panel chrome are changed.' }],
      requiredCapabilities: [],
      patch,
    },
  };
}

export function createFireSafetyPanelTemplate(now = new Date().toISOString()): CustomizationTemplate {
  const panelId = `user:panel:fire-safety:${Date.now().toString(36)}`;
  return {
    id: 'template.fire-safety-panel',
    name: 'Fire safety panel',
    description: 'Creates a personal dashboard scaffold for fire-safety review prompts.',
    plan: {
      schemaVersion: 1,
      id: 'plan.fire-safety-panel',
      intent: 'create-panel',
      summary: 'Add a fire-safety review panel to the right dock.',
      risks: [{ tier: 'info', message: 'Adds a local personal panel only.' }],
      requiredCapabilities: [],
      patch: {
        id: `template.fire-safety.${Date.now().toString(36)}`,
        author: 'system',
        createdAt: now,
        operations: [
          {
            op: 'addPersonalPanel',
            zone: 'right',
            panel: {
              id: panelId,
              title: 'Fire safety',
              createdAt: now,
              updatedAt: now,
              widget: {
                type: 'Stack',
                direction: 'vertical',
                gap: 'md',
                children: [
                  { type: 'Text', variant: 'heading', text: 'Fire safety review' },
                  { type: 'Markdown', content: 'Track missing fire ratings, doors, exits, and compartment notes here.' },
                  { type: 'KeyValueGrid', rows: [{ label: 'Status', value: 'Draft' }, { label: 'Source', value: 'Personal flavor' }] },
                ],
              },
            },
          },
        ],
      },
    },
  };
}

export function listCustomizationTemplates(): CustomizationTemplate[] {
  return [
    createReviewWorkspaceTemplate(),
    createFireSafetyPanelTemplate(),
  ];
}
