/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { memo, useCallback, useMemo, type MutableRefObject } from 'react';
import { HierarchyNode, type HierarchyNodeProps } from './HierarchyNode';
import type { HierarchyRowAction } from './HierarchyRowActions';
import type { TreeNode } from './types';

export type HierarchyRowSection = 'filtered' | 'storeys' | 'models';

/** The panel's current row callbacks, read at call time. */
export interface HierarchyRowCallbacks {
  click: (node: TreeNode, event: React.MouseEvent | React.KeyboardEvent, section: HierarchyRowSection, index: number) => void;
  keyboards: Record<HierarchyRowSection, { registerRow: (nodeId: string, el: HTMLElement | null) => void; onRowFocus: (nodeId: string) => void }>;
  toggleExpand: HierarchyNodeProps['onToggleExpand'];
  visibilityToggle: HierarchyNodeProps['onVisibilityToggle'];
  action: (node: TreeNode, action: HierarchyRowAction) => void;
  modelVisibilityToggle: HierarchyNodeProps['onModelVisibilityToggle'];
  removeModel: HierarchyNodeProps['onRemoveModel'];
  syncSourceModel: NonNullable<HierarchyNodeProps['onSyncSourceModel']>;
  modelHeaderClick: HierarchyNodeProps['onModelHeaderClick'];
}

type StableHandlers = ReturnType<typeof stableRowHandlers>;

/**
 * Handlers with one identity for the panel's lifetime that call the latest
 * callbacks, so a row re-renders only when what it shows changes (#10535).
 */
export function stableRowHandlers(latest: MutableRefObject<HierarchyRowCallbacks>) {
  return {
    click: (node: TreeNode, event: React.MouseEvent | React.KeyboardEvent, section: HierarchyRowSection, index: number) =>
      latest.current.click(node, event, section, index),
    registerRow: (section: HierarchyRowSection, nodeId: string, el: HTMLElement | null) => latest.current.keyboards[section].registerRow(nodeId, el),
    focusRow: (section: HierarchyRowSection, nodeId: string) => latest.current.keyboards[section].onRowFocus(nodeId),
    toggleExpand: (nodeId: string) => latest.current.toggleExpand(nodeId),
    visibilityToggle: (node: TreeNode) => latest.current.visibilityToggle(node),
    action: (node: TreeNode, action: HierarchyRowAction) => latest.current.action(node, action),
    modelVisibilityToggle: (modelId: string, e: React.MouseEvent) => latest.current.modelVisibilityToggle(modelId, e),
    removeModel: (modelId: string, e: React.MouseEvent) => latest.current.removeModel(modelId, e),
    syncSourceModel: (modelId: string, e: React.MouseEvent) => latest.current.syncSourceModel(modelId, e),
    modelHeaderClick: (modelId: string, nodeId: string, hasChildren: boolean) => latest.current.modelHeaderClick(modelId, nodeId, hasChildren),
  };
}

type RowValues = Omit<HierarchyNodeProps, 'virtualRow' | 'onNodeClick' | 'rowRef' | 'onRowFocus' | 'onToggleExpand'
  | 'onVisibilityToggle' | 'onAction' | 'onModelVisibilityToggle' | 'onRemoveModel' | 'onSyncSourceModel' | 'onModelHeaderClick'>;

export interface HierarchyRowProps extends RowValues {
  section: HierarchyRowSection;
  index: number;
  start: number;
  size: number;
  handlers: StableHandlers;
}

function Row({ section, index, start, size, handlers, ...values }: HierarchyRowProps) {
  const { node } = values;
  const virtualRow = useMemo(() => ({ start, size }), [start, size]);
  const onNodeClick = useCallback((_: TreeNode, event: React.MouseEvent | React.KeyboardEvent) =>
    handlers.click(node, event, section, index), [handlers, node, section, index]);
  const rowRef = useCallback((el: HTMLElement | null) => handlers.registerRow(section, node.id, el), [handlers, section, node.id]);
  const onRowFocus = useCallback(() => handlers.focusRow(section, node.id), [handlers, section, node.id]);
  return <HierarchyNode {...values} virtualRow={virtualRow} onNodeClick={onNodeClick} rowRef={rowRef} onRowFocus={onRowFocus}
    onToggleExpand={handlers.toggleExpand} onVisibilityToggle={handlers.visibilityToggle} onAction={handlers.action}
    onModelVisibilityToggle={handlers.modelVisibilityToggle} onRemoveModel={handlers.removeModel}
    onSyncSourceModel={handlers.syncSourceModel} onModelHeaderClick={handlers.modelHeaderClick} />;
}

function sameActions(a: readonly HierarchyRowAction[] | undefined, b: readonly HierarchyRowAction[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((action, i) => action === b[i]);
}

function sameRow(previous: HierarchyRowProps, next: HierarchyRowProps): boolean {
  const keys = Object.keys(next) as (keyof HierarchyRowProps)[];
  if (keys.length !== Object.keys(previous).length) return false;
  return keys.every((key) => key === 'actions' ? sameActions(previous.actions, next.actions) : Object.is(previous[key], next[key]));
}

/** A hierarchy row that skips rendering when its node and state are unchanged. */
export const HierarchyRow = memo(Row, sameRow);
