/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * In the Model workspace the select tool's move gizmo gives way to the Move /
 * Rotate handles, which start the commands on the selection (#6232 C2).
 * Outside it the gizmo is what it was, and there are no handles.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { cleanup, click, render } from '@/test/render.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin.js';
import { SelectEditScene } from './SelectEditScene';

function seedSelectedColumn(): void {
  const s = useViewerStore.getState();
  const column = s.addColumn(MODEL_ID, STOREY, { Position: [1, 1, 0], Width: 0.3, Depth: 0.3, Height: 3 });
  assert.ok('expressId' in column);
  const globalId = toGlobalIdFromModels(s.models, MODEL_ID, column.expressId);
  const mesh: MeshData = {
    expressId: globalId,
    positions: new Float32Array([0.85, 0, -0.85, 1.15, 0, -1.15, 1, 3, -1]),
    normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
  };
  const model = s.models.get(MODEL_ID)!;
  const geometryResult = { ...model.geometryResult!, meshes: [mesh] };
  useViewerStore.setState({
    models: new Map([[MODEL_ID, { ...model, geometryResult }]]),
    geometryResult,
    cameraCallbacks: { ...s.cameraCallbacks, projectToScreen: (p) => ({ x: 200 + p.x * 20, y: 200 - p.y * 20 }) },
  });
  useViewerStore.getState().setSelectedEntityIds([globalId]);
  useViewerStore.getState().setSelectedEntity({ modelId: MODEL_ID, expressId: column.expressId });
}

beforeEach(async () => {
  await seedModelingSession();
  seedSelectedColumn();
});
afterEach(() => {
  cleanup();
  useViewerStore.getState().exitModelWorkspace();
});

describe('TransformHandles (#6232 C2)', () => {
  it('outside the Model workspace the move gizmo shows and the handles do not', () => {
    const host = render(<SelectEditScene />);
    assert.ok(host.querySelector('#gizmo-arrow-x'), 'the gizmo is unchanged');
    assert.equal(host.querySelector('[data-transform-handles]') === null, true, 'no handles outside the workspace');
  });

  it('in the workspace the handles replace the gizmo and start Move / Rotate on the selection', () => {
    assert.ok(useViewerStore.getState().enterModelWorkspace());
    useViewerStore.getState().setActiveTool('select');
    const host = render(<SelectEditScene />);
    // Compare booleans: a failing assert.equal would try to print the whole SVG element.
    assert.equal(host.querySelector('#gizmo-arrow-x') === null, true, 'no free-drag gizmo in the workspace');
    const move = host.querySelector('[data-transform-handle="element.move"]');
    const rotate = host.querySelector('[data-transform-handle="element.rotate"]');
    assert.equal(move !== null && rotate !== null, true, 'both handles show');

    assert.ok(rotate, 'the rotate handle shows');
    click(rotate);
    assert.equal(useViewerStore.getState().session?.activeCommandId, 'element.rotate');
  });
});
