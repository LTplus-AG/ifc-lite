/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BUILTIN_PANEL_IDS, type WorkbenchPatch } from '@ifc-lite/extensions';
import { createFireSafetyPanelTemplate, createReviewWorkspaceTemplate } from './templates.js';
import type { CustomizationPlan } from './types.js';

export function draftCustomizationPlanFromPrompt(prompt: string, now = new Date().toISOString()): CustomizationPlan {
  const normalized = prompt.toLowerCase();
  if (normalized.includes('fire')) return createFireSafetyPanelTemplate(now).plan;
  if (normalized.includes('qa') || normalized.includes('review') || normalized.includes('ids')) {
    return createReviewWorkspaceTemplate(now).plan;
  }
  const patch: WorkbenchPatch = {
    id: `ai.layout.${Date.now().toString(36)}`,
    author: 'ai',
    createdAt: now,
    operations: [
      { op: 'movePanel', panelId: BUILTIN_PANEL_IDS.properties, toZone: 'right', toIndex: 0 },
      { op: 'setPanelChrome', panelId: BUILTIN_PANEL_IDS.properties, chrome: { title: 'Inspector' } },
      {
        op: 'appendHistory',
        entry: { id: `history.ai.${Date.now().toString(36)}`, label: `AI draft: ${prompt.slice(0, 60)}`, createdAt: now },
      },
    ],
  };
  return {
    schemaVersion: 1,
    id: `plan.ai.${Date.now().toString(36)}`,
    intent: 'morph-layout',
    summary: `Draft UI morph for: ${prompt}`,
    risks: [{ tier: 'caution', message: 'This is a heuristic local draft; review before applying.' }],
    requiredCapabilities: [],
    patch,
  };
}
