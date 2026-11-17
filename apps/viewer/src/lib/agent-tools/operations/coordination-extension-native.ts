/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { parseCapabilities, type InstalledExtensionRecord } from '@ifc-lite/extensions';
import { coordinationExtensions } from '@/services/coordination-hosts';
import { useViewerStore } from '@/store';
import { coordination } from './coordination-common';
const identity = { expected_model_ids: { type: 'array' as const, maxItems: 1000, uniqueItems: true as const, items: { type: 'string' as const, minLength: 1, maxLength: 200 } }, expected_mutation_version: { type: 'integer' as const, minimum: 0 }, expected_geometry_version: { type: 'integer' as const, minimum: 0 }, extension_id: { type: 'string' as const, minLength: 1, maxLength: 200 }, expected_bundle_hash: { type: 'string' as const, minLength: 1, maxLength: 200 }, expected_version: { type: 'string' as const, minLength: 1, maxLength: 200 }, expected_grants_json: { type: 'string' as const, maxLength: 100000 } };
async function installed(id: string, hash: string, version: string, grants: string): Promise<InstalledExtensionRecord> {
  const record = (await coordinationExtensions().listInstalled()).find(record => record.id === id);
  if (!record || record.bundleHash !== hash || record.version !== version || JSON.stringify(record.grantedCapabilities) !== grants) throw new Error('The exact installed extension bundle changed or is absent.'); return record;
}
function modelGuard(input: { expected_model_ids: string[]; expected_mutation_version: number; expected_geometry_version: number }) {
  const state = useViewerStore.getState(); if (JSON.stringify([...state.models.keys()].sort()) !== JSON.stringify([...input.expected_model_ids].sort()) || state.mutationVersion !== input.expected_mutation_version || state.geometryContentVersion !== input.expected_geometry_version) throw new Error('Native extension model sources or revisions changed.');
}
/** Native install review remains authoritative; these calls never add capabilities. Extension-owned side effects are unknown. */
export function validateNativeExtensionGrants(record: InstalledExtensionRecord): void {
  const grants = parseCapabilities(record.grantedCapabilities); if (!grants.ok) throw new Error('Native installed extension grants are invalid.');
}
export const coordinationExtensionNativeOperations = [
  coordination<{ extension_id: string; expected_bundle_hash: string; expected_version: string; expected_grants_json: string; expected_model_ids: string[]; expected_mutation_version: number; expected_geometry_version: number }>('extensions.enable', 'Enable the exact installed bundle under its existing reviewed grants through native loader/activation. No grant is added. Extension activation retains native install review and current grants.', ['configuration', 'model', 'view', 'network'], {
    type: 'object', properties: identity, required: ['expected_model_ids', 'expected_mutation_version', 'expected_geometry_version', 'extension_id', 'expected_bundle_hash', 'expected_version', 'expected_grants_json'], additionalProperties: false,
  }, async (i, c) => {
    const record = await installed(i.extension_id, i.expected_bundle_hash, i.expected_version, i.expected_grants_json); validateNativeExtensionGrants(record);
    return c.commitAsync(async () => { await installed(i.extension_id, i.expected_bundle_hash, i.expected_version, i.expected_grants_json); c.checkpoint?.(); modelGuard(i); await coordinationExtensions().setEnabled(i.extension_id, true); const current = await installed(i.extension_id, i.expected_bundle_hash, i.expected_version, i.expected_grants_json); if (!current.enabled) throw new Error('Native extension enable did not settle.'); return { state: 'enabled', extension_id: i.extension_id }; });
  }),
  coordination<{ extension_id: string; expected_bundle_hash: string; expected_version: string; expected_grants_json: string; expected_model_ids: string[]; expected_mutation_version: number; expected_geometry_version: number; command_id: string; args_json: string }>('extensions.runCommand', 'Invoke one exact enabled native extension command under its stored grants and sandbox budgets. Returns the actual settled native result. Unknown extension-owned side effects are not inferred as external publication success; native running evaluations drain to their actual outcome.', ['configuration', 'model', 'view', 'network'], {
    type: 'object', properties: { ...identity, command_id: { type: 'string', minLength: 1, maxLength: 500 }, args_json: { type: 'string', maxLength: 1000000 } }, required: ['expected_model_ids', 'expected_mutation_version', 'expected_geometry_version', 'extension_id', 'expected_bundle_hash', 'expected_version', 'expected_grants_json', 'command_id', 'args_json'], additionalProperties: false,
  }, async (i, c) => {
    const host = coordinationExtensions(), record = await installed(i.extension_id, i.expected_bundle_hash, i.expected_version, i.expected_grants_json); if (!record.enabled) throw new Error('Native extension is disabled.');
    const bundle = host.loader.getBundle(i.extension_id); if (!bundle?.manifest.contributes?.commands?.some(command => command.id === i.command_id)) throw new Error('This exact native bundle does not own that command.');
    validateNativeExtensionGrants(record);
    const args: unknown = JSON.parse(i.args_json); if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Native command arguments must be a JSON object.');
    return c.commitAsync(async () => { await installed(i.extension_id, i.expected_bundle_hash, i.expected_version, i.expected_grants_json); c.checkpoint?.(); modelGuard(i); const result = await host.runCommand(i.command_id, i.extension_id, args as Record<string, unknown>, () => !c.signal?.aborted); if (!result) throw new Error('Native command invocation produced no result.'); return { state: 'settled', extension_id: i.extension_id, result }; });
  }),
  coordination<{ extension_id: string; expected_bundle_hash: string; expected_version: string; expected_grants_json: string; expected_model_ids: string[]; expected_mutation_version: number; expected_geometry_version: number; exporter_id: string }>('extensions.runExporter', 'Invoke one exact enabled native extension exporter under its stored grants, await its actual bytes, and return a host-owned artifact. Native installed capability review remains authoritative; artifact creation does not assert that unknown external side effects succeeded.', ['configuration', 'model', 'view', 'network', 'artifact'], {
    type: 'object', properties: { ...identity, exporter_id: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['expected_model_ids', 'expected_mutation_version', 'expected_geometry_version', 'extension_id', 'expected_bundle_hash', 'expected_version', 'expected_grants_json', 'exporter_id'], additionalProperties: false,
  }, async (i, c) => {
    const host = coordinationExtensions(), record = await installed(i.extension_id, i.expected_bundle_hash, i.expected_version, i.expected_grants_json); if (!record.enabled) throw new Error('Native extension is disabled.');
    const bundle = host.loader.getBundle(i.extension_id); if (!bundle?.manifest.contributes?.exporters?.some(exporter => exporter.id === i.exporter_id)) throw new Error('This exact native bundle does not own that exporter.');
    validateNativeExtensionGrants(record);
    const output = await c.commitAsync(async () => { await installed(i.extension_id, i.expected_bundle_hash, i.expected_version, i.expected_grants_json); c.checkpoint?.(); modelGuard(i); return host.runExporter(i.exporter_id, i.extension_id); });
    const artifact = await c.artifacts.create({ filename: `${i.exporter_id.replace(/[^a-zA-Z0-9_-]/g, '_')}.${output.contribution.extension.replace(/^\./, '')}`, mimeType: output.contribution.mimeType, data: output.data }); return { state: 'settled', extension_id: i.extension_id, artifact, result: output.result };
  }),
];
