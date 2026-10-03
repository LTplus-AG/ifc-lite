/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { readSpaceEnvelope } from '@/lib/rooms/space-envelope-read';
import { routeCommandPointer } from '@/components/viewer/commandPointer';
import { routePlanPointer, resolvePlanSnap } from '@/components/viewer/plan/PlanPointer';
import type { MouseHandlerContext } from '@/components/viewer/mouseHandlerTypes';
import { setRequestRemesh } from '../transaction';
import { getCommandRuntime, updateCommandGesture, writeCommandField, commitCommand } from '../runtime';
import { SPACE_ENVELOPE, type SpaceEnvelopeGesture } from './space-envelope';
import '../builtin';

const s = () => useViewerStore.getState();
const gesture = () => getCommandRuntime().gesture as SpaceEnvelopeGesture;
const room = (modelId = MODEL_ID) => {
  const r = s().addSpace(modelId, STOREY, { Profile: 'polygon', OuterCurve: [[0, 0], [4, 0], [4, 3], [0, 3]], Position: [0, 0, 0], Height: 3 });
  assert.ok('expressId' in r, 'error' in r ? r.error : ''); return r.expressId;
};
const start = (id: number, modelId = MODEL_ID) => {
  s().setSelectedEntityId(toGlobalIdFromModels(s().models, modelId, id));
  s().startCommand(SPACE_ENVELOPE.id);
  assert.ok(gesture().target);
};
let restore: () => void;
beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.setState({ sectionPlane: { ...s().sectionPlane, enabled: false, custom: undefined, box: undefined } });
  restore = setRequestRemesh(() => {});
});
afterEach(() => { restore(); s().exitModelWorkspace(); });

/** Fake GPU picking only; the workplane, mesh-source adapter, shared solver,
 * pointer router, command runtime and mutation transaction are all real. */
function roofPointer(id: number) {
  let hidden: ReadonlySet<number> = new Set();
  const target = { x: 0, y: 4, z: -1.5 };
  const ctx = {
    renderer: {
      getCanvas: () => ({ width: 1000, height: 1000, getBoundingClientRect: () => ({ width: 1000, height: 1000 }) }),
      getCamera: () => ({ unprojectToRay: (x: number, y: number) => ({ origin: { x: x / 100, y: -y / 100, z: 10 }, direction: { x: 0, y: 0, z: -1 } }) }),
      raycastScene: () => null,
      raycastSceneMagnetic: (_x: number, _y: number, _lock: unknown, options: { hiddenIds: ReadonlySet<number> }) => {
        hidden = options.hiddenIds;
        return { snapTarget: { type: 'vertex', position: target, expressId: 9000 }, intersection: { point: target, expressId: 9000 },
          edgeLock: { edge: null, meshExpressId: null, edgeT: 0, shouldLock: false, shouldRelease: false, isCorner: false, cornerValence: 0 } };
      },
    },
    getPickOptions: () => ({ isStreaming: false, hiddenIds: new Set(), isolatedIds: null }),
    edgeLockStateRef: { current: { edge: null, meshExpressId: null, lockStrength: 0 } },
    snapEnabledRef: { current: true }, setSnapTarget: () => {}, setEdgeLock: () => {}, clearEdgeLock: () => {},
    measureRaycastPendingRef: { current: false }, measureRaycastFrameRef: { current: null },
  } as unknown as MouseHandlerContext;
  return { ctx, excludesSpace: () => hidden.has(toGlobalIdFromModels(s().models, MODEL_ID, id)) };
}

