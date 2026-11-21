/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { viewerOperation, operation } from './contract';
import { assertToolActive } from '../cancellation';
import { bsddTools } from '../bsdd-tools';
import { internal } from './refusals';
const outputSchema = { type: 'object', properties: { native_json: { type: 'string' }, text: { type: 'string' } }, required: ['native_json', 'text'], additionalProperties: false };
const meta = (id: string, description: string) => ({ id, owner: 'properties', description: `${description} Uses the host's native bSDD provider and its rate-limit/error contract. Requests send search terms/class names, never IFC model content. Cancellation suppresses the result; the provider's admitted HTTP call may settle.`, features: ['privacy.third-party'] as const, effects: ['network'] as const, capability: 'commands-and-edits' as const, implementation: 'sdk' as const, outputSchema, policy: { network: 'native-provider' as const } });
export const bsddOperations = [
  viewerOperation<{ query: string }>(meta('properties.bsdd.search', 'Search live bSDD classes/dictionaries using the canonical native provider.'), {
    type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['query'], additionalProperties: false,
  }, async (i, c) => { const tool = bsddTools.bsdd_search; if (tool.needs !== 'none') throw internal('Native bSDD search contract changed.'); const result = await tool.run(c.host, i, c); assertToolActive(c); return { native_json: JSON.stringify(result.structured ?? null), text: result.text }; }),
  ...(['class', 'property_sets'] as const).map(kind => viewerOperation<{ ifc_type: string }>(meta(`properties.bsdd.${kind}`, kind === 'class' ? 'Inspect a canonical bSDD class and its property definitions, allowed values and units.' : 'Inspect complete canonical bSDD property-set groups for a class.'), {
    type: 'object', properties: { ifc_type: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['ifc_type'], additionalProperties: false,
  }, async (i, c) => { const tool = kind === 'class' ? bsddTools.bsdd_class : bsddTools.bsdd_property_sets; if (tool.needs !== 'none') throw internal('Native bSDD lookup contract changed.'); const result = await tool.run(c.host, i, c); assertToolActive(c); return { native_json: JSON.stringify(result.structured ?? null), text: result.text }; })),
  operation<{ express_id: number }>(meta('properties.bsdd.match', 'Find bSDD classification candidates for the validated model-qualified entity class through the existing native matching service.'), {
    type: 'object', properties: { express_id: { type: 'integer', minimum: 1 } }, required: ['express_id'], additionalProperties: false,
  }, async (i, c) => { const tool = bsddTools.bsdd_match; if (tool.needs === 'none') throw internal('Native bSDD matching contract changed.'); const result = await tool.run(c.host, c.model, i, c); assertToolActive(c); return { native_json: JSON.stringify(result.structured ?? null), text: result.text }; }),
];
