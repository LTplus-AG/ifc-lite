/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { addHostedElementInStore, readHostOpeningExtents, resolveHostAnchor, type SlabOpeningInStoreParams } from '@ifc-lite/create';
import { effectiveMetadataRecord, type IfcDataStore } from '@ifc-lite/parser';
import { AnchorEntityReader } from '../../../../../packages/create/src/in-store/resolve-anchor';
import { axis3d, refId } from '../../../../../packages/create/src/in-store/host-geometry-frame';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { ElementTarget, ModelAuthoringBatch, AuthoringUnits } from './model-authoring';
import { parseLength, record } from './model-authoring-fields';
import { parseSplitSnapshot } from './model-authoring-split-params';
import { readSplitSnapshot, sameSplitSnapshot, type SplitSnapshot } from './model-authoring-split-state';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { nativeLengthUnitAvailable } from './model-authoring-read-target';
import { uniqueSplitGuid } from './model-authoring-split';

/** Bare slab cut: Position is host-local XY, not storey-local placement. */
export interface SlabOpeningCreate {
  op: 'hosted.create'; kind: 'opening'; host: ElementTarget; ref?: string; name?: string;
  params: { Position: [number, number]; Width: number; Depth: number; CutDepth?: number };
  expected?: SplitSnapshot;
}
export function parseSlabOpeningFields(value: Record<string, unknown>, host: ElementTarget, units: AuthoringUnits, at: string): Pick<SlabOpeningCreate, 'params' | 'expected'> {
  if (value.kind !== 'opening') throw new Error(`${at}: slab hosts support bare openings only, not doors or windows`);
  const p = value.params;
  if (!record(p) || Object.keys(p).some(key => !['Position', 'Width', 'Depth', 'CutDepth'].includes(key))) throw new Error(`${at}: state native slab opening params Position, Width, Depth and optional CutDepth`);
  if (!Array.isArray(p.Position) || p.Position.length !== 2) throw new Error(`${at}: Position needs two host-local coordinates`);
  const length = (v: unknown, key: string, positive: boolean) => {
    const n = parseLength(v, units, { min: positive ? 0 : -Number.MAX_VALUE, max: Number.MAX_VALUE, signed: !positive }, `${at} ${key}`);
    if (positive && n <= 0) throw new Error(`${at}: ${key} must be positive`);
    return n;
  };
  const params = { Position: p.Position.map(v => length(v, 'Position', false)) as [number, number], Width: length(p.Width, 'Width', true), Depth: length(p.Depth, 'Depth', true),
    ...(p.CutDepth === undefined ? {} : { CutDepth: length(p.CutDepth, 'CutDepth', true) }) };
  if ('ref' in host) {
    if (value.expected !== undefined) throw new Error(`${at}: a preceding slab ref uses its current native draft, not an imported source expectation`);
    return { params };
  }
  const expected = parseSplitSnapshot(value.expected, `${at} expected slab`);
  if (expected.kind !== 'slab') throw new Error(`${at}: expected must be the canonical native slab shape and placement`);
  return { params, expected };
}
export function slabOpeningSpec(batch: ModelAuthoringBatch, op: SlabOpeningCreate, globalId?: string): { kind: 'opening'; params: SlabOpeningInStoreParams } {
  const m = (v: number) => batch.units === 'mm' ? v / 1000 : v;
  return { kind: 'opening', params: { Position: [m(op.params.Position[0]), m(op.params.Position[1])], Width: m(op.params.Width), Depth: m(op.params.Depth),
    ...(op.params.CutDepth === undefined ? {} : { CutDepth: m(op.params.CutDepth) }), ...(op.name ? { Name: op.name } : {}), ...(globalId ? { GlobalId: globalId } : {}) } };
}
/** The inherited snapshot may not represent a named placement retarget.
 * Compare against its existing canonical native frame reader; refuse rather
 * than attest the stale axis or invent a second snapshot/placement resolver. */
