/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Relationships display component for IFC element structural relationships.
 */

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Link2, Focus } from 'lucide-react';
import type { EntityRelationshipsData } from '@ifc-lite/sdk';
import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';

interface RelationshipsCardProps {
  relationships: EntityRelationshipsData;
  onSelectEntity?: (entityId: number) => void;
  /** Isolate + select all member objects of a group/zone in 3D (#1075). */
  onIsolateGroupMembers?: (groupId: number) => void;
}

const EXACT_RELATION_PAGE_SIZE = 100;

function relationListKey(relations: NonNullable<EntityRelationshipsData['relations']>): string {
  const edgeKey = (index: number) => {
    const edge = relations[index];
    return edge ? `${edge.direction}:${edge.relationshipId}:${edge.entity.id}:${edge.relationshipType}` : '';
  };
  return `${relations.length}:${edgeKey(0)}:${edgeKey(relations.length - 1)}`;
}

export function RelationshipsCard({ relationships, onSelectEntity, onIsolateGroupMembers }: RelationshipsCardProps) {
  const { t, locale } = useTranslation();
  const { voids, fills, groups, connections } = relationships;
  // Keep the exact record rows even when a convenience section below also
  // names the endpoint. Those legacy arrays collapse repeated IfcRel records
  // and omit the relationship id/direction, while this view is the lossless
  // graph surface promised by #4205.
  const exactRelations = relationships.relations ?? [];
  const exactKey = relationListKey(exactRelations);
  const [exactPage, setExactPage] = useState({ key: exactKey, count: EXACT_RELATION_PAGE_SIZE });
  const visibleExactCount = exactPage.key === exactKey ? exactPage.count : EXACT_RELATION_PAGE_SIZE;
  const visibleExactRelations = exactRelations.slice(0, visibleExactCount);
  const totalCount = voids.length + fills.length + groups.length + connections.length + exactRelations.length;

  if (totalCount === 0) return null;

  return (
    <Collapsible defaultOpen className="border-2 border-zinc-300 dark:border-zinc-700 bg-zinc-50/20 dark:bg-zinc-950/20 w-full max-w-full overflow-hidden">
      <CollapsibleTrigger className="flex items-center gap-2 w-full p-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-800/30 text-left transition-colors overflow-hidden">
        <Link2 className="h-3.5 w-3.5 text-zinc-600 dark:text-zinc-400 shrink-0" />
        <span className="font-bold text-xs text-zinc-700 dark:text-zinc-300 truncate flex-1 min-w-0">
          {t('properties.relationships.heading')}
        </span>
        <span className="text-2xs font-mono bg-zinc-200 dark:bg-zinc-800 px-1.5 py-0.5 border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 shrink-0">
          {formatLocaleNumber(locale, totalCount)}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t-2 border-zinc-300 dark:border-zinc-700 divide-y divide-zinc-200 dark:divide-zinc-800">
          {voids.length > 0 && (
            <div className="px-3 py-2">
              <div className="text-2xs font-bold text-zinc-500 uppercase tracking-wider mb-1">
                {t('properties.relationships.openings', { count: voids.length, countDisplay: formatLocaleNumber(locale, voids.length) })}
              </div>
              {voids.map((item) => (
                <RelItem key={item.id} item={item} onSelect={onSelectEntity} />
              ))}
            </div>
          )}
          {fills.length > 0 && (
            <div className="px-3 py-2">
              <div className="text-2xs font-bold text-zinc-500 uppercase tracking-wider mb-1">
                {t('properties.relationships.fills', { count: fills.length, countDisplay: formatLocaleNumber(locale, fills.length) })}
              </div>
              {fills.map((item) => (
                <RelItem key={item.id} item={item} onSelect={onSelectEntity} />
              ))}
            </div>
          )}
          {groups.length > 0 && (
            <div className="px-3 py-2">
              <div className="text-2xs font-bold text-zinc-500 uppercase tracking-wider mb-1">
                {t('properties.relationships.groupsAndZones', { count: groups.length, countDisplay: formatLocaleNumber(locale, groups.length) })}
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
              <div className="text-2xs font-bold text-zinc-500 uppercase tracking-wider mb-1">
                {t('properties.relationships.connections', { count: connections.length, countDisplay: formatLocaleNumber(locale, connections.length) })}
              </div>
              {connections.map((item) => (
                <RelItem key={item.id} item={item} onSelect={onSelectEntity} />
              ))}
            </div>
          )}
          {exactRelations.length > 0 && (
            <div className="px-3 py-2">
              <div className="text-2xs font-bold text-zinc-500 uppercase tracking-wider mb-1">
                {t('relationshipCard.exactRecords', { count: exactRelations.length })}
              </div>
              {visibleExactRelations.map((relation, index) => (
                <RelationshipEdgeItem
                  key={`${relation.direction}:${relation.relationshipId}:${relation.entity.id}:${relation.relationshipType}:${index}`}
                  relation={relation}
                  onSelect={onSelectEntity}
                />
              ))}
              {visibleExactRelations.length < exactRelations.length && (
                <button
                  className="mt-1 text-xs text-primary hover:underline"
                  onClick={() => setExactPage({
                    key: exactKey,
                    count: Math.min(visibleExactCount + EXACT_RELATION_PAGE_SIZE, exactRelations.length),
                  })}
                  type="button"
                >
                  {t('relationshipCard.showMore', {
                    count: Math.min(EXACT_RELATION_PAGE_SIZE, exactRelations.length - visibleExactCount),
                  })}
                </button>
              )}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function RelationshipEdgeItem({ relation, onSelect }: {
  relation: NonNullable<EntityRelationshipsData['relations']>[number];
  onSelect?: (id: number) => void;
}) {
  return (
    <button
      className="flex items-center gap-2 text-xs py-0.5 w-full text-left hover:text-primary transition-colors"
      onClick={() => onSelect?.(relation.entity.id)}
      type="button"
      title={`#${relation.relationshipId} ${relation.relationshipType}`}
    >
      <span className="font-mono text-zinc-500 dark:text-zinc-500 text-2xs">
        {relation.direction === 'forward' ? '→' : '←'} #{relation.entity.id}
      </span>
      <span className="text-zinc-600 dark:text-zinc-400 truncate">
        {relation.entity.name || relation.entity.type}
      </span>
      <span className="text-2xs text-zinc-400 ml-auto shrink-0">{relation.relationshipType}</span>
    </button>
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
      <span className="font-mono text-zinc-500 dark:text-zinc-500 text-2xs">#{item.id}</span>
      <span className="text-zinc-600 dark:text-zinc-400 truncate">{item.name || item.type}</span>
      <span className="text-2xs text-zinc-400 ml-auto shrink-0">{item.type}</span>
    </button>
  );
}

/** A group/zone row (IfcZone / IfcGroup / IfcSystem): click the name to inspect
 *  the group's own attributes; click the focus button to isolate + select all of
 *  its member objects (e.g. every space in a dwelling) in the 3D view (#1075). */
function GroupItem({ item, onSelect, onIsolateMembers }: {
  item: EntityRelationshipsData['groups'][number];
  onSelect?: (id: number) => void;
  onIsolateMembers?: (id: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 py-0.5 group/rel">
      <button
        className="flex items-center gap-2 text-xs flex-1 min-w-0 text-left hover:text-primary transition-colors"
        onClick={() => onSelect?.(item.id)}
        type="button"
        title={t('properties.relationships.showGroupAttributesTooltip')}
      >
        <span className="font-mono text-zinc-500 dark:text-zinc-500 text-2xs">#{item.id}</span>
        <span className="text-zinc-600 dark:text-zinc-400 truncate">
          {item.name || t('properties.relationships.groupFallbackName', { id: item.id })}
        </span>
        {item.type && <span className="text-2xs text-zinc-400 ml-auto shrink-0">{item.type}</span>}
      </button>
      {onIsolateMembers && (
        <button
          className="shrink-0 p-0.5 text-zinc-400 hover:text-primary transition-colors"
          onClick={() => onIsolateMembers(item.id)}
          type="button"
          title={t('properties.relationships.isolateGroupMembersTooltip')}
        >
          <Focus className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
