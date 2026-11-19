/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { HierarchyNode, type HierarchyNodeProps } from './HierarchyNode';
import type { TreeNode } from './types';

export type HierarchyRowSection = 'filtered' | 'storeys' | 'models';
type ActivationEvent = React.MouseEvent | React.KeyboardEvent;

type NodeHandlers = Pick<HierarchyNodeProps, 'onToggleExpand' | 'onVisibilityToggle' | 'onModelVisibilityToggle'
  | 'onRemoveModel' | 'onModelHeaderClick'> & Required<Pick<HierarchyNodeProps, 'onAction' | 'onSyncSourceModel'>>;

/** The panel's current row callbacks, read at call time. */
export interface HierarchyRowCallbacks extends NodeHandlers {
  click: (node: TreeNode, event: ActivationEvent, section: HierarchyRowSection, index: number) => void;
}

/**
 * One forwarder per callback name, each calling the latest callback of that
 * name. Built here, not in the hook, so the forwarders close over only
 * `latest` and their name, never a render's callbacks.
 */
function forwardToLatest(latest: { readonly current: HierarchyRowCallbacks }, names: string[]): HierarchyRowCallbacks {
  return Object.fromEntries(names.map((key) => [key,
    (...args: unknown[]) => Reflect.apply(Reflect.get(latest.current, key), undefined, args)])) as unknown as HierarchyRowCallbacks;
}

/**
 * A handlers object for the panel's lifetime whose members call the callbacks
 * of the last committed render, so a row re-renders only when what it shows
 * changes (#10535). The object and each of its members are stable.
 */
export function useStableRowHandlers(callbacks: HierarchyRowCallbacks): HierarchyRowCallbacks {
  const latest = useRef(callbacks);
  // Published at commit, so a discarded render never leaves rows calling its callbacks.
  useLayoutEffect(() => { latest.current = callbacks; });
  return useState(() => forwardToLatest(latest, Object.keys(callbacks)))[0];
}

type RowValues = Omit<HierarchyNodeProps, 'virtualRow' | 'onNodeClick' | 'rowRef' | 'onRowFocus' | keyof NodeHandlers>;

export interface HierarchyRowProps extends RowValues {
  section: HierarchyRowSection;
  index: number;
  start: number;
  size: number;
  /** One object for the panel's lifetime (`useStableRowHandlers`). */
  handlers: HierarchyRowCallbacks;
  /** The section keyboard's stable row registration and focus callbacks. */
  registerRow: (nodeId: string, el: HTMLElement | null) => void;
  focusRow: (nodeId: string) => void;
}

function Row({ section, index, start, size, handlers, registerRow, focusRow, ...values }: HierarchyRowProps) {
  const { node } = values;
  const { click, ...nodeHandlers } = handlers;
  // Stable so a re-render does not unregister and re-register the row element.
  const rowRef = useCallback((el: HTMLElement | null) => registerRow(node.id, el), [registerRow, node.id]);
  return <HierarchyNode {...values} {...nodeHandlers} virtualRow={{ start, size }} rowRef={rowRef} onRowFocus={() => focusRow(node.id)}
    onNodeClick={(_: TreeNode, event: ActivationEvent) => click(node, event, section, index)} />;
}

/**
 * A hierarchy row that skips rendering when its props are unchanged. Every
 * prop is a primitive, a shared tree row (`shareUnchangedNodes`), a shared
 * action list (`hierarchyRowActions`) or a stable callback.
 */
export const HierarchyRow = memo(Row);
