/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { memo, useCallback } from 'react';
import { HierarchyNode, type HierarchyNodeProps } from './HierarchyNode';
import type { HierarchyRowAction } from './HierarchyRowActions';
import type { TreeNode } from './types';

export type HierarchyRowSection = 'filtered' | 'storeys' | 'models';
type ActivationEvent = React.MouseEvent | React.KeyboardEvent;

/** The panel's current row callbacks, read at call time. */
export interface HierarchyRowCallbacks {
  click: (node: TreeNode, event: ActivationEvent, section: HierarchyRowSection, index: number) => void;
  toggleExpand: HierarchyNodeProps['onToggleExpand'];
  visibilityToggle: HierarchyNodeProps['onVisibilityToggle'];
  action: (node: TreeNode, action: HierarchyRowAction) => void;
  modelVisibilityToggle: HierarchyNodeProps['onModelVisibilityToggle'];
  removeModel: HierarchyNodeProps['onRemoveModel'];
  syncSourceModel: NonNullable<HierarchyNodeProps['onSyncSourceModel']>;
  modelHeaderClick: HierarchyNodeProps['onModelHeaderClick'];
}

/**
 * Handlers with one identity for the panel's lifetime that call the latest
 * callbacks, so a row re-renders only when what it shows changes (#10535).
 */
export function stableRowHandlers(latest: { readonly current: HierarchyRowCallbacks }): HierarchyRowCallbacks {
  return {
    click: (node, event, section, index) => latest.current.click(node, event, section, index),
    toggleExpand: (nodeId) => latest.current.toggleExpand(nodeId),
    visibilityToggle: (node) => latest.current.visibilityToggle(node),
    action: (node, action) => latest.current.action(node, action),
    modelVisibilityToggle: (modelId, e) => latest.current.modelVisibilityToggle(modelId, e),
    removeModel: (modelId, e) => latest.current.removeModel(modelId, e),
    syncSourceModel: (modelId, e) => latest.current.syncSourceModel(modelId, e),
    modelHeaderClick: (modelId, nodeId, hasChildren) => latest.current.modelHeaderClick(modelId, nodeId, hasChildren),
  };
}

type RowValues = Omit<HierarchyNodeProps, 'virtualRow' | 'onNodeClick' | 'rowRef' | 'onRowFocus' | 'onToggleExpand'
  | 'onVisibilityToggle' | 'onAction' | 'onModelVisibilityToggle' | 'onRemoveModel' | 'onSyncSourceModel' | 'onModelHeaderClick'>;

export interface HierarchyRowProps extends RowValues {
  section: HierarchyRowSection;
  index: number;
  start: number;
  size: number;
  /** Stable for the panel's lifetime (`stableRowHandlers`). */
  handlers: HierarchyRowCallbacks;
  /** The section keyboard's stable row registration and focus callbacks. */
  registerRow: (nodeId: string, el: HTMLElement | null) => void;
  focusRow: (nodeId: string) => void;
}

function Row({ section, index, start, size, handlers, registerRow, focusRow, ...values }: HierarchyRowProps) {
  const { node } = values;
  // Stable so a re-render does not unregister and re-register the row element.
  const rowRef = useCallback((el: HTMLElement | null) => registerRow(node.id, el), [registerRow, node.id]);
  return <HierarchyNode {...values} virtualRow={{ start, size }} rowRef={rowRef} onRowFocus={() => focusRow(node.id)}
    onNodeClick={(_: TreeNode, event: ActivationEvent) => handlers.click(node, event, section, index)}
    onToggleExpand={handlers.toggleExpand} onVisibilityToggle={handlers.visibilityToggle} onAction={handlers.action}
    onModelVisibilityToggle={handlers.modelVisibilityToggle} onRemoveModel={handlers.removeModel}
    onSyncSourceModel={handlers.syncSourceModel} onModelHeaderClick={handlers.modelHeaderClick} />;
}

/**
 * A hierarchy row that skips rendering when its props are unchanged. Every
 * prop is a primitive, a shared tree row (`shareUnchangedNodes`), a shared
 * action list (`hierarchyRowActions`) or a stable callback.
 */
export const HierarchyRow = memo(Row);
