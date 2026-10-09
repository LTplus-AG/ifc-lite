/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerState } from '@/store';
import type { MeshData } from '@ifc-lite/geometry';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { stairGhostMesh, railingGhostMesh } from '@/lib/commands/modeling/stair-railing-ghost';
import { stairParamsInMetres, railingParamsInMetres } from './model-authoring-stair-railing-fields';
import type { ModelAuthoringBatch } from './model-authoring';
import type { AuthoringRow } from './model-authoring-preview';
/** Same command ghosts, with their existing solid-step / square-section approximation explicitly disclosed. */
export function stairRailingGhost(state: ViewerState, batch: ModelAuthoringBatch, row: AuthoringRow, id: number): MeshData | null {
    const op = row.op;
    if (!['stair.create', 'railing.create', 'stair.replace', 'railing.replace'].includes(op.op) || !('storey' in op) || !('params' in op))
        return null;
    if (row.modelId === null || row.resolved.storey === undefined)
        return null;
    const plane = buildStoreyWorkplane(state, row.modelId, row.resolved.storey, 0);
    if (!isWorkplane(plane))
        return null;
    if (op.op === 'stair.create' || op.op === 'stair.replace') {
        const p = stairParamsInMetres(op.params, batch.units), angle = p.Direction ?? 0, c = Math.cos(angle), s = Math.sin(angle);
        const mesh = stairGhostMesh(plane, (x, y) => [p.Position[0] + x * c - (y + p.Width / 2) * s, p.Position[1] + x * s + (y + p.Width / 2) * c], p.NumberOfRisers, p.RiserHeight, p.TreadLength, p.Width, id);
        if (mesh && p.Position[2] !== 0) {
            const base = plane.localToRender([0, 0, 0]), at = plane.localToRender([0, 0, p.Position[2]]);
            for (let i = 0; i < mesh.positions.length; i++)
                mesh.positions[i] += at[i % 3] - base[i % 3];
        }
        return mesh;
    }
    if (op.op === 'railing.create' || op.op === 'railing.replace') {
        const p = railingParamsInMetres(op.params, batch.units);
        // Command preview has fixed 0.05 m rail/post sections; other explicit native diameters remain unavailable.
        if ((p.RailDiameter ?? .05) !== .05 || (p.PostDiameter ?? p.RailDiameter ?? .05) !== .05)
            return null;
        const path = p.Path.map(point => [point[0], point[1], point[2]] as [
            number,
            number,
            number
        ]);
        if (path.slice(1).some((point, i) => Math.hypot(point[0] - path[i][0], point[1] - path[i][1]) <= 1e-9))
            return null;
        // Native omission places posts at vertices only; maximum segment length requests that exact pattern.
        const spacing = p.PostSpacing ?? Math.max(...path.slice(1).map((point, i) => Math.hypot(...point.map((value, axis) => value - path[i][axis]))));
        return railingGhostMesh(plane, path, p.Height, spacing, id);
    }
    return null;
}
