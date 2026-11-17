/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { operationContracts } from './generated/contracts';
import { operationLoaders } from './generated/loaders';
import { operationValidators } from './validators';
import { publicOperationContract, contractFingerprint, type OperationContract } from './metadata';
import { isFeatureEnabled } from '@/lib/features';
import { PANEL_FEATURE } from '@/lib/panels/availability';
import type { Operation } from './contract';

function lazyOperation(contract: OperationContract): Operation {
  const { module, exportName, ...metadata } = contract;
  if (!metadata.outputSchema) throw new Error(`Missing output contract: ${metadata.id}`);
  let implementation: Promise<Operation> | undefined;
  const load = () => implementation ??= (async () => {
    const loader = operationLoaders[module];
    if (!loader) throw new Error(`Missing operation module: ${module}`);
    const loaded = await loader();
    const candidates = loaded[exportName];
    if (!Array.isArray(candidates)) throw new Error(`Missing native operations: ${module}.${exportName}`);
    const native = (candidates as Operation[]).find(candidate => candidate.id === metadata.id);
    if (!native || contractFingerprint(publicOperationContract(native)) !== contractFingerprint(metadata)) {
      throw new Error(`Native operation contract changed: ${metadata.id}. Rebuild the verified operation catalogue.`);
    }
    return native;
  })().catch((error: unknown) => {
    // A transient import failure (chunk 404 after a redeploy, network drop) must stay retryable.
    implementation = undefined; throw error;
  });
  return { ...metadata, ...operationValidators(metadata.id, metadata.inputSchema, metadata.outputSchema),
    async execute(input, context) { return (await load()).execute(input, context); },
  };
}
const entries = operationContracts.map(lazyOperation);
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
  return { ...publicOperationContract(entry), completion: entry.completion ?? 'synchronous' };
}
export function operationUnavailable(entry: Operation): string | null {
  const feature = PANEL_FEATURE[entry.owner as keyof typeof PANEL_FEATURE];
  const disabled = [feature, ...(entry.features ?? [])].find(id => id && !isFeatureEnabled(id));
  return disabled ? `Host feature ${disabled} is disabled.` : null;
}
