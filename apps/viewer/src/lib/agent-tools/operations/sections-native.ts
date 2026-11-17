/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import type { SectionCapStyle } from '@/store/types';
import { useViewerStore } from '@/store';
import { isToolAvailable } from '@/lib/features/tools';
import { viewerOperation, emptySchema, pointSchema } from './contract';
const outputSchema = { type: 'object', properties: { native_json: { type: 'string' } }, required: ['native_json'], additionalProperties: false };
function snapshot() {
  const s = useViewerStore.getState();
  return { native_json: JSON.stringify({ active: s.sectionPlane, inactive: s.inactiveSectionPlanes, undo: s.sectionUndo }) };
}
function change<T>(id: string, description: string, schema: JSONSchemaType<T>, action: (input: T) => void) {
  return viewerOperation({ id, owner: 'viewport', description: `${description} Coordinates are renderer Y-up metres. Uses native section actions and undo ownership.`,
    features: ['tools.section'], effects: ['view'], capability: 'commands-and-edits', implementation: 'native-store', synchronous: true, outputSchema }, schema, input => {
    if (!isToolAvailable('section')) throw new Error('Section tools are disabled by the host.');
    action(input); return snapshot();
  });
}
const rgba = { type: 'array', items: { type: 'number', minimum: 0, maximum: 1 }, minItems: 4, maxItems: 4, nullable: true };
const capSchema = { type: 'object', properties: {
  fillColor: rgba, strokeColor: rgba,
  pattern: { type: 'string', enum: ['solid', 'diagonal', 'crossHatch', 'horizontal', 'vertical', 'concrete', 'brick', 'insulation'], nullable: true },
  fillMode: { type: 'string', enum: ['uniform', 'element'], nullable: true },
  spacingPx: { type: 'number', minimum: 2, maximum: 1000, nullable: true },
  angleRad: { type: 'number', nullable: true }, secondaryAngleRad: { type: 'number', nullable: true },
  widthPx: { type: 'number', minimum: 1, maximum: 100, nullable: true },
}, required: [], additionalProperties: false } as unknown as JSONSchemaType<Partial<SectionCapStyle>>;
export const nativeSectionOperations = [
  viewerOperation({ id: 'section.nativeState', owner: 'viewport', description: 'Read native cardinal/custom/box cuts, named planes, cap appearance, gizmos and pending Undo state. native_json follows the native SectionPlane snapshot.', features: ['tools.section'], effects: ['read'], capability: 'read', implementation: 'native-store', outputSchema }, emptySchema, snapshot),
  change<{ min: [number, number, number]; max: [number, number, number] }>('section.box', 'Install a numerical native section box, replacing the custom-plane mode.', {
    type: 'object', properties: { min: pointSchema, max: pointSchema }, required: ['min', 'max'], additionalProperties: false,
  }, i => {
    if (i.min.some((value, index) => value >= i.max[index] || !Number.isFinite(i.max[index] - value))) throw new Error('Every box minimum must be below its maximum.');
    useViewerStore.getState().setSectionBox(i);
  }),
  change<{ normal: [number, number, number]; point: [number, number, number] }>('section.facePlane', 'Install a numerical face plane through the native face-pick commit policy, including its native inset and kept-side semantics.', {
    type: 'object', properties: { normal: pointSchema, point: pointSchema }, required: ['normal', 'point'], additionalProperties: false,
  }, i => {
    const length = Math.hypot(...i.normal);
    if (!Number.isFinite(length) || length < 1e-6) throw new Error('Face normal must have a finite nonzero magnitude.');
    if (!Number.isFinite(i.normal.reduce((sum, value, index) => sum + value / length * i.point[index], 0))) throw new Error('Plane distance exceeds the finite coordinate range.');
    useViewerStore.getState().setSectionPlaneFromFace(i.normal, i.point);
  }),
  change<{ distance: number }>('section.customDistance', 'Move the current native custom plane by its signed distance. Refuses cardinal/box mode.', {
    type: 'object', properties: { distance: { type: 'number' } }, required: ['distance'], additionalProperties: false,
  }, i => {
    if (Math.abs(i.distance) > 1e9) throw new Error('distance must be within ±1e9 metres, like section.box coordinates.');
    const s = useViewerStore.getState(); if (!s.sectionPlane.custom) throw new Error('No active custom plane.');
    s.setSectionCustomDistance(i.distance);
  }),
  change<{ id: string; action: 'activate' | 'rename' | 'duplicate' | 'cutting' | 'gizmo'; name?: string; enabled?: boolean }>('section.managePlane', 'Activate, rename, duplicate, enable cutting or show the gizmo of one exact existing native plane.', {
    type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 200 }, action: { type: 'string', enum: ['activate', 'rename', 'duplicate', 'cutting', 'gizmo'] }, name: { type: 'string', minLength: 1, maxLength: 200, nullable: true }, enabled: { type: 'boolean', nullable: true } }, required: ['id', 'action'], additionalProperties: false,
  }, i => {
    const s = useViewerStore.getState();
    if (![s.sectionPlane, ...s.inactiveSectionPlanes].some(plane => plane.id === i.id)) throw new Error('Unknown native plane.');
    if (i.name === null || i.enabled === null) throw new Error('Plane values cannot be null.');
    switch (i.action) {
      case 'activate': s.activateSectionPlane(i.id); break;
      case 'rename': if (!i.name?.trim()) throw new Error('Name is required.'); s.renameSectionPlane(i.id, i.name); break;
      case 'duplicate': if (!s.duplicateSectionPlane(i.id)) throw new Error('Native plane limit reached.'); break;
      case 'cutting': if (typeof i.enabled !== 'boolean') throw new Error('enabled is required.'); s.setSectionPlaneCutting(i.id, i.enabled); break;
      case 'gizmo': if (typeof i.enabled !== 'boolean') throw new Error('enabled is required.'); s.setSectionPlaneShowGizmo(i.id, i.enabled); break;
    }
  }),
  change('section.capStyle', 'Patch the native cut-cap appearance through its shared persisted style action. Browser persistence is best effort.', capSchema, i => {
    if (Object.values(i).some(value => value === null)) throw new Error('Cap fields cannot be null.');
    useViewerStore.getState().setSectionCapStyle(i);
  }),
  change<{ cap: boolean; outlines: boolean }>('section.display', 'Set native cap and outline visibility.', {
    type: 'object', properties: { cap: { type: 'boolean' }, outlines: { type: 'boolean' } }, required: ['cap', 'outlines'], additionalProperties: false,
  }, i => { const s = useViewerStore.getState(); s.setSectionShowCap(i.cap); s.setSectionShowOutlines(i.outlines); }),
  change<{ action: 'undo' | 'dismiss' | 'clear' }>('section.history', 'Undo/dismiss the native last section change or clear cutting planes through native history.', {
    type: 'object', properties: { action: { type: 'string', enum: ['undo', 'dismiss', 'clear'] } }, required: ['action'], additionalProperties: false,
  }, i => { const s = useViewerStore.getState(); if (i.action === 'undo') s.undoSectionChange(); else if (i.action === 'dismiss') s.dismissSectionUndo(); else s.clearSectionPlanes(); }),
];
