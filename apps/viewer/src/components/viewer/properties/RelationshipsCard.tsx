/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Relationships display component for IFC element structural relationships.
 */

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Link2, Focus } from 'lucide-react';
import type { EntityRelationships } from '@ifc-lite/parser';

interface RelationshipsCardProps {
  relationships: EntityRelationships;
  onSelectEntity?: (entityId: number) => void;
  /** Isolate + select all member objects of a group/zone in 3D (#1075). */
  onIsolateGroupMembers?: (groupId: number) => void;
}

export function RelationshipsCard({ relationships, onSelectEntity, onIsolateGroupMembers }: RelationshipsCardProps) {
  const { voids, fills, groups, connections } = relationships;
  const totalCount = voids.length + fills.length + groups.length + connections.length;

  if (totalCount === 0) return null;

  return (
    <Collapsible defaultOpen className="border-2 border-zinc-300 dark:border-zinc-700 bg-zinc-50/20 dark:bg-zinc-950/20 w-full max-w-full overflow-hidden">
      <CollapsibleTrigger className="flex items-center gap-2 w-full p-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-800/30 text-left transition-colors overflow-hidden">
        <Link2 className="h-3.5 w-3.5 text-zinc-600 dark:text-zinc-400 shrink-0" />
        <span className="font-bold text-xs text-zinc-700 dark:text-zinc-300 truncate flex-1 min-w-0">
          Relationships
        </span>
        <span className="text-[10px] font-mono bg-zinc-200 dark:bg-zinc-800 px-1.5 py-0.5 border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 shrink-0">
          {totalCount}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t-2 border-zinc-300 dark:border-zinc-700 divide-y divide-zinc-200 dark:divide-zinc-800">
          {voids.length > 0 && (
            <div className="px-3 py-2">
              <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">
                Openings ({voids.length})
              </div>
              {voids.map((item) => (
                <RelItem key={item.id} item={item} onSelect={onSelectEntity} />
              ))}
            </div>
          )}
          {fills.length > 0 && (
            <div className="px-3 py-2">
              <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">
                Fills ({fills.length})
              </div>
              {fills.map((item) => (
                <RelItem key={item.id} item={item} onSelect={onSelectEntity} />
              ))}
            </div>
          )}
          {groups.length > 0 && (
            <div className="px-3 py-2">
              <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">
                Groups &amp; Zones ({groups.length})
              </div>
              {groups.map((item) => (
                <GroupItem
                  key={item.id}
                  item={item}
                  onSelect={onSelectEntity}
                  onIsolateMembers={onIsolateGroupMembers}
                />
              ))}
            </div>
          )}
          {connections.length > 0 && (
            <div className="px-3 py-2">
              <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">
                Connections ({connections.length})
              </div>
              {connections.map((item) => (
                <RelItem key={item.id} item={item} onSelect={onSelectEntity} />
              ))}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function RelItem({ item, onSelect }: {
  item: { id: number; name?: string; type: string };
  onSelect?: (id: number) => void;
}) {
  return (
    <button
      className="flex items-center gap-2 text-xs py-0.5 w-full text-left hover:text-primary transition-colors"
      onClick={() => onSelect?.(item.id)}
      type="button"
    >
      <span className="font-mono text-zinc-500 dark:text-zinc-500 text-[10px]">#{item.id}</span>
      <span className="text-zinc-600 dark:text-zinc-400 truncate">{item.name || item.type}</span>
      <span className="text-[10px] text-zinc-400 ml-auto shrink-0">{item.type}</span>
    </button>
  );
}

/** A group/zone row (IfcZone / IfcGroup / IfcSystem): click the name to inspect
 *  the group's own attributes; click the focus button to isolate + select all of
 *  its member objects (e.g. every space in a dwelling) in the 3D view (#1075). */
function GroupItem({ item, onSelect, onIsolateMembers }: {
  item: { id: number; name?: string; type: string };
  onSelect?: (id: number) => void;
  onIsolateMembers?: (id: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 py-0.5 group/rel">
      <button
        className="flex items-center gap-2 text-xs flex-1 min-w-0 text-left hover:text-primary transition-colors"
        onClick={() => onSelect?.(item.id)}
        type="button"
        title="Show this group's attributes"
      >
        <span className="font-mono text-zinc-500 dark:text-zinc-500 text-[10px]">#{item.id}</span>
        <span className="text-zinc-600 dark:text-zinc-400 truncate">{item.name || `Group #${item.id}`}</span>
        <span className="text-[10px] text-zinc-400 ml-auto shrink-0">{item.type}</span>
      </button>
      {onIsolateMembers && (
        <button
          className="shrink-0 p-0.5 text-zinc-400 hover:text-primary transition-colors"
          onClick={() => onIsolateMembers(item.id)}
          type="button"
          title="Isolate this group's members in 3D"
        >
          <Focus className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
