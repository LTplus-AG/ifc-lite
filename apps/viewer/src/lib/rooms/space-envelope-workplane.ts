/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CommandContext, Vec3, Workplane } from '@/lib/commands/modeling/types';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { mergedSectionBounds, sectionAxisRange } from '@/lib/section/section-distance';
import { sectionRenderClip } from '@/lib/section/section-render-clip';
import { resolveSectionPlaneFrame } from '../../../../../packages/renderer/src/render-section-plane';
import { activeSectionPlane } from '@/store/section-active';
import { readSpaceEnvelope, type SpaceEnvelopeTarget } from './space-envelope-read';

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (p: Vec3): Vec3 => { const l = Math.hypot(...p); return [p[0] / l, p[1] / l, p[2] / l]; };

export function selectedSpace(ctx: CommandContext): SpaceEnvelopeTarget | null {
  const s = ctx.get();
  const ref = s.selectedEntityId === null ? null : s.resolveGlobalIdFromModels(s.selectedEntityId);
  const target = ref && modelEditTarget(s, ref.modelId);
  return target && ref ? readSpaceEnvelope(target, ref.expressId) : null;
}

/** A vertical editing plane through the space, on the active front /
 * side / face-picked section. With no section it is the model's front elevation.
 * Its XY coordinates are horizontal distance and storey-local height. All model
 * placement, unit, RTC and federation conversion stays in the storey workplane. */
export function spaceEnvelopeWorkplane(ctx: CommandContext): Workplane | null {
  const target = selectedSpace(ctx);
  if (!target) return null;
  const base = buildStoreyWorkplane(ctx.get(), target.modelId, target.storeyId, 0);
  if (!isWorkplane(base)) return null;
  const section = activeSectionPlane(ctx.get());
  if (section?.box || section && !section.custom && section.axis === 'down') return null;
  const state = ctx.get();
  const scene = getGlobalRenderer()?.getScene();
  const bounds = mergedSectionBounds(state.models, state.geometryResult);
  // Resolve the actual cut with the renderer's own normal/rotation/range math.
  // Geometry bounds are only a fallback before the GPU scene is available.
  const cut = section ? resolveSectionPlaneFrame({
    options: { ...sectionRenderClip(true, section, sectionAxisRange(bounds, section.axis), 'command'), buildingRotation: state.geometryResult?.coordinateInfo?.buildingRotation },
    batchedMeshes: scene?.getBatchedMeshes() ?? [], meshes: scene?.getMeshes() ?? [],
    pointCloudBounds: scene || !bounds ? null : { min: [bounds.min.x, bounds.min.y, bounds.min.z], max: [bounds.max.x, bounds.max.y, bounds.max.z] },
    logSectionBounds: false, spendLogLatch: () => {},
  }).sectionPlaneData : undefined;
  const normal: Vec3 = cut?.normal ?? base.plane.v;
  if (!normal.every(Number.isFinite) || Math.hypot(...normal) < 1e-9) return null;
  // Tilted sections cannot describe a ceiling as z(horizontal distance).
  if (Math.abs(dot(unit(normal), base.plane.normal)) > 1e-6) return null;
  const n = unit(normal);
  const horizontal: Vec3 = [base.plane.normal[1] * n[2] - base.plane.normal[2] * n[1],
    base.plane.normal[2] * n[0] - base.plane.normal[0] * n[2], base.plane.normal[0] * n[1] - base.plane.normal[1] * n[0]];
  const du = dot(horizontal, base.plane.u), dv = dot(horizontal, base.plane.v);
  const xs = target.chain.footprint.map(p => p[0]), ys = target.chain.footprint.map(p => p[1]);
  const centre: Vec3 = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, 0];
  // Hold the plane at the centre's normal coordinate, leave absolute U and Z
  // coordinates intact so snapped heights are the heights written to IFC.
  const baseOrigin = base.localToRender([0, 0, 0]);
  // Dot the render-space cut equation through the canonical storey transform.
  // The generated plane normal points along (-dv, du) in storey XY.
  const across: Vec3 = sub(base.localToRender([-dv, du, 0]), baseOrigin);
  const normalOffset = cut ? (cut.distance - dot(baseOrigin, normal)) / dot(across, normal)
    : -dv * centre[0] + du * centre[1];
  if (!Number.isFinite(normalOffset)) return null;
  const localToRender = ([u, z, depth]: Vec3) => base.localToRender([du * u - dv * (normalOffset + depth), dv * u + du * (normalOffset + depth), z]);
  const renderToLocal = (p: Vec3): Vec3 => {
    const l = base.renderToLocal(p);
    return [du * l[0] + dv * l[1], l[2], -dv * l[0] + du * l[1] - normalOffset];
  };
  const origin = localToRender([0, 0, 0]);
  const planeNormal = unit(sub(localToRender([0, 0, 1]), origin));
  return {
    modelId: target.modelId, spec: { kind: 'section', planeId: 'space-envelope' }, localToRender, renderToLocal,
    plane: { origin, u: unit(sub(localToRender([1, 0, 0]), origin)), v: base.plane.normal, normal: planeNormal },
    intersectRay(ray) {
      const denominator = dot(ray.direction, planeNormal);
      if (Math.abs(denominator) < 1e-9) return null;
      const t = dot(sub(origin, ray.origin), planeNormal) / denominator;
      if (t < 0 || !Number.isFinite(t)) return null;
      const render: Vec3 = [ray.origin[0] + ray.direction[0] * t, ray.origin[1] + ray.direction[1] * t, ray.origin[2] + ray.direction[2] * t];
      const local = renderToLocal(render);
      return { render, local: [local[0], local[1]] };
    },
  };
}
