/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CustomizationPlan } from './types.js';

export function validateCustomizationPlan(plan: CustomizationPlan): string[] {
  const errors: string[] = [];
  if (plan.schemaVersion !== 1) errors.push('Unsupported customization plan schemaVersion.');
  if (!plan.id) errors.push('Customization plan id is required.');
  if (!plan.summary) errors.push('Customization plan summary is required.');
  if (!plan.patch && !plan.widget) errors.push('Plan must include a workbench patch or widget.');
  if (plan.patch && plan.patch.operations.length === 0) errors.push('Workbench patch contains no operations.');
  return errors;
}
