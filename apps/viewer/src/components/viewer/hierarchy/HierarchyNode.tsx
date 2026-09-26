/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChevronRight, Layers, Eye, EyeOff, FileBox } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { isNoGeometryNode, isSpatialContainer, type TreeNode } from './types';
import { CountBadgeTooltip } from './CountBadgeTooltip';
import { IFC_ICON_CODEPOINTS, IFC_ICON_DEFAULT } from './ifc-icons';
import { ModelTagGroupRow } from './ModelTagGroupRow';
import { ModelHeaderRow } from './ModelHeaderRow';
import { ModelBadge } from '../ModelBadge';

/**
 * Resolve the Material Symbols code point for a given IFC type string.
 * Falls back to the generic product icon for unmapped classes.
 */
function getIfcIconCodepoint(ifcType: string | undefined): string {
  if (!ifcType) return IFC_ICON_DEFAULT;
  return IFC_ICON_CODEPOINTS[ifcType] ?? IFC_ICON_DEFAULT;
}

/** Lucide fallback icons for non-IFC node types */
const NODE_TYPE_ICONS: Record<string, React.ElementType> = {
  'unified-storey': Layers,
  'model-header': FileBox,
};

/** Indent per tree level. 12 px (was 16) still reads as a hierarchy and gives
 *  a storey row 12 px more for its name (#5394). */
const HIERARCHY_INDENT_STEP_PX = 12;

export interface HierarchyNodeProps {
  node: TreeNode;
  virtualRow: { size: number; start: number };
  isSelected: boolean;
  nodeHidden: boolean;
  isMultiModel: boolean;
  modelsCount: number;
  searchActive?: boolean;
  modelVisible?: boolean;
  onNodeClick: (node: TreeNode, e: React.MouseEvent | React.KeyboardEvent) => void;
  onToggleExpand: (nodeId: string) => void;
  onVisibilityToggle: (node: TreeNode) => void;
  onModelVisibilityToggle: (modelId: string, e: React.MouseEvent) => void;
  onRemoveModel: (modelId: string, e: React.MouseEvent) => void;
  onSyncSourceModel?: (modelId: string, e: React.MouseEvent) => void;
  onModelHeaderClick: (modelId: string, nodeId: string, hasChildren: boolean) => void;
  sourceBacked?: boolean;
  sourceSyncing?: boolean;
}

