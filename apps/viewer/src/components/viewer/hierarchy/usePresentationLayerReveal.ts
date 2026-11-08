/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, type RefObject } from 'react';
import { useViewerStore } from '@/store';
import type { TreeNode } from './types';

/** Layer headers are roots: reveal the exact assignment, not its first product. */
export function usePresentationLayerReveal(
  nodes: TreeNode[], container: RefObject<HTMLDivElement | null>,
  virtualizer: { scrollToIndex(index: number, options: { align: 'auto' }): void; getVirtualItems?(): { index: number }[] },
  setSearchQuery?: (query: string) => void, searchQuery = '', ready = false,
) {
  const request = useViewerStore(s => s.pendingPresentationLayerReveal);
  const mode = useViewerStore(s => s.hierarchyMode);
  const selectionRevision = useViewerStore(s => s.selectionRevision);
  const models = useViewerStore(s => s.models);
  const store = useViewerStore(s => s.ifcDataStore);
  const rendered = virtualizer.getVirtualItems?.().map(item => item.index).join(',');
  useEffect(() => {
    if (!request) return;
    // A failed metadata/code load must not arm focus for some later file forever.
    const timeout = setTimeout(() => {
      if (useViewerStore.getState().pendingPresentationLayerReveal === request) {
        useViewerStore.setState({ pendingPresentationLayerReveal: null });
      }
    }, 30_000);
    return () => clearTimeout(timeout);
  }, [request]);
  useEffect(() => { if (request) setSearchQuery?.(''); }, [request, setSearchQuery]);
  useEffect(() => {
    if (!request || mode !== 'presentation-layers') return;
    const clear = () => {
      if (useViewerStore.getState().pendingPresentationLayerReveal === request) {
        useViewerStore.setState({ pendingPresentationLayerReveal: null });
      }
    };
    if (request.selectionRevision !== useViewerStore.getState().selectionRevision) { clear(); return; }
    if (request.modelId === 'legacy' ? !store : !models.has(request.modelId)) { clear(); return; }
    if (searchQuery) return; // Wait for the unfiltered tree, not the previous search result.
    const index = nodes.findIndex(node => node.id === request.nodeId);
    if (index < 0) {
      if (ready) clear(); // Fully loaded metadata cannot supply this deleted/missing layer.
      return;
    }
    virtualizer.scrollToIndex(index, { align: 'auto' });
    const row = [...(container.current?.querySelectorAll<HTMLElement>('[data-node-id]') ?? [])]
      .find(element => element.dataset.nodeId === request.nodeId);
    if (!row) return; // Retry after the virtualizer materialises the row.
    row.focus();
    clear();
  }, [request, mode, models, store, nodes, container, virtualizer, rendered, searchQuery, ready, selectionRevision]);
}
