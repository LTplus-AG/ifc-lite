/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { effectiveMetadataRecord } from '@ifc-lite/parser';
import { iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import { liveEntityConforms } from '@ifc-lite/create';
import type { PreparedRoomCommand, RoomCommandResult } from '@ifc-lite/sdk';
import { effectiveStoreyId } from '../../../../../packages/create/src/in-store/edit/effective-storey.js';
import { roomChainInStore } from '../../../../../packages/create/src/in-store/room-store.js';
import { useViewerStore, type ViewerState } from '@/store';
import { prepareNativeRoomCommand } from '@/sdk/adapters/store-adapter-room';
import { nativeRootName } from './native-edit-evidence';
import { nativeLengthUnitAvailable, readOnlyModelEditTarget } from './model-authoring-read-target';
import { uniqueSplitGuid } from './model-authoring-split';
import { resolveGlobalId } from './resolve-global-id';
import type { RoomProposal, RoomRootTarget } from './room-command-proposal';
import { layoutVersion } from '@/lib/rooms/room-layout';
import { sameReportEvidence } from '@/lib/flow/report-provenance';

export interface RoomIdentity extends RoomRootTarget {
  expressId: number;
  supported: boolean;
  outline: [number, number][] | null;
  height: number | null;
  z: number | null;
}
export interface RoomSnapshot {
  modelId: string;
  storey: RoomRootTarget & { expressId: number };
  units: 'm';
  frame: 'storey-local';
  settings: { weld: number; minArea: number; boundary: string; height: number; z: number; namePattern: string; PredefinedType: string | null; ObjectType: string | null };
  candidateCount: number;
  roomCount: number;
  candidates: RoomCommandResult['candidates'];
  rooms: RoomIdentity[];
}
export interface RoomReview {
  proposal: RoomProposal;
  snapshot: RoomSnapshot;
  prepared: PreparedRoomCommand;
  validate(): void;
  commit(): RoomCommandResult;
  dispose(): void;
}
export interface RoomGrounding { snapshot: RoomSnapshot }
const grounding = new WeakMap<RoomGrounding, { sources: ReturnType<typeof sources>; layout: number; json: string }>();

function target(state: ViewerState, modelId: string, root: RoomRootTarget, ifcClass: string): number {
  const reader = readOnlyModelEditTarget(state, modelId);
  if (!reader || !nativeLengthUnitAvailable(reader)) throw new Error('The loaded source has no authoritative native length unit or editable index');
  const resolved = resolveGlobalId(state, { globalId: root.GlobalId, modelId });
  if (typeof resolved === 'string' || !uniqueSplitGuid(reader.dataStore, reader.editor, root.GlobalId)) throw new Error('The Room target is missing or its current GlobalId is ambiguous');
  if (!liveEntityConforms(reader.dataStore, resolved.expressId, ifcClass, reader.view) || nativeRootName(reader, resolved.expressId) !== root.Name) throw new Error('The Room target differs from its expected current class or Name');
  return resolved.expressId;
}

/** Complete current population; unsupported room shapes stay visible rather than disappearing from counts. */
function roomPopulation(state: ViewerState, modelId: string, storeyId: number): RoomIdentity[] {
  const reader = readOnlyModelEditTarget(state, modelId);
  if (!reader) throw new Error('The current Room source is unavailable');
  const { dataStore: store, view, editor } = reader;
  const changed = new Set(view.getEffectiveChanges().map(change => change.entityId));
  const rows: RoomIdentity[] = [];
  let scanned = 0;
  for (const { expressId } of iterateEffectiveEntityIds(store, view)) {
    if (++scanned > 200000) throw new Error('The loaded model is too large for a complete reviewed Room population');
    if (!liveEntityConforms(store, expressId, 'IfcSpace', view) || effectiveStoreyId(store, view, expressId) !== storeyId) continue;
    if (rows.length >= 128) throw new Error('More than 128 rooms belong to this storey; a complete review is unavailable');
    const GlobalId = changed.has(expressId) || view.getNewEntity(expressId)
      ? effectiveMetadataRecord(store, expressId, view)?.attributes[0] : store.entities.getGlobalId(expressId);
    if (typeof GlobalId !== 'string' || !GlobalId || !uniqueSplitGuid(store, editor, GlobalId)) throw new Error('A current room has an unavailable or ambiguous native identity');
    const native = roomChainInStore(store, editor, expressId);
    rows.push({ expressId, GlobalId, Name: nativeRootName(reader, expressId), supported: native.ok,
      outline: native.ok ? structuredClone(native.chain.footprint) : null,
      height: native.ok ? native.chain.thickness : null, z: native.ok ? native.chain.baseElevation : null });
  }
  return rows.sort((a, b) => a.expressId - b.expressId);
}

function sources(state: ViewerState) {
  return [...state.models].map(([id, model]) => ({ id, store: model.ifcDataStore, source: model.ifcDataStore?.source,
    hash: model.sourceContentHash, view: state.mutationViews.get(id), revision: state.mutationViews.get(id)?.getMutationRevision() }));
}
function sourcesCurrent(captured: ReturnType<typeof sources>, state: ViewerState): boolean {
  return captured.length === state.models.size && captured.every(row => {
    const model = state.models.get(row.id);
    return !!model && model.ifcDataStore === row.store && model.ifcDataStore?.source === row.source && model.sourceContentHash === row.hash
      && state.mutationViews.get(row.id) === row.view && state.mutationViews.get(row.id)?.getMutationRevision() === row.revision;
  });
}

/** Explicit preparation only: current native meshes/candidates plus a detached canonical writer preview. */
export async function prepareRoomReview(proposal: RoomProposal, signal: AbortSignal): Promise<RoomReview> {
  const state = useViewerStore.getState();
  const storeyId = target(state, proposal.modelId, proposal.storey, 'IfcBuildingStorey');
  const command = proposal.command.action === 'update'
    ? { ...proposal.command, expressIds: (proposal.rooms ?? []).map(root => target(state, proposal.modelId, root, 'IfcSpace')) }
    : proposal.command;
  const prepared = await prepareNativeRoomCommand(useViewerStore, proposal.modelId, storeyId, { ...command, signal });
  try {
    signal.throwIfAborted();
    const current = useViewerStore.getState();
    if (target(current, proposal.modelId, proposal.storey, 'IfcBuildingStorey') !== storeyId) throw new Error('The storey changed while Room geometry was preparing');
    const rooms = roomPopulation(current, proposal.modelId, storeyId);
    if (command.action === 'update' && command.expressIds.some(id => !rooms.some(room => room.expressId === id))) throw new Error('A selected room no longer belongs to this storey');
    const candidates = prepared.result.candidates;
    const vertices = candidates.reduce((count, face) => count + face.centre.length + face.inner.length + face.outer.length, 0);
    if (candidates.length > 128 || vertices > 4096) throw new Error('The native Room candidate population is too large for a complete review');
    if (candidates.some(face => !Number.isFinite(face.grossArea) || !Number.isFinite(face.netArea)
      || [...face.centre, ...face.inner, ...face.outer].some(point => point.some(value => !Number.isFinite(value))))) throw new Error('The native Room contours or areas are unavailable');
    const after = prepared.layoutAfter;
    if (after && (after.length > 128 || after.reduce((count, face) => count + face.centre.length + face.inner.length + face.outer.length, 0) > 4096
      || after.some(face => [...face.centre, ...face.inner, ...face.outer].some(point => point.some(value => !Number.isFinite(value)))))) {
      throw new Error('The complete post-edit native Room layout is unavailable or exceeds the review limit');
    }
    const snapshot: RoomSnapshot = { modelId: proposal.modelId, storey: { ...proposal.storey, expressId: storeyId }, units: 'm', frame: 'storey-local',
      settings: { weld: command.weld, minArea: command.minArea, boundary: command.boundary, height: command.height, z: command.z, namePattern: command.namePattern, PredefinedType: command.PredefinedType ?? null, ObjectType: command.ObjectType ?? null },
      candidateCount: candidates.length, roomCount: rooms.length, candidates: structuredClone(candidates), rooms };
    if (JSON.stringify(snapshot).length > 60000) throw new Error('The complete Room snapshot exceeds the attachment limit');
    if (proposal.expected !== undefined && !sameReportEvidence(proposal.expected, snapshot)) throw new Error('The supplied native Room snapshot differs from the current source; prepare it again');
    const captured = sources(current);
    const validate = () => {
      signal.throwIfAborted();
      if (!sourcesCurrent(captured, useViewerStore.getState())) throw new Error('The loaded sources changed after Room preparation; prepare again');
      prepared.validate();
      if (target(useViewerStore.getState(), proposal.modelId, proposal.storey, 'IfcBuildingStorey') !== storeyId) throw new Error('The current storey identity changed');
    };
    return { proposal, snapshot, prepared, validate, commit: () => { validate(); return prepared.commit(); }, dispose: prepared.dispose };
  } catch (error) { prepared.dispose(); throw error; }
}

/** Known complete snapshots only; private native approval ownership never goes into a provider payload. */
export function roomGroundingText(review: RoomReview): string {
  review.validate();
  return `Explicitly attached complete native Room snapshot (SI metres; no edit executed):\n${JSON.stringify(review.snapshot)}`;
}

/** Explicit attachment owns only immutable evidence, never a plate or a commit capability. */
export function captureRoomGrounding(review: RoomReview): RoomGrounding {
  review.validate();
  const attachment = { snapshot: structuredClone(review.snapshot) };
  grounding.set(attachment, { sources: sources(useViewerStore.getState()), layout: layoutVersion(), json: JSON.stringify(attachment.snapshot) });
  return attachment;
}
export function roomGroundingIsCurrent(attachment: RoomGrounding): boolean {
  const captured = grounding.get(attachment);
  return !!captured && captured.layout === layoutVersion() && sourcesCurrent(captured.sources, useViewerStore.getState())
    && captured.json === JSON.stringify(attachment.snapshot);
}
export function roomAttachmentText(attachment: RoomGrounding): string {
  // Formatting is inert; request ownership checks refuse a stale attachment before sending.
  return `Explicitly attached complete native Room snapshot (SI metres; no edit executed):\n${JSON.stringify(attachment.snapshot)}`;
}
