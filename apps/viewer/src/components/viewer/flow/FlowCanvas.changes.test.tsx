/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, createRef, useImperativeHandle, useState } from 'react';
import { ReactFlowProvider, useReactFlowStoreApi } from '@xyflow/react';
import { createStandardRegistry } from '@ifc-lite/flow-nodes';
import { addNode, connect } from '@/lib/flow/editor-ops';
import { newFlowDocument } from '@/lib/flow/persistence';
import type { CanvasEdge, CanvasNode } from '@/lib/flow/view-model';
import { cleanup, render } from '@/test/render';
import { FlowCanvas } from './FlowCanvas.js';

afterEach(cleanup);

it('commits React Flow 13 node and edge changes to the controlled Flow document (#10840)', () => {
  const registry = createStandardRegistry();
  const source = addNode(newFlowDocument('Changes'), 'model.byType', [0, 0]);
  const target = addNode(source.doc, 'model.property', [200, 0]);
  const wired = connect(target.doc, registry, {
    from: [source.nodeId, 'entities'],
    to: [target.nodeId, 'entity'],
  });
  assert.equal(wired.error, undefined);

  const store = createRef<ReturnType<typeof useReactFlowStoreApi<CanvasNode, CanvasEdge>>>();
  function Editor() {
    const api = useReactFlowStoreApi<CanvasNode, CanvasEdge>();
    useImperativeHandle(store, () => api, [api]);
    const [doc, setDoc] = useState(wired.doc);
    const [selection, setSelection] = useState<string | null>(null);
    return <FlowCanvas
      doc={doc}
      registry={registry}
      selectedNodeId={selection}
      onDocChange={setDoc}
      onSelect={setSelection}
      onConnectError={assert.fail}
    />;
  }

  render(<ReactFlowProvider><Editor /></ReactFlowProvider>);
  const api = store.current;
  assert.ok(api);
  assert.equal(api.edgesStore.getState().edges.length, 1);
  const [edge] = api.edgesStore.getState().edges;

  act(() => api.optionsStore.getState().emitNodeChanges([
    { id: source.nodeId, type: 'position', position: { x: 17.4, y: 27.6 } },
    { id: source.nodeId, type: 'select', selected: true },
  ]));
  const moved = api.nodesStore.getState().nodes.find((node) => node.id === source.nodeId);
  assert.deepEqual(moved?.position, { x: 17, y: 28 });
  assert.equal(moved?.selected, true);

  act(() => api.optionsStore.getState().emitEdgeChanges([{ id: edge.id, type: 'select', selected: true }]));
  assert.equal(api.edgesStore.getState().edges[0].selected, true);
  act(() => api.optionsStore.getState().emitEdgeChanges([{ id: edge.id, type: 'remove' }]));
  assert.equal(api.edgesStore.getState().edges.length, 0);

  act(() => api.optionsStore.getState().emitNodeChanges([{ id: target.nodeId, type: 'remove' }]));
  assert.deepEqual(api.nodesStore.getState().nodes.map((node) => node.id), [source.nodeId]);
});
