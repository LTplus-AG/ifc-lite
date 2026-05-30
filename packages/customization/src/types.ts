/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  JsonValue,
  WorkbenchLayoutState,
  WorkbenchOperation,
  WorkbenchPatch,
} from '@ifc-lite/extensions';

export type CustomizationIntentKind =
  | 'morph-layout'
  | 'create-panel'
  | 'edit-panel'
  | 'create-extension'
  | 'create-automation'
  | 'merge-flavor'
  | 'debug-customization';

export interface CustomizationRisk {
  tier: 'info' | 'caution' | 'requires-review';
  message: string;
}

export interface CustomizationPlan {
  schemaVersion: 1;
  id: string;
  intent: CustomizationIntentKind;
  summary: string;
  risks: CustomizationRisk[];
  requiredCapabilities: string[];
  patch?: WorkbenchPatch;
  widget?: JsonValue;
  notes?: string[];
}

export interface PatchChangeSummary {
  operation: WorkbenchOperation['op'];
  label: string;
  detail?: string;
}

export interface PatchSimulationResult {
  ok: boolean;
  base: WorkbenchLayoutState;
  next: WorkbenchLayoutState;
  changes: PatchChangeSummary[];
  warnings: string[];
}

export interface CustomizationTemplate {
  id: string;
  name: string;
  description: string;
  plan: CustomizationPlan;
}
