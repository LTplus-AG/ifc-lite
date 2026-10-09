/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { curtainWallFrameAvailable } from './model-authoring-curtain-wall-frame';
import type { ViewerState } from '@/store';
import type { MeshData } from '@ifc-lite/geometry';
import { curtainWallLayout } from '@ifc-lite/create';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { curtainWallGhosts, initCurtainWall, CURTAIN_PANEL_THICKNESS } from '@/lib/commands/modeling/commands/curtainwall-place-geometry';
import { curtainWallParamsInMetres } from './model-authoring-curtain-wall-fields';
import type { ModelAuthoringBatch } from './model-authoring';
import type { AuthoringRow } from './model-authoring-preview';
/** Reuse the actual native command's rectangular-section preview; refuse unsupported section detail honestly. */
export function authoringCurtainWallGhost(state: ViewerState, batch: ModelAuthoringBatch, row: AuthoringRow, id: number): MeshData[] {
  if (row.op.op !== 'curtainWall.create' || row.modelId === null || row.resolved.storey === undefined) return [];
  const store = state.models.get(row.modelId)?.ifcDataStore;
  if (!store || !curtainWallFrameAvailable(store, state.mutationViews.get(row.modelId), row.resolved.storey)) return [];
  const p = curtainWallParamsInMetres(row.op.params, batch.units);
  const mullion = p.MullionProfile ?? { Type: 'Rectangle' as const, XDim: .05, YDim: .15 };
  const transom = p.TransomProfile ?? mullion;
  if (mullion.Type !== 'Rectangle' || transom.Type !== 'Rectangle' || mullion.XDim !== transom.XDim || mullion.YDim !== transom.YDim || (p.PanelThickness ?? CURTAIN_PANEL_THICKNESS) !== CURTAIN_PANEL_THICKNESS) return [];
  const plane = buildStoreyWorkplane(state, row.modelId, row.resolved.storey, 0);
  if (!isWorkplane(plane)) return [];
  const layout = curtainWallLayout(p);
  return curtainWallGhosts(plane, { ok: true, params: p, start: [p.Start[0], p.Start[1]], end: [p.End[0], p.End[1]], bays: layout.uLines.length-1, rows: layout.vLines.length-1 }, layout,
    { ...initCurtainWall(), height: p.Height, baseOffset: p.Start[2], mullionWidth: mullion.XDim, mullionDepth: mullion.YDim }, [id, id]);
}
