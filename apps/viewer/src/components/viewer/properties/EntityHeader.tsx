/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The selected element's header in the Properties panel (#8802 R2).
 *
 * The name gets its own line in real case (up to two lines, full text in the
 * tooltip) instead of sharing a row with the action icons. The IFC class and
 * the type object sit on one quiet secondary line; the element actions sit in
 * a compact toolbar below; identity and location follow as ordinary key/value
 * rows (GlobalId, storey, elevation, assembly, position).
 */

import type { ReactNode } from 'react';
import { Layers2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n';
import { EntityHeaderActions } from './EntityHeaderActions';
import { UnitDisplayControl } from './UnitDisplayControl';
import { EXPRESS_GLOBAL_ID_ATTRIBUTE } from './express-labels';
import { InspectorRow } from './inspector-ui';

export interface EntityHeaderProps {
  name?: string;
  entityType: string;
  /** "IfcWallType: Basic Wall" for an occurrence with a type object. */
  typeLine?: string | null;
  layersMerged?: boolean;
  globalId?: string | null;
  /** Identity / location rows rendered under the GlobalId row. */
  children?: ReactNode;
}

export function EntityHeader({ name, entityType, typeLine, layersMerged, globalId, children }: EntityHeaderProps) {
  const { t } = useTranslation();
  const title = name || entityType;
  return (
    <div className="border-b border-border bg-background">
      <div className="px-3 pt-2.5">
        <h3 className="line-clamp-2 break-words text-row font-semibold text-foreground" title={title}>
          {title}
        </h3>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
          <span className="shrink-0 font-mono">{entityType}</span>
          {typeLine && (
            <>
              <span aria-hidden="true">·</span>
              <span className="min-w-0 truncate" title={typeLine}>{typeLine}</span>
            </>
          )}
          {/* Issue #540: indicate that the wall solid the user is looking at
              represents aggregated multilayer parts. We over-trigger on any
              IfcWall* class instead of probing the aggregation graph: the
              chip is cheap and informative, and walls that aren't actually
              layered simply confirm the user's selection is the parent. */}
          {layersMerged && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="secondary" className="ml-auto h-4 shrink-0 gap-1 rounded-sm px-1.5 py-0 text-2xs font-medium leading-none">
                  <Layers2 className="h-2.5 w-2.5" />
                  {t('properties.panel.layersMergedBadge')}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{t('properties.panel.layersMergedTooltip')}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      <div role="toolbar" aria-label={t('properties.panel.entityActionsLabel')} className="flex items-center gap-0.5 px-1.5 py-1">
        <EntityHeaderActions />
        {/* Display-unit converter (issue #1573 proposal 2): covers both the
            Properties and Quantities tabs below, so it lives in the shared
            header rather than inside either TabsContent. */}
        <div className="ml-auto">
          <UnitDisplayControl />
        </div>
      </div>
      <div className="border-t border-border py-1">
        {globalId && <InspectorRow label={EXPRESS_GLOBAL_ID_ATTRIBUTE} value={globalId} mono />}
        {children}
      </div>
    </div>
  );
}
