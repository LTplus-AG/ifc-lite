/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The stream-end camera refit must not change when the robust-fit bounds are
// folded per streamed commit (scan) instead of all at once at stream end.
// Real corpus models, meshed by the real engine through the loader, are
// streamed in commits into one growing array; the refit runs on a real
// Camera both ways and must give the same pose, orbit anchor and bounds, bit
// for bit. Includes a model moved by a non-zero translation (per-element
// origin) and the retained kernel's union with instanced-shard bounds.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import type { MeshData } from '@ifc-lite/geometry';
import { NOOP_LOAD_TRACE } from '@ifc-lite/load-trace';
import { Camera, type Renderer } from '@ifc-lite/renderer';
import * as harness from '@/test/blank-ifc-loader-harness.js';
import { createRobustFitBoundsAccumulator, robustFitBoundsFull } from './robustFitBoundsAccumulator.js';
import { refitCompletedStreamBounds } from './streamingCompletionBounds.js';
import type { Bounds } from './streamingBounds.js';

const FIXTURES = ['ara3d/AC20-FZK-Haus.ifc', 'ara3d/duplex.ifc', 'ara3d/C20-Institute-Var-2.ifc', 'ara3d/dental_clinic.ifc', 'ara3d/advanced_model.ifc'];
const TRANSLATION: [number, number, number] = [1234.5, -567.25, 89.125];

type Pose = { position: unknown; target: unknown; anchor: unknown; sceneBounds: unknown; fitted: Bounds | null; policy: string | null };

function boundsOf(meshes: readonly MeshData[]): Bounds {
  const b = robustFitBoundsFull(meshes, { quiet: true })!.full;
  return { min: { ...b.min }, max: { ...b.max } };
}

/** Stream `meshes` in commits (the first fits the camera), then run the stream-end refit. */
function streamAndRefit(meshes: readonly MeshData[], perCommitScan: boolean, kernel: 'exact' | 'retained', instanced: Map<number, Bounds>): Pose {
  const camera = new Camera();
  const scene = { getInstancedEntityIds: () => [...instanced.keys()], getInstancedEntityBounds: (id: number) => instanced.get(id) ?? null };
  const renderer = { getCamera: () => camera, getScene: () => scene, getCanvas: () => ({ clientWidth: 1600, clientHeight: 1000 }) } as unknown as Renderer;
  const acc = { current: createRobustFitBoundsAccumulator() };
  const streamed: MeshData[] = [];
  let seed = 7, at = 0, commit = 0;
  while (at < meshes.length) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const n = 1 + (seed % 97);
    streamed.push(...meshes.slice(at, at + n)); at += n;
    if (commit++ === 0) {
      const early = acc.current.update(streamed, { streaming: true, quiet: true })!;
      camera.fitBoundsAdaptive(early.robust ?? early.full, { viewportShortPx: 1000 });
    } else if (perCommitScan) acc.current.scan(streamed);
  }
  const pos = camera.getPosition(), tgt = camera.getTarget();
  const lastFitPolicyKindRef = { current: null as 'compact' | 'linear' | null };
  const geometryBoundsRef = { current: null as unknown as Bounds };
  refitCompletedStreamBounds({ geometryKernel: kernel, renderer, capturedGeometry: streamed,
    cameraFittedRef: { current: true }, finalBoundsRefittedRef: { current: false }, robustFitAccRef: acc,
    cameraSnapshotRef: { current: { px: pos.x, py: pos.y, pz: pos.z, tx: tgt.x, ty: tgt.y, tz: tgt.z } },
    lastFitPolicyKindRef, geometryBoundsRef, trace: NOOP_LOAD_TRACE, notifyLinearFit: () => {} });
  return { position: { ...camera.getPosition() }, target: { ...camera.getTarget() }, anchor: camera.getOrbitAnchorBounds(),
    sceneBounds: camera.getSceneBounds(), fitted: geometryBoundsRef.current, policy: lastFitPolicyKindRef.current };
}

for (const name of FIXTURES) {
  const fixture = new URL(`../../../../../tests/models/${name}`, import.meta.url);
  const skip = !existsSync(fixture) ? `Run pnpm fixtures for ${name}.` : harness.skip;
  it(`${name}: the stream-end camera refit is identical with per-commit folding (as loaded, translated, and with instanced shards)`, { skip }, async () => {
    const bytes = new Uint8Array(readFileSync(fixture));
    const model = await harness.load(new File([bytes.buffer], name.split('/').pop()!, { lastModified: 1 }));
    const meshes = model.geometryResult?.meshes ?? [];
    assert.ok(meshes.length > 0, `${name}: the engine meshed it`);
    const translated = meshes.map((m) => {
      const o = m.origin ?? [0, 0, 0];
      return { ...m, origin: [o[0] + TRANSLATION[0], o[1] + TRANSLATION[1], o[2] + TRANSLATION[2]] as [number, number, number] };
    });
    // Instanced-shard bounds as the retained kernel unions them: boxes outside the flat geometry's extent.
    const box = boundsOf(meshes), span = Math.max(box.max.x - box.min.x, 1);
    const shards = new Map<number, Bounds>([[900001, { min: { x: box.max.x + span, y: box.min.y, z: box.min.z }, max: { x: box.max.x + 2 * span, y: box.max.y, z: box.max.z } }],
      [900002, { min: { x: box.min.x - 0.5 * span, y: box.min.y - span, z: box.min.z }, max: { x: box.min.x, y: box.min.y, z: box.max.z } }]]);
    const cases: Array<[string, readonly MeshData[], 'exact' | 'retained', Map<number, Bounds>]> = [
      ['as loaded', meshes, 'exact', new Map()],
      [`translated by ${TRANSLATION.join(', ')}`, translated, 'exact', new Map()],
      ['retained kernel with instanced shards', meshes, 'retained', shards],
    ];
    for (const [label, input, kernel, instanced] of cases) {
      const today = streamAndRefit(input, false, kernel, instanced);
      const folded = streamAndRefit(input, true, kernel, instanced);
      assert.deepEqual(folded, today, `${name}, ${label}: same camera pose, orbit anchor, scene bounds and fitted bounds`);
      const full = robustFitBoundsFull(input, { quiet: true })!;
      if (kernel === 'exact') assert.deepEqual(today.fitted, full.robust ?? full.full, `${name}, ${label}: the fitted bounds are the full rescan's`);
    }
  });
}
