/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { addStairToStore, addRailingToStore, readStairDimensions, editStairDimensionsInStore, removeStairInStore, replaceElementInStore, resolveSpatialAnchor, type StairDimensions } from '@ifc-lite/create';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import type { ViewerState } from '@/store';
import { ensureStoreyPlacement } from '@/store/slices/storeyPlacement';
import { nativeLengthUnitAvailable, readOnlyModelEditTarget } from './model-authoring-read-target';
import { stairParamsInMetres, railingParamsInMetres, stairPatchInMetres } from './model-authoring-stair-railing-fields';
import type { AuthoringOp, ModelAuthoringBatch } from './model-authoring';
import { uniqueSplitGuid } from './model-authoring-split';
export type StairLifecycle = Extract<AuthoringOp, {
    op: 'stair.resize' | 'stair.replace' | 'railing.replace' | 'stair.delete' | 'railing.delete';
}>;
export function nativeStairEvidence(state: ViewerState, modelId: string, id: number): StairDimensions | null {
    const target = readOnlyModelEditTarget(state, modelId);
    return nativeStairEvidenceFromTarget(target, id);
}
export function nativeStairEvidenceFromTarget(target: ModelEditTarget | null, id: number): StairDimensions | null {
    return target && nativeLengthUnitAvailable(target) ? readStairDimensions(target.dataStore, id, target.view) : null;
}
export function sameStairSnapshot(a: StairDimensions, b: StairDimensions): boolean {
    if (a.stairId !== b.stairId || a.flightId !== b.flightId || a.NumberOfRisers !== b.NumberOfRisers)
        return false;
    return (['Width', 'RiserHeight', 'TreadLength', 'WaistThickness'] as const).every(key => a[key] === undefined ? b[key] === undefined : typeof b[key] === 'number' && Math.abs(a[key]! - b[key]!) <= 1e-9 * Math.max(1, Math.abs(a[key]!)));
}
/** Validate actual native Root records before the prepared transaction is published. */
function assertCreatedIdentities(store: IfcDataStore, editor: StoreEditor, ids: readonly number[]): void {
    for (const id of ids) {
        const guid = editor.getMutationView().getNewEntity(id)?.attributes[0];
        if (typeof guid !== 'string' || !uniqueSplitGuid(store, editor, guid))
            throw new Error('The native product or flight GlobalId is not unique in its owning model');
    }
}
export function writeStairCreation(store: IfcDataStore, editor: StoreEditor, batch: ModelAuthoringBatch, op: Extract<AuthoringOp, {op: 'stair.create' | 'railing.create'}>, storey: number): {expressId: number; flightId?: number} {
    ensureStoreyPlacement(store, editor, storey);
    const anchor = resolveSpatialAnchor(store, storey, editor.getMutationView());
    const made = op.op === 'stair.create'
        ? addStairToStore(editor, anchor, stairParamsInMetres(op.params, batch.units))
        : addRailingToStore(editor, anchor, railingParamsInMetres(op.params, batch.units));
    const result = 'stairId' in made ? {expressId: made.stairId, flightId: made.flightId} : {expressId: made.railingId};
    assertCreatedIdentities(store, editor, [result.expressId, ...(result.flightId === undefined ? [] : [result.flightId])]);
    return result;
}
/** Execute only canonical writers. Both dry run and the actual history batch reach this same boundary. */
export function writeStairLifecycle(store: IfcDataStore, editor: StoreEditor, batch: ModelAuthoringBatch, op: StairLifecycle, id: number, storey?: number): {
    created: number[];
    deleted: number[];
    remesh: number[];
    root?: number;
} {
    if (op.op === 'stair.resize') {
        const current = readStairDimensions(store, id, editor.getMutationView());
        if (!current || !sameStairSnapshot(current, op.expected))
            throw new Error('The current native stair snapshot differs from expected');
        const result = editStairDimensionsInStore(store, editor, id, stairPatchInMetres(op.size, batch.units));
        return { created: [], deleted: [], remesh: [result.flightId] };
    }
    if (op.op === 'stair.delete') {
        const removed = removeStairInStore(store, editor, id);
        return { created: [], deleted: [removed.stairId, removed.flightId], remesh: [] };
    }
    if (op.op === 'railing.delete') {
        if (!editor.removeEntity(id))
            throw new Error('The railing could not be removed');
        return { created: [], deleted: [id], remesh: [] };
    }
    if (storey === undefined)
        throw new Error('The replacement storey is unavailable');
    const element = op.op === 'stair.replace' ? { kind: 'stair' as const, params: stairParamsInMetres(op.params, batch.units) } : { kind: 'railing' as const, params: railingParamsInMetres(op.params, batch.units) };
    const result = replaceElementInStore(store, editor, id, draft => { ensureStoreyPlacement(store, draft, storey); return resolveSpatialAnchor(store, storey, draft.getMutationView()); }, element);
    assertCreatedIdentities(store, editor, [result.expressId, ...(result.flightId === undefined ? [] : [result.flightId])]);
    return { created: [result.expressId, ...(result.flightId === undefined ? [] : [result.flightId])], deleted: result.removedIds, remesh: [result.flightId ?? result.expressId], root: result.expressId };
}
