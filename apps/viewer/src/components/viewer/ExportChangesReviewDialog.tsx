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
 * This component is a PURE display of the `groups` prop — it does not read
 * the store itself and does not memoize/snapshot anything. `ExportChangesButton`
 * builds `groups` from live state, and the overlay can still change while this
 * dialog is open (every mutating action mutates its `MutablePropertyView`
 * instance in place — there is no cheap frozen snapshot to hand this
 * component instead). Freezing the display here would only make that
 * divergence invisible, not fix it: `handleExport` re-reads live state
 * regardless. So `ExportChangesButton.handleConfirm` re-derives `groups`
 * synchronously at click time and refuses to export (toasting instead) if it
 * no longer matches what was on screen — see that file's detect-and-require
 * re-review logic.
 *
 * Georeferencing and schedule edits are not `MutablePropertyView` overlay
 * entries (they live in separate store slices), so they cannot be itemized
 * per-entity here; a summary line reports their contribution to the total
 * count instead of silently dropping it from the review.
 */

import { Download } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useTranslation } from '@/i18n';
import { resolve } from '@/i18n/registry';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { EffectiveChange, MutablePropertyView } from '@ifc-lite/mutations';
import type { ChangedModelsResult } from '@/lib/export/model-changes';

export interface EntityRowGroup {
  entityId: number;
  label: string;
  changes: EffectiveChange[];
}

export interface ModelReviewGroup {
  modelId: string;
  modelName: string;
  entities: EntityRowGroup[];
  /** Changes counted in the badge but not itemizable here (georef / schedule). */
  unitemizedCount: number;
}

/** `IfcTypeName #expressId — Name`, or a fallback for entities the base store
 *  doesn't know yet. Called from `buildReviewGroups` (not a component), so it
 *  takes an optional non-hook translator the same way `webGpuBannerBlurb`
 *  does — the label is precomputed once, same as every other precomputed
 *  display label in this sweep. */
function describeEntity(
  dataStore: IfcDataStore | null,
  entityId: number,
  changes: EffectiveChange[],
  t: typeof resolve = resolve,
): string {
  const created = changes.find((c) => c.kind === 'entity-added');
  if (created) {
    return t('exportChangesReviewDialog.newEntityLabel', {
      type: created.newValue ?? t('exportChangesReviewDialog.entityFallback'),
      id: entityId,
    });
  }
  if (!dataStore) return t('exportChangesReviewDialog.entityIdLabel', { id: entityId });
  const typeName = dataStore.entities.getTypeName(entityId) || t('exportChangesReviewDialog.unknownTypeFallback');
  const name = dataStore.entities.getName(entityId);
  return name
    ? t('exportChangesReviewDialog.entityTypeIdNameLabel', { type: typeName, id: entityId, name })
    : t('exportChangesReviewDialog.entityTypeIdLabel', { type: typeName, id: entityId });
}

/** Called from JSX at render time, so `t` is threaded from the component's
 *  own `useTranslation()` to retranslate live on a locale switch. */
function describeChangeKind(c: EffectiveChange, t: typeof resolve): string {
  switch (c.kind) {
    case 'attribute': return t('exportChangesReviewDialog.kindAttribute', { name: c.name ?? '' });
    case 'property': return t('exportChangesReviewDialog.kindProperty', { set: c.setName ?? '', name: c.name ?? '' });
    case 'quantity': return t('exportChangesReviewDialog.kindQuantity', { set: c.setName ?? '', name: c.name ?? '' });
    case 'pset-added': return t('exportChangesReviewDialog.kindPsetAdded', { set: c.setName ?? '' });
    case 'pset-deleted': return t('exportChangesReviewDialog.kindPsetDeleted', { set: c.setName ?? '' });
    case 'qset-added': return t('exportChangesReviewDialog.kindQsetAdded', { set: c.setName ?? '' });
    case 'qset-deleted': return t('exportChangesReviewDialog.kindQsetDeleted', { set: c.setName ?? '' });
    case 'type': return t('exportChangesReviewDialog.kindType');
    case 'entity-added': return t('exportChangesReviewDialog.kindEntityAdded');
    case 'entity-deleted': return t('exportChangesReviewDialog.kindEntityDeleted');
    default: return c.kind;
  }
}

/** Whether this kind has a meaningful previous/new value pair to render. */
function hasValuePair(kind: EffectiveChange['kind']): boolean {
  return kind === 'attribute' || kind === 'property' || kind === 'quantity' || kind === 'type';
}

export function buildReviewGroups(
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
  groups: ModelReviewGroup[];
  totalCount: number;
  isExporting: boolean;
  onConfirm: () => void;
}

export function ExportChangesReviewDialog({
  open,
  onOpenChange,
  groups,
  totalCount,
  isExporting,
  onConfirm,
}: ExportChangesReviewDialogProps) {
  const { t } = useTranslation();
  const isEmpty = totalCount === 0 || groups.every((g) => g.entities.length === 0 && g.unitemizedCount === 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            {t('exportChangesReviewDialog.title')}
          </DialogTitle>
          <DialogDescription>
            {isEmpty
              ? t('exportChangesReviewDialog.noPendingChanges')
              : t('exportChangesReviewDialog.changesSummary', {
                  count: totalCount,
                  models: t('exportChangesReviewDialog.modelsCount', { count: groups.length }),
                  fileSuffix: groups.length === 1 ? '' : 's',
                })}
          </DialogDescription>
        </DialogHeader>

        {isEmpty ? (
          <p className="py-4 text-sm text-muted-foreground">
            {t('exportChangesReviewDialog.emptyStateMessage')}
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
                            <span className="shrink-0">{describeChangeKind(c, t)}</span>
                            {hasValuePair(c.kind) && (
                              <span className="truncate">
                                {c.previousValue ?? t('exportChangesReviewDialog.noneValue')} <span className="opacity-60">→</span>{' '}
                                {/* `newValue === undefined` alone does not mean "deleted" — a SET whose
                                    stored value is `null` (e.g. an unset Boolean added from bSDD, issue
                                    #1107) stringifies to `undefined` too, but the property/quantity is
                                    still present in the exported file, just empty. `c.deleted` is the
                                    only reliable signal a DELETE-operation mutation actually produced
                                    this row (see `EffectiveChange.deleted`). */}
                                {c.deleted ? t('exportChangesReviewDialog.deletedValue') : (c.newValue ?? t('exportChangesReviewDialog.noneValue'))}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                  {group.unitemizedCount > 0 && (
                    <div className="text-[10px] text-muted-foreground px-2 py-1">
                      {t('exportChangesReviewDialog.unitemizedNote', { count: group.unitemizedCount })}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('exportChangesReviewDialog.cancelButton')}
          </Button>
          <Button onClick={onConfirm} disabled={isExporting || isEmpty}>
            {isExporting ? (
              <>
                <Spinner size="md" className="mr-2" />
                {t('exportChangesReviewDialog.exportingLabel')}
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                {t('exportChangesReviewDialog.exportButton')}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
