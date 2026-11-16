/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { UNIT_ALTERNATIVES } from '@/lib/units/alternatives';
import { viewerOperation, emptySchema } from './contract';

function inspect() {
  const s = useViewerStore.getState();
  return { theme: s.theme, navigationPreset: s.navigationPreset, wheelZoomSensitivity: s.wheelZoomSensitivity,
    hoverTooltips: s.hoverTooltipsEnabled, performanceStats: s.showPerformanceStats, visualEnhancements: s.visualEnhancementsEnabled,
    centreline: s.centrelineOverlayEnabled, ribbonCollapsed: s.ribbonCollapsed, ribbonContext: s.ribbonContextualTabs,
    geometryMode: s.geometryMode, mergeLayers: s.mergeLayers, geometryPendingReload: s.geometryModePendingReload,
    mergeLayersPendingReload: s.mergeLayersPendingReload, unitOverrides: s.unitDisplayOverrides,
    persistence: 'native-browser-preferences-best-effort' };
}
const string = { type: 'string' }, boolean = { type: 'boolean' };
const outputSchema = { type: 'object', properties: {
  theme: string, navigationPreset: string, wheelZoomSensitivity: string, hoverTooltips: boolean, performanceStats: boolean,
  visualEnhancements: boolean, centreline: boolean, ribbonCollapsed: boolean, ribbonContext: boolean, geometryMode: string,
  mergeLayers: boolean, geometryPendingReload: boolean, mergeLayersPendingReload: boolean,
  unitOverrides: { type: 'object', additionalProperties: string }, persistence: string,
}, required: ['theme', 'navigationPreset', 'wheelZoomSensitivity', 'hoverTooltips', 'performanceStats', 'visualEnhancements', 'centreline', 'ribbonCollapsed', 'ribbonContext', 'geometryMode', 'mergeLayers', 'geometryPendingReload', 'mergeLayersPendingReload', 'unitOverrides', 'persistence'], additionalProperties: false };
const metadata = (id: string, description: string) => ({ id, owner: 'preferences', description,
  effects: ['configuration'] as const, capability: 'commands-and-edits' as const, implementation: 'native-store' as const, synchronous: true, outputSchema });
function choice<T extends string>(id: string, description: string, values: readonly T[], set: (value: T) => void) {
  const schema = { type: 'object', properties: { value: { type: 'string', enum: values } }, required: ['value'], additionalProperties: false } as unknown as JSONSchemaType<{ value: T }>;
  return viewerOperation(metadata(id, description), schema, i => { set(i.value); return inspect(); });
}
function flag(id: string, description: string, set: (value: boolean) => void) {
  return viewerOperation<{ value: boolean }>(metadata(id, description), {
    type: 'object', properties: { value: { type: 'boolean' } }, required: ['value'], additionalProperties: false,
  }, i => { set(i.value); return inspect(); });
}
export const preferenceOperations = [
  viewerOperation({ ...metadata('preferences.read', 'Read native viewer preferences and load-time reload requirements. Persistence is native browser best effort, not a durable project write.'), effects: ['read'], capability: 'read' }, emptySchema, inspect),
  choice('preferences.theme', 'Set the native display theme.', ['light', 'dark', 'colorful'] as const, v => useViewerStore.getState().setTheme(v)),
  choice('preferences.navigation', 'Set native mouse/trackpad navigation mapping.', ['default', 'navisworks', 'trackpad'] as const, v => useViewerStore.getState().setNavigationPreset(v)),
  choice('preferences.wheel', 'Set the native wheel zoom sensitivity.', ['slow', 'normal', 'fast'] as const, v => useViewerStore.getState().setWheelZoomSensitivity(v)),
  choice('preferences.geometry', 'Set load-time geometry fidelity. A loaded model is not remeshed by this preference; inspect pending reload flags.', ['fast', 'exact'] as const, v => useViewerStore.getState().setGeometryMode(v)),
  flag('preferences.mergeLayers', 'Set native multilayer merge preference; loaded geometry may require reload.', v => useViewerStore.getState().setMergeLayers(v)),
  flag('preferences.performanceStats', 'Show or hide native performance statistics.', v => useViewerStore.getState().setShowPerformanceStats(v)),
  flag('preferences.visualEnhancements', 'Set native visual enhancements.', v => useViewerStore.getState().setVisualEnhancementsEnabled(v)),
  flag('preferences.centreline', 'Set native centreline overlays.', v => useViewerStore.getState().setCentrelineOverlayEnabled(v)),
  flag('preferences.ribbonCollapsed', 'Set native ribbon folding.', v => useViewerStore.getState().setRibbonCollapsed(v)),
  flag('preferences.ribbonContext', 'Set native contextual ribbon following.', v => useViewerStore.getState().setRibbonContextualTabs(v)),
  flag('preferences.tooltips', 'Set hover tooltips through the native toggle only when its state differs.', v => {
    const s = useViewerStore.getState(); if (s.hoverTooltipsEnabled !== v) s.toggleHoverTooltips();
  }),
  viewerOperation({ ...metadata('preferences.unitOptions', 'Read the same curated IFC unit-type alternatives offered by native property display controls.'), effects: ['read'], capability: 'read', outputSchema: { type: 'object', additionalProperties: { type: 'array', items: { type: 'object' } } } }, emptySchema, () => UNIT_ALTERNATIVES),
  viewerOperation<{ unit_type: string; option_id: string | null }>(metadata('preferences.unitOverride', 'Set or clear a curated display-unit override. Does not change model values.'), {
    type: 'object', properties: { unit_type: { type: 'string', enum: Object.keys(UNIT_ALTERNATIVES) }, option_id: { anyOf: [{ type: 'string' }, { type: 'null', nullable: true }] } }, required: ['unit_type', 'option_id'], additionalProperties: false,
  } as unknown as JSONSchemaType<{ unit_type: string; option_id: string | null }>, i => {
    if (i.option_id !== null && !UNIT_ALTERNATIVES[i.unit_type].some(option => option.id === i.option_id)) throw new Error('The display unit is not an alternative for this IFC unit type.');
    useViewerStore.getState().setUnitDisplayOverride(i.unit_type, i.option_id); return inspect();
  }),
  viewerOperation(metadata('preferences.unitReset', 'Clear every native display-unit override.'), emptySchema, () => { useViewerStore.getState().resetUnitDisplayOverrides(); return inspect(); }),
];
