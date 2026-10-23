/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TreeNode } from './types';

export type HierarchyVisibilityAction = 'show' | 'hide';

/** A mixed row offers Show, matching its toggle's existing reveal-all action.
 * Only a fully hidden row gets hidden styling. Assemblies use their drawable
 * parts: the shape-less owner's own id never determines visible appearance. */
export function hierarchyNodeVisibility(
  node: TreeNode,
  elements: readonly number[],
  hidden: ReadonlySet<number>,
): { nodeHidden: boolean; visibilityAction: HierarchyVisibilityAction } {
  const targets = node.assemblyChildGlobalIds?.length ? node.assemblyChildGlobalIds : elements;
  return {
    nodeHidden: targets.length > 0 && targets.every((id) => hidden.has(id)),
    visibilityAction: elements.some((id) => hidden.has(id)) ? 'show' : 'hide',
  };
}
