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
 * Row handlers for the panel's lifetime that call the callbacks of the last
 * committed render, so a row re-renders only when what it shows changes (#10535).
 */
export function useStableRowHandlers(callbacks: HierarchyRowCallbacks): HierarchyRowCallbacks {
  const latest = useRef(callbacks);
  // Published at commit, so a discarded render never leaves rows calling its callbacks.
  useLayoutEffect(() => { latest.current = callbacks; });
  // Each handler read returns a forwarder to the latest callback of that name. The
  // target holds only the names, so the first render's closures are not kept; the
  // proxy presents exactly the callbacks interface, which the cast states.
  return useState(() => new Proxy(Object.fromEntries(Object.keys(callbacks).map((key) => [key, key])), {
    get: (names, key) => key in names ? (...args: unknown[]) => Reflect.apply(Reflect.get(latest.current, key), undefined, args) : undefined,
  }) as unknown as HierarchyRowCallbacks)[0];
}

type RowValues = Omit<HierarchyNodeProps, 'virtualRow' | 'onNodeClick' | 'rowRef' | 'onRowFocus' | keyof NodeHandlers>;

export interface HierarchyRowProps extends RowValues {
  section: HierarchyRowSection;
  index: number;
  start: number;
  size: number;
  /** Stable for the panel's lifetime (`useStableRowHandlers`). */
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
