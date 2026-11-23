/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { operationContracts } from './generated/contracts';
import { operationLoaders } from './generated/loaders';
import { operationValidators } from './validators';
import { nearestIds, rankSearch, type SearchFields } from './discovery-search';
import { publicOperationContract, contractFingerprint, type OperationContract } from './metadata';
import { isFeatureEnabled } from '@/lib/features';
import { PANEL_FEATURE } from '@/lib/panels/availability';
import type { Operation } from './contract';
import { internal, invalidInput } from './refusals';

function lazyOperation(contract: OperationContract): Operation {
  const { module, exportName, candidateOnly, ...metadata } = contract;
  if (!metadata.outputSchema) throw internal(`Missing output contract: ${metadata.id}`);
  let implementation: Promise<Operation> | undefined;
  const load = () => implementation ??= (async () => {
    const loader = operationLoaders[module];
    if (!loader) throw internal(`Missing operation module: ${module}`);
    const loaded = await loader();
    const candidates = loaded[exportName];
    if (!Array.isArray(candidates)) throw internal(`Missing native operations: ${module}.${exportName}`);
    const native = (candidates as Operation[]).find(candidate => candidate.id === metadata.id);
    if (!native || native.candidateOnly !== candidateOnly || contractFingerprint(publicOperationContract(native)) !== contractFingerprint(metadata)) {
      throw internal(`Native operation contract changed: ${metadata.id}. Rebuild the verified operation catalogue.`);
    }
    return native;
  })().catch((error: unknown) => {
    // A transient import failure (chunk 404 after a redeploy, network drop) must stay retryable.
    implementation = undefined; throw error;
  });
  return { ...metadata, candidateOnly, ...operationValidators(metadata.id, metadata.inputSchema, metadata.outputSchema), load,
    async execute(input, context) { return (await load()).execute(input, context); },
  };
}
const entries = operationContracts.map(lazyOperation);
const registry = new Map<string, Operation>();
for (const entry of entries) {
  if (registry.has(entry.id)) throw internal(`Duplicate viewer operation: ${entry.id}`);
  registry.set(entry.id, entry);
}
export function viewerOperations(): readonly Operation[] { return entries; }
/** Catalogue ranked for a natural-language task query; ids and owners outrank descriptions. */
const operationFields = (op: Operation): SearchFields => ({ primary: [op.id, op.owner], secondary: [op.description] });
export function rankOperations(query: string): Operation[] {
  return rankSearch(entries, query, operationFields);
}
/** Error/hint text for an operation_id that is not in the catalogue, naming the nearest ids. */
export function unknownOperationMessage(id: string): string {
  const nearest = nearestIds(entries, id, operationFields, op => op.id);
  return `Unknown operation_id.${nearest.length ? ` Nearest: ${nearest.join(', ')}.` : ''} Discover exact IDs with viewer_operations {"query": "<task>"}.`;
}
/** Distinct owner families in catalogue order, for agents whose query matched nothing. */
export function operationOwners(): string[] { return [...new Set(entries.map(op => op.owner))]; }
export function viewerOperation(id: string): Operation {
  const entry = registry.get(id);
  if (!entry) throw invalidInput('unknown-target', `Unknown viewer operation: ${id}`);
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