function readSlabOpeningSnapshot(store: IfcDataStore, editor: StoreEditor, id: number, units: AuthoringUnits): SplitSnapshot {
  const snapshot=readSplitSnapshot(store,editor,id,units),reader=new AnchorEntityReader(store,editor.getMutationView());
  const host=reader.entity(id),localId=refId(host?.attributes[5]),placement=localId===null?null:reader.entity(localId);
  const frame=placement?axis3d(reader,placement.attributes[1]):null;
  const scale=getModelLengthUnitScale(store),factor=units==='mm'?1000:1;
  if(!placement || placement.type.toUpperCase()!=='IFCLOCALPLACEMENT' || !frame
    || refId(placement.attributes[0])!==snapshot.placement.parent
    || !sameSplitSnapshot({...frame,o:frame.o.map(v=>v*scale*factor)},snapshot.placement.frame)){
    throw new Error('Complete current native slab placement snapshot is unavailable; save/reload the native edits before proposing the cut');
  }
  return snapshot;
}

/** The same native intermediate-view proof precedes dry run and atomic commit. */
export function verifySlabOpeningHost(batch: ModelAuthoringBatch, op: SlabOpeningCreate, store: IfcDataStore, editor: StoreEditor, id: number, compareExpected = true): SplitSnapshot {
  if (!store.source || store.source.byteLength === 0) throw new Error('Native slab opening source geometry is unavailable');
  const view = editor.getMutationView();
  if (resolveHostAnchor(store, id, view).hostKind !== 'slab') throw new Error('A bare slab opening requires a current native slab host');
  const current = readSlabOpeningSnapshot(store, editor, id, batch.units);
  const record = effectiveMetadataRecord(store, id, view), guid = record?.attributes[0];
  if (typeof guid !== 'string' || !uniqueSplitGuid(store, editor, guid)) throw new Error('The native slab host GlobalId is not unique in its owning model');
  if (!('ref' in op.host) && (guid !== op.host.globalId || (record?.attributes[2] ?? '') !== op.host.name)) throw new Error('The native slab host identity changed after review');
  if (compareExpected && op.expected && !sameSplitSnapshot(current, op.expected)) throw new Error('The native slab host shape, placement or storey changed after review');
  return current;
}
export function writeSlabOpening(batch: ModelAuthoringBatch, op: SlabOpeningCreate, store: IfcDataStore, editor: StoreEditor, id: number, globalId?: string) {
  verifySlabOpeningHost(batch, op, store, editor, id);
  return addHostedElementInStore(store, editor, id, slabOpeningSpec(batch, op, globalId));
}

export interface SlabOpeningEvidence { units: 'm'; status: 'available' | 'unavailable'; expected: SplitSnapshot | null }
/** Both selection transports use the same pure current native host snapshot. */
export function nativeSlabOpeningEvidence(target: ModelEditTarget | null, id: number): SlabOpeningEvidence {
  const unavailable: SlabOpeningEvidence = { units: 'm', status: 'unavailable', expected: null };
  if (!target || !nativeLengthUnitAvailable(target) || !target.dataStore.source?.byteLength
    || !['IFCSLAB', 'IFCSLABSTANDARDCASE', 'IFCSLABELEMENTEDCASE'].includes(String(target.editor.getEntityType(id)).toUpperCase())) return unavailable;
  try {
    const expected = readSlabOpeningSnapshot(target.dataStore, target.editor, id, 'm');
    const guid = effectiveMetadataRecord(target.dataStore, id, target.view)?.attributes[0];
    if (expected.kind !== 'slab' || typeof guid !== 'string' || !uniqueSplitGuid(target.dataStore, target.editor, guid)) return unavailable;
    return { units: 'm', status: 'available', expected };
  } catch (error) {
    console.warn('[Native slab opening] Complete current host snapshot is unavailable', error);
    return unavailable;
  }
}

/** Only the canonical native writer supplies a cutter; no preview defaults or
 * geometry calculation are duplicated here. Bounds use metres. */
export function readSlabOpeningPreview(store: IfcDataStore, editor: StoreEditor, hostId: number, openingId: number) {
  const cuts=readHostOpeningExtents(store,hostId,editor.getMutationView());
  const cut=cuts.cuts.find(row=>row.openingId===openingId);
  if(!cut || cuts.unreadable.includes(openingId))return undefined;
  const scale=getModelLengthUnitScale(store);
  return {snapshot:readSlabOpeningSnapshot(store,editor,hostId,'m'),bounds:{
    min:cut.bounds.min.map(v=>v*scale) as [number,number,number],
    max:cut.bounds.max.map(v=>v*scale) as [number,number,number]}};
}
