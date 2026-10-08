/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Accepted scan-to-BIM proposals become IFC elements (#6894), through the
 * Model workspace's one write path: a single `runTransaction`, so the whole
 * batch is one undo step, re-meshed, in the tree and exported like any
 * authored element.
 *
 * Each element goes to the storey it stands on: the highest storey whose
 * floor is at or below the element's base (within `STOREY_TOLERANCE_METRES`),
 * else the lowest storey. Its geometry goes from the workspace world back to
 * the render frame (`workspaceToRender`) and then through that storey's
 * workplane (`renderToLocal`), the map every modelling command writes
 * through, so the target model's RTC, rotation, alignment and placement are
 * honoured without restating them.
 *
 * - walls: `addWall`, axis centred (`Alignment` default);
 * - slabs: `addSlab` with the outline as a polygon, extruded up from the
 *   slab's bottom;
 * - columns: `addColumn` with a circular profile;
 * - pipes: `addMember` with a circular profile along the axis, then
 *   reclassified to `IfcPipeSegment` (IFC4+) or `IfcFlowSegment` (IFC2X3).
 *   The class follows the model the pipe is created in, not the one that was
 *   active at detection: IFC2X3 has no `IfcPipeSegment`.
 *
 * Every element gets the `IfcLite_ScanDetection` property set (no `Pset_`
 * prefix: that is reserved for buildingSMART's own sets) with its provenance.
 */

import type { ScanElementProposal } from '@ifc-lite/geometry/scan-proposals';
import type { ScanVec3 } from '@ifc-lite/geometry/scan-segmentation';
import { PropertyValueType } from '@ifc-lite/data';
import { useViewerStore, type ViewerState } from '@/store';
import { runTransaction } from '@/lib/commands/modeling/transaction';
import type { AuthoringTransaction, ModelingCommand, Workplane } from '@/lib/commands/modeling/types';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { workspaceToRender } from './scan-model-frame';

export const SCAN_DETECTION_PSET = 'IfcLite_ScanDetection';
/** An element whose base is this far below a storey's floor still belongs to it. */
export const STOREY_TOLERANCE_METRES = 0.3;

interface StoreyFrame {
  storeyId: number;
  plane: Workplane;
}

export interface CreatedScanElement {
  proposalId: string;
  expressId: number;
  storeyId: number;
  /** Survives export and reopening, unlike the express id. */
  globalId: string;
}

export type ScanCreationOutcome =
  | { ok: true; created: CreatedScanElement[]; batchId: string | null }
  | { ok: false; reason: string };

export interface ScanCreationRequest {
  modelId: string;
  proposals: readonly ScanElementProposal[];
  /** Recorded in the property set as `SourceScan`. */
  scanName: string;
}

function storeyFrames(state: ViewerState, modelId: string): StoreyFrame[] | string {
  const storeys = modelStoreys(state, modelId);
  if (storeys.length === 0) return 'The IFC model has no storey to place the elements on.';
  const frames: StoreyFrame[] = [];
  for (const storey of storeys) {
    const plane = buildStoreyWorkplane(state, modelId, storey.expressId, 0);
    if (!isWorkplane(plane)) return plane.refused;
    frames.push({ storeyId: storey.expressId, plane });
  }
  return frames;
}

/** The base point an element stands on, in the workspace world. */
function basePoint(p: ScanElementProposal): ScanVec3 {
  const g = p.geometry;
  switch (g.kind) {
    case 'wall': return g.start;
    case 'slab': return [g.outline[0][0], g.outline[0][1], g.outline[0][2] - g.thicknessMetres];
    case 'column': return g.base;
    case 'pipe': return g.start[2] <= g.end[2] ? g.start : g.end;
  }
}

/** Storeys are lowest first; pick the highest at or below the base. */
function chooseStorey(state: ViewerState, frames: StoreyFrame[], p: ScanElementProposal): StoreyFrame {
  const render = workspaceToRender(state, basePoint(p));
  let chosen = frames[0];
  for (const frame of frames) {
    if (frame.plane.renderToLocal(render)[2] >= -STOREY_TOLERANCE_METRES) chosen = frame;
  }
  return chosen;
}

function local(state: ViewerState, frame: StoreyFrame, p: ScanVec3): [number, number, number] {
  const [x, y, z] = frame.plane.renderToLocal(workspaceToRender(state, p));
  return [x, y, z];
}

function provenance(p: ScanElementProposal, scanName: string) {
  return [
    { name: 'SourceScan', value: scanName, type: PropertyValueType.Label },
    { name: 'DetectionId', value: p.id, type: PropertyValueType.Identifier },
    { name: 'Basis', value: p.basis, type: PropertyValueType.Label },
    { name: 'SourceDetections', value: p.sources.map((s) => `${s.kind}:${s.index}`).join(' '), type: PropertyValueType.Label },
    { name: 'Confidence', value: p.confidence, type: PropertyValueType.Real },
    { name: 'FitRmsMetres', value: p.fit.rmsMetres, type: PropertyValueType.Real },
    { name: 'InlierPoints', value: p.fit.inlierPoints, type: PropertyValueType.Integer },
  ];
}

/** The pipe class `modelId`'s schema has. */
function pipeClass(state: ViewerState, modelId: string): 'IfcPipeSegment' | 'IfcFlowSegment' {
  return state.models.get(modelId)?.ifcDataStore?.schemaVersion === 'IFC2X3' ? 'IfcFlowSegment' : 'IfcPipeSegment';
}

function created(result: { expressId: number } | { error: string }, what: string): number {
  if ('error' in result) throw new Error(`${what}: ${result.error}`);
  return result.expressId;
}

/** Write one proposal into `frame`'s storey; returns its express id. */
function createOne(tx: AuthoringTransaction, state: ViewerState, frame: StoreyFrame, p: ScanElementProposal): number {
  const s = tx.store;
  const name = `Scan ${p.id}`;
  const g = p.geometry;
  switch (g.kind) {
    case 'wall': {
      const [a, b] = [local(state, frame, g.start), local(state, frame, g.end)];
      return created(s.addWall(tx.modelId, frame.storeyId, { Start: a, End: [b[0], b[1], a[2]], Thickness: g.thicknessMetres, Height: g.heightMetres, Name: name }), p.id);
    }
    case 'slab': {
      const ring = g.outline.map((q) => local(state, frame, q));
      const bottom = ring[0][2] - g.thicknessMetres;
      return created(s.addSlab(tx.modelId, frame.storeyId, {
        Profile: 'polygon', OuterCurve: ring.map(([x, y]) => [x, y]), Position: [0, 0, bottom], Thickness: g.thicknessMetres, Name: name,
      }), p.id);
    }
    case 'column':
      return created(s.addColumn(tx.modelId, frame.storeyId, {
        Position: local(state, frame, g.base), Height: g.heightMetres, Profile: { Type: 'Circle', Radius: g.radiusMetres }, Name: name,
      }), p.id);
    case 'pipe': {
      const id = created(s.addMember(tx.modelId, frame.storeyId, {
        Start: local(state, frame, g.start), End: local(state, frame, g.end), Profile: { Type: 'Circle', Radius: g.radiusMetres }, Name: name,
      }), p.id);
      const ifcClass = pipeClass(state, tx.modelId);
      if (!s.setEntityType(tx.modelId, id, ifcClass.toUpperCase(), null)) throw new Error(`${p.id}: cannot make it ${ifcClass}`);
      return id;
    }
  }
}

/** Create `request.proposals` as one undoable batch. */
export function createScanElements(request: ScanCreationRequest): ScanCreationOutcome {
  const get = useViewerStore.getState;
  const frames = storeyFrames(get(), request.modelId);
  if (typeof frames === 'string') return { ok: false, reason: frames };
  if (request.proposals.length === 0) return { ok: false, reason: 'No accepted proposals to create.' };
  // The model's mutation view and editor, opened the way modelling commands open them.
  if (!modelEditTarget(get(), request.modelId)) return { ok: false, reason: 'The model has no editable IFC data.' };
  const made: CreatedScanElement[] = [];
  const command: ModelingCommand = {
    id: 'scan.create',
    labelKey: 'scanToBim.create',
    hud: {},
    snap: 'modeling',
    init: () => null,
    pointerMove: (g) => g,
    pointerDown: (g) => g,
    commit: (_g, tx) => {
      const state = get();
      for (const proposal of request.proposals) {
        const frame = chooseStorey(state, frames, proposal);
        const expressId = createOne(tx, state, frame, proposal);
        if (!tx.store.createPropertySet(tx.modelId, expressId, SCAN_DETECTION_PSET, provenance(proposal, request.scanName))) {
          throw new Error(`${proposal.id}: cannot record its provenance`);
        }
        const globalId = get().mutationViews.get(tx.modelId)?.getNewEntity(expressId)?.attributes[0];
        if (typeof globalId !== 'string') throw new Error(`${proposal.id}: the created element has no GlobalId`);
        made.push({ proposalId: proposal.id, expressId, storeyId: frame.storeyId, globalId });
      }
      const ids = made.map((m) => m.expressId);
      return { created: ids, deleted: [], remesh: ids };
    },
  };
  const outcome = runTransaction(useViewerStore, command, null, { get, modelId: request.modelId, storeyId: frames[0].storeyId, workplane: null });
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  return { ok: true, created: made, batchId: outcome.batchId };
}
