/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcAttributeValue, StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { structuralGraph } from './_structural-graph.js';

/** Exact EXPRESS attribute names in the model's schema. Geometry and owned
 * references are deliberately excluded: use the builders for new geometry. */
export type StructuralEntityEdit = Readonly<Record<string, string | number | boolean | null | readonly number[]>>;

/** Schema-aware scalar edits, committed together or not at all. */
export function editStructuralEntityInStore(store: IfcDataStore, editor: StoreEditor, expressId: number, patch: StructuralEntityEdit): void {
  const graph = structuralGraph(store, editor);
  const record = graph.requireStructural(expressId);
  const attributes = graph.meta(record.type)?.allAttributes ?? [];
  const effective = [...record.attributes];
  const writes: [number, IfcAttributeValue][] = [];
  for (const [name, value] of Object.entries(patch)) {
    const index = attributes.findIndex(a => a.name === name);
    const attr = attributes[index];
    if (!attr || name === 'GlobalId' || name === 'OwnerHistory'
      || (graph.registry.entities[attr.type] || graph.registry.selects[attr.type])
        && !name.includes('Stiffness') && !['RelatingElement', 'RelatingStructuralMember'].includes(name)) {
      throw new Error(`editStructuralEntity: ${record.type}.${name} is not an editable value attribute`);
    }
    const aggregate = attr.isArray || attr.isList || attr.isSet;
    let encoded: IfcAttributeValue;
    if (value === null) {
      if (!attr.optional) throw new Error(`editStructuralEntity: ${name} is required`);
      encoded = null;
    } else if (['RelatingElement', 'RelatingStructuralMember'].includes(name)) {
      const ids = Array.isArray(value) ? value : [value];
      if (ids.length === 0 || !aggregate && ids.length !== 1 || ids.some(id => {
        if (typeof id !== 'number') return true;
        const target = graph.records.get(id);
        const type = target && graph.meta(target.type);
        const allowed = graph.registry.selects[attr.type] ?? [attr.type];
        return !type || !allowed.some(t => type.name === t || type.inheritanceChain?.includes(t));
      })) throw new Error(`editStructuralEntity: ${name} requires live ${attr.type} references`);
      encoded = aggregate ? ids.map(id => `#${id}`) : `#${ids[0]}`;
    } else if (name.includes('Stiffness')) {
      if (typeof value !== 'boolean' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
        throw new Error(`editStructuralEntity: ${name} must be a finite nonnegative stiffness or boolean`);
      }
      const measure = graph.registry.selects[attr.type]?.find(t => t !== 'IfcBoolean');
      encoded = graph.schema === 'IFC2X3'
        ? { real: typeof value === 'boolean' ? value ? -1 : 0 : value }
        : { typed: { type: typeof value === 'boolean' ? 'IfcBoolean' : measure!, value } };
    } else if (graph.registry.enums[attr.type]) {
      if (typeof value !== 'string' || !graph.registry.enums[attr.type].includes(value)) {
        throw new Error(`editStructuralEntity: invalid ${name}: ${String(value)}`);
      }
      encoded = `.${value}.`;
    } else if (aggregate) {
      if (name !== 'SelfWeightCoefficients' || !Array.isArray(value) || value.length !== 3 || value.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
        throw new Error(`editStructuralEntity: ${name} requires three finite coefficients`);
      }
      encoded = [...value];
    } else {
      const underlying = graph.registry.types[attr.type] ?? attr.type;
      if (/^(REAL|NUMBER|INTEGER)|Measure$/.test(underlying) || attr.type.endsWith('Measure')) {
        if (typeof value !== 'number' || !Number.isFinite(value) || (name === 'Thickness' && value <= 0)) {
          throw new Error(`editStructuralEntity: ${name} requires a finite${name === 'Thickness' ? ' positive' : ''} number`);
        }
        encoded = { real: value };
      } else if (attr.type === 'IfcBoolean' || underlying === 'BOOLEAN') {
        if (typeof value !== 'boolean') throw new Error(`editStructuralEntity: ${name} requires a boolean`);
        encoded = value;
      } else {
        if (typeof value !== 'string') throw new Error(`editStructuralEntity: ${name} requires a string`);
        if (/^#\d+$|^\.[A-Za-z_]+\.$|^'.*'$/s.test(value)) {
          throw new Error(`editStructuralEntity: ${name} must be plain text, not a STEP token`);
        }
        encoded = value;
      }
    }
    effective[index] = encoded;
    writes.push([index, encoded]);
  }
  if (record.type.startsWith('IfcStructuralLoad') && !record.type.endsWith('Group') && !record.type.endsWith('Case')
    && !attributes.some((a, i) => a.name !== 'Name' && effective[i] != null)) {
    throw new Error('editStructuralEntity: supply at least one load component');
  }
  const objectType = attributes.findIndex(a => a.name === 'ObjectType');
  if (attributes.some((a, i) => graph.registry.enums[a.type] && effective[i] === '.USERDEFINED.')
    && objectType >= 0 && !effective[objectType]) throw new Error('editStructuralEntity: USERDEFINED requires ObjectType');
  if (record.type === 'IfcStructuralLoadCase' && effective[5] !== '.LOAD_CASE.') {
    throw new Error('editStructuralEntity: IfcStructuralLoadCase requires LOAD_CASE');
  }
  editor.runAtomic(draft => {
    for (const [index, value] of writes) draft.setPositionalAttribute(expressId, index, value);
  });
}
