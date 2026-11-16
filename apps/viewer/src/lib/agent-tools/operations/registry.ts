/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { validationOperations } from './validation';
import { measurementOperations } from './measurements';
import { pointCloudOperations } from './pointclouds';
import { clashOperations } from './clash';
import { viewOperations } from './view';
import { readOperations } from './reads';
import { environmentOperations } from './environment';
import { isFeatureEnabled, type FeatureId } from '@/lib/features';
import type { Operation } from './contract';

const entries = [...viewOperations, ...readOperations, ...environmentOperations, ...validationOperations, ...measurementOperations, ...pointCloudOperations, ...clashOperations];
const registry = new Map<string, Operation>();
for (const entry of entries) {
  if (registry.has(entry.id)) throw new Error(`Duplicate viewer operation: ${entry.id}`);
  registry.set(entry.id, entry);
}
export function viewerOperations(): readonly Operation[] { return entries; }
export function viewerOperation(id: string): Operation {
  const entry = registry.get(id);
  if (!entry) throw new Error(`Unknown viewer operation: ${id}`);
  return entry;
}
export function describeOperation(entry: Operation) {
  return { id: entry.id, version: entry.version, owner: entry.owner, description: entry.description,
    effects: entry.effects, capability: entry.capability, inputSchema: entry.inputSchema,
    result: entry.result, completion: entry.completion ?? 'synchronous', implementation: entry.implementation };
}

const ownerFeatures: Readonly<Record<string, FeatureId>> = {
  environment: 'view.environment', pointclouds: 'view.point-clouds', gantt: 'data.schedule',
  cost: 'data.cost', clash: 'check.clash', validation: 'check.validation', lens: 'view.lens',
};
export function operationUnavailable(entry: Operation): string | null {
  const feature = ownerFeatures[entry.owner];
  return feature && !isFeatureEnabled(feature) ? `Host feature ${feature} is disabled.` : null;
}
