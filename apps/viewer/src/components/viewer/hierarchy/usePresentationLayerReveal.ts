/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, type RefObject } from 'react';
import { useViewerStore } from '@/store';
import type { TreeNode } from './types';

/** Layer headers are roots: reveal the exact assignment, not its first product. */
export function usePresentationLayerReveal(
  nodes: TreeNode[],
  container: RefObject<HTMLDivElement | null>,
  virtualizer: { scrollToIndex(index: number, options: { align: 'auto' }): void; getVirtualItems(): { index: number }[] },
  setSearchQuery: (query: string) => void,
) {
  const request = useViewerStore(s => s.pendingPresentationLayerReveal);
  const mode = useViewerStore(s => s.hierarchyMode);
  const rendered = virtualizer.getVirtualItems().map(item => item.index).join(',');
  useEffect(() => { if (request) setSearchQuery(''); }, [request, setSearchQuery]);
  useEffect(() => {
    if (!request || mode !== 'presentation-layers') return;
    const index = nodes.findIndex(node => node.id === request.nodeId);
    if (index < 0) return; // Metadata/lazy tree code may still be loading.
    virtualizer.scrollToIndex(index, { align: 'auto' });
    const row = [...(container.current?.querySelectorAll<HTMLElement>('[data-node-id]') ?? [])]
      .find(element => element.dataset.nodeId === request.nodeId);
    if (!row) return; // Retry after the virtualizer materialises the row.
    row.focus();
    if (useViewerStore.getState().pendingPresentationLayerReveal === request) {
      useViewerStore.setState({ pendingPresentationLayerReveal: null });
    }
  }, [request, mode, nodes, container, virtualizer, rendered]);
}
