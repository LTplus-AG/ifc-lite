/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState } from 'react';
import type { SourceContainer } from '@ifc-lite/plugin-api';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { ChevronRight, Folder } from 'lucide-react';

export interface ContainerTreeNode extends SourceContainer {
  children: ContainerTreeNode[];
}

/** Nests the folders under `rootId` (a file area) into a tree, ignoring anything outside that subtree. */
export function buildContainerTree(containers: SourceContainer[], rootId: string): ContainerTreeNode[] {
  const byId = new Map<string, ContainerTreeNode>();
  for (const c of containers) byId.set(c.id, { ...c, children: [] });

  const roots: ContainerTreeNode[] = [];
  for (const c of containers) {
    if (c.id === rootId) continue;
    const node = byId.get(c.id)!;
    if (c.parentId === rootId) {
      roots.push(node);
    } else if (c.parentId) {
      byId.get(c.parentId)?.children.push(node);
    }
  }
  return roots;
}

export function buildContainerParentIndex(
  containers: SourceContainer[],
  rootId: string,
): Map<string, string> {
  const parents = new Map<string, string>();
  for (const container of containers) {
    if (!container.parentId || container.id === rootId) continue;
    parents.set(container.id, container.parentId);
  }
  return parents;
}

export function collectAncestorIds(
  parentById: ReadonlyMap<string, string>,
  nodeId: string | undefined,
  rootId: string,
): string[] {
  if (!nodeId || nodeId === rootId) return [];

  const ancestors: string[] = [];
  const seen = new Set<string>();
  let currentId = nodeId;

  for (;;) {
    const parentId = parentById.get(currentId);
    if (!parentId || parentId === rootId || seen.has(parentId)) break;
    ancestors.push(parentId);
    seen.add(parentId);
    currentId = parentId;
  }

  return ancestors;
}

interface SourceFolderTreeProps {
  /** All folders (and file areas) for the project — the tree scopes itself to descendants of `rootId`. */
  containers: SourceContainer[];
  /** The selected file area's id. Its direct folders render as the tree's top level. */
  rootId: string;
  selectedId?: string;
  activeIds?: ReadonlySet<string>;
  onSelect: (container: SourceContainer) => void;
}

export function SourceFolderTree({ containers, rootId, selectedId, activeIds, onSelect }: SourceFolderTreeProps) {
  const tree = useMemo(() => buildContainerTree(containers, rootId), [containers, rootId]);
  const parentById = useMemo(
    () => buildContainerParentIndex(containers, rootId),
    [containers, rootId],
  );
  const nodeIds = useMemo(() => new Set(containers.map((container) => container.id)), [containers]);
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setOpenIds((previous) => {
      const next = new Set<string>();
      for (const id of previous) {
        if (nodeIds.has(id)) next.add(id);
      }
      for (const id of collectAncestorIds(parentById, selectedId, rootId)) next.add(id);
      return areSetsEqual(previous, next) ? previous : next;
    });
  }, [nodeIds, parentById, rootId, selectedId]);

  if (tree.length === 0) {
    return (
      <div className="px-3 py-4 text-center text-sm text-muted-foreground">
        No subfolders
      </div>
    );
  }

  return (
    <div className="py-1">
      {tree.map((node) => (
        <TreeRow
          key={node.id}
          node={node}
          depth={0}
          openIds={openIds}
          selectedId={selectedId}
          activeIds={activeIds}
          onSelect={onSelect}
          onToggle={(id) =>
            setOpenIds((previous) => {
              const next = new Set(previous);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
        />
      ))}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  openIds,
  selectedId,
  activeIds,
  onSelect,
  onToggle,
}: {
  node: ContainerTreeNode;
  depth: number;
  openIds: ReadonlySet<string>;
  selectedId?: string;
  activeIds?: ReadonlySet<string>;
  onSelect: (container: SourceContainer) => void;
  onToggle: (id: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const open = openIds.has(node.id);
  const isSelected = selectedId === node.id;
  const isActive = activeIds?.has(node.id) ?? true;

  return (
    <Collapsible open={open}>
      <div
        className={cn(
          'flex w-full items-center gap-1 rounded-sm py-1 pr-2 text-sm hover:bg-accent',
          isSelected && 'bg-accent font-medium',
          !isActive && 'text-muted-foreground/60',
        )}
        style={{ paddingLeft: 4 + depth * 16 }}
      >
        <button
          type="button"
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-sm',
            !hasChildren && 'invisible',
          )}
          aria-label={hasChildren ? (open ? 'Collapse folder' : 'Expand folder') : undefined}
          disabled={!hasChildren}
          onClick={() => hasChildren && onToggle(node.id)}
        >
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
        </button>
        <button
          type="button"
          className={cn(
            'flex flex-1 items-center gap-2 truncate text-left',
            !isActive && 'cursor-default text-muted-foreground/60',
          )}
          disabled={!isActive}
          onClick={() => isActive && onSelect(node)}
        >
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{node.name}</span>
        </button>
      </div>
      {hasChildren && (
        <CollapsibleContent>
          {node.children.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              openIds={openIds}
              selectedId={selectedId}
              activeIds={activeIds}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

function areSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}
