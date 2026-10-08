/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDSCorrectionDialog — correct a failed IDS scalar-property requirement
 * for a chosen subset of failed entities (#3929).
 *
 * The primary action, "Review as changes" (#6912), converts the same typed,
 * unit-scaled values into a reviewed model change batch; the direct apply
 * below stays as the secondary action.
 *
 * Writes through the SAME canonical path as the property panel and the
 * bulk editor: `store.setProperty` → `MutablePropertyView.setProperty`,
 * which is undo/redo-tracked, dirty-flags the model, and mirrors into a
 * collab session when one is active. After applying, it re-runs IDS
 * validation so the report reflects reality rather than an assumed
 * success — a correction that fails to apply is reported per-entity, not
 * swallowed.
 *
 * `specResult` itself is a captured, one-time audit snapshot — nothing
 * re-runs validation just because the model changed underneath it. An
 * entity deleted after the audit (with this dialog closed; no race needed)
 * would otherwise still be listed, selected and clickable here (#5200).
 * `getCorrectableRequirements` is given the active `MutablePropertyView`'s
 * `isDeleted` check and drops tombstoned entities before they reach
 * `failedEntities` — the list, the selection count, and `handleApply`'s
 * write set all derive from that one filtered array, so there is nothing
 * left to silently skip at apply time.
 */

import { useCallback, useId, useMemo, useState } from 'react';
import { AlertCircle, Check, ListChecks, Wrench } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { configureMutationView } from '@/utils/configureMutationView';
import { createDataAccessor } from '@/hooks/ids/idsDataAccessor';
import {
  inferValueType,
  parseCorrectionValue,
  applyPropertyCorrection,
  CorrectionValueError,
  type CorrectionApplyResult,
} from '@/hooks/ids/idsCorrection';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { scaleCorrectionForWrite } from '@/hooks/ids/idsCorrectionScale';
import type { IDSSpecificationResult } from '@ifc-lite/ids';
import { getCorrectableRequirements } from '@/hooks/ids/idsCorrectableRequirements';
import type { ChangeConversion } from '@/lib/actions/change-conversion';
import { idsCorrectionToModelChanges } from '@/lib/actions/ids-changes';
import { ChangeReviewDialog } from './actions/ChangeReviewDialog';
export { getCorrectableRequirements, type CorrectableRequirement } from '@/hooks/ids/idsCorrectableRequirements';

interface IDSCorrectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  specResult: IDSSpecificationResult;
  modelId: string;
  /** Re-runs IDS validation for `modelId` after applying corrections. */
  onRevalidate: (modelId: string) => Promise<unknown>;
}

export function IDSCorrectionDialog({
  open,
  onOpenChange,
  specResult,
  modelId,
  onRevalidate,
}: IDSCorrectionDialogProps) {
  const { t } = useTranslation();
  const models = useIfc().models;
  const legacyIfcDataStore = useViewerStore((s) => s.ifcDataStore);
  const getMutationView = useViewerStore((s) => s.getMutationView);
  const registerMutationView = useViewerStore((s) => s.registerMutationView);
  const setStoreProperty = useViewerStore((s) => s.setProperty);
  // Recompute from the audit snapshot when overlay deletions change (#5200).
  const mutationVersion = useViewerStore((s) => s.mutationVersion);

  const correctable = useMemo(() => {
    const mutationView = getMutationView(modelId);
    return getCorrectableRequirements(
      specResult,
      mutationView ? (expressId) => mutationView.isDeleted(expressId) : undefined,
    );
  }, [specResult, modelId, getMutationView, mutationVersion]);

  const [requirementId, setRequirementId] = useState<string | null>(correctable[0]?.requirementId ?? null);
  const activeRequirement = correctable.find((r) => r.requirementId === requirementId) ?? correctable[0] ?? null;
  const [selectedIds, setSelectedIds] = useState<Set<number> | null>(null);
  const [rawValue, setRawValue] = useState('');
  const newValueInputId = useId();
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<CorrectionApplyResult[] | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const failedEntities = activeRequirement?.failedEntities ?? [];
  const liveIds = new Set(failedEntities.map((e) => e.expressId));
  const effectiveSelection = selectedIds
    ? new Set([...selectedIds].filter((id) => liveIds.has(id)))
    : liveIds;

  const toggleEntity = useCallback((expressId: number) => {
    setSelectedIds((prev) => {
      const base = prev ?? new Set(failedEntities.map((e) => e.expressId));
      const next = new Set(base);
      if (next.has(expressId)) next.delete(expressId);
      else next.add(expressId);
      return next;
    });
  }, [failedEntities]);

  const dataStore = useMemo(() => {
    if (modelId === '__legacy__' || modelId === 'legacy') return legacyIfcDataStore ?? undefined;
    return models.get(modelId)?.ifcDataStore ?? undefined;
  }, [modelId, models, legacyIfcDataStore]);

  const resetForNewOpen = useCallback(() => {
    setSelectedIds(null);
    setRawValue('');
    setResults(null);
    setApplyError(null);
  }, []);

  const handleApply = useCallback(async () => {
    if (!activeRequirement || !dataStore) return;
    setApplyError(null);
    setResults(null);

    const ids = failedEntities
      .map((e) => e.expressId)
      .filter((id) => effectiveSelection.has(id));
    if (ids.length === 0) {
      setApplyError(t('idsPanel.correction.selectAtLeastOne'));
      return;
    }

    // Ensure a mutation view exists for this model — same lazy-init pattern
    // the Bulk Property Editor and PropertiesPanel use.
    let mutationView = getMutationView(modelId);
    if (!mutationView) {
      mutationView = new MutablePropertyView(dataStore.properties || null, modelId);
      configureMutationView(mutationView, dataStore);
      registerMutationView(modelId, mutationView);
    }

    setApplying(true);
    try {
      const accessor = createDataAccessor(dataStore, modelId, mutationView);
      const applied: CorrectionApplyResult[] = [];

      for (const expressId of ids) {
        const existing = accessor.getPropertyValue(
          expressId,
          activeRequirement.target.psetName,
          activeRequirement.target.propName,
        );
        const valueType = inferValueType(existing?.dataType, activeRequirement.facetDataType);

        let value: string | number | boolean;
        try {
          value = parseCorrectionValue(rawValue, valueType);
        } catch (err) {
          applied.push({
            expressId,
            applied: false,
            error: err instanceof CorrectionValueError ? err.message : 'Invalid value',
          });
          continue;
        }

        // Convert the user-typed, IDS-facing (base-SI) value into the raw
        // frame the model stores — see idsCorrectionScale.ts for why.
        const dataType = existing?.dataType || activeRequirement.facetDataType;
        value = scaleCorrectionForWrite(dataStore, expressId, dataType, value);

        const result = applyPropertyCorrection(
          {
            setProperty: (entityId, pset, prop, v, vt, dt) =>
              setStoreProperty(modelId, entityId, pset, prop, v, vt, dt),
            getPropertyValue: (entityId, pset, prop) =>
              mutationView!.getPropertyValue(entityId, pset, prop),
          },
          expressId,
          activeRequirement.target,
          value,
          valueType,
          dataType,
        );
        applied.push(result);
      }

      setResults(applied);

      const succeeded = applied.some((r) => r.applied);
      if (succeeded) {
        // Rerun validation so the report reflects the corrected data —
        // never assume success just because no write threw.
        await onRevalidate(modelId);
      }
    } finally {
      setApplying(false);
    }
  }, [
    activeRequirement,
    dataStore,
    failedEntities,
    effectiveSelection,
    getMutationView,
    modelId,
    rawValue,
    registerMutationView,
    setStoreProperty,
    onRevalidate,
    t,
  ]);

  // Review as changes (P15): the same typed, unit-scaled values as a checked batch; nothing is written here.
  const [review, setReview] = useState<ChangeConversion | null>(null);
  const handleReview = () => {
    if (!activeRequirement) return;
    const { psetName, propName } = activeRequirement.target;
    setReview(idsCorrectionToModelChanges(useViewerStore.getState(), { modelId, target: activeRequirement.target,
      facetDataType: activeRequirement.facetDataType, rawValue, title: t('tableChanges.idsTitle', { field: `${psetName}.${propName}` }),
      expressIds: failedEntities.map((e) => e.expressId).filter((id) => effectiveSelection.has(id)) }));
  };

  const appliedCount = results?.filter((r) => r.applied).length ?? 0;
  const failedCount = results ? results.length - appliedCount : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) resetForNewOpen();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench className="h-5 w-5" />
            {t('idsPanel.correction.title')}
          </DialogTitle>
          <DialogDescription>
            {t('idsPanel.correction.description')}
          </DialogDescription>
        </DialogHeader>

        {!activeRequirement || !dataStore ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>{t('idsPanel.correction.nothingToCorrect')}</AlertTitle>
            <AlertDescription>
              {!dataStore
                ? t('idsPanel.correction.noParsedData')
                : t('idsPanel.correction.noCorrectableRequirement')}
            </AlertDescription>
          </Alert>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-hidden">
            {correctable.length > 1 && (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">{t('idsPanel.correction.requirement')}</Label>
                <select aria-label={t('idsPanel.correction.requirement')}
                  className="w-full rounded border border-border bg-transparent px-2 py-1 text-sm"
                  value={activeRequirement.requirementId}
                  onChange={(e) => {
                    setRequirementId(e.target.value);
                    setSelectedIds(null);
                    setResults(null);
                  }}
                >
                  {correctable.map((r) => (
                    <option key={r.requirementId} value={r.requirementId}>
                      {r.target.psetName}.{r.target.propName}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="text-sm text-muted-foreground">
              {t('idsPanel.correction.target')} <span className="font-medium text-foreground">{activeRequirement.target.psetName}.{activeRequirement.target.propName}</span>
            </div>

            <div className="space-y-1">
              <Label htmlFor={newValueInputId} className="text-xs text-muted-foreground">{t('idsPanel.correction.newValue')}</Label>
              <Input id={newValueInputId}
                value={rawValue}
                onChange={(e) => setRawValue(e.target.value)}
                placeholder={t('idsPanel.correction.newValuePlaceholder')}
              />
            </div>

            <div className="space-y-1 flex-1 min-h-0 flex flex-col">
              <Label className="text-xs text-muted-foreground">
                {t('idsPanel.correction.failedEntitiesLabel', { selected: effectiveSelection.size, total: failedEntities.length })}
              </Label>
              <ScrollArea className="border rounded-md flex-1 min-h-0 max-h-48">
                <div className="divide-y">
                  {failedEntities.map((entity) => {
                    const result = results?.find((r) => r.expressId === entity.expressId);
                    return (
                      <label
                        key={entity.expressId}
                        className="flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-muted/50 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={effectiveSelection.has(entity.expressId)}
                          onChange={() => toggleEntity(entity.expressId)}
                        />
                        <span className="flex-1 truncate">
                          {entity.entityName || `#${entity.expressId}`}
                        </span>
                        {result && (
                          result.applied
                            ? <Check className="h-3.5 w-3.5 text-green-600 shrink-0" aria-label={t('idsPanel.correction.applied')} />
                            : <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" aria-label={result.error} />
                        )}
                      </label>
                    );
                  })}
                </div>
              </ScrollArea>
            </div>

            {applyError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{applyError}</AlertDescription>
              </Alert>
            )}

            {results && (
              <Alert variant={failedCount === 0 ? 'default' : 'destructive'}>
                {failedCount === 0 ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
                <AlertTitle>{failedCount === 0 ? t('idsPanel.correction.appliedTitle') : t('idsPanel.correction.someFailedTitle')}</AlertTitle>
                <AlertDescription>
                  {failedCount > 0 ? t('idsPanel.correction.summaryWithFailed', { appliedCount, failedCount }) : t('idsPanel.correction.summary', { appliedCount })}
                  {failedCount > 0 && (
                    <ul className="mt-1 list-disc list-inside">
                      {results.filter((r) => !r.applied).map((r) => (
                        <li key={r.expressId}>#{r.expressId}: {r.error}</li>
                      ))}
                    </ul>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('idsPanel.correction.close')}</Button>
          <Button onClick={handleReview} disabled={!activeRequirement || !dataStore || applying || rawValue.trim().length === 0 || effectiveSelection.size === 0}>
            <ListChecks className="h-4 w-4 mr-2" />{t('tableChanges.reviewButton')}
          </Button>
          <Button
            variant="outline"
            onClick={() => { void handleApply(); }}
            disabled={!activeRequirement || !dataStore || applying || rawValue.trim().length === 0 || effectiveSelection.size === 0}
          >
            {applying ? <Spinner size="md" className="mr-2" /> : <Wrench className="h-4 w-4 mr-2" />}
            {t('idsPanel.correction.applyTo', { count: effectiveSelection.size })}
          </Button>
        </DialogFooter>
        <ChangeReviewDialog conversion={review} origin={`ids:${modelId}`} onClose={() => setReview(null)} />
      </DialogContent>
    </Dialog>
  );
}
