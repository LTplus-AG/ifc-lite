/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Classification display component for IFC element classifications.
 */

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tag } from 'lucide-react';
import type { ClassificationInfo } from '@ifc-lite/parser';

export function ClassificationCard({ classification }: { classification: ClassificationInfo }) {
  // Matches the "unavailable on this data source" treatment in
  // ModelMetadataPanel: a server-parsed store (#3948) can prove the entity
  // is classified via the relationship graph without being able to read
  // any of the classification's own attributes. Without this branch the
  // card fell through to the general case below and rendered a
  // content-free "Classification / Unknown" card.
  if (classification.unresolved) {
    return (
      <div className="border-2 border-emerald-200 dark:border-emerald-800 bg-emerald-50/20 dark:bg-emerald-950/20 w-full max-w-full overflow-hidden flex items-center gap-2 p-2.5">
        <Tag className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          Classification present, but unavailable on this data source
        </span>
      </div>
    );
  }

  const displayName = classification.identification || classification.name || 'Unknown';
  const systemName = classification.system;

  return (
    <Collapsible defaultOpen className="border-2 border-emerald-200 dark:border-emerald-800 bg-emerald-50/20 dark:bg-emerald-950/20 w-full max-w-full overflow-hidden">
      <CollapsibleTrigger className="flex items-center gap-2 w-full p-2.5 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 text-left transition-colors overflow-hidden">
        <Tag className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
        <span className="font-bold text-xs text-emerald-700 dark:text-emerald-400 truncate flex-1 min-w-0">
          {systemName || 'Classification'}
        </span>
        <span className="text-[10px] font-mono bg-emerald-100 dark:bg-emerald-900/50 px-1.5 py-0.5 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 shrink-0">
          {displayName}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t-2 border-emerald-200 dark:border-emerald-800 divide-y divide-emerald-100 dark:divide-emerald-900/30">
          {classification.identification && (
            <div className="flex flex-col gap-0.5 px-3 py-2 text-xs hover:bg-emerald-50/50 dark:hover:bg-emerald-900/20">
              <span className="text-zinc-500 dark:text-zinc-400 font-medium">Identification</span>
              <span className="font-mono text-emerald-700 dark:text-emerald-400 select-all break-words">{classification.identification}</span>
            </div>
          )}
          {classification.name && (
            <div className="flex flex-col gap-0.5 px-3 py-2 text-xs hover:bg-emerald-50/50 dark:hover:bg-emerald-900/20">
              <span className="text-zinc-500 dark:text-zinc-400 font-medium">Name</span>
              <span className="font-mono text-emerald-700 dark:text-emerald-400 select-all break-words">{classification.name}</span>
            </div>
          )}
          {classification.system && (
            <div className="flex flex-col gap-0.5 px-3 py-2 text-xs hover:bg-emerald-50/50 dark:hover:bg-emerald-900/20">
              <span className="text-zinc-500 dark:text-zinc-400 font-medium">System</span>
              <span className="font-mono text-emerald-700 dark:text-emerald-400 select-all break-words">{classification.system}</span>
            </div>
          )}
          {classification.location && (
            <div className="flex flex-col gap-0.5 px-3 py-2 text-xs hover:bg-emerald-50/50 dark:hover:bg-emerald-900/20">
              <span className="text-zinc-500 dark:text-zinc-400 font-medium">Location</span>
              <span className="font-mono text-emerald-700 dark:text-emerald-400 select-all break-words">{classification.location}</span>
            </div>
          )}
          {classification.path && classification.path.length > 0 && (
            <div className="flex flex-col gap-0.5 px-3 py-2 text-xs hover:bg-emerald-50/50 dark:hover:bg-emerald-900/20">
              <span className="text-zinc-500 dark:text-zinc-400 font-medium">Path</span>
              <span className="font-mono text-emerald-700 dark:text-emerald-400 select-all break-words">{classification.path.join(' > ')}</span>
            </div>
          )}
          {classification.description && (
            <div className="flex flex-col gap-0.5 px-3 py-2 text-xs hover:bg-emerald-50/50 dark:hover:bg-emerald-900/20">
              <span className="text-zinc-500 dark:text-zinc-400 font-medium">Description</span>
              <span className="font-mono text-emerald-700 dark:text-emerald-400 select-all break-words">{classification.description}</span>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
