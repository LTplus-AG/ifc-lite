/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { operation, emptySchema, pointSchema, type OperationContext } from './contract';
import { assertToolActive } from '../cancellation';
import { isFeatureEnabled } from '@/lib/features';
import { mutationPermission } from '@/store/mutation-permission';

const outputSchema = { type: 'object', properties: { native_json: { type: 'string' } }, required: ['native_json'], additionalProperties: false };
const out = (value: unknown) => ({ native_json: JSON.stringify(value) });
const meta = (id: string, description: string, model = false) => ({ id, owner: 'placement', description, effects: model ? ['model'] as const : ['view', 'configuration'] as const,
  capability: 'commands-and-edits' as const, implementation: 'native-store' as const, outputSchema, policy: model ? { model: 'native-reviewed' as const } : undefined });
function gate(c: OperationContext) {
  assertToolActive(c); if (!isFeatureEnabled('edit.placement')) throw new Error('The host disabled model placement.');
}
function inspect() {
  const s = useViewerStore.getState();
  return { revision: s.modelPlacement.revision, placements: [...s.modelPlacement.placements], preview: s.modelPlacement.preview ? { ...s.modelPlacement.preview, before: [...s.modelPlacement.preview.before] } : null,
    canUndo: s.modelPlacement.undo.length > 0, canRedo: s.modelPlacement.redo.length > 0 };
}
function expected(value: number) { if (useViewerStore.getState().modelPlacement.revision !== value) throw new Error('The placement revision changed. Inspect again.'); }
type GeorefEditInput = { entity: 'mapConversion' | 'projectedCRS'; fields: Array<{ field: string; value: string | number; oldValue: string | number | null }> };
export const placementOperations = [
  operation({ ...meta('placement.read', 'Read native whole-model placements and the current numerical preview. Engineering coordinates are IFC Z-up metres; rotations are radians.'), effects: ['read'], capability: 'read' }, emptySchema, () => out(inspect())),
  operation<{ delta: [number, number, number]; model_ids?: string[] | null; placement_revision: number }>(meta('placement.translation.preview', 'Start an explicit native reposition session for the selected model or an explicit model_ids set and preview a numerical engineering Z-up metre translation. Refuses an existing interactive preview.'), {
    type: 'object', properties: { delta: pointSchema, model_ids: { type: 'array', nullable: true, minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1 } }, placement_revision: { type: 'integer', minimum: 0 } }, required: ['delta', 'placement_revision'], additionalProperties: false,
  }, (i, c) => { gate(c); expected(i.placement_revision); const s = useViewerStore.getState(); if (s.modelPlacement.preview) throw new Error('Finish or cancel the existing reposition preview first.');
    return out(c.commit(() => { const ids = i.model_ids ?? [c.model.id]; if (!ids.includes(c.model.id)) throw new Error('The operation model must be among the explicitly moved models.'); s.openReposition(ids); useViewerStore.getState().previewModelTranslation(i.delta); return inspect(); }));
  }),
  operation<{ placement_revision: number; action: 'apply' | 'cancel' | 'undo' | 'redo' | 'reset' }>(meta('placement.translation.action', 'Apply/cancel the exact current numerical preview, or use native placement undo/redo/reset. Preview must include the selected model. Undo/redo refuse history belonging to another model.'), {
    type: 'object', properties: { placement_revision: { type: 'integer', minimum: 0 }, action: { type: 'string', enum: ['apply', 'cancel', 'undo', 'redo', 'reset'] } }, required: ['placement_revision', 'action'], additionalProperties: false,
  }, (i, c) => { gate(c); expected(i.placement_revision); return out(c.commit(() => {
    const s = useViewerStore.getState(), preview = s.modelPlacement.preview;
    if ((i.action === 'apply' || i.action === 'cancel') && (!preview || !preview.modelIds.includes(c.model.id))) throw new Error('The current preview does not belong to this model.');
    if (i.action === 'undo' || i.action === 'redo') { const stack = i.action === 'undo' ? s.modelPlacement.undo : s.modelPlacement.redo; const command = stack.at(-1); if (command && !command.before.has(c.model.id)) throw new Error('The latest native placement command belongs to another model.'); }
    if (i.action === 'apply') s.applyModelTranslation(); else if (i.action === 'cancel') s.closeReposition();
    else if (i.action === 'undo') s.undoModelTranslation(); else if (i.action === 'redo') s.redoModelTranslation(); else s.resetModelTranslations([c.model.id]); return inspect();
  })); }),
  operation<{ angle: number; pivot: [number, number, number]; placement_revision: number }>(meta('placement.rotation', 'Set absolute native whole-model yaw in radians about an explicit engineering Z-up metre pivot; preserves native geometry/rotation refusals and placement history.'), {
    type: 'object', properties: { angle: { type: 'number', minimum: -1000, maximum: 1000 }, pivot: pointSchema, placement_revision: { type: 'integer', minimum: 0 } }, required: ['angle', 'pivot', 'placement_revision'], additionalProperties: false,
  }, (i, c) => { gate(c); expected(i.placement_revision); return out(c.commit(() => { useViewerStore.getState().setModelRotation([c.model.id], { angle: i.angle, pivot: i.pivot }); return inspect(); })); }),
  operation<{ locked: boolean; placement_revision: number }>(meta('placement.lock', 'Set the selected model’s native placement lock.'), {
    type: 'object', properties: { locked: { type: 'boolean' }, placement_revision: { type: 'integer', minimum: 0 } }, required: ['locked', 'placement_revision'], additionalProperties: false,
  }, (i, c) => { gate(c); expected(i.placement_revision); return out(c.commit(() => { useViewerStore.getState().setModelPositionLocked(c.model.id, i.locked); return inspect(); })); }),
  operation({ ...meta('georeference.read', 'Read native effective projected CRS and map conversion, including unsaved edits.'), effects: ['read'], capability: 'read' }, emptySchema, async (_, c) => {
    const { getEffectiveGeoreference } = await import('@/lib/geo/effective-georef'); assertToolActive(c);
    const model = useViewerStore.getState().models.get(c.model.id); return out(getEffectiveGeoreference(c.model.store, model?.geometryResult?.coordinateInfo, useViewerStore.getState().georefMutations.get(c.model.id)));
  }),
  operation<GeorefEditInput>(meta('georeference.edit', 'Set a validated native georeferencing field batch as one native history operation. Exact current expected values are required. Existing field casing follows the georeference API.', true), {
    type: 'object', properties: { entity: { type: 'string', enum: ['mapConversion', 'projectedCRS'] }, fields: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: {
      field: { type: 'string', minLength: 1, maxLength: 80 }, value: { anyOf: [{ type: 'string', maxLength: 2000 }, { type: 'number' }] }, oldValue: { anyOf: [{ type: 'string', maxLength: 2000 }, { type: 'number' }, { type: 'null' }] } as unknown as JSONSchemaType<string | number | null>,
    }, required: ['field', 'value', 'oldValue'], additionalProperties: false } } }, required: ['entity', 'fields'], additionalProperties: false,
  } as unknown as JSONSchemaType<GeorefEditInput>, async (i, c) => {
    const [{ getEffectiveGeoreference, supportsStandardGeoreferencing }, { isReadOnlyCoordinateOperation }] = await Promise.all([import('@/lib/geo/effective-georef'), import('@/components/viewer/properties/georef-notices')]); assertToolActive(c);
    const effective = getEffectiveGeoreference(c.model.store, useViewerStore.getState().models.get(c.model.id)?.geometryResult?.coordinateInfo, useViewerStore.getState().georefMutations.get(c.model.id));
    if (!supportsStandardGeoreferencing(c.model.store.schemaVersion, effective) || isReadOnlyCoordinateOperation(effective)) throw new Error('The native panel treats this coordinate operation or schema as read-only.');
    const value = effective?.[i.entity];
    const allowed = i.entity === 'mapConversion' ? ['eastings', 'northings', 'orthogonalHeight', 'xAxisAbscissa', 'xAxisOrdinate', 'scale', 'factorX', 'factorY', 'factorZ'] : ['name', 'description', 'geodeticDatum', 'verticalDatum', 'mapProjection', 'mapZone', 'mapUnit'];
    for (const field of i.fields) {
      if (!allowed.includes(field.field)) throw new Error('Unsupported native georeference field.');
      if (((value as unknown as Record<string, unknown> | undefined)?.[field.field] ?? null) !== field.oldValue || typeof field.value !== (i.entity === 'mapConversion' ? 'number' : 'string')) throw new Error('The georeference value or field type changed.');
      if (typeof field.value === 'number' && (!Number.isFinite(field.value) || (['scale', 'factorX', 'factorY', 'factorZ'].includes(field.field) && field.value <= 0))) throw new Error('Invalid georeference numeric value.');
    }
    return out(c.commit(() => { const permission = mutationPermission(useViewerStore.getState(), c.model.id); if (!permission.allowed) throw new Error(permission.reason);
      useViewerStore.getState().setGeorefFields(c.model.id, i.entity, i.fields.map(field => ({ ...field, oldValue: field.oldValue ?? undefined }))); return { changed: i.fields.length }; }));
  }),
];
