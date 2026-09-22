/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The React Flow canvas over a `FlowDocument`. Every edit goes through
 * `lib/flow/editor-ops` and lands as a new document in the store; React
 * Flow is a view, not the source of truth.
 */

import { useCallback, useMemo } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { FlowDocument, NodeRegistry, NodeReport } from '@ifc-lite/flow';
import { connect, disconnect, moveNode, removeNode } from '@/lib/flow/editor-ops';
import { toCanvas, type CanvasEdge, type CanvasNode } from '@/lib/flow/view-model';
import { FlowNodeView } from './FlowNodeView';

const NODE_TYPES = { flow: FlowNodeView };

export interface FlowCanvasProps {
  readonly doc: FlowDocument;
  readonly registry: NodeRegistry<unknown>;
  readonly reports?: ReadonlyMap<string, NodeReport>;
  readonly selectedNodeId: string | null;
  readonly onDocChange: (doc: FlowDocument) => void;
  readonly onSelect: (nodeId: string | null) => void;
  readonly onConnectError: (message: string) => void;
}

/** Must render inside a `ReactFlowProvider` (the panel owns it so the palette can share it). */
export function FlowCanvas(props: FlowCanvasProps) {
  const { doc, registry, reports, selectedNodeId, onDocChange, onSelect, onConnectError } = props;
  const { nodes, edges } = useMemo(() => toCanvas(doc, registry, reports, selectedNodeId), [doc, registry, reports, selectedNodeId]);

  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    let next = doc;
    let selection: string | null | undefined;
    for (const c of changes) {
      // Controlled canvas: every drag step lands in the document, else the node would not follow the pointer.
      if (c.type === 'position' && c.position) next = moveNode(next, c.id, [Math.round(c.position.x), Math.round(c.position.y)]);
      else if (c.type === 'remove') next = removeNode(next, c.id);
      else if (c.type === 'select') selection = c.selected ? c.id : selection === undefined ? null : selection;
    }
    if (next !== doc) onDocChange(next);
    if (selection !== undefined) onSelect(selection);
  }, [doc, onDocChange, onSelect]);

  const onEdgesChange = useCallback((changes: EdgeChange<CanvasEdge>[]) => {
    let next = doc;
    for (const c of changes) {
      if (c.type !== 'remove') continue;
      const edge = edges.find((e) => e.id === c.id);
      if (edge?.targetHandle) next = disconnect(next, edge.target, edge.targetHandle);
    }
    if (next !== doc) onDocChange(next);
  }, [doc, edges, onDocChange]);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
    const result = connect(doc, registry, { from: [c.source, c.sourceHandle], to: [c.target, c.targetHandle] });
    if (result.error) onConnectError(result.error);
    else onDocChange(result.doc);
  }, [doc, registry, onDocChange, onConnectError]);

  return (
    <div className="h-full min-h-0 w-full min-w-0" data-flow-canvas>
    <ReactFlow<CanvasNode, CanvasEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onPaneClick={() => onSelect(null)}
      fitView
      minZoom={0.2}
      maxZoom={2}
      deleteKeyCode={['Backspace', 'Delete']}
      proOptions={{ hideAttribution: true }}
      colorMode="system"
    >
      <Background gap={16} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
    </div>
  );
}

/** Where a palette-added node lands: the centre of the current viewport. */
export function useCanvasDropPosition(): () => [number, number] {
  const rf = useReactFlow();
  return useCallback(() => {
    const { x, y, zoom } = rf.getViewport();
    const el = document.querySelector<HTMLElement>('.react-flow');
    const w = el?.clientWidth ?? 800;
    const h = el?.clientHeight ?? 400;
    return [Math.round((w / 2 - x) / zoom - 75), Math.round((h / 2 - y) / zoom - 20)];
  }, [rf]);
}
