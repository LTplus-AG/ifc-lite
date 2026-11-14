/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Level `render` for structural members: the geometry module the viewer draws
 * with (`@ifc-lite/geometry`, the wasm mesh pipeline) emits a mesh for the
 * member that reaches every vertex of its analytical topology (the axis edge's
 * two ends, every face bound vertex) at the file's coordinates.
 *
 * Every member record must draw: the analytical model is its members. Where a
 * member sits is read from the file by an oracle that shares no code with the
 * product (`lib/topology.mjs`); a member the file gives no topology
 * representation cannot be placed by anyone and counts as not drawn.
 */

import { cached } from '../lib/packages.mjs';
import { lengthScale, meshDistance, topologyPoints } from '../lib/topology.mjs';
import { verdict } from '../lib/values.mjs';

/** Metres between an oracle vertex and the drawn mesh, for f32 mesh positions. */
const TOLERANCE_M = 2e-3;

const isMember = (row) => row.family === 'item' && /Member(Varying)?$/.test(row.entity);

/** The meshes of one file by express id, with the render frame they are in, or the error that stopped the product. */
function memberMeshes(ctx, file) {
  return cached(ctx, `meshes:${file.path}`, async () => {
    const processor = new ctx.pkgs.geometry.GeometryProcessor({ enableInstancing: false });
    try {
      await processor.init();
      const { meshes, coordinateInfo } = await processor.process(new Uint8Array(file.bytes));
      const byId = new Map();
      for (const m of meshes) {
        if ((m.geometryClass ?? 0) === 2) continue;
        byId.set(m.expressId, [...(byId.get(m.expressId) ?? []), m]);
      }
      return { byId, frame: coordinateInfo ?? {} };
    } catch (e) {
      return { error: `geometry threw: ${e.message}` };
    } finally {
      processor.dispose();
    }
  });
}

/** Why one member record is not drawn at the file's coordinates, or null when it is. */
function memberMiss(step, rec, drawn, scale = lengthScale(step)) {
  const points = topologyPoints(step, rec.id, scale);
  if (!points.length) return 'the file gives it no topology representation';
  const meshes = drawn.byId.get(rec.id);
  if (!meshes?.length) return 'no mesh';
  const far = points.map((p) => meshDistance(meshes, p, drawn.frame)).find((d) => !(d <= TOLERANCE_M));
  return far === undefined ? null : `mesh misses a topology vertex by ${Number.isFinite(far) ? `${far.toFixed(3)} m` : 'all triangles'}`;
}

export default {
  name: 'render:structural-member-mesh',
  level: 'render',
  covers: isMember,
  async run(rows, ctx) {
    const out = new Map();
    for (const row of rows) {
      const carriers = ctx.corpus.carriers(row.schema, row.entity);
      if (!carriers.length) { out.set(row.id, ctx.corpus.nothingCarries(row.schema, row.entity)); continue; }
      const problems = [];
      const missed = [];
      let checked = 0;
      for (const file of carriers) {
        const drawn = await memberMeshes(ctx, file);
        if (drawn.error) { problems.push(`${file.path}: ${drawn.error}`); continue; }
        const scale = lengthScale(file.step);
        for (const rec of file.step.of(row.entity)) {
          checked += 1;
          const why = memberMiss(file.step, rec, drawn, scale);
          if (why) missed.push(`${file.path}#${rec.id} (${why})`);
        }
      }
      if (missed.length) problems.unshift(`${missed.length} of ${checked} member(s) not drawn at the file's coordinates, e.g. ${missed[0]}`);
      const result = checked ? verdict(checked, problems, { anyHeld: missed.length < checked })
        : { status: 'fail', reason: `no corpus record of ${row.entity} was meshed${problems.length ? `: ${problems.join('; ')}` : ''}` };
      out.set(row.id, { ...result, evidence: carriers.map((f) => f.path) });
    }
    return out;
  },
};
