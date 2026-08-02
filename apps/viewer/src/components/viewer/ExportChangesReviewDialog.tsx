/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review step for `ExportChangesButton` (issue #1915): before the actual
 * export runs, list what the overlay currently carries so the user can
 * compare previous → new values instead of exporting blind. Grouped by
 * model, then by entity, reading `MutablePropertyView.getEffectiveChanges()`
 * — the live overlay, so this always agrees with the badge count the button
 * shows (both are overlay-based as of #1915, not the append-only
 * `mutationHistory`).
 *
 * Georeferencing and schedule edits are not `MutablePropertyView` overlay
 * entries (they live in separate store slices), so they cannot be itemized
 * per-entity here; a summary line reports their contribution to the total
 * count instead of silently dropping it from the review.
 */

import { useMemo } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { EffectiveChange, MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import type { ChangedModelsResult } from '@/lib/export/model-changes';

interface EntityRowGroup {
  entityId: number;
  label: string;
  changes: EffectiveChange[];
}

interface ModelReviewGroup {
  modelId: string;
  modelName: string;
  entities: EntityRowGroup[];
  /** Changes counted in the badge but not itemizable here (georef / schedule). */
  unitemizedCount: number;
}

/** `IfcTypeName #expressId — Name`, or a fallback for entities the base store doesn't know yet. */
function describeEntity(dataStore: IfcDataStore | null, entityId: number, changes: EffectiveChange[]): string {
  const created = changes.find((c) => c.kind === 'entity-added');
  if (created) {
    return `New ${created.newValue ?? 'entity'} #${entityId}`;
  }
  if (!dataStore) return `#${entityId}`;
  const typeName = dataStore.entities.getTypeName(entityId) || 'Unknown';
  const name = dataStore.entities.getName(entityId);
  return name ? `${typeName} #${entityId} — ${name}` : `${typeName} #${entityId}`;
}

function describeChangeKind(c: EffectiveChange): string {
  switch (c.kind) {
    case 'attribute': return `Attribute: ${c.name ?? ''}`;
    case 'property': return `Property: ${c.setName ?? ''}.${c.name ?? ''}`;
    case 'quantity': return `Quantity: ${c.setName ?? ''}.${c.name ?? ''}`;
    case 'pset-added': return `Property set added: ${c.setName ?? ''}`;
    case 'pset-deleted': return `Property set deleted: ${c.setName ?? ''}`;
    case 'qset-added': return `Quantity set added: ${c.setName ?? ''}`;
    case 'qset-deleted': return `Quantity set deleted: ${c.setName ?? ''}`;
    case 'type': return 'Entity type';
    case 'entity-added': return 'Entity created';
    case 'entity-deleted': return 'Entity deleted';
    default: return c.kind;
  }
}

/** Whether this kind has a meaningful previous/new value pair to render. */
function hasValuePair(kind: EffectiveChange['kind']): boolean {
  return kind === 'attribute' || kind === 'property' || kind === 'quantity' || kind === 'type';
}

function buildReviewGroups(
  mutationViews: ReadonlyMap<string, MutablePropertyView>,
  changed: ChangedModelsResult,
): ModelReviewGroup[] {
  return changed.models.map((entry) => {
    const view = mutationViews.get(entry.id);
    const effectiveChanges = view ? view.getEffectiveChanges() : [];

    const byEntity = new Map<number, EffectiveChange[]>();
    for (const change of effectiveChanges) {
      let bucket = byEntity.get(change.entityId);
      if (!bucket) {
        bucket = [];
        byEntity.set(change.entityId, bucket);
      }
      bucket.push(change);
    }

    const entities: EntityRowGroup[] = Array.from(byEntity.entries()).map(([entityId, changes]) => ({
      entityId,
      label: describeEntity(entry.ifcDataStore, entityId, changes),
      changes,
    }));
    entities.sort((a, b) => a.entityId - b.entityId);

    const itemizedCount = view ? view.getModifiedEntityCount() : 0;
    const unitemizedCount = Math.max(0, entry.changeCount - itemizedCount);

    return { modelId: entry.id, modelName: entry.name, entities, unitemizedCount };
  });
}

interface ExportChangesReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  changed: ChangedModelsResult;
  totalCount: number;
  isExporting: boolean;
  onConfirm: () => void;
}

export function ExportChangesReviewDialog({
  open,
  onOpenChange,
  changed,
  totalCount,
  isExporting,
  onConfirm,
}: ExportChangesReviewDialogProps) {
  // Snapshot at open time (not a live subscription) — a review dialog should
  // show a stable list while the user reads it, not shift under them if an
  // edit lands elsewhere while it's open. Matches the `getState()` idiom
  // ExportChangesButton itself uses for click-time reads.
  const groups = useMemo(
    () => (open ? buildReviewGroups(useViewerStore.getState().mutationViews, changed) : []),
    [open, changed],
  );

  const isEmpty = totalCount === 0 || groups.every((g) => g.entities.length === 0 && g.unitemizedCount === 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Review changes
          </DialogTitle>
          <DialogDescription>
            {isEmpty
              ? 'No pending changes to export.'
              : `${totalCount} change${totalCount === 1 ? '' : 's'} across ${groups.length} model${groups.length === 1 ? '' : 's'} will be applied to the exported file${groups.length === 1 ? '' : 's'}.`}
          </DialogDescription>
        </DialogHeader>

        {isEmpty ? (
          <p className="py-4 text-sm text-muted-foreground">
            Nothing has changed since the last export — there is no overlay to apply.
          </p>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto pr-1 space-y-4 py-2">
            {groups.map((group) => (
              <div key={group.modelId}>
                <div className="text-xs font-semibold text-foreground mb-1.5 truncate" title={group.modelName}>
                  {group.modelName}
                </div>
                <div className="space-y-1">
                  {group.entities.map((entity) => (
                    <div key={entity.entityId} className="rounded-md border border-border px-2 py-1.5">
                      <div className="truncate text-xs font-medium" title={entity.label}>
                        {entity.label}
                      </div>
                      <div className="mt-1 space-y-0.5">
                        {entity.changes.map((c, i) => (
                          <div key={i} className="text-[10px] text-muted-foreground flex items-baseline gap-1.5">
                            <span className="shrink-0">{describeChangeKind(c)}</span>
                            {hasValuePair(c.kind) && (
                              <span className="truncate">
                                {c.previousValue ?? '(none)'} <span className="opacity-60">→</span>{' '}
                                {c.newValue ?? '(deleted)'}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                  {group.unitemizedCount > 0 && (
                    <div className="text-[10px] text-muted-foreground px-2 py-1">
                      + {group.unitemizedCount} georeferencing / schedule change{group.unitemizedCount === 1 ? '' : 's'} (not itemized above)
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={isExporting || isEmpty}>
            {isExporting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Exporting...
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                Export
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
