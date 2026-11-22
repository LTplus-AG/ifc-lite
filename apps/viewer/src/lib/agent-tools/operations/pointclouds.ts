/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { viewerOperation as operation, emptySchema } from './contract';
import { unavailable } from './refusals';
const metadata = (id: string, description: string) => ({
  id, owner: 'pointclouds', description, effects: ['view'] as const,
  capability: 'commands-and-edits' as const, synchronous: true, implementation: 'native-store' as const,
});
function inspect() {
  const s = useViewerStore.getState();
  return { colorMode: s.pointCloudColorMode, sizeMode: s.pointCloudSizeMode, pointSize: s.pointCloudPointSize,
    worldRadius: s.pointCloudWorldRadius, roundShape: s.pointCloudRoundShape, edlEnabled: s.pointCloudEdlEnabled,
    edlStrength: s.pointCloudEdlStrength, classMask: s.pointCloudClassMask, classCounts: s.pointCloudClassCounts,
    deviationComputed: s.pointCloudDeviationComputed, deviationStatistics: s.pointCloudDeviationStatistics,
    deviationRevision: s.pointCloudDeviationRevision };
}
export const pointCloudOperations = [
  operation({ ...metadata('pointclouds.read', 'Read effective point-cloud display, class counts and deviation diagnostics.'), effects: ['read'], capability: 'read' }, emptySchema, inspect),
  operation<{ mode: 'rgb' | 'classification' | 'intensity' | 'height' | 'fixed' | 'deviation' }>(metadata('pointclouds.colorMode', 'Set a native point-cloud color mode; deviation requires a completed native deviation computation.'), {
    type: 'object', properties: { mode: { type: 'string', enum: ['rgb', 'classification', 'intensity', 'height', 'fixed', 'deviation'] } },
    required: ['mode'], additionalProperties: false,
  } satisfies JSONSchemaType<{ mode: 'rgb' | 'classification' | 'intensity' | 'height' | 'fixed' | 'deviation' }>, i => {
    const s = useViewerStore.getState();
    if (i.mode === 'deviation' && !s.pointCloudDeviationComputed) throw unavailable('Compute deviation through the native analysis first.');
    s.setPointCloudColorMode(i.mode); return inspect();
  }),
  operation<{ pixels: number }>(metadata('pointclouds.pointSize', 'Set native point-cloud point size in pixels.'), {
    type: 'object', properties: { pixels: { type: 'number', minimum: 1, maximum: 20 } }, required: ['pixels'], additionalProperties: false,
  } satisfies JSONSchemaType<{ pixels: number }>, i => { useViewerStore.getState().setPointCloudPointSize(i.pixels); return inspect(); }),
  operation<{ metres: number }>(metadata('pointclouds.worldRadius', 'Set native point-cloud world radius in metres.'), {
    type: 'object', properties: { metres: { type: 'number', exclusiveMinimum: 0, maximum: 1 } }, required: ['metres'], additionalProperties: false,
  } satisfies JSONSchemaType<{ metres: number }>, i => { useViewerStore.getState().setPointCloudWorldRadius(i.metres); return inspect(); }),
  operation<{ enabled: boolean }>(metadata('pointclouds.edl', 'Enable or disable native eye-dome lighting.'), {
    type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'], additionalProperties: false,
  } satisfies JSONSchemaType<{ enabled: boolean }>, i => { useViewerStore.getState().setPointCloudEdlEnabled(i.enabled); return inspect(); }),
  operation<{ words: number[] }>(metadata('pointclouds.classMask', 'Replace all 256 native LAS class visibility bits as eight unsigned 32-bit words.'), {
    type: 'object', properties: { words: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 4294967295 }, minItems: 8, maxItems: 8 } },
    required: ['words'], additionalProperties: false,
  } satisfies JSONSchemaType<{ words: number[] }>, i => { useViewerStore.getState().setPointCloudClassMask(i.words); return inspect(); }),
];
