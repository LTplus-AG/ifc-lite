/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Operation } from './contract';
export type OperationContract = Pick<Operation, 'id' | 'version' | 'owner' | 'features' | 'description' | 'needs' | 'effects' | 'capability' | 'inputSchema' | 'outputSchema' | 'result' | 'completion' | 'implementation' | 'policy'> & { module: string; exportName: string };
/** Property ordering must not make an equivalent generated/native contract look different. */
export function contractFingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]])) : item);
}

export function publicOperationContract(entry: Pick<Operation, 'id' | 'version' | 'owner' | 'features' | 'description' | 'needs' | 'effects' | 'capability' | 'inputSchema' | 'outputSchema' | 'result' | 'completion' | 'implementation' | 'policy'>) {
  const { id, version, owner, features, description, needs, effects, capability, inputSchema, outputSchema, result, completion, implementation, policy } = entry;
  return { id, version, owner, features, description, needs, effects, capability, inputSchema, outputSchema, result, completion, implementation, policy };
}
