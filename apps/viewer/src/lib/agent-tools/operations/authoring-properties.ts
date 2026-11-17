/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { operation, type OperationContext } from './contract';
import { resolveRef } from '../refs';
import { assertToolActive } from '../cancellation';
import type { PropertyValueType } from '@ifc-lite/data';
const outputSchema = { type: 'object', properties: { native_json: { type: 'string' } }, required: ['native_json'], additionalProperties: false };
const out = (value: unknown) => ({ native_json: JSON.stringify(value) });
const meta = (id: string, description: string, write = false) => ({ id, owner: 'properties', description, effects: write ? ['model'] as const : ['read'] as const,
  capability: write ? 'commands-and-edits' as const : 'read' as const, implementation: 'native-store' as const, outputSchema, policy: write ? { model: 'native-reviewed' as const } : undefined });
async function inspect(c: OperationContext, id: number) {
  resolveRef(c.model, { express_id: id });
  const { effectiveTypeProperties } = await import('@/components/viewer/properties/effectiveTypeProperties'); assertToolActive(c);
  const s = useViewerStore.getState(), view = s.mutationViews.get(c.model.id);
  const properties = view?.getForEntity(id) ?? c.model.store.properties.getForEntity(id);
  const inherited = effectiveTypeProperties(c.model.store, id, view);
  const entity = c.model.bim.entity({ modelId: c.model.id, expressId: id }); if (!entity) throw new Error('Native entity is no longer available.');
  return { properties, inherited, IfcClass: entity.type };
}
export const propertyInspectorOperations = [
  operation<{ express_id: number }>(meta('properties.inherited.read', 'Read native occurrence and inherited type property sets, with an exact snapshot for lossless occurrence overrides.'), {
    type: 'object', properties: { express_id: { type: 'integer', minimum: 1 } }, required: ['express_id'], additionalProperties: false,
  }, async (i, c) => { const value = await inspect(c, i.express_id); return out({ ...value, expected_properties: JSON.stringify(value) }); }),
  operation<{ express_id: number; pset: string; properties: Array<{ name: string; value: string | number | boolean; type: PropertyValueType }>; expected_properties: string }>(meta('properties.add', 'Add native scalar properties using the exact Properties/bSDD shared handler. Inherited-only sets carry forward their type values; non-copyable complex or explicitly-unitized inherited values are refused. One native transaction/Undo.', true), {
    type: 'object', properties: { express_id: { type: 'integer', minimum: 1 }, pset: { type: 'string', minLength: 1, maxLength: 200 }, expected_properties: { type: 'string', maxLength: 1000000 }, properties: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 }, value: { anyOf: [{ type: 'string', maxLength: 20000 }, { type: 'number' }, { type: 'boolean' }] }, type: { type: 'integer', enum: [0, 1, 2, 3, 4, 5, 6, 7] },
    }, required: ['name', 'value', 'type'], additionalProperties: false } } }, required: ['express_id', 'pset', 'properties', 'expected_properties'], additionalProperties: false,
  }, async (i, c) => {
    const [{ addToPropertySet }, { runInspectorEdit }] = await Promise.all([import('@/lib/properties/add-to-property-set'), import('@/components/viewer/model-inspector/inspector-edits')]); const value = await inspect(c, i.express_id);
    if (JSON.stringify(value) !== i.expected_properties) throw new Error('Occurrence/type properties changed. Inspect again.');
    const names = new Set<string>(); for (const p of i.properties) { if (names.has(p.name)) throw new Error('Duplicate property.'); names.add(p.name);
      if ((p.type === 1 || p.type === 2) ? typeof p.value !== 'number' || (p.type === 2 && !Number.isInteger(p.value)) : (p.type === 3 || p.type === 4) ? typeof p.value !== 'boolean' : typeof p.value !== 'string') throw new Error('Scalar value does not match the supplied native property type.');
    }
    const inheritedFrom = value.inherited && !value.IfcClass.endsWith('Type') ? { typeId: value.inherited.typeId, typeName: value.inherited.typeName, psetNames: value.inherited.psets.map(p => p.name).filter(name => !value.properties.some(p => p.name === name)) } : null;
    const ok = c.commit(() => runInspectorEdit(c.model.id, tx => { const result = addToPropertySet(tx.store, { modelId: c.model.id, entityId: i.express_id, existingPsets: value.properties.map(p => p.name), inheritedFrom }, i.pset, i.properties);
      if (!result.ok) throw new Error(`Native inherited property refusal: ${result.uncopyable.join(', ')}`); return [];
    })); if (!ok) throw new Error('The native property transaction refused this add.'); return out({ added: i.properties.length });
  }),
  operation<{ express_id: number; IfcClass: string; PredefinedType: string; expected_class: string }>(meta('properties.reassignClass', 'Reassign the exact element IFC class/PredefinedType using the native Properties writer inside one rollback-capable transaction. expected_class guards against a concurrent retype; native keyword/export constraints remain authoritative.', true), {
    type: 'object', properties: { express_id: { type: 'integer', minimum: 1 }, IfcClass: { type: 'string', pattern: '^Ifc[A-Za-z][A-Za-z0-9_]*$', maxLength: 200 }, PredefinedType: { type: 'string', maxLength: 100 }, expected_class: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['express_id', 'IfcClass', 'PredefinedType', 'expected_class'], additionalProperties: false,
  }, async (i, c) => { const { runInspectorEdit } = await import('@/components/viewer/model-inspector/inspector-edits'); resolveRef(c.model, { express_id: i.express_id }); assertToolActive(c);
    if (c.model.bim.entity({ modelId: c.model.id, expressId: i.express_id })?.type !== i.expected_class) throw new Error('IFC class changed. Inspect again.');
    const ok = c.commit(() => runInspectorEdit(c.model.id, tx => { if (!tx.store.setEntityType(c.model.id, i.express_id, i.IfcClass, i.PredefinedType || null)) throw new Error('Native retype refused.'); return []; }));
    if (!ok) throw new Error('The native retype transaction refused this change.'); return out({ IfcClass: i.IfcClass, express_id: i.express_id });
  }),
];
