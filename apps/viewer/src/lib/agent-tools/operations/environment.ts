/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { viewerOperation as operation, emptySchema } from './contract';

const metadata = (id: string, description: string) => ({
  id, owner: 'environment', description, effects: ['configuration', 'view'] as const,
  capability: 'commands-and-edits' as const, synchronous: true, implementation: 'native-store' as const,
});
function inspect() {
  const s = useViewerStore.getState();
  return { preset: s.envPreset, skyEnabled: s.envSkyEnabled, exposure: s.envExposure,
    hardness: s.envHardness, softness: s.envSoftness, shadowsEnabled: s.envShadowsEnabled,
    sunAngle: s.envSunAngle, shadowResolution: s.envShadowResolution,
    sunTimeEnabled: s.envSunTimeEnabled, sunTime: s.envSunTime };
}
const numberSetting = (id: string, description: string, minimum: number, maximum: number, apply: (value: number) => void) =>
  operation<{ value: number }>(metadata(id, description), {
    type: 'object', properties: { value: { type: 'number', minimum, maximum } }, required: ['value'], additionalProperties: false,
  } satisfies JSONSchemaType<{ value: number }>, i => { apply(i.value); return inspect(); });
const booleanSetting = (id: string, description: string, apply: (value: boolean) => void) =>
  operation<{ value: boolean }>(metadata(id, description), {
    type: 'object', properties: { value: { type: 'boolean' } }, required: ['value'], additionalProperties: false,
  } satisfies JSONSchemaType<{ value: boolean }>, i => { apply(i.value); return inspect(); });

export const environmentOperations = [
  operation({ ...metadata('environment.read', 'Read effective lighting and solar settings.'), effects: ['read'], capability: 'read' }, emptySchema, inspect),
  numberSetting('environment.exposure', 'Set lighting exposure.', 0.4, 2, v => useViewerStore.getState().setEnvExposure(v)),
  numberSetting('environment.hardness', 'Set lighting hardness.', 0.5, 2, v => useViewerStore.getState().setEnvHardness(v)),
  numberSetting('environment.softness', 'Set lighting softness.', 0, 2, v => useViewerStore.getState().setEnvSoftness(v)),
  numberSetting('environment.sunAngle', 'Set sun angular diameter in degrees.', 0.1, 5, v => useViewerStore.getState().setEnvSunAngle(v)),
  numberSetting('environment.sunTime', 'Set solar time in hours.', 6, 18, v => useViewerStore.getState().setEnvSunTime(v)),
  booleanSetting('environment.sky', 'Enable or disable the sky.', v => useViewerStore.getState().setEnvSkyEnabled(v)),
  booleanSetting('environment.shadows', 'Enable or disable shadows.', v => useViewerStore.getState().setEnvShadowsEnabled(v)),
  booleanSetting('environment.sunTimeEnabled', 'Enable or disable time-driven solar lighting.', v => useViewerStore.getState().setEnvSunTimeEnabled(v)),
];
