/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  ChevronRight,
  Layers,
  Eye,
  EyeOff,
  FileBox,
  X,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { TreeNode } from './types';
import { isSpatialContainer } from './types';
import { IFC_ICON_CODEPOINTS, IFC_ICON_DEFAULT } from './ifc-icons';

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

export interface HierarchyNodeProps {
  node: TreeNode;
  virtualRow: { size: number; start: number };
  isSelected: boolean;
  nodeHidden: boolean;
  isMultiModel: boolean;
  modelsCount: number;
  modelVisible?: boolean;
  onNodeClick: (node: TreeNode, e: React.MouseEvent) => void;
  onToggleExpand: (nodeId: string) => void;
  onVisibilityToggle: (node: TreeNode) => void;
  onModelVisibilityToggle: (modelId: string, e: React.MouseEvent) => void;
  onRemoveModel: (modelId: string, e: React.MouseEvent) => void;
  onModelHeaderClick: (modelId: string, nodeId: string, hasChildren: boolean) => void;
}

export function HierarchyNode({
  node,
  virtualRow,
  isSelected,
  nodeHidden,
  isMultiModel,
  modelsCount,
  modelVisible,
  onNodeClick,
  onToggleExpand,
  onVisibilityToggle,
  onModelVisibilityToggle,
  onRemoveModel,
  onModelHeaderClick,
}: HierarchyNodeProps) {
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
    node.type === 'material-group'
      ? 'font-medium text-zinc-900 dark:text-zinc-100'
      : 'text-zinc-700 dark:text-zinc-300';
  const strikeWhenHidden = nodeHidden && 'line-through decoration-zinc-400 dark:decoration-zinc-600';

  // Model header nodes (for visibility control and expansion)
  if (node.type === 'model-header' && node.id.startsWith('model-')) {
    const modelId = node.modelIds[0];

    return (
      <div
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
          className={cn(
            'flex items-center gap-1 px-2 py-1.5 border-l-4 transition-all group',
            'hover:bg-zinc-50 dark:hover:bg-zinc-900',
            'border-transparent',
            !modelVisible && 'opacity-50',
            node.hasChildren && 'cursor-pointer'
          )}
          style={{ paddingLeft: '8px' }}
          onClick={() => onModelHeaderClick(modelId, node.id, node.hasChildren)}
        >
          {/* Expand/collapse chevron */}
          {node.hasChildren ? (
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 text-zinc-400 transition-transform shrink-0',
                node.isExpanded && 'rotate-90'
              )}
            />
          ) : (
            <div className="w-3.5" />
          )}

          <FileBox className="h-3.5 w-3.5 text-primary shrink-0" />
          <span className="flex-1 text-sm truncate ml-1.5 text-zinc-900 dark:text-zinc-100">
            {node.name}
          </span>

          {node.elementCount !== undefined && (
            <span className="text-[10px] font-mono bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-zinc-500 dark:text-zinc-400 rounded-none">
              {node.elementCount.toLocaleString()}
            </span>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onModelVisibilityToggle(modelId, e);
                }}
                className="p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                {modelVisible ? (
                  <Eye className="h-3.5 w-3.5 text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100" />
                ) : (
                  <EyeOff className="h-3.5 w-3.5 text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs">{modelVisible ? 'Hide model' : 'Show model'}</p>
            </TooltipContent>
          </Tooltip>

          {modelsCount > 1 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveModel(modelId, e);
                  }}
                  className="p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="h-3.5 w-3.5 text-zinc-400 hover:text-red-500" />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs">Remove model</p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    );
  }

  // Regular node rendering (spatial hierarchy nodes and elements)
  return (
    <div
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
        className={cn(
          'flex items-center gap-1 px-2 py-1.5 border-l-4 transition-all group hierarchy-item',
          // No selection styling for spatial containers in multi-model mode
          isMultiModel && isSpatialContainer(node.type)
            ? 'border-transparent cursor-default'
            : cn(
                'cursor-pointer',
                isSelected ? 'border-l-primary font-medium selected' : 'border-transparent'
              ),
          nodeHidden && 'opacity-50 grayscale'
        )}
        style={{
          paddingLeft: `${node.depth * 16 + 8}px`,
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
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest('button') === null) {
            e.preventDefault();
          }
        }}
      >
        {/* Expand/Collapse */}
        {node.hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand(node.id);
            }}
            className="p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded-none mr-1"
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

        {/* Visibility Toggle - hide for spatial containers (Project/Site/Building) in multi-model mode */}
        {!(isMultiModel && isSpatialContainer(node.type)) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onVisibilityToggle(node);
                }}
                className={cn(
                  'p-0.5 opacity-0 group-hover:opacity-100 transition-opacity mr-1',
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
                {node.isVisible ? 'Hide' : 'Show'}
              </p>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Type Icon */}
        <Tooltip>
          <TooltipTrigger asChild>
            {LucideIcon ? (
              <LucideIcon className="h-3.5 w-3.5 shrink-0 text-zinc-500 dark:text-zinc-400" />
            ) : (
              <span
                className="material-symbols-outlined shrink-0 leading-none text-zinc-500 dark:text-zinc-400"
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

        {/* Name (+ optional muted LongName for spatial nodes carrying an ISO
            19650 code in Name and the descriptive label in LongName, #1634) */}
        {node.secondaryName ? (
          <span
            className="flex-1 min-w-0 flex items-baseline text-sm ml-1.5"
            title={`${node.name} - ${node.secondaryName}`}
          >
            <span className={cn('shrink-0 max-w-[55%] truncate', primaryNameClass, strikeWhenHidden)}>
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

        {node.ifcType && node.type === 'element' && (
          <span className="text-[10px] font-mono text-zinc-400 dark:text-zinc-500 truncate max-w-[90px]">
            {node.ifcType}
          </span>
        )}

        {/* Storey Elevation */}
        {node.storeyElevation !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[10px] font-mono bg-emerald-100 dark:bg-emerald-950 px-1.5 py-0.5 border border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400 rounded-none">
                {node.storeyElevation >= 0 ? '+' : ''}{node.storeyElevation.toFixed(2)}m
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs">Elevation: {node.storeyElevation >= 0 ? '+' : ''}{node.storeyElevation.toFixed(2)}m</p>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Element Count */}
        {node.elementCount !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[10px] font-mono bg-zinc-100 dark:bg-zinc-950 px-1.5 py-0.5 border border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 rounded-none">
                {node.elementCount.toLocaleString()}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs">{node.elementCount.toLocaleString()} {node.elementCount === 1 ? 'element' : 'elements'}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

export interface SectionHeaderProps {
  icon: React.ElementType;
  title: string;
  count?: number;
}

export function SectionHeader({ icon: IconComponent, title, count }: SectionHeaderProps) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-zinc-100 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
      <IconComponent className="h-3.5 w-3.5 text-zinc-500" />
      <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
        {title}
      </span>
      {count !== undefined && (
        <span className="text-[10px] font-mono text-zinc-400 dark:text-zinc-500 ml-auto">
          {count}
        </span>
      )}
    </div>
  );
}
