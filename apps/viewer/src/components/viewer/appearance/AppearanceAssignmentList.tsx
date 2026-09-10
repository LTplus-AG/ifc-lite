/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useId, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ResolvedAssignment } from '@/lib/appearance/assignments/types.js';
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
  if (!props.rows.length) return null;
  return <section className="space-y-2" aria-label="Appearance assignments">
    <div><h3 className="text-xs font-semibold">Assignments</h3>
      <p className="text-[11px] text-muted-foreground">Later assignments replace earlier ones on overlapping objects. Excluding an object here keeps any earlier assignment.</p></div>
    <ol className="space-y-2">{props.rows.map((row, index) => {
      const item = row.assignment;
      return <li key={item.id} className="rounded-md border p-2" aria-label={`Assignment ${index + 1}: ${item.source.name} on ${item.model.name}`}>
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{index + 1}. {item.source.name}</p>
            <p className="truncate text-[11px] text-muted-foreground">{item.model.name}</p></div>
          <Button type="button" size="icon" variant="ghost" className="h-6 w-6" disabled={props.disabled || index === 0}
            aria-label={`Move assignment ${index + 1} earlier`} onClick={() => props.onMove(item.id, -1)}><ArrowUp className="h-3 w-3" /></Button>
          <Button type="button" size="icon" variant="ghost" className="h-6 w-6" disabled={props.disabled || index === props.rows.length - 1}
            aria-label={`Move assignment ${index + 1} later`} onClick={() => props.onMove(item.id, 1)}><ArrowDown className="h-3 w-3" /></Button>
          <Button type="button" size="icon" variant="ghost" className="h-6 w-6" disabled={props.disabled}
            aria-label={`Remove assignment ${index + 1}`} onClick={() => props.onRemove(item.id)}><Trash2 className="h-3 w-3" /></Button>
        </div>
        <p className="mt-1 text-[11px]">{row.productIds.length} objects · {row.excluded} excluded · {row.overridden} replaced by later assignments</p>
        <Button type="button" variant="ghost" size="sm" className="mt-1 h-6 px-0 text-[11px]" disabled={props.disabled}
          aria-label={`Review objects for assignment ${index + 1}`} aria-expanded={expandedId === item.id}
          aria-controls={`${reviewId}-${index}`} onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}>
          <ChevronRight className={`h-3 w-3 ${expandedId === item.id ? 'rotate-90' : ''}`} />Review objects and exceptions
        </Button>
        <div id={`${reviewId}-${index}`}>
          {expandedId === item.id && <AppearanceAssignmentMembers assignment={item} disabled={props.disabled} objectName={props.objectName} onExclude={props.onExclude} />}
        </div>
      </li>;
    })}</ol>
  </section>;
}
