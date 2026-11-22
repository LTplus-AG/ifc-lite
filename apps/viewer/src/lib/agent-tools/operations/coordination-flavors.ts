/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { validateFlavor, type Flavor } from '@ifc-lite/extensions';
import { coordinationExtensions } from '@/services/coordination-hosts';
import { captureNativeFlavor, createNativeFlavor } from '@/services/extensions/flavor-capture';
import { validateNativeExtensionGrants } from './coordination-extension-native';
import { coordination, idSchema } from './coordination-common';
import { emptySchema } from './contract';
import { invalidInput, parseJsonInput, stale } from './refusals';
const bounded = { type: 'string' as const, minLength: 1, maxLength: 500 };
async function exactFlavor(id: string, expected: string) {
  const target = (await coordinationExtensions().flavors.list()).find(flavor => flavor.id === id);
  if (!target || target.updatedAt !== expected) throw stale('The native flavor changed or is absent.'); return target;
}
export const coordinationFlavorOperations = [
  coordination('extensions.flavors', 'Read the native flavor library and current persisted active pointer.', ['read'], emptySchema, async () => { const host = coordinationExtensions(); return { flavors: await host.flavors.list(), active_id: await host.flavors.activeId() ?? null }; }),
  coordination<{ name: string; description: string; snapshot: boolean }>('extensions.createFlavor', 'Create and activate a native flavor, optionally capturing the same live lenses/clash/sidebar state as New snapshot. No extension capability is installed or broadened.', ['configuration'], {
    type: 'object', properties: { name: bounded, description: { type: 'string', maxLength: 10000 }, snapshot: { type: 'boolean' } }, required: ['name', 'description', 'snapshot'], additionalProperties: false,
  }, (i, c) => c.commitAsync(async () => { const host = coordinationExtensions(), flavor = createNativeFlavor(i.name, i.description, i.snapshot); await host.flavors.put(flavor, i.snapshot ? 'created from current state' : 'created empty'); await host.flavors.activate(flavor.id); return { flavor }; })),
  coordination<{ id: string; expected_updated_at: string; action: 'rename' | 'duplicate' | 'capture' | 'delete'; name: string }>('extensions.editFlavor', 'Rename, duplicate, capture the native live viewer state into, or delete one exact flavor revision through its native persisted service.', ['configuration'], {
    type: 'object', properties: { id: bounded, expected_updated_at: bounded, action: { type: 'string', enum: ['rename', 'duplicate', 'capture', 'delete'] }, name: { type: 'string', maxLength: 500 } }, required: ['id', 'expected_updated_at', 'action', 'name'], additionalProperties: false,
  }, (i, c) => c.commitAsync(async () => {
    const host = coordinationExtensions(), target = await exactFlavor(i.id, i.expected_updated_at); if (i.action === 'delete') { await host.flavors.delete(i.id); return { state: 'deleted', id: i.id }; }
    const now = new Date().toISOString(); let flavor: Flavor;
    if (i.action === 'capture') flavor = captureNativeFlavor(target);
    else { if (!i.name.trim()) throw invalidInput('invalid-value', 'A nonempty native flavor name is required.'); flavor = { ...target, name: i.name, updatedAt: now, ...(i.action === 'duplicate' ? { id: `${target.id}.copy.${now.replace(/[:.]/g, '-').toLowerCase()}`, createdAt: now } : {}) }; }
    await host.flavors.put(flavor, i.action === 'capture' ? 'capture current state' : i.action); return { state: 'saved', id: flavor.id, flavor };
  })),
  coordination<{ id: string; expected_updated_at: string }>('extensions.switchFlavor', 'Run the complete native flavor switcher, retaining existing reviewed extension grants and reporting every refused saved-state restore. Activations retain their existing native install review and exact current grants; no new capability is granted.', ['configuration', 'model', 'view', 'network'], {
    type: 'object', properties: { id: bounded, expected_updated_at: bounded }, required: ['id', 'expected_updated_at'], additionalProperties: false,
  }, async (i, c) => {
    const host = coordinationExtensions();
    await exactFlavor(i.id, i.expected_updated_at);
    const installed = await host.listInstalled();
    for (const record of installed) validateNativeExtensionGrants(record);
    return c.commitAsync(async () => { await exactFlavor(i.id, i.expected_updated_at); if (JSON.stringify(await host.listInstalled()) !== JSON.stringify(installed)) throw stale('Native installed extension revisions/grants changed before switching.'); const outcome = await host.switchFlavor(i.id); return { state: outcome.unapplied.length ? 'partial' : 'completed', id: i.id, ...outcome }; });
  }),
  coordination('extensions.exportFlavor', 'Export the exact native flavor archive bytes, preserving snapshots and metadata through the canonical packer.', ['artifact'], idSchema, async (i, c) => { const bytes = await coordinationExtensions().flavors.exportFlavor(i.id); return c.artifacts.create({ filename: `${i.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.iflv`, mimeType: 'application/octet-stream', data: bytes }); }),
  coordination<{ base64: string; strategy: 'replace' | 'save-as-new'; new_id: string; expected_updated_at: string }>('extensions.importFlavor', 'Preview and validate bounded native flavor archive bytes before saving with explicit replace or save-as-new strategy. Does not activate, install bundled extensions or broaden grants.', ['configuration'], {
    type: 'object', properties: { base64: { type: 'string', maxLength: 1000000 }, strategy: { type: 'string', enum: ['replace', 'save-as-new'] }, new_id: { type: 'string', maxLength: 500 }, expected_updated_at: { type: 'string', maxLength: 500 } }, required: ['base64', 'strategy', 'new_id', 'expected_updated_at'], additionalProperties: false,
  }, async (i, c) => { if (!/^[A-Za-z0-9+/]*={0,2}$/.test(i.base64)) throw invalidInput('invalid-value', 'Expected native base64 .iflv archive.'); const host = coordinationExtensions(), unpacked = await host.flavors.preview(Uint8Array.from(atob(i.base64), value => value.charCodeAt(0))); return c.commitAsync(async () => { if (i.strategy === 'replace') { const existing = (await host.flavors.list()).find(flavor => flavor.id === unpacked.flavor.id); if ((existing?.updatedAt ?? '') !== i.expected_updated_at) throw stale('Native flavor replacement revision changed.'); } else if (!i.new_id || (await host.flavors.list()).some(flavor => flavor.id === i.new_id)) throw invalidInput('invalid-value', 'Save-as-new requires a fresh explicit native flavor id.'); return { flavor: await host.flavors.importFlavor(unpacked, { strategy: i.strategy, ...(i.new_id ? { newId: i.new_id } : {}) }) }; }); }),
  coordination<{ definition_json: string; expected_updated_at: string }>('extensions.saveFlavorDefinition', 'Save one exact data-only flavor definition through the canonical strict validator. Supports the native portable merge/editor result while preserving an explicit existing revision guard; does not activate or grant capabilities.', ['configuration'], {
    type: 'object', properties: { definition_json: { type: 'string', maxLength: 1000000 }, expected_updated_at: { type: 'string', maxLength: 500 } }, required: ['definition_json', 'expected_updated_at'], additionalProperties: false,
  }, async (i, c) => { const validated = validateFlavor(parseJsonInput(i.definition_json, 'definition_json')); if (!validated.ok) throw invalidInput('invalid-value', validated.errors[0]?.message ?? 'Native flavor definition refused.'); const flavor = validated.value; return c.commitAsync(async () => { const existing = (await coordinationExtensions().flavors.list()).find(item => item.id === flavor.id); if ((existing?.updatedAt ?? '') !== i.expected_updated_at) throw stale('Native flavor revision changed.'); const saved = { ...flavor, updatedAt: new Date().toISOString() }; await coordinationExtensions().flavors.put(saved, 'reviewed definition'); return { flavor: saved }; }); }),
  coordination<{ expected_active_id: string }>('extensions.resetFlavors', 'Use the native Reset defaults lifecycle with its exact active pointer guard. Preserves native persistence refusal behavior.', ['configuration'], {
    type: 'object', properties: { expected_active_id: { type: 'string', maxLength: 500 } }, required: ['expected_active_id'], additionalProperties: false,
  }, (i, c) => c.commitAsync(async () => { const host = coordinationExtensions(); if ((await host.flavors.activeId() ?? '') !== i.expected_active_id) throw stale('Native active flavor changed.'); return { flavor: await host.flavors.resetToDefaults() }; })),
];