describe('vertical space snapping (#6686)', () => {
  it('the split workspace plan cannot feed XY coordinates into a ceiling handle', () => {
    const id = room(); start(id);
    updateCommandGesture(g => ({ ...g as SpaceEnvelopeGesture, active: 0 }));
    const before = gesture();
    const input = { local: [10, 20] as const, metresPerPixel: 0.02, mods: { shiftKey: false, altKey: false }, snapping: true, planSources: [] };
    assert.equal(resolvePlanSnap(input), null);
    for (const kind of ['move', 'down', 'up'] as const) assert.equal(routePlanPointer(kind, input), true);
    assert.equal(gesture(), before);
    assert.equal(readSpaceEnvelope(modelEditTarget(s(), MODEL_ID)!, id)!.envelope.ceiling[0].c, 3);
  });

  it('a real pointer route snaps to a roof vertex, excludes the editable space and commits its height', () => {
    const id = room();
    useViewerStore.setState({ sectionPlane: { ...s().sectionPlane, enabled: true, axis: 'front' } });
    start(id);
    updateCommandGesture(g => ({ ...g as SpaceEnvelopeGesture, active: 0 }));
    const pointer = roofPointer(id);
    routeCommandPointer(pointer.ctx, 'down', 3, -397, { shiftKey: false, altKey: false });
    assert.ok(pointer.excludesSpace());
    const read = readSpaceEnvelope(modelEditTarget(s(), MODEL_ID)!, id)!;
    assert.ok(read); assert.equal(read.envelope.ceiling[0].c, 4);
  });

  it('Alt bypasses roof snapping while keeping the vertical handle constraint', () => {
    const id = room(); start(id);
    updateCommandGesture(g => ({ ...g as SpaceEnvelopeGesture, active: 0 }));
    const pointer = roofPointer(id);
    routeCommandPointer(pointer.ctx, 'down', 3, -397, { shiftKey: false, altKey: true });
    const read = readSpaceEnvelope(modelEditTarget(s(), MODEL_ID)!, id)!;
    assert.ok(Math.abs(read.envelope.ceiling[0].c - 3.97) < 1e-6);
  });

  it('typed elevations stay fixed when the pointer moves over the viewport', () => {
    const id = room(); start(id);
    writeCommandField(1, 4);
    assert.equal(gesture().active, null);
    assert.equal(commitCommand(), true);
    assert.equal(readSpaceEnvelope(modelEditTarget(s(), MODEL_ID)!, id)!.envelope.ceiling[0].c, 4);
  });

  it('targets an overlay space in a second model, preserving the first model and global selection', () => {
    const first = room();
    const base = s().models.get(MODEL_ID)!;
    const second = 'second';
    useViewerStore.setState({ models: new Map([...s().models, [second, { ...base, id: second, idOffset: 1_000_000 }]]) });
    modelEditTarget(s(), second);
    const id = room(second); start(id, second);
    writeCommandField(1, 4); assert.equal(commitCommand(), true);
    const read = readSpaceEnvelope(modelEditTarget(s(), second)!, id)!;
    assert.equal(read.envelope.ceiling[0].c, 4);
    assert.equal(readSpaceEnvelope(modelEditTarget(s(), MODEL_ID)!, first)!.envelope.ceiling[0].c, 3);
    assert.equal(s().selectedEntityId, toGlobalIdFromModels(s().models, second, id));
    assert.equal(s().resolveGlobalIdFromModels(s().selectedEntityId!)?.modelId, second);
  });

  it('uses the face-picked section equation and maps moved model heights back to IFC', () => {
    const id = room();
    useViewerStore.setState({ modelPlacement: { ...s().modelPlacement, placements: new Map([[MODEL_ID, {
      translation: [10, 20, 5], rotation: { angle: Math.PI / 3, pivot: [0, 0, 0] }, locked: false,
    }]]) } });
    // A custom vertical section in the model's rotated front direction.
    const normal: [number, number, number] = [-Math.sin(Math.PI / 3), 0, Math.cos(Math.PI / 3)];
    const distance = normal[0] * 10 + normal[2] * -20;
    useViewerStore.setState({ sectionPlane: { ...s().sectionPlane, enabled: true, custom: {
      normal, distance, pickedAt: [10, 5, -20], tangent: [0, 1, 0], bitangent: [1, 0, 0],
    } } });
    start(id);
    const plane = getCommandRuntime().ctx!.workplane!;
    const p = plane.localToRender([gesture().points[0][0], 4, 0]);
    assert.ok(Math.abs(p[0] * normal[0] + p[2] * normal[2] - distance) < 1e-6);
    assert.ok(Math.abs(plane.renderToLocal(p)[1] - 4) < 1e-6);
    assert.ok(Math.abs(p[1] - 9) < 1e-6, 'workspace height includes the moved model while IFC height does not');
    writeCommandField(1, 4); commitCommand();
    assert.ok(Math.abs(readSpaceEnvelope(modelEditTarget(s(), MODEL_ID)!, id)!.envelope.ceiling[0].c - 4) < 1e-6);
  });

  it('a horizontal or invalid section refuses without writing', () => {
    const id = room();
    const view = s().mutationViews.get(MODEL_ID)!, before = view.getMutations().slice();
    useViewerStore.setState({ sectionPlane: { ...s().sectionPlane, enabled: true, axis: 'down' } });
    s().setSelectedEntityId(id); s().startCommand(SPACE_ENVELOPE.id);
    assert.equal(gesture().target, null); commitCommand();
    assert.deepEqual(view.getMutations(), before);
  });
});
