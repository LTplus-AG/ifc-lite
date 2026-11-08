/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Quantities tab's side of "Update quantities of edited elements" (#9026
 * item 20 follow-up): the switch, shown for a loaded element whose base
 * quantity set an edit would refresh, and the "Updated from geometry" marker on
 * a set that was. A set without the marker reads as the file wrote it.
 */

import { useMemo } from 'react';
import { hasRefreshableBaseQuantities, refreshedBaseQuantitySet } from '@ifc-lite/create';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useEditedQuantityRefresh } from '@/hooks/useEditedQuantityRefresh';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';

export interface QuantityEntityRef { readonly modelId: string; readonly expressId: number }
/** A quantity set as a card shows it: what identifies it is its GlobalId, and its name. */
export interface ShownSet { readonly name: string; readonly globalId?: string }

/** The store and view an entity's quantities read through, or null without a mutation view. */
function useQuantityReaders(entity: QuantityEntityRef | null | undefined): { dataStore: IfcDataStore; view: MutablePropertyView } | null {
  const models = useViewerStore((s) => s.models);
  const legacyStore = useViewerStore((s) => s.ifcDataStore);
  const mutationViews = useViewerStore((s) => s.mutationViews);
  return useMemo(() => {
    if (!entity) return null;
    const legacy = entity.modelId === 'legacy';
    const dataStore = (legacy ? legacyStore : models.get(entity.modelId)?.ifcDataStore) as IfcDataStore | null | undefined;
    const view = mutationViews.get(legacy ? '__legacy__' : entity.modelId);
    return dataStore?.source?.length && view ? { dataStore, view } : null;
  }, [entity, models, legacyStore, mutationViews]);
}

/**
 * Whether the card's set is the refreshed one. The refresh keeps the file
 * set's GlobalId, which `IfcElementQuantity` must have, so the set is matched by
 * it: a second set of the same name has its own, and an edit made by hand
 * on top of the refreshed values leaves it as it was. A malformed file whose
 * sets have none is matched by name.
 */
export function isRefreshedSet(qset: ShownSet, refreshed: ShownSet | null): boolean {
  if (refreshed === null || qset.name !== refreshed.name) return false;
  return qset.globalId && refreshed.globalId ? qset.globalId === refreshed.globalId : true;
}

/** Whether `qset` on `entity` was refreshed from its edited geometry. */
function useRefreshedFromGeometry(entity: QuantityEntityRef | null | undefined, qset: ShownSet): boolean {
  const [enabled] = useEditedQuantityRefresh();
  const readers = useQuantityReaders(enabled ? entity : null);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const refreshed = useMemo(() => {
    if (!readers || !entity) return null;
    try {
      return refreshedBaseQuantitySet(readers.dataStore, readers.view, entity.expressId);
    } catch (error) {
      console.warn('[quantities] could not tell whether a set was refreshed', error);
      return null;
    }
    // `mutationVersion` stands for the overlay the readers see.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readers, entity, mutationVersion]);
  return isRefreshedSet(qset, refreshed);
}

/** "Updated from geometry", beside a refreshed set's name. Renders nothing for a set read from the file. */
export function QuantitySetSourceBadge({ entity, qset }: { entity?: QuantityEntityRef | null; qset: ShownSet }) {
  const { t } = useTranslation();
  if (!useRefreshedFromGeometry(entity, qset)) return null;
  return (
    <Badge
      variant="secondary"
      title={t('properties.quantitySet.fromGeometryHint')}
      className="h-4 shrink-0 px-1 text-2xs font-medium bg-overlay-accent-soft text-foreground border-overlay-accent/40"
    >
      {t('properties.quantitySet.fromGeometry')}
    </Badge>
  );
}

/** The switch, for a loaded element of a kind whose file quantities an edit can refresh. */
export function EditedQuantitiesSwitch({ entity }: { entity?: QuantityEntityRef | null }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useEditedQuantityRefresh();
  const readers = useQuantityReaders(entity);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const shown = useMemo(() => {
    if (!readers || !entity) return false;
    try {
      return hasRefreshableBaseQuantities(readers.dataStore, readers.view, entity.expressId);
    } catch (error) {
      console.warn('[quantities] could not read the element\'s quantity sets', error);
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readers, entity, mutationVersion]);
  if (!shown) return null;
  return (
    <div className="flex items-start justify-between gap-3 border-b px-3 py-2">
      <div className="min-w-0">
        <label htmlFor="quantities-update-edited" className="text-xs">{t('properties.quantitySet.updateEdited')}</label>
        <p className="text-2xs text-muted-foreground">{t('properties.quantitySet.updateEditedHint')}</p>
      </div>
      <Switch id="quantities-update-edited" checked={enabled} onCheckedChange={setEnabled} className="mt-0.5 shrink-0" />
    </div>
  );
}
