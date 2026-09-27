/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useId, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import type { ResolvedAssignment } from '@/lib/appearance/assignments/types.js';
import { useTranslation } from '@/i18n';
import { AppearanceAssignmentMembers } from './AppearanceAssignmentMembers.js';

export interface AppearanceAssignmentListProps {
  rows: readonly ResolvedAssignment[];
  disabled: boolean;
  objectName(modelId: string, expressId: number): string;
  onMove(id: string, direction: -1 | 1): void;
  onRemove(id: string): void;
  onExclude(id: string, GlobalId: string, excluded: boolean): void;
}

/** Ordered recipe review; the controller alone prepares and publishes changes. */
export function AppearanceAssignmentList(props: AppearanceAssignmentListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const reviewId = useId();
  const { t } = useTranslation();
  if (!props.rows.length) return null;
  return <section className="space-y-2" aria-label={t('appearanceAssignmentList.sectionAriaLabel')}>
    <div><h3 className="text-xs font-semibold">{t('appearanceAssignmentList.heading')}</h3>
      <p className="text-2xs text-muted-foreground">{t('appearanceAssignmentList.description')}</p></div>
    <ol className="space-y-2">{props.rows.map((row, index) => {
      const item = row.assignment;
      const position = index + 1;
      const products = t('appearanceAssignmentList.summaryProducts', {
        count: row.productIds.length,
      });
      const excluded = t('appearanceAssignmentList.summaryExcluded', { count: row.excluded });
      const overridden = t('appearanceAssignmentList.summaryOverridden', { count: row.overridden });
      return <li key={item.id} className="rounded-md border p-2" aria-label={t('appearanceAssignmentList.assignmentAriaLabel', { position, sourceName: item.source.name, modelName: item.model.name })}>
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{position}. {item.source.name}</p>
            <p className="truncate text-2xs text-muted-foreground">{item.model.name}</p></div>
          <IconButton
            label={t('appearanceAssignmentList.moveEarlierAriaLabel', { position })}
            type="button"
            className="h-6 w-6"
            disabled={props.disabled || index === 0}
            onClick={() => props.onMove(item.id, -1)}
          ><ArrowUp className="h-3 w-3" /></IconButton>
          <IconButton
            label={t('appearanceAssignmentList.moveLaterAriaLabel', { position })}
            type="button"
            className="h-6 w-6"
            disabled={props.disabled || index === props.rows.length - 1}
            onClick={() => props.onMove(item.id, 1)}
          ><ArrowDown className="h-3 w-3" /></IconButton>
          <IconButton
            label={t('appearanceAssignmentList.removeAriaLabel', { position })}
            type="button"
            className="h-6 w-6"
            disabled={props.disabled}
            onClick={() => props.onRemove(item.id)}
          ><Trash2 className="h-3 w-3" /></IconButton>
        </div>
        <p className="mt-1 text-2xs">{t('appearanceAssignmentList.summary', {
          products, excluded, overridden,
        })}</p>
        <Button type="button" variant="ghost" size="sm" className="mt-1 h-6 px-0 text-2xs" disabled={props.disabled}
          aria-label={t('appearanceAssignmentList.reviewAriaLabel', { position })} aria-expanded={expandedId === item.id}
          aria-controls={`${reviewId}-${index}`} onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}>
          <ChevronRight className={`h-3 w-3 ${expandedId === item.id ? 'rotate-90' : ''}`} />{t('appearanceAssignmentList.reviewButton')}
        </Button>
        <div id={`${reviewId}-${index}`}>
          {expandedId === item.id && <AppearanceAssignmentMembers assignment={item} disabled={props.disabled} objectName={props.objectName} onExclude={props.onExclude} />}
        </div>
      </li>;
    })}</ol>
  </section>;
}