export function HierarchyNode({
  node,
  virtualRow,
  isSelected,
  nodeHidden,
  isMultiModel,
  modelsCount,
  searchActive = false,
  modelVisible,
  onNodeClick,
  onToggleExpand,
  onVisibilityToggle,
  onModelVisibilityToggle,
  onRemoveModel,
  onSyncSourceModel,
  onModelHeaderClick,
  sourceBacked = false,
  sourceSyncing = false,
}: HierarchyNodeProps) {
  const { t, locale } = useTranslation();
  const resolvedType = node.ifcType || node.type;
  // Use Lucide icon for non-IFC structural nodes, Material Symbols for IFC classes
  const LucideIcon = NODE_TYPE_ICONS[node.type];
  const iconCodepoint = getIfcIconCodepoint(resolvedType);

  // Spatial containers, storeys, spaces, and grouping headers get the emphasized
  // label treatment; element rows stay lighter.
  const primaryNameClass =
    isSpatialContainer(node.type) ||
    node.type === 'IfcBuildingStorey' ||
    node.type === 'IfcSpace' ||
    node.type === 'IfcSpatialZone' ||
    node.type === 'unified-storey' ||
    node.type === 'type-group' ||
    node.type === 'material-group' ||
    node.type === 'group' ||
    node.type === 'other-group'
      ? 'font-medium text-zinc-900 dark:text-zinc-100'
      : 'text-zinc-700 dark:text-zinc-300';
  const strikeWhenHidden = nodeHidden && 'line-through decoration-zinc-400 dark:decoration-zinc-600';
  const noGeometry = isNoGeometryNode(node);
  if (node.type === 'model-tag-group') return <ModelTagGroupRow node={node} virtualRow={virtualRow} />;
  // Model header nodes (for visibility control and expansion)
  if (node.type === 'model-header' && node.id.startsWith('model-')) {
    return (
      <ModelHeaderRow
        node={node}
        virtualRow={virtualRow}
        modelsCount={modelsCount}
        modelVisible={modelVisible}
        onModelVisibilityToggle={onModelVisibilityToggle}
        onRemoveModel={onRemoveModel}
        onSyncSourceModel={onSyncSourceModel}
        onModelHeaderClick={onModelHeaderClick}
        sourceBacked={sourceBacked}
        sourceSyncing={sourceSyncing}
      />
    );
  }

  // The visibility toggle shares the type icon's slot (#5394); spatial
  // containers in multi-model mode have none.
  const hasToggle = !(isMultiModel && isSpatialContainer(node.type));
  const iconClass = cn(
    'text-zinc-500 dark:text-zinc-400 transition-opacity',
    hasToggle && 'group-hover:opacity-0',
    hasToggle && nodeHidden && 'opacity-0',
  );

  // Regular node rendering (spatial hierarchy nodes and elements)
  return (
    <div
      // Query container for the badges below (#5394): its width is the tree
      // panel's, whatever the row's depth.
      className="@container"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: `${virtualRow.size}px`,
        transform: `translateY(${virtualRow.start}px)`,
      }}
    >
      <div
        role="treeitem"
        tabIndex={0}
        aria-level={node.depth + 1}
        aria-expanded={node.hasChildren ? node.isExpanded : undefined}
        aria-selected={isSelected}
        className={cn(
          'flex items-center gap-1 px-2 py-1.5 border-l-4 transition-all group hierarchy-item',
          // No selection styling for spatial containers in multi-model mode
          isMultiModel && isSpatialContainer(node.type)
            ? 'border-transparent cursor-default'
            : cn(
                'cursor-pointer',
                isSelected ? 'border-l-primary font-medium selected' : 'border-transparent'
              ),
          (nodeHidden || noGeometry) && 'opacity-50 grayscale'
        )}
        style={{
          paddingLeft: `${node.depth * HIERARCHY_INDENT_STEP_PX + 8}px`,
          // No selection highlighting for spatial containers in multi-model mode
          backgroundColor: isSelected && !(isMultiModel && isSpatialContainer(node.type))
            ? 'var(--hierarchy-selected-bg)' : undefined,
          color: isSelected && !(isMultiModel && isSpatialContainer(node.type))
            ? 'var(--hierarchy-selected-text)' : undefined,
        }}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button') === null) {
            onNodeClick(node, e);
          }
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          onNodeClick(node, e);
        }}
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest('button') === null) {
            e.preventDefault();
          }
        }}
      >
        {/* Expand/Collapse */}
        {node.hasChildren ? (
          <button
            disabled={searchActive}
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand(node.id);
            }}
            aria-label={
              node.isExpanded
                ? t('hierarchy.node.collapseAriaLabel', { name: node.name })
                : t('hierarchy.node.expandAriaLabel', { name: node.name })
            }
            aria-expanded={node.isExpanded}
            // 14px icon, `p-[5px]` a side: 14 + 2*5 = 24, the WCAG 2.2 2.5.8
            // minimum with no headroom to spare (#5826 review round) — grown
            // via padding (part of the button's own box) rather than a
            // pseudo-element slop, so normal flex flow keeps it from
            // overlapping the type-icon slot that follows.
            className="p-[5px] hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded-none mr-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 transition-transform duration-200',
                node.isExpanded && 'rotate-90'
              )}
            />
          </button>
        ) : (
          <div className="w-5" />
        )}

        {/* Type icon, with the visibility toggle overlaid in the same 14 px slot
            (#5394). The toggle used to reserve its own slot while invisible;
            now it replaces the icon on row hover, and stays shown while the node
            is hidden. Spatial containers in multi-model mode have no toggle. */}
        <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          <Tooltip>
            <TooltipTrigger asChild>
              {LucideIcon ? (
                <LucideIcon data-hierarchy-type-icon className={cn('h-3.5 w-3.5 shrink-0', iconClass)} />
              ) : (
                <span
                  data-hierarchy-type-icon
                  className={cn('material-symbols-outlined shrink-0 leading-none', iconClass)}
                  style={{ fontSize: '14px' }}
                  aria-hidden="true"
                >
                  {iconCodepoint}
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs">{resolvedType}</p>
            </TooltipContent>
          </Tooltip>
          {hasToggle && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onVisibilityToggle(node);
                  }}
                  aria-label={
                    node.isVisible
                      ? t('hierarchy.node.hideAriaLabel', { name: node.name })
                      : t('hierarchy.node.showAriaLabel', { name: node.name })
                  }
                  className={cn(
                    // The 14px slot itself is `inset-0`; `-inset-[5px]`
                    // grows the button's own box to 14 + 2*5 = 24, the WCAG
                    // 2.2 2.5.8 minimum (#5826). The type-icon slot's
                    // neighbours (the chevron before, the name after) sit
                    // >=8px away in normal flow, so this clears them.
                    'absolute -inset-[5px] flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring transition-opacity',
                    nodeHidden && 'opacity-100'
                  )}
                >
                  {node.isVisible ? (
                    <Eye className="h-3 w-3 text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100" />
                  ) : (
                    <EyeOff className="h-3 w-3 text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs">
                  {node.isVisible ? t('hierarchy.node.hide') : t('hierarchy.node.show')}
                </p>
              </TooltipContent>
            </Tooltip>
          )}
        </span>

        {/* Name (+ optional muted LongName for spatial nodes carrying an ISO
            19650 code in Name and the descriptive label in LongName, #1634) */}
        {node.secondaryName ? (
          <span
            className="flex-1 min-w-0 flex items-baseline text-sm ml-1.5"
            title={t('hierarchy.node.nameAndSecondaryTitle', { name: node.name, secondaryName: node.secondaryName ?? '' })}
          >
            {/* The Name takes its full width first and the LongName gets the
                rest (#5394). A 55% cap truncated a descriptive Name to make
                room for a LongName that was often an id; the #1634 case, a
                short ISO code, still leaves the LongName its room. */}
            <span className={cn('shrink-0 max-w-full truncate', primaryNameClass, strikeWhenHidden)}>
              {node.name}
            </span>
            <span className={cn('truncate min-w-0 ml-1.5 font-normal text-zinc-400 dark:text-zinc-500', strikeWhenHidden)}>
              {node.secondaryName}
            </span>
          </span>
        ) : (
          <span className={cn('flex-1 text-sm truncate ml-1.5', primaryNameClass, strikeWhenHidden)}>
            {node.name}
          </span>
        )}

        {isMultiModel && node.type !== 'model-header' && node.modelIds.length === 1 && (
          <ModelBadge modelId={node.modelId ?? node.modelIds[0]} className="max-w-24 shrink-0" />
        )}

        {node.ifcType && (node.type === 'element' || node.type === 'group-member') && (
          <span className="text-[10px] font-mono text-zinc-400 dark:text-zinc-500 truncate max-w-[90px]">
            {node.ifcType}
          </span>
        )}

        {/* Storey Elevation */}
        {node.storeyDisplayElevation !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[10px] font-mono bg-emerald-100 dark:bg-emerald-950 px-1.5 py-0.5 border border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400 rounded-none">
                {t('hierarchy.node.elevationBadge', {
                  sign: node.storeyDisplayElevation >= 0 ? '+' : '',
                  value: formatLocaleNumber(locale, node.storeyDisplayElevation, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                })}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs">
                {t('hierarchy.node.elevationTooltip', {
                  sign: node.storeyDisplayElevation >= 0 ? '+' : '',
                  value: formatLocaleNumber(locale, node.storeyDisplayElevation, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                })}
              </p>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Element Count */}
        {node.elementCount !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Yields first when the tree is narrow (#5394): below 18rem the
                  name needs the room more than the count does. */}
              <span data-hierarchy-count-badge className="hidden @2xs:inline text-[10px] font-mono bg-zinc-100 dark:bg-zinc-950 px-1.5 py-0.5 border border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 rounded-none">
                {formatLocaleNumber(locale, node.elementCount)}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <CountBadgeTooltip elementCount={node.elementCount} summary={node.countSummary} />
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
