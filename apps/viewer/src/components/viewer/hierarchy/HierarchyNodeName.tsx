/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { isSpatialContainer, type TreeNode } from './types';
import { NameWithTail } from './NameWithTail';

/** Spatial containers, storeys, spaces, and grouping headers get the
 *  emphasized label treatment; element rows stay lighter. */
function primaryNameClass(type: TreeNode['type']): string {
  return isSpatialContainer(type) ||
    type === 'IfcBuildingStorey' ||
    type === 'IfcSpace' ||
    type === 'IfcSpatialZone' ||
    type === 'unified-storey' ||
    type === 'type-group' ||
    type === 'material-group' ||
    type === 'presentation-layer' ||
    type === 'group' ||
    type === 'other-group'
    ? 'font-medium text-foreground'
    : 'text-foreground';
}

/**
 * A row's label: the Name first, an optional muted LongName (spatial nodes
 * carrying an ISO 19650 code in Name and the descriptive label in LongName,
 * #1634), then the IFC class suffix, which truncates first (#8802). The Name
 * keeps its distinguishing end in both layouts: siblings that differ only at
 * the end must not read the same (#8802).
 */
export function HierarchyNodeName({ node, nodeHidden }: { node: TreeNode; nodeHidden: boolean }) {
  const { t } = useTranslation();
  const nameClass = cn(primaryNameClass(node.type), nodeHidden && 'line-through decoration-muted-foreground');
  const showClassSuffix = Boolean(node.ifcType) && (node.type === 'element' || node.type === 'group-member');
  // The IFC class is a quiet trailing suffix with no basis of its own, so it
  // only takes room the name (and LongName) leave and truncates first (#8802).
  const classSuffix = showClassSuffix ? (
    <span data-hierarchy-class-suffix className="ml-1.5 min-w-0 flex-1 basis-0 truncate text-right text-2xs font-mono text-muted-foreground">
      {node.ifcType}
    </span>
  ) : null;
  const suffixTitle = showClassSuffix ? ` · ${node.ifcType}` : '';

  if (!node.secondaryName) {
    return (
      <span className="ml-1.5 flex min-w-0 flex-1 items-baseline text-row" title={`${node.name}${suffixTitle}`}>
        <NameWithTail name={node.name} className={nameClass} />
        {classSuffix}
      </span>
    );
  }
  return (
    <span
      className="flex-1 min-w-0 flex items-baseline text-row ml-1.5"
      title={`${t('hierarchy.node.nameAndSecondaryTitle', { name: node.name, secondaryName: node.secondaryName })}${suffixTitle}`}
    >
      {/* The Name takes its full width first and the LongName gets the rest
          (#5394). A 55% cap truncated a descriptive Name to make room for a
          LongName that was often an id; the #1634 case, a short ISO code,
          still leaves the LongName its room. */}
      <NameWithTail name={node.name} className={cn('shrink-0 max-w-full', nameClass)} />
      <span className={cn('truncate min-w-0 ml-1.5 font-normal text-muted-foreground', nodeHidden && 'line-through decoration-muted-foreground')}>
        {node.secondaryName}
      </span>
      {classSuffix}
    </span>
  );
}
