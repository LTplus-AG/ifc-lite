/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { resolvePresentationIds } from '@/lib/presentation/resolvePresentationIds';
import { useViewerStore } from '@/store';
import { currentNativeLensRuleId, discoverNativeLensData, isolateNativeLensRule } from '@/lib/lens/native-controls';
import { operation } from './contract';
import { metadata, checkpoint, idSchema } from './analytics-common';
export const analyticsLensControlOperations = [
  operation<{ properties: boolean; quantities: boolean; classifications: boolean; materials: boolean }>(metadata('lens.discover', 'lens', 'Complete native Lens picker discovery over the effective federation, including IFC classes and requested property/quantity/classification/material categories; publish the same lazy data as the panel.', ['read', 'configuration'], { type: 'object', properties: { data: { type: ['object', 'null'] } }, required: ['data'], additionalProperties: false }), {
    type: 'object', properties: { properties: { type: 'boolean' }, quantities: { type: 'boolean' }, classifications: { type: 'boolean' }, materials: { type: 'boolean' } }, required: ['properties', 'quantities', 'classifications', 'materials'], additionalProperties: false,
  } satisfies JSONSchemaType<{ properties: boolean; quantities: boolean; classifications: boolean; materials: boolean }>, (i, c) => { checkpoint(c);
    const data = c.commit(() => discoverNativeLensData(i));
    return { data: data && { ...data, propertySets: data.propertySets ? [...data.propertySets] : null,
      quantitySets: data.quantitySets ? [...data.quantitySets] : null } }; }),
  operation<{ id: string; expected_lens_id: string; action: 'select' | 'isolate' }>(metadata('lens.ruleMembers', 'lens', 'Select an evaluated rule/value membership or run the exact native rule-isolation toggle, preserving assembly expansion and ownership. Requires the active lens to match inspection; evaluate it first using lens.apply.', ['selection', 'view'], { type: 'object', properties: { matched: { type: 'integer' }, isolated_rule: { type: ['string', 'null'] } }, required: ['matched', 'isolated_rule'], additionalProperties: false }), {
    type: 'object', properties: { id: idSchema.properties.id, expected_lens_id: idSchema.properties.id, action: { type: 'string', enum: ['select', 'isolate'] } }, required: ['id', 'expected_lens_id', 'action'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; expected_lens_id: string; action: 'select' | 'isolate' }>, (i, c) => {
    const s = useViewerStore.getState(); if (s.activeLensId !== i.expected_lens_id) throw new Error('Active Lens changed since inspection.');
    const ids = s.lensRuleEntityIds.get(i.id); if (!ids) throw new Error('Unknown evaluated native rule/value.');
    checkpoint(c); c.commit(() => { if (i.action === 'isolate') isolateNativeLensRule(i.id); else s.setSelectedEntityIds(resolvePresentationIds(s.cameraCallbacks?.resolveHighlightIds, ids)); });
    return { matched: ids.length, isolated_rule: currentNativeLensRuleId(useViewerStore.getState()) };
  }),
];
