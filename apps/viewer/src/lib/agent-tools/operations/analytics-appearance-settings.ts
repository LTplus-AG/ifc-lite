/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { decodeAppearanceScope } from '@/lib/appearance/draft-scope';
import { settingsSchema, type Settings } from './analytics-appearance';
import { operation } from './contract';
import { metadata, idSchema, checkpoint } from './analytics-common';
export const analyticsAppearanceSettingOperations = [
  operation<{ source_id: string; scope_json: string; settings: Settings; preview_enabled: boolean }>(metadata('appearance.configureDraft', 'appearance', 'Configure the native source/model/selection/class/type/Rules-filter scope and every UV/planar/box mapping setting in the same saved draft consumed by the panel. preview_enabled requests native auto-preview; use appearance.preview to await an immutable candidate.', ['configuration', 'view'], {
    type: 'object', properties: { model_id: { type: 'string' }, source_id: { type: 'string' }, scope: { type: 'object' }, settings: { type: 'object' }, preview_enabled: { type: 'boolean' } }, required: ['model_id', 'source_id', 'scope', 'settings', 'preview_enabled'], additionalProperties: false,
  }), {
    type: 'object', properties: { source_id: idSchema.properties.id, scope_json: { type: 'string', minLength: 2, maxLength: 200000 }, settings: settingsSchema, preview_enabled: { type: 'boolean' } }, required: ['source_id', 'scope_json', 'settings', 'preview_enabled'], additionalProperties: false,
  } satisfies JSONSchemaType<{ source_id: string; scope_json: string; settings: Settings; preview_enabled: boolean }>, (i, c) => {
    const scope = decodeAppearanceScope(JSON.parse(i.scope_json));
    if (!useViewerStore.getState().appearanceSources.some(source => source.id === i.source_id)) throw new Error('Unknown native appearance source.');
    checkpoint(c); c.commit(() => { const s = useViewerStore.getState(); s.saveAppearanceDraft({ intent: s.appearanceDraft?.intent ?? 'apply', modelId: c.model.id, sourceId: i.source_id, scope, settings: i.settings, previewEnabled: i.preview_enabled }); });
    return { model_id: c.model.id, source_id: i.source_id, scope, settings: i.settings, preview_enabled: i.preview_enabled };
  }),
];
