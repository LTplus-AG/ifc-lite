/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Box } from 'lucide-react';

export interface AssemblyParentInfo {
  expressId: number;
  name?: string;
}

/** Issue #3620: a selected element that is a member of an IfcElementAssembly
 *  (via IfcRelAggregates) gives no indication of that relationship anywhere
 *  near the IfcClass label — the reporter could not tell the part belonged to
 *  an assembly, nor select the assembly itself. This badge surfaces the
 *  parent and, on click, selects it via the same `onSelect` path the
 *  Relationships card already uses for related entities. */
export function AssemblyBadge({ assembly, onSelect }: {
  assembly: AssemblyParentInfo | null;
  onSelect: (expressId: number) => void;
}) {
  if (!assembly) return null;

  return (
    <button
      type="button"
      onClick={() => onSelect(assembly.expressId)}
      className="flex items-center gap-2 text-xs border border-indigo-500/30 bg-indigo-50/50 dark:bg-indigo-900/10 px-2 py-1.5 text-indigo-800 dark:text-indigo-400 min-w-0 w-full text-left hover:bg-indigo-100/60 dark:hover:bg-indigo-900/20 transition-colors"
      title="Select the parent assembly"
    >
      <Box className="h-3.5 w-3.5 shrink-0" />
      <span className="font-bold uppercase tracking-wide shrink-0">Part of Assembly</span>
      <span className="truncate min-w-0 flex-1 font-mono">{assembly.name || `#${assembly.expressId}`}</span>
    </button>
  );
}
