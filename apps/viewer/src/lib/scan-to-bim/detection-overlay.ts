/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The detection overlay (#6894): every plane and cylinder a visible proposal
 * came from, drawn in the render frame and coloured by the proposed class.
 * Planes are their extent quads, cylinders 16-sided tubes. Rejected and
 * filtered-out proposals are not drawn; accepted ones are more opaque than
 * pending ones. One merged mesh per class and state keeps it to a few draws.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { ProposalClass, ScanElementProposal } from '@ifc-lite/geometry/scan-proposals';
import type { ScanVec3 } from '@ifc-lite/geometry/scan-segmentation';
import { visibleScanProposals, type ScanDetectionRun, type ScanProposalDecision, type ScanProposalFilter } from '@/store/slices/scanDetectionSlice';
import { sampleToRender } from './scan-model-frame';

type Rgb = [number, number, number];

/** Overlay colour per proposed class; the review list's swatches use the same. */
export const SCAN_PROPOSAL_COLORS: Readonly<Record<ProposalClass, Rgb>> = {
  IfcWall: [0.2, 0.5, 0.95],
  IfcSlab: [0.55, 0.55, 0.62],
  IfcColumn: [0.95, 0.55, 0.15],
  IfcPipeSegment: [0.2, 0.75, 0.4],
  IfcFlowSegment: [0.2, 0.75, 0.4],
};

export const PENDING_ALPHA = 0.35;
export const ACCEPTED_ALPHA = 0.7;
const TUBE_SIDES = 16;

interface Builder {
  positions: number[];
  normals: number[];
  indices: number[];
}

const sub = (a: ScanVec3, b: ScanVec3): ScanVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: ScanVec3, b: ScanVec3): ScanVec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: ScanVec3): ScanVec3 => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};

function triangle(b: Builder, p: ScanVec3[], n: ScanVec3): void {
  const base = b.positions.length / 3;
  for (const v of p) {
    b.positions.push(...v);
    b.normals.push(...n);
  }
  b.indices.push(base, base + 1, base + 2);
}

function quad(b: Builder, c: ScanVec3[]): void {
  const n = unit(cross(sub(c[1], c[0]), sub(c[3], c[0])));
  triangle(b, [c[0], c[1], c[2]], n);
  triangle(b, [c[0], c[2], c[3]], n);
}

/** Tube around `start..end` of `radius`, in the sample frame, then mapped. */
function tube(b: Builder, start: ScanVec3, end: ScanVec3, radius: number, map: (p: ScanVec3) => ScanVec3): void {
  const axis = unit(sub(end, start));
  const helper: ScanVec3 = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = unit(cross(helper, axis));
  const v = cross(axis, u);
  const ring = (centre: ScanVec3, i: number): ScanVec3 => {
    const angle = (i / TUBE_SIDES) * 2 * Math.PI;
    const [cos, sin] = [Math.cos(angle) * radius, Math.sin(angle) * radius];
    return map([centre[0] + cos * u[0] + sin * v[0], centre[1] + cos * u[1] + sin * v[1], centre[2] + cos * u[2] + sin * v[2]]);
  };
  for (let i = 0; i < TUBE_SIDES; i++) quad(b, [ring(start, i), ring(start, i + 1), ring(end, i + 1), ring(end, i)]);
}

/**
 * The renderer model index the overlay draws as (#6894): far above any index
 * the viewer's model allocator hands out (it counts up from 0). Model 0's
 * buckets share one GPU frame; a scan overlay at map coordinates batched into
 * them would be rounded by float32 (or would pin that frame at map
 * coordinates for the model's own geometry). Its own index gives the overlay
 * its own buckets and frame and leaves every model's batching untouched.
 */
export const SCAN_OVERLAY_MODEL_INDEX = 0x7fff_ff00;

/**
 * The overlay's float64 frame origin: the scan placement's render-frame
 * translation. A georeferenced scan sits ~1e6 m out, where float32 vertices
 * step 0.125-0.5 m; positions are stored relative to this and the batcher
 * folds `MeshData.origin` back in float64.
 */
function overlayOrigin(run: ScanDetectionRun): ScanVec3 {
  const m = run.cloudMatrix;
  return m ? [m[12], m[13], m[14]] : [0, 0, 0];
}

function addSources(b: Builder, proposal: ScanElementProposal, run: ScanDetectionRun, origin: ScanVec3): void {
  const map = (p: ScanVec3) => sub(sampleToRender(run.cloudMatrix, p), origin);
  for (const source of proposal.sources) {
    if (source.kind === 'plane') {
      const plane = run.result.planes[source.index];
      if (plane) quad(b, plane.extent.corners.map(map));
    } else {
      const cylinder = run.result.cylinders[source.index];
      if (cylinder) tube(b, cylinder.axisStart, cylinder.axisEnd, cylinder.radius, map);
    }
  }
}

/**
 * Overlay meshes for `run` under `decisions` and `filter`; mesh ids are
 * `idFor(0)`, `idFor(1)`, ... in a stable order.
 */
export function detectionOverlayMeshes(
  run: ScanDetectionRun | null,
  decisions: Readonly<Record<string, ScanProposalDecision>>,
  filter: ScanProposalFilter,
  idFor: (index: number) => number,
): MeshData[] {
  const groups = new Map<string, { color: [number, number, number, number]; builder: Builder }>();
  for (const proposal of visibleScanProposals(run, filter)) {
    const decision = decisions[proposal.id];
    if (decision === 'rejected' || !run) continue;
    const alpha = decision === 'accepted' ? ACCEPTED_ALPHA : PENDING_ALPHA;
    const key = `${proposal.ifcClass}:${alpha}`;
    let group = groups.get(key);
    if (!group) {
      group = { color: [...SCAN_PROPOSAL_COLORS[proposal.ifcClass], alpha], builder: { positions: [], normals: [], indices: [] } };
      groups.set(key, group);
    }
    addSources(group.builder, proposal, run, overlayOrigin(run));
  }
  const origin = run ? overlayOrigin(run) : null;
  return [...groups.keys()].sort().map((key, index) => {
    const { color, builder } = groups.get(key)!;
    return {
      expressId: idFor(index),
      positions: new Float32Array(builder.positions),
      normals: new Float32Array(builder.normals),
      indices: new Uint32Array(builder.indices),
      color,
      modelIndex: SCAN_OVERLAY_MODEL_INDEX,
      ...(origin && origin.some((v) => v !== 0) ? { origin } : {}),
    };
  });
}
