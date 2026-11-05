/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Box } from 'lucide-react';
import { useTranslation } from '@/i18n';

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
  const { t } = useTranslation();
  if (!assembly) return null;

  return (
    <button
      type="button"
      onClick={() => onSelect(assembly.expressId)}
      className="inspector-kv min-h-7 w-full gap-x-2 pl-3 pr-1 text-left text-xs hover:bg-muted/50"
      title={t('properties.assemblyBadge.tooltip')}
    >
      <span data-assembly-label className="min-w-0 truncate text-muted-foreground">{t('properties.assemblyBadge.label')}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-primary">
        <Box className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate min-w-0">{assembly.name || `#${assembly.expressId}`}</span>
      </span>
      <span className="w-6" aria-hidden="true" />
    </button>
  );
}
