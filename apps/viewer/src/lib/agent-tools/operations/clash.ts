/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { JSONSchemaType } from 'ajv';
import type { ClashRule } from '@ifc-lite/sdk';
import { operation } from './contract';

interface ClashInput {
  rules: Array<{ id: string; name: string; a: string; b: string; mode: 'hard' | 'clearance'; tolerance: number; clearance: number }>;
}
const schema: JSONSchemaType<ClashInput> = {
  type: 'object', properties: { rules: { type: 'array', minItems: 1, maxItems: 100, items: {
    type: 'object', properties: {
      id: { type: 'string', minLength: 1, maxLength: 100 }, name: { type: 'string', minLength: 1, maxLength: 200 },
      a: { type: 'string', minLength: 1, maxLength: 500 }, b: { type: 'string', minLength: 1, maxLength: 500 },
      mode: { type: 'string', enum: ['hard', 'clearance'] }, tolerance: { type: 'number', minimum: 0, maximum: 10 },
      clearance: { type: 'number', minimum: 0, maximum: 10 },
    }, required: ['id', 'name', 'a', 'b', 'mode', 'tolerance', 'clearance'], additionalProperties: false,
  } } }, required: ['rules'], additionalProperties: false,
};
export const clashOperations = [operation<ClashInput>({
  id: 'clash.analyze', owner: 'clash', description: 'Run parameterized clash rules against live native geometry of the selected model. Uses the panel geometry collector (including instanced occurrences and exclusions) and SDK engine. Selectors are IFC type globs. Returns an analysis result without replacing the panel report or its visibility. Background execution supports cancellation.',
  effects: ['read'], capability: 'read', implementation: 'sdk',
}, schema, async (input, c) => {
  const [{ gatherClashElements }, { federationIsCurrent }, { jobPlacementIsCurrent }, { useViewerStore }] = await Promise.all([
    import('@/lib/clash/gather-elements'), import('@/lib/federation/federation-identity'),
    import('@/lib/model-placement/placement-snapshot'), import('@/store'),
  ]);
  c.checkpoint?.();
  // Released CPU geometry (#10264) is read back first; resident geometry is unchanged.
  const { withReleasedExportGeometry } = await import('@/utils/instancedExport');
  const gathered = await withReleasedExportGeometry((context) => gatherClashElements(new Set([c.model.id]), context), [c.model.id]);
  if (!gathered.elements.length) throw new Error('No native mesh geometry is loaded for this model.');
  const rules: ClashRule[] = input.rules;
  if (new Set(rules.map(rule => rule.id)).size !== rules.length) throw new Error('Clash rule IDs must be unique.');
  const result = await c.model.bim.clash.run(gathered.elements, rules, { signal: c.signal, exclusions: gathered.exclusions, onProgress: progress => c.progress?.({ phase: progress.phase, done: progress.done, total: progress.total }) });
  c.checkpoint?.();
  const state = useViewerStore.getState();
  if (!federationIsCurrent(gathered.federationIdentity, state.models) || !jobPlacementIsCurrent(gathered.federationIdentity, state)) {
    throw new Error('Geometry or placement changed during clash analysis. Discarded result.');
  }
  return { result, groups: c.model.bim.clash.group(result), model_id: c.model.id };
})];
