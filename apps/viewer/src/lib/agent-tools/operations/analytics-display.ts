/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { viewerOperation } from './contract';
import { metadata, checkpoint } from './analytics-common';
const output = { type: 'object', properties: { applied: { type: 'boolean' } }, required: ['applied'], additionalProperties: false };
export const analyticsDisplayOperations = [
  viewerOperation<{ preset: 'default' | 'daylight' | 'overcast' | 'golden' | 'night'; shadow_resolution: 512 | 1024 | 2048 | 4096 }>(metadata('environment.configurePreset', 'environment', 'Apply the native lighting preset (including its solar angle seed) and shadow map resolution.', ['configuration', 'view'], output), {
    type: 'object', properties: { preset: { type: 'string', enum: ['default', 'daylight', 'overcast', 'golden', 'night'] }, shadow_resolution: { type: 'integer', enum: [512, 1024, 2048, 4096] } }, required: ['preset', 'shadow_resolution'], additionalProperties: false,
  } satisfies JSONSchemaType<{ preset: 'default' | 'daylight' | 'overcast' | 'golden' | 'night'; shadow_resolution: 512 | 1024 | 2048 | 4096 }>, (i, c) => { checkpoint(c); c.commit(() => { const s = useViewerStore.getState(); s.setEnvPreset(i.preset); s.setEnvShadowResolution(i.shadow_resolution); }); return { applied: true }; }),
  viewerOperation<{ rgba: [number, number, number, number] }>(metadata('pointclouds.fixedColor', 'pointclouds', 'Set the native fixed RGBA point color; each channel is in [0,1].', ['configuration', 'view'], output), {
    type: 'object', properties: { rgba: { type: 'array', items: [{ type: 'number', minimum: 0, maximum: 1 }, { type: 'number', minimum: 0, maximum: 1 }, { type: 'number', minimum: 0, maximum: 1 }, { type: 'number', minimum: 0, maximum: 1 }], minItems: 4, maxItems: 4 } }, required: ['rgba'], additionalProperties: false,
  } satisfies JSONSchemaType<{ rgba: [number, number, number, number] }>, (i, c) => { checkpoint(c); c.commit(() => useViewerStore.getState().setPointCloudFixedColor(i.rgba)); return { applied: true }; }),
  viewerOperation<{ size_mode: 'fixed-px' | 'adaptive-world' | 'attenuated'; round: boolean; edl_strength: number; preview_stride: number; alignment: boolean; deviation_center: number; deviation_half_range: number }>(metadata('pointclouds.configureDisplay', 'pointclouds', 'Configure all remaining native point sizing, EDL, preview decimation, alignment and deviation-ramp controls. Refuses unavailable CRS alignment.', ['configuration', 'view'], output), {
    type: 'object', properties: { size_mode: { type: 'string', enum: ['fixed-px', 'adaptive-world', 'attenuated'] }, round: { type: 'boolean' }, edl_strength: { type: 'number', minimum: 0, maximum: 3 }, preview_stride: { type: 'integer', minimum: 1, maximum: 100 }, alignment: { type: 'boolean' }, deviation_center: { type: 'number', minimum: -1000, maximum: 1000 }, deviation_half_range: { type: 'number', minimum: 0.0001, maximum: 1000 } }, required: ['size_mode', 'round', 'edl_strength', 'preview_stride', 'alignment', 'deviation_center', 'deviation_half_range'], additionalProperties: false,
  } satisfies JSONSchemaType<{ size_mode: 'fixed-px' | 'adaptive-world' | 'attenuated'; round: boolean; edl_strength: number; preview_stride: number; alignment: boolean; deviation_center: number; deviation_half_range: number }>, (i, c) => {
    const s = useViewerStore.getState();
    if (i.alignment && !s.pointCloudAlignmentAvailable) throw new Error('No native point-cloud CRS alignment is available.');
    checkpoint(c); c.commit(() => { s.setPointCloudSizeMode(i.size_mode); s.setPointCloudRoundShape(i.round); s.setPointCloudEdlStrength(i.edl_strength); s.setPointCloudPreviewStride(i.preview_stride); s.setPointCloudAlignmentEnabled(i.alignment); s.setPointCloudDeviationCenterOffset(i.deviation_center); s.setPointCloudDeviationHalfRange(i.deviation_half_range); }); return { applied: true };
  }),
];
