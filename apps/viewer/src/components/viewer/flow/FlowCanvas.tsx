/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The React Flow canvas over a `FlowDocument`. Every edit goes through
 * `lib/flow/editor-ops` and lands as a new document in the store; React
 * Flow is a view, not the source of truth.
 *
 * Because the canvas is fully controlled, *selection is part of the view
 * model too*: an edge whose `selected` flag is not fed back on the next
 * render is deselected by the very re-render its click caused, which is
 * why clicking an edge and pressing Delete used to do nothing at all. The
 * selected edge is held here (it is view state, not document state) and
 * written back into `toCanvas`.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { isAssignable, type FlowDocument, type NodeRegistry, type NodeReport } from '@ifc-lite/flow';
import { connect, disconnect, moveNode, portTypes, removeNode } from '@/lib/flow/editor-ops';
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
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const { nodes, edges } = useMemo(
    () => toCanvas(doc, registry, reports, selectedNodeId, selectedEdgeId),
    [doc, registry, reports, selectedNodeId, selectedEdgeId],
  );
  /** Set while an edge endpoint is being dragged, so a drop on empty canvas can delete it. */
  const reconnected = useRef(false);

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
    if (selection !== undefined) {
      onSelect(selection);
      // Selecting a node clears the edge selection, so Delete cannot remove
      // an edge the user stopped pointing at two clicks ago.
      if (selection !== null) setSelectedEdgeId(null);
    }
  }, [doc, onDocChange, onSelect]);

  const onEdgesChange = useCallback((changes: EdgeChange<CanvasEdge>[]) => {
    let next = doc;
    for (const c of changes) {
      if (c.type === 'select') {
        setSelectedEdgeId((current) => (c.selected ? c.id : current === c.id ? null : current));
        continue;
      }
      if (c.type !== 'remove') continue;
      const edge = edges.find((e) => e.id === c.id);
      if (edge?.targetHandle) next = disconnect(next, edge.target, edge.targetHandle);
      setSelectedEdgeId((current) => (current === c.id ? null : current));
    }
    if (next !== doc) onDocChange(next);
  }, [doc, edges, onDocChange]);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
    const result = connect(doc, registry, { from: [c.source, c.sourceHandle], to: [c.target, c.targetHandle] });
    if (result.error) onConnectError(result.error);
    else onDocChange(result.doc);
  }, [doc, registry, onDocChange, onConnectError]);

  /**
   * Dragging either end of an existing edge onto another port. The old edge
   * is dropped first so re-pointing an edge at a *different* input does not
   * leave the original behind, and the new one is validated exactly like a
   * fresh connection — a rejected reconnect restores the document untouched.
   */
  const onReconnect = useCallback((oldEdge: Edge, c: Connection) => {
    reconnected.current = true;
    if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
    const without = oldEdge.targetHandle ? disconnect(doc, oldEdge.target, oldEdge.targetHandle) : doc;
    const result = connect(without, registry, { from: [c.source, c.sourceHandle], to: [c.target, c.targetHandle] });
    if (result.error) onConnectError(result.error);
    else onDocChange(result.doc);
  }, [doc, registry, onDocChange, onConnectError]);

  const onReconnectStart = useCallback(() => { reconnected.current = false; }, []);

  /** Dropped on empty canvas: that is how a graph editor unplugs a wire. */
  const onReconnectEnd = useCallback((_e: MouseEvent | TouchEvent, edge: Edge) => {
    if (reconnected.current || !edge.targetHandle) return;
    onDocChange(disconnect(doc, edge.target, edge.targetHandle));
  }, [doc, onDocChange]);

  /**
   * Live feedback while dragging: React Flow greys out the handles this
   * returns false for, so an incompatible port is visible before the drop
   * rather than as an error message after it.
   */
  const isValidConnection = useCallback<IsValidConnection<CanvasEdge>>((c) => {
    if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle || c.source === c.target) return false;
    const { out, inp } = portTypes(doc, registry, c.source, c.sourceHandle, c.target, c.targetHandle);
    return out !== undefined && inp !== undefined && isAssignable(out, inp);
  }, [doc, registry]);

  return (
    <div className="h-full min-h-0 w-full min-w-0" data-flow-canvas>
    <ReactFlow<CanvasNode, CanvasEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onReconnect={onReconnect}
      onReconnectStart={onReconnectStart}
      onReconnectEnd={onReconnectEnd}
      isValidConnection={isValidConnection}
      // The reconnect grab-handle is a circle of this radius, centred that
      // far in from the edge's end — so the default 10 puts its centre a
      // couple of screen pixels from the port handle at fit-view zoom, and
      // the handle (a DOM node, drawn above the edge SVG) swallows the
      // press. 18 puts it clearly on the wire and is a bigger target.
      reconnectRadius={18}
      onPaneClick={() => { onSelect(null); setSelectedEdgeId(null); }}
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
